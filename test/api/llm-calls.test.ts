import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LlmCallDetailDTO, LlmCallPageDTO, LlmContentDTO, LlmJsonDTO, WorkDTO, WorkStatusDTO } from "../../src/shared/contracts.ts";
import { FAKE_KEY_ENV, startHttpRuntime, waitForFixture, type FixtureAnswer, type FixtureRequest } from "../helpers/emit-fixture.ts";
import { jsonInit as json, openSeededApiFixture, requestJson as request } from "../helpers/api-fixture.ts";
import { openEventStream } from "../helpers/sse-client.ts";
import { LlmCallDoc, WorkDoc, WorkLlmCallIndexDoc } from "../../src/server/documents.ts";

const cleanup: Array<() => Promise<void> | void> = [];
let previousApiKey: string | undefined;
let releaseProvider: (() => void) | undefined;

beforeEach(() => {
  previousApiKey = process.env[FAKE_KEY_ENV];
  process.env[FAKE_KEY_ENV] = "api-llm-calls-fixture-key";
});

afterEach(async () => {
  releaseProvider?.();
  releaseProvider = undefined;
  for (const close of cleanup.splice(0).reverse()) {
    try {
      await close();
    } catch {
      // Preserve the assertion result while still releasing this test's resources.
    }
  }
  if (previousApiKey === undefined) delete process.env[FAKE_KEY_ENV];
  else process.env[FAKE_KEY_ENV] = previousApiKey;
});

function answerFor(request: FixtureRequest, gate: Promise<void>): FixtureAnswer {
  if (request.model === "fake-reviewer") {
    return {
      content: JSON.stringify({
        outcome: "allow",
        risk: "low",
        rationale: "Local LLM call history fixture",
        readOnly: true,
        userAuthorization: "unknown",
      }),
    };
  }
  if (request.prompt.includes("API_LLM_CALL_GATE")) {
    return {
      content: '{"token":"output-secret-canary","visible":"OUTPUT_VISIBLE_CANARY"}',
      gate,
    };
  }
  if (request.prompt.includes("API_LLM_CALL_PAGINATION")) {
    const messages = JSON.parse(request.prompt) as { role?: string }[];
    const completedReads = messages.filter((message) => message.role === "tool").length;
    if (completedReads < 55) {
      return { toolCall: { name: "read_file", args: { path: join("missing-pages", `page-${completedReads}.txt`) } } };
    }
    return { content: "PAGINATION_COMPLETE" };
  }
  if (request.prompt.includes("API_LLM_CALL_OTHER")) return { content: "SECOND_WORK_OUTPUT" };
  return { content: "Unexpected fixture request" };
}

async function waitForWorkStatus(url: string, id: string, status: WorkStatusDTO): Promise<void> {
  await waitForFixture(async () => {
    const response = await request<WorkDTO[]>(url, "/api/works");
    const work = response.body.find((entry) => entry.id === id);
    if (work !== undefined && ["succeeded", "failed", "stopped"].includes(work.status) && work.status !== status) {
      throw new Error(`Work ${id} reached ${work.status}, expected ${status}`);
    }
    return work?.status === status;
  }, `work ${id} to become ${status}`, 30_000);
}

async function sendToEmployee(url: string, roomId: string, employeeId: string, body: string): Promise<string> {
  const sent = await request<{ workIds: string[] }>(url, `/api/rooms/${roomId}/messages`, {
    ...json("POST", { body, recipientIds: [employeeId] }),
  });
  expect(sent.status).toBe(200);
  const workId = sent.body.workIds[0];
  if (workId === undefined) throw new Error(`Message ${body} did not create work`);
  return workId;
}

function textBlocks(parts: readonly LlmContentDTO[]): Extract<LlmContentDTO, { type: "text" }>[] {
  return parts.filter((part): part is Extract<LlmContentDTO, { type: "text" }> => part.type === "text");
}

function jsonScalars(value: LlmJsonDTO): unknown[] {
  if (value.type === "scalar") return [value.value];
  if (value.type === "array") return value.items.flatMap(jsonScalars);
  return value.entries.flatMap((entry) => [entry.key, ...jsonScalars(entry.value)]);
}

