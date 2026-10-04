import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type {
  AppConfigDTO,
  MessageDTO,
  RoomDTO,
  ServerEvent,
  WorkDTO,
  WorkExecutionDTO,
  WorkExecutionStepDTO,
} from "../../src/shared/contracts.ts";
import { describe, expect, it } from "vitest";
import { openEventStream } from "../helpers/sse-client.ts";
import {
  FAKE_KEY_ENV,
  startFixture,
  type Fixture,
  type FixtureAnswer,
  type FixtureRequest,
  waitForFixture,
} from "../helpers/emit-fixture.ts";
import { startEmitProcess, type EmitProcessFixture } from "../helpers/process-fixture.ts";
import { loadTestSettings } from "../helpers/test-settings.ts";
import { seedTestWorkspace } from "../helpers/workspace-fixture.ts";
import { printStressMetrics, StressMetrics, stressRequest } from "../helpers/stress-metrics.ts";

const settings = loadTestSettings();
const requestTimeoutMs = Math.min(settings.durationMs, 30_000);
const lowVerdict = JSON.stringify({
  outcome: "allow",
  risk: "low",
  rationale: "Local stress provider",
  readOnly: true,
  userAuthorization: "unknown",
});

type SeededWorkspace = {
  employeeIds: readonly string[];
  channelId: string;
  mailRoomId: string;
};

type StressProcess = {
  emit: EmitProcessFixture;
  workRoot: string;
  workspace: SeededWorkspace;
  close(): Promise<void>;
};

type EventStream = {
  next(predicate: (event: ServerEvent) => boolean, timeoutMs?: number): Promise<ServerEvent>;
  close(): Promise<void>;
};

function toolBatchAnswer(model: string | undefined, calls: readonly { name: string; args: unknown }[]): FixtureAnswer {
  const encoder = new TextEncoder();
  const base = { id: "chatcmpl-stress-batch", object: "chat.completion.chunk", created: 1, model: model ?? "fake-chat" };
  const chunk = (choices: unknown[]) => encoder.encode(`data: ${JSON.stringify({ ...base, choices })}\n\n`);
  return {
    chunks: [
      chunk([{ index: 0, delta: { role: "assistant" }, finish_reason: null }]),
      chunk([{
        index: 0,
        delta: {
          tool_calls: calls.map((call, index) => ({
            index,
            id: `call_stress_${index}`,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          })),
        },
        finish_reason: null,
      }]),
      chunk([{ index: 0, delta: {}, finish_reason: "tool_calls" }]),
      encoder.encode("data: [DONE]\n\n"),
    ],
  };
}

async function openStressProcess(): Promise<StressProcess> {
  const root = mkdtempSync(join(tmpdir(), "emit-stress-load-"));
  let provider: Fixture | undefined;
  let emit: EmitProcessFixture | undefined;
  try {
    provider = await startFixture((request: FixtureRequest) => {
      if (request.model === "fake-reviewer") return { content: lowVerdict };
      if (request.prompt.includes("localpart")) return { content: '{"localpart":"stress-user"}' };
      if (request.prompt.includes("STRESS_EXECUTION_PAGES")) {
        const messages = JSON.parse(request.prompt) as Array<{ role?: string }>;
        const completed = messages.filter((message) => message.role === "tool").length;
        if (completed < 60) return { toolCall: { name: "read_file", args: { path: `page-${String(completed).padStart(3, "0")}.txt` } } };
        return { content: "STRESS_EXECUTION_COMPLETE" };
      }
      if (request.prompt.includes("STRESS_CONCURRENT_WAKE_CAP")) {
        if (request.prompt.includes('"role":"tool"')) return { content: "Concurrent wake batch completed." };
        const calls = Array.from({ length: Math.max(60, settings.concurrency + 1) }, (_, index) => ({
          name: "delegate_task",
          args: { employee: "Bob", task: `stress delegated item ${index}` },
        }));
        return toolBatchAnswer(request.model, calls);
      }
      return { content: "Stress work completed." };
    });
    emit = await startEmitProcess({
      root,
      dataDir: join(root, "data"),
      env: {
        [FAKE_KEY_ENV]: "stress-local-provider-key",
        EMIT_TEST_ALLOWED_ORIGINS: JSON.stringify([new URL(provider.baseUrl).origin]),
      },
    });
    const workspace = await seedTestWorkspace({ url: emit.url, providerBaseUrl: provider.baseUrl, root });
    const process = emit;
    const fake = provider;
    let closing: Promise<void> | undefined;
    return {
      emit: process,
      workRoot: join(root, "work"),
      workspace,
      close(): Promise<void> {
        closing ??= (async () => {
          try {
            await process.stop();
          } finally {
            try {
              await fake.close();
            } finally {
              rmSync(root, { recursive: true, force: true });
            }
          }
        })();
        return closing;
      },
    };
  } catch (error) {
    try {
      await emit?.stop();
    } finally {
      try {
        await provider?.close();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
    throw error;
  }
}

async function runConcurrent<T>(count: number, concurrency: number, operation: (index: number) => Promise<T>): Promise<T[]> {
  let next = 0;
  const results: T[] = new Array(count);
  let stopped = false;
  const failures: unknown[] = [];
  const workerCount = Math.min(count, concurrency);
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      if (stopped) return;
      const index = next;
      next += 1;
      if (index >= count) return;
      try {
        results[index] = await operation(index);
      } catch (error) {
        failures.push(error);
        stopped = true;
      }
    }
  });
  await Promise.all(workers);
  if (failures.length > 0) throw new AggregateError(failures, `${failures.length} concurrent operations failed`);
  return results;
}

async function waitForWorkSet(
  metrics: StressMetrics,
  baseUrl: string,
  condition: (works: readonly WorkDTO[]) => boolean,
  description: string,
  timeoutMs: number,
): Promise<WorkDTO[]> {
  let latest: WorkDTO[] = [];
  await waitForFixture(async () => {
    latest = (await stressRequest<WorkDTO[]>(metrics, baseUrl, "/api/works", { timeoutMs: Math.min(10_000, timeoutMs) })).body;
    return condition(latest);
  }, description, timeoutMs);
  return latest;
}

async function readEveryExecutionPage(
  metrics: StressMetrics,
  baseUrl: string,
  workId: string,
): Promise<{ steps: WorkExecutionStepDTO[]; pages: number }> {
  let cursor: string | undefined;
  let pages = 0;
  const collected: WorkExecutionStepDTO[] = [];
  const seenIds = new Set<string>();
  do {
    const query = cursor === undefined ? "" : `?${new URLSearchParams({ cursor }).toString()}`;
    const page = await stressRequest<WorkExecutionDTO>(metrics, baseUrl, `/api/works/${workId}/execution${query}`, {
      timeoutMs: Math.min(10_000, requestTimeoutMs),
    });
    expect(page.body.work.id).toBe(workId);
    const entryIds = page.body.steps.map((step) => Number(step.entryId));
    expect(entryIds).toEqual([...entryIds].sort((left, right) => left - right));
    for (const step of page.body.steps) {
      expect(seenIds.has(step.id), `execution step ${step.id} repeated between pages`).toBe(false);
      seenIds.add(step.id);
    }
    collected.unshift(...page.body.steps);
    cursor = page.body.nextCursor;
    pages += 1;
    expect(pages).toBeLessThanOrEqual(10);
  } while (cursor !== undefined);
  return { steps: collected, pages };
}