describe("LLM call history HTTP contract", () => {
  it("captures a running call's actual categorized input, then its redacted output in the same work-scoped record", async () => {
    const providerGate = Promise.withResolvers<void>();
    releaseProvider = providerGate.resolve;
    const { http, provider, workspace } = await openSeededApiFixture({
      prefix: "emit-api-llm-calls-",
      cleanups: cleanup,
      decide: (_root, request) => answerFor(request, providerGate.promise),
    });

    const events = await openEventStream(`${http.url}/api/events`);
    cleanup.push(() => events.close());

    // Exercise free-form values after JSON, including malformed composite
    // prefixes, later complete composites, and a composite with an open quote.
    const userMessage = `${JSON.stringify({
      task: "API_LLM_CALL_GATE",
      visible: "INPUT_VISIBLE_CANARY",
      password: "input-secret-canary",
      credentials: { label: "input-nested-secret-canary", note: "brackets ] } inside a string" },
      passwords: ["input-array-secret-canary", { note: "brackets ] } inside a string" }],
    })}
credentials: {note: '}', label: 'input-single-quoted-secret-canary'}
${"password: { ".repeat(128)}password: {note: '}', label: 'input-later-composite-secret-canary'}
credentials: [the user's key, input-apostrophe-composite-secret-canary]`;
    const firstWorkId = await sendToEmployee(
      http.url,
      workspace.channelId,
      workspace.employeeIds[0]!,
      userMessage,
    );
    await waitForFixture(
      async () => provider.requests.some((entry) => entry.prompt.includes("API_LLM_CALL_GATE")),
      "the gated SDK request to reach the local provider",
      30_000,
    );
    await waitForFixture(async () => {
      const page = await request<LlmCallPageDTO>(http.url, `/api/works/${firstWorkId}/llm-calls`);
      return page.status === 200 && page.body.items.some((call) => call.status === "running");
    }, "the committed running LLM call metadata", 30_000);

    const runningPage = await request<LlmCallPageDTO>(http.url, `/api/works/${firstWorkId}/llm-calls`);
    expect(runningPage.status).toBe(200);
    expect(runningPage.body.captureHealth).toEqual({ failedCount: 0, accepting: true });
    expect(runningPage.body.items).toHaveLength(1);
    const running = runningPage.body.items[0]!;
    const startedEvent = await events.next((event) => event.type === "llm-call" && event.callId === running.id);
    expect(startedEvent).toEqual({ type: "llm-call", workId: firstWorkId, callId: running.id, revision: 1 });
    expect(running).toMatchObject({
      workId: firstWorkId,
      sequence: 1,
      kind: "employee",
      status: "running",
      model: { providerId: "fake", modelId: "fake-chat" },
      redactionApplied: true,
      captureBoundary: "models-sdk",
    });
    expect(running.inputBytes).toBeGreaterThan(0);
    expect("input" in running).toBe(false);
    expect("responses" in running).toBe(false);

    const runningDetail = await request<LlmCallDetailDTO>(http.url, `/api/works/${firstWorkId}/llm-calls/${running.id}`);
    expect(runningDetail.status).toBe(200);
    expect(runningDetail.body.responses).toEqual([]);
    const system = runningDetail.body.input.system;
    expect(system).toBeDefined();
    expect((system?.content.length ?? 0) + (system?.sections.length ?? 0)).toBeGreaterThan(0);
    expect(runningDetail.body.input.tools.some((tool) => tool.name === "read_file")).toBe(true);
    const inputText = runningDetail.body.input.messages.flatMap((message) => textBlocks(message.content)).map((part) => part.text).join("\n");
    expect(inputText).toContain("INPUT_VISIBLE_CANARY");
    expect(inputText).toContain("[REDACTED]");
    expect(JSON.stringify(runningDetail.body)).not.toContain("input-secret-canary");
    expect(JSON.stringify(runningDetail.body)).not.toContain("input-nested-secret-canary");
    expect(JSON.stringify(runningDetail.body)).not.toContain("input-array-secret-canary");
    expect(JSON.stringify(runningDetail.body)).not.toContain("input-single-quoted-secret-canary");
    expect(JSON.stringify(runningDetail.body)).not.toContain("input-later-composite-secret-canary");
    expect(JSON.stringify(runningDetail.body)).not.toContain("input-apostrophe-composite-secret-canary");

    const returnedEventPromise = events.next(
      (event) => event.type === "llm-call" && event.callId === running.id && event.revision > 1,
    );
    providerGate.resolve();
    const returnedEvent = await returnedEventPromise;
    expect(returnedEvent).toEqual({ type: "llm-call", workId: firstWorkId, callId: running.id, revision: 2 });
    await waitForWorkStatus(http.url, firstWorkId, "succeeded");
    await waitForFixture(async () => {
      const page = await request<LlmCallPageDTO>(http.url, `/api/works/${firstWorkId}/llm-calls`);
      return page.status === 200 && page.body.items.some((call) => call.id === running.id && call.status === "returned");
    }, "the same call to receive its SDK output", 30_000);

    const completedDetail = await request<LlmCallDetailDTO>(http.url, `/api/works/${firstWorkId}/llm-calls/${running.id}`);
    expect(completedDetail.status).toBe(200);
    expect(completedDetail.body.id).toBe(running.id);
    expect(completedDetail.body.revision).toBeGreaterThan(running.revision);
    const outputText = textBlocks(completedDetail.body.responses[0]!.content)[0];
    expect(outputText?.text).toContain("OUTPUT_VISIBLE_CANARY");
    expect(outputText?.structured).toBeDefined();
    expect(jsonScalars(outputText!.structured!)).toContain("[REDACTED]");
    expect(JSON.stringify(completedDetail.body)).not.toContain("output-secret-canary");

    const secondWorkId = await sendToEmployee(
      http.url,
      workspace.channelId,
      workspace.employeeIds[1]!,
      "API_LLM_CALL_OTHER",
    );
    await waitForWorkStatus(http.url, secondWorkId, "succeeded");
    const secondPage = await request<LlmCallPageDTO>(http.url, `/api/works/${secondWorkId}/llm-calls`);
    expect(secondPage.status).toBe(200);
    expect(secondPage.body.items).toHaveLength(1);
    expect(secondPage.body.items[0]!.workId).toBe(secondWorkId);

    const wrongWorkDetail = await request<{ message: string }>(http.url, `/api/works/${secondWorkId}/llm-calls/${running.id}`);
    const missingWork = await request<{ message: string }>(http.url, "/api/works/not-a-real-work/llm-calls");
    const badCursor = await request<{ message: string }>(http.url, `/api/works/${firstWorkId}/llm-calls?cursor=${encodeURIComponent("not-json")}`);
    expect(wrongWorkDetail.status).toBe(404);
    expect(missingWork.status).toBe(404);
    expect(badCursor.status).toBe(400);
  }, 60_000);
  it("recovers a running call as interrupted without fabricating a response or end time", async () => {
    const providerGate = Promise.withResolvers<void>();
    releaseProvider = providerGate.resolve;
    const { root, http, provider, workspace } = await openSeededApiFixture({
      prefix: "emit-api-llm-calls-recovery-",
      cleanups: cleanup,
      decide: (_root, request) => answerFor(request, providerGate.promise),
    });
    const workId = await sendToEmployee(
      http.url,
      workspace.channelId,
      workspace.employeeIds[0]!,
      "API_LLM_CALL_GATE RECOVERY_INPUT",
    );
    await waitForFixture(
      async () => provider.requests.some((entry) => entry.prompt.includes("RECOVERY_INPUT")),
      "the provider to hold a running call during shutdown",
      30_000,
    );
    await waitForFixture(async () => {
      const page = await request<LlmCallPageDTO>(http.url, `/api/works/${workId}/llm-calls`);
      return page.status === 200 && page.body.items.some((call) => call.status === "running");
    }, "the running call metadata before shutdown", 30_000);
    const before = await request<LlmCallPageDTO>(http.url, `/api/works/${workId}/llm-calls`);
    expect(before.body.items).toHaveLength(1);
    const callId = before.body.items[0]!.id;

    await http.close();
    const reopened = await startHttpRuntime(join(root, "data"));
    cleanup.push(() => reopened.close());
    const recovered = await request<LlmCallPageDTO>(reopened.url, `/api/works/${workId}/llm-calls`);
    expect(recovered.status).toBe(200);
    expect(recovered.body.items).toHaveLength(1);
    expect(recovered.body.items[0]).toMatchObject({ id: callId, status: "interrupted" });
    expect(recovered.body.items[0]!.endedAt).toBeUndefined();
    const detail = await request<LlmCallDetailDTO>(reopened.url, `/api/works/${workId}/llm-calls/${callId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.responses).toEqual([]);
    expect(textBlocks(detail.body.input.messages.flatMap((message) => message.content)).map((part) => part.text).join("\\n")).toContain(
      "RECOVERY_INPUT",
    );
    providerGate.resolve();
  }, 60_000);

  it("paginates only compact per-work metadata in begin sequence order", async () => {
    const fixture = await openSeededApiFixture({
      prefix: "emit-api-llm-calls-pages-",
      cleanups: cleanup,
      decide: (_root, request) => answerFor(request, Promise.resolve()),
    });
    let http = fixture.http;
    const { workspace } = fixture;
    const settings = await request(http.url, "/api/app", json("PATCH", {
      collaboration: { maxDepth: 3, maxCrossEmployeeWakes: 12, maxModelTurns: 80 },
    }));
    expect(settings.status).toBe(200);
    const workId = await sendToEmployee(
      http.url,
      workspace.channelId,
      workspace.employeeIds[0]!,
      "API_LLM_CALL_PAGINATION",
    );
    await waitForWorkStatus(http.url, workId, "succeeded");

    const sequences: number[] = [];
    const ids = new Set<string>();
    let cursor: string | undefined;
    let pageCount = 0;
    do {
      const query = cursor === undefined ? "" : `?cursor=${encodeURIComponent(cursor)}`;
      const page = await request<LlmCallPageDTO>(http.url, `/api/works/${workId}/llm-calls${query}`);
      expect(page.status).toBe(200);
      expect(page.body.items.length).toBeLessThanOrEqual(50);
      expect(page.body.items.map((call) => call.sequence)).toEqual(
        [...page.body.items.map((call) => call.sequence)].sort((left, right) => right - left),
      );
      for (const call of page.body.items) {
        expect(ids.has(call.id)).toBe(false);
        ids.add(call.id);
        expect(call.workId).toBe(workId);
        expect("input" in call).toBe(false);
        expect("responses" in call).toBe(false);
        sequences.push(call.sequence);
      }
      cursor = page.body.nextCursor;
      pageCount += 1;
      expect(pageCount).toBeLessThan(5);
    } while (cursor !== undefined);
    expect(pageCount).toBe(2);
    expect(sequences).toHaveLength(56);
    expect(sequences).toEqual(Array.from({ length: 56 }, (_, index) => 56 - index));

    await http.close();
    http = await startHttpRuntime(join(fixture.root, "data"));
    cleanup.push(() => http.close());
    const firstAfterRestart = await request<LlmCallPageDTO>(http.url, `/api/works/${workId}/llm-calls`);
    expect(firstAfterRestart.status).toBe(200);
    expect(firstAfterRestart.body.items.map((call) => call.sequence)).toEqual(
      Array.from({ length: 50 }, (_, index) => 56 - index),
    );
    const restartCursor = firstAfterRestart.body.nextCursor;
    expect(restartCursor).toBeDefined();
    const secondAfterRestart = await request<LlmCallPageDTO>(
      http.url,
      `/api/works/${workId}/llm-calls?cursor=${encodeURIComponent(restartCursor!)}`,
    );
    expect(secondAfterRestart.status).toBe(200);
    expect(secondAfterRestart.body.items.map((call) => call.sequence)).toEqual([6, 5, 4, 3, 2, 1]);
    expect(secondAfterRestart.body.nextCursor).toBeUndefined();
  }, 120_000);

  it("rebuilds legacy per-work indexes before serving pages and reports indexed header corruption", async () => {
    const fixture = await openSeededApiFixture({
      prefix: "emit-api-llm-calls-index-migration-",
      cleanups: cleanup,
      resume: false,
    });
    const employeeId = fixture.workspace.employeeIds[0]!;
    const { channelId, workContextId } = fixture.workspace;
    const seedWork = async (id: string): Promise<void> => {
      await fixture.http.runtime.updateFamily(WorkDoc, id, { id }, (draft) => {
        draft.employeeId = employeeId;
        draft.roomId = channelId;
        draft.workContextId = workContextId;
        draft.kind = "message";
        draft.status = "succeeded";
        draft.rootWorkId = id;
      });
    };
    const seedCall = async (workId: string, id: string, sequence: number): Promise<void> => {
      await fixture.http.runtime.updateFamily(LlmCallDoc, id, { id }, (draft) => {
        Object.assign(draft, {
          id,
          workId,
          sequence,
          revision: 1,
          kind: "employee",
          employeeId,
          model: { providerId: "fixture", modelId: "fake-chat" },
          startedAt: sequence,
          endedAt: sequence + 1,
          status: "returned",
          reasoning: "",
          inputBytes: 1,
          outputBytes: 1,
          messageCount: 0,
          toolCount: 0,
          redactionApplied: true,
          captureBoundary: "models-sdk",
        });
      });
    };

    await seedWork("legacy-work");
    await seedWork("other-legacy-work");
    await seedWork("empty-work");
    await seedCall("legacy-work", "legacy-call-1", 1);
    await seedCall("legacy-work", "legacy-call-2", 2);
    await seedCall("legacy-work", "legacy-call-3", 3);
    await seedCall("other-legacy-work", "other-call-1", 1);

    await fixture.http.close();
    const firstRestart = await startHttpRuntime(join(fixture.root, "data"));
    cleanup.push(() => firstRestart.close());
    const legacy = await request<LlmCallPageDTO>(firstRestart.url, "/api/works/legacy-work/llm-calls");
    const other = await request<LlmCallPageDTO>(firstRestart.url, "/api/works/other-legacy-work/llm-calls");
    const empty = await request<LlmCallPageDTO>(firstRestart.url, "/api/works/empty-work/llm-calls");
    expect(legacy.status).toBe(200);
    expect(legacy.body.items.map((call) => call.id)).toEqual(["legacy-call-3", "legacy-call-2", "legacy-call-1"]);
    expect(other.status).toBe(200);
    expect(other.body.items.map((call) => call.id)).toEqual(["other-call-1"]);
    expect(empty.status).toBe(200);
    expect(empty.body.items).toEqual([]);

    await firstRestart.runtime.updateFamily(WorkLlmCallIndexDoc, "legacy-work", { workId: "legacy-work" }, (draft) => {
      draft.calls = draft.calls.filter((call) => call.id !== "legacy-call-2");
    });
    await firstRestart.close();
    const repaired = await startHttpRuntime(join(fixture.root, "data"));
    cleanup.push(() => repaired.close());
    const repairedPage = await request<LlmCallPageDTO>(repaired.url, "/api/works/legacy-work/llm-calls");
    expect(repairedPage.status).toBe(200);
    expect(repairedPage.body.items.map((call) => call.id)).toEqual(["legacy-call-3", "legacy-call-2", "legacy-call-1"]);

    await repaired.runtime.updateFamily(WorkLlmCallIndexDoc, "legacy-work", { workId: "legacy-work" }, (draft) => {
      draft.calls = [{ id: "missing-call", sequence: 4 }];
    });
    const corrupt = await request<{ message: string; messageLocalized?: { en: string; "zh-CN": string } }>(
      repaired.url,
      "/api/works/legacy-work/llm-calls",
    );
    expect(corrupt.status).toBe(500);
    expect(corrupt.body.message).toBe("The LLM call record is incomplete");
    expect(corrupt.body.messageLocalized).toEqual({
      en: "The LLM call record is incomplete",
      "zh-CN": "LLM 调用记录不完整",
    });
  }, 60_000);
});