describe("manual stress: public runtime concurrency and history load", () => {
  it("fans out SSE, stores bounded large mail history, caps concurrent work, and pages execution through HTTP", async () => {
    const service = await openStressProcess();
    const metrics = new StressMetrics(() => service.emit.rssBytes());
    const streams: EventStream[] = [];
    try {
      const fanout = settings.concurrency;
      const openResults = await Promise.allSettled(Array.from({ length: fanout }, async () => {
        const started = performance.now();
        try {
          const stream = await openEventStream(`${service.emit.url}/api/events`);
          metrics.recordRequest(performance.now() - started);
          streams.push(stream);
          return stream;
        } catch (error) {
          metrics.recordRequest(performance.now() - started, true);
          throw error;
        }
      }));
      const openFailures = openResults.filter((result) => result.status === "rejected");
      expect(openFailures, `failed to open ${fanout} SSE clients`).toHaveLength(0);
      expect(streams).toHaveLength(fanout);

      const userName = `Stress fanout ${settings.seed}`;
      const waiters = streams.map(async (stream) => {
        const started = performance.now();
        try {
          const event = await stream.next(
            (candidate) => candidate.type === "app" && candidate.app.user.name === userName,
            Math.max(1_000, requestTimeoutMs),
          );
          metrics.recordObservation(performance.now() - started);
          return event;
        } catch (error) {
          metrics.recordObservation(performance.now() - started, true);
          throw error;
        }
      });
      const patched = await stressRequest<AppConfigDTO>(metrics, service.emit.url, "/api/app", {
        method: "PATCH",
        body: { userName },
        timeoutMs: requestTimeoutMs,
      });
      expect(patched.body.user.name).toBe(userName);
      const observedEvents = await Promise.all(waiters);
      expect(observedEvents).toHaveLength(fanout);
      expect(observedEvents.every((event) => event.type === "app" && event.app.user.name === userName)).toBe(true);
      const persistedApp = await stressRequest<AppConfigDTO>(metrics, service.emit.url, "/api/app", { timeoutMs: requestTimeoutMs });
      expect(persistedApp.body.user.name).toBe(userName);
      await Promise.allSettled(streams.map((stream) => stream.close()));
      streams.length = 0;

      const historyCount = Math.min(1_000, settings.operations);
      const storedMessages = await runConcurrent(historyCount, settings.concurrency, async (index) => {
        const body = `STRESS_HISTORY_${String(index).padStart(4, "0")}`;
        const result = await stressRequest<{ message: MessageDTO; workIds: string[] }>(
          metrics,
          service.emit.url,
          `/api/rooms/${service.workspace.mailRoomId}/messages`,
          {
            method: "POST",
            body: { body, subject: `Stress history ${index}`, to: [], cc: [], draft: true },
            timeoutMs: requestTimeoutMs,
          },
        );
        expect(result.body.workIds).toEqual([]);
        expect(result.body.message.body).toBe(body);
        expect(result.body.message.mail?.draft).toBe(true);
        return result.body.message;
      });
      const history = await stressRequest<{ room: RoomDTO; messages: MessageDTO[] }>(
        metrics,
        service.emit.url,
        `/api/rooms/${service.workspace.mailRoomId}/messages`,
        { timeoutMs: requestTimeoutMs },
      );
      expect(history.body.room.messageCount).toBe(historyCount);
      expect(history.body.messages).toHaveLength(Math.min(200, historyCount));
      const newestExpected = [...storedMessages]
        .sort((left, right) => Number(left.id) - Number(right.id))
        .slice(-history.body.messages.length)
        .map(({ id }) => id);
      expect(history.body.messages.map(({ id }) => id)).toEqual(newestExpected);

      const aliceId = service.workspace.employeeIds[0];
      if (aliceId === undefined) throw new Error("The stress workspace has no Alice employee");
      const budget = settings.concurrency;
      const delegationCalls = Math.max(60, budget + 1);
      const app = await stressRequest<AppConfigDTO>(metrics, service.emit.url, "/api/app", { timeoutMs: requestTimeoutMs });
      const changedLimits = await stressRequest<AppConfigDTO>(metrics, service.emit.url, "/api/app", {
        method: "PATCH",
        body: { collaboration: { ...app.body.collaboration, maxCrossEmployeeWakes: budget } },
        timeoutMs: requestTimeoutMs,
      });
      expect(changedLimits.body.collaboration.maxCrossEmployeeWakes).toBe(budget);
      const acceptedRoot = await stressRequest<{ message: MessageDTO; workIds: string[] }>(
        metrics,
        service.emit.url,
        `/api/rooms/${service.workspace.channelId}/messages`,
        { method: "POST", body: { body: "STRESS_CONCURRENT_WAKE_CAP", recipientIds: [aliceId] }, timeoutMs: requestTimeoutMs },
      );
      expect(acceptedRoot.body.workIds).toHaveLength(1);
      const rootWorkId = acceptedRoot.body.workIds[0];
      if (rootWorkId === undefined) throw new Error("The public message did not create its root work");

      const completed = await waitForWorkSet(
        metrics,
        service.emit.url,
        (works) => {
          const root = works.find((work) => work.id === rootWorkId);
          const children = works.filter((work) => work.parentWorkId === rootWorkId);
          return root?.status === "succeeded" && children.length === budget && children.every((work) => ["succeeded", "failed", "stopped"].includes(work.status));
        },
        `${budget} admitted concurrent children and terminal work`,
        settings.durationMs,
      );
      const root = completed.find((work) => work.id === rootWorkId);
      const children = completed.filter((work) => work.parentWorkId === rootWorkId);
      expect(root?.status).toBe("succeeded");
      expect(children).toHaveLength(budget);
      expect(children.every((work) => work.status === "succeeded")).toBe(true);

      const execution = await readEveryExecutionPage(metrics, service.emit.url, rootWorkId);
      const toolCalls = execution.steps.filter((step) => step.kind === "tool-call");
      const toolResults = execution.steps.filter((step) => step.kind === "tool-result");
      expect(toolCalls).toHaveLength(delegationCalls);
      expect(toolCalls.every((step) => step.toolName === "delegate_task")).toBe(true);
      expect(toolResults).toHaveLength(delegationCalls);
      const refused = toolResults.filter((step) => step.isError === true);
      expect(refused).toHaveLength(delegationCalls - budget);
      expect(children.every((work) => work.depth === 1 && work.rootWorkId === rootWorkId)).toBe(true);

      expect(metrics.summary().errors).toBe(0);
      expect(metrics.summary().observationErrors).toBe(0);
      console.info(`[stress] workload ${JSON.stringify({ fanout, historyCount, workBudget: budget, delegationCalls, executionPages: execution.pages })}`);
    } finally {
      await Promise.allSettled(streams.map((stream) => stream.close()));
      try {
        metrics.close();
        printStressMetrics("public-runtime-load", metrics);
      } finally { await service.close(); }
    }
  }, settings.durationMs + 120_000);

  it("pages over one hundred durable entries from sixty real sequential file reads without loss or duplication", async () => {
    const service = await openStressProcess();
    const metrics = new StressMetrics(() => service.emit.rssBytes());
    try {
      for (let index = 0; index < 60; index += 1) {
        writeFileSync(join(service.workRoot, `page-${String(index).padStart(3, "0")}.txt`), `STRESS_EXECUTION_OUTPUT_${String(index).padStart(3, "0")}`);
      }
      const app = await stressRequest<AppConfigDTO>(metrics, service.emit.url, "/api/app", { timeoutMs: requestTimeoutMs });
      await stressRequest(metrics, service.emit.url, "/api/app", {
        method: "PATCH", body: { collaboration: { ...app.body.collaboration, maxModelTurns: 80 } }, timeoutMs: requestTimeoutMs,
      });
      const accepted = await stressRequest<{ workIds: string[] }>(metrics, service.emit.url, `/api/rooms/${service.workspace.channelId}/messages`, {
        method: "POST", body: { body: "STRESS_EXECUTION_PAGES", recipientIds: [service.workspace.employeeIds[0]] }, timeoutMs: requestTimeoutMs,
      });
      expect(accepted.body.workIds).toHaveLength(1);
      const workId = accepted.body.workIds[0]!;
      const works = await waitForWorkSet(metrics, service.emit.url,
        (items) => items.some((work) => work.id === workId && ["succeeded", "failed", "stopped"].includes(work.status)),
        "sequential pagination work to finish", settings.durationMs);
      expect(works.find((work) => work.id === workId)).toMatchObject({ status: "succeeded", answer: "STRESS_EXECUTION_COMPLETE" });
      const execution = await readEveryExecutionPage(metrics, service.emit.url, workId);
      expect(execution.pages).toBeGreaterThan(1);
      const results = execution.steps.filter((step) => step.kind === "tool-result");
      expect(results).toHaveLength(60);
      for (let index = 0; index < 60; index += 1) {
        expect(results[index]?.text).toContain(`STRESS_EXECUTION_OUTPUT_${String(index).padStart(3, "0")}`);
      }
      expect(execution.steps.filter((step) => step.kind === "tool-call")).toHaveLength(60);
      expect(new Set(execution.steps.map((step) => step.entryId)).size).toBeGreaterThan(100);
    } finally {
      try {
        metrics.close();
        printStressMetrics("execution-pagination", metrics);
      } finally { await service.close(); }
    }
  }, settings.durationMs + 120_000);
});
