import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { InMemoryCredentialStore, type Provider } from "@earendil-works/pi-ai";
import { typesafeProvider } from "@earendil-works/pi-ai/providers/typesafe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApprovalDTO, LlmCallPageDTO, LlmJsonDTO, WorkDTO } from "../../src/shared/contracts.ts";
import { createClassifierEvaluator } from "../../src/server/approval/evaluators.ts";
import type { ApprovalCase, ApprovalEvaluatorConfig, EvaluationOutcome } from "../../src/server/approval/contracts.ts";
import { ModelCatalog } from "../../src/server/models.ts";
import {
  captureLlmCallException,
  captureLlmCallInput,
  captureLlmCallResponse,
  readWorkLlmCall,
  readWorkLlmCalls,
  withLlmCallOwner,
  type LlmCallInputSnapshot,
  type LlmCallObserver,
  type LlmCallResponseSnapshot,
  type ObservedLlmRequest,
} from "../../src/server/llm-calls.ts";
import { FAKE_KEY_ENV, waitForFixture, type FixtureAnswer, type FixtureRequest } from "../helpers/emit-fixture.ts";
import { jsonInit as json, openSeededApiFixture, requestJson as request } from "../helpers/api-fixture.ts";

const cleanup: Array<() => Promise<void> | void> = [];
let previousApiKey: string | undefined;

beforeEach(() => {
  previousApiKey = process.env[FAKE_KEY_ENV];
  process.env[FAKE_KEY_ENV] = "integration-llm-calls-fixture-key";
});

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    try {
      await close();
    } catch {
      // Preserve the assertion while still releasing the fixture.
    }
  }
  if (previousApiKey === undefined) delete process.env[FAKE_KEY_ENV];
  else process.env[FAKE_KEY_ENV] = previousApiKey;
});

function approvalAnswer(root: string, request: FixtureRequest): FixtureAnswer {
  if (request.model === "fake-reviewer") {
    return {
      content: JSON.stringify({
        outcome: "allow",
        risk: "high",
        rationale: "Integration approval review output.",
        readOnly: false,
        userAuthorization: "unknown",
      }),
    };
  }
  if (request.prompt.includes("INTEGRATION_LLM_APPROVAL") && !request.prompt.includes('"role":"tool"')) {
    return {
      toolCall: {
        name: "write_file",
        args: { path: join(root, "work", "integration-approval.txt"), content: "approval must reject this write" },
      },
    };
  }
  return { content: "The approval decision has been handled." };
}

async function sendWork(httpUrl: string, roomId: string, employeeId: string, body: string): Promise<string> {
  const response = await request<{ workIds: string[] }>(httpUrl, `/api/rooms/${roomId}/messages`, {
    ...json("POST", { body, recipientIds: [employeeId] }),
  });
  expect(response.status).toBe(200);
  const workId = response.body.workIds[0];
  if (workId === undefined) throw new Error(`Message ${body} did not create work`);
  return workId;
}

function classifierCase(id: string): ApprovalCase {
  return {
    schemaVersion: 3,
    id,
    toolTaskId: `task-${id}`,
    employee: { id: "employee-classifier", name: "Classifier worker", role: "Research" },
    tool: { name: "run_shell", kind: "shell", description: "Run a shell command in the session directory." },
    argumentsPreview: '{"command":"ls"}',
    arguments: '{"command":"ls -la"}',
    cwd: "/tmp/classifier-work",
    directories: { roomId: "room-classifier", workContextId: "ctx-classifier", version: 1, paths: ["/tmp/classifier-work"], defaultPath: "/tmp/classifier-work" },
    targetPaths: [],
    allowedTools: ["run_shell"],
    userIntent: {
      text: "INTEGRATION_CLASSIFIER_INTENT list this work directory",
      source: "room-message",
      truncated: false,
      authorization: "user",
      author: { id: "user", name: "Test User", type: "user" },
    },
    recentContext: [],
    executionContext: [
      {
        source: "execution-context",
        role: "assistant",
        toolName: "run_shell",
        toolCallId: "call-classifier",
        text: "INTEGRATION_CLASSIFIER_EXECUTION_CONTEXT",
        truncated: false,
      },
    ],
    contextBudget: { omittedEntries: 0, truncatedEntries: 0 },
    origin: { kind: "room", description: "integration channel" },
    configVersion: 1,
    policyVersion: 1,
  };
}

function jsonScalars(value: LlmJsonDTO): unknown[] {
  if (value.type === "scalar") return [value.value];
  if (value.type === "array") return value.items.flatMap(jsonScalars);
  return value.entries.flatMap((entry) => [entry.key, ...jsonScalars(entry.value)]);
}

type ClassifierFixture = { baseUrl: string; requests: Record<string, unknown>[]; close(): Promise<void> };

async function startClassifierFixture(): Promise<ClassifierFixture> {
  const requests: Record<string, unknown>[] = [];
  const answers = {
    outcome: { type: "choice", choice: "allow", probabilities: { allow: 0.99, deny: 0.01 }, confidence: 0.99 },
    risk: { type: "choice", choice: "low", probabilities: { low: 0.99, medium: 0.01, high: 0, critical: 0, unknown: 0 }, confidence: 0.99 },
    read_only: { type: "noul", noul: 0.99 },
    authorized: { type: "noul", noul: 0.01 },
  };
  const server: Server = createServer((incoming, response) => {
    void (async () => {
      if (incoming.method !== "POST" || incoming.url !== "/v1/systemone") {
        response.writeHead(404).end("not found");
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ answers, usage: { input_tokens: 12, output_tokens: 4 } }));
    })().catch(() => {
      try { response.writeHead(500).end("fixture error"); }
      catch { /* The SDK may already have disconnected. */ }
    });
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", () => listening.resolve());
  await listening.promise;
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Classifier fixture did not listen on TCP");
  const fixture: ClassifierFixture = {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
  cleanup.push(fixture.close);
  return fixture;
}

type CapturedClassifierCall = {
  request: ObservedLlmRequest;
  input: LlmCallInputSnapshot;
  response?: LlmCallResponseSnapshot;
  failure?: LlmCallResponseSnapshot;
};

describe("real LLM invocation capture", () => {
  it("persists the work and approval owner on an actual reviewer call, with its complete request and response", async () => {
    const { root, http, workspace } = await openSeededApiFixture({
      prefix: "emit-integration-llm-approval-",
      cleanups: cleanup,
      decide: approvalAnswer,
    });
    const workId = await sendWork(http.url, workspace.channelId, workspace.employeeIds[0]!, "INTEGRATION_LLM_APPROVAL");

    let approval: ApprovalDTO | undefined;
    await waitForFixture(async () => {
      const payload = await request<{ approvals: ApprovalDTO[] }>(http.url, "/api/approvals");
      approval = payload.body.approvals.find((item) => item.workId === workId && item.status === "pending-human");
      return approval !== undefined;
    }, "the reviewer call to produce a pending approval", 45_000);
    if (approval === undefined) throw new Error("The integration work did not create a pending approval");

    let reviewCall: LlmCallPageDTO["items"][number] | undefined;
    await waitForFixture(async () => {
      const page = await readWorkLlmCalls(http.runtime, workId);
      if (page === undefined) return false;
      reviewCall = page.items.find((call) => call.kind === "approval-llm" && call.approvalId === approval!.id && call.status === "returned");
      return reviewCall !== undefined;
    }, "the durable approval-model call", 30_000);
    if (reviewCall === undefined) throw new Error("The approval model call was not recorded");

    expect(reviewCall).toMatchObject({
      workId,
      employeeId: workspace.employeeIds[0],
      approvalId: approval.id,
      kind: "approval-llm",
      status: "returned",
      model: { providerId: "fake", modelId: "fake-reviewer" },
    });
    const detail = await readWorkLlmCall(http.runtime, workId, reviewCall.id);
    expect(detail).toBeDefined();
    expect(detail!.input.messages.length).toBeGreaterThan(0);
    const reviewInput = detail!.input.messages.flatMap((message) => message.content)
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    expect(reviewInput).toContain("INTEGRATION_LLM_APPROVAL");
    expect(reviewInput).toContain("integration-approval.txt");
    const reviewOutput = detail!.responses.flatMap((response) => response.content)
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    expect(reviewOutput).toContain("Integration approval review output.");
    expect(detail!.responses[0]?.type).toBe("response");

    const decision = await request<ApprovalDTO>(http.url, `/api/approvals/${approval.id}/decision`, json("POST", {
      decision: "rejected",
      comment: "Finish the integration fixture without applying the write.",
    }));
    expect(decision.status).toBe(200);
    await waitForFixture(async () => {
      const works = await request<WorkDTO[]>(http.url, "/api/works");
      return works.body.some((work) => work.id === workId && ["succeeded", "failed", "stopped"].includes(work.status));
    }, "the rejected approval work to finish", 30_000);
    expect(existsSync(join(root, "work", "integration-approval.txt"))).toBe(false);
  }, 60_000);

  it("classifies real approval context through the SDK observer as structured input and answers", async () => {
    const fixture = await startClassifierFixture();
    const credentials = new InMemoryCredentialStore();
    await credentials.modify("typesafe", async () => ({ type: "api_key", key: "local-classifier-fixture-key" }));
    const catalog = new ModelCatalog([], { credentials });
    const native = typesafeProvider();
    catalog.models.setProvider({
      ...native,
      getAllModels: () => native.getAllModels!().map((model) => ({ ...model, baseUrl: fixture.baseUrl })),
    } satisfies Provider);

    const captured: CapturedClassifierCall[] = [];
    const observer: LlmCallObserver = {
      begin(request) {
        const call: CapturedClassifierCall = { request, input: captureLlmCallInput(request) };
        captured.push(call);
        return {
          returned(response, source) { call.response = captureLlmCallResponse(response, source); },
          failed(error, source) { call.failure = captureLlmCallException(error, source); },
        };
      },
      deferredReturned() {},
      deferredFailed() {},
    };
    catalog.setLlmCallObserver(observer);

    const modelRef = { providerId: "typesafe", modelId: "jev-latest" };
    const model = catalog.classifierModel(modelRef);
    if (model === undefined) throw new Error("The TypeSafe fixture did not expose its classifier model");
    const evaluator = createClassifierEvaluator(catalog);
    const config: ApprovalEvaluatorConfig = { kind: "classifier", model: modelRef, criteriaVersion: 3 };
    const owner = {
      workId: "wk_classifier_integration",
      employeeId: "employee-classifier",
      conversationId: 23,
      approvalId: "approval_classifier_integration",
      kind: "approval-classifier" as const,
    };
    const outcome: EvaluationOutcome = await withLlmCallOwner(owner, () => evaluator.evaluate(
      classifierCase("classifier-integration"),
      config,
      { evaluationId: "evaluation-classifier-integration", contextWindow: model.contextWindow },
    ));

    expect(outcome.status).toBe("evaluated");
    if (outcome.status !== "evaluated") return;
    expect(outcome.outcome).toBe("allow");
    expect(fixture.requests).toHaveLength(1);
    expect(captured).toHaveLength(1);
    const call = captured[0]!;
    expect(call.request.method).toBe("classify");
    expect(call.request.owner).toEqual(owner);
    expect(call.input.input.classifier).toBeDefined();
    const classifierInput = call.input.input.classifier!;
    expect(jsonScalars(classifierInput.state)).toContain("INTEGRATION_CLASSIFIER_EXECUTION_CONTEXT");
    expect(jsonScalars(classifierInput.questions)).toContain("risk");
    expect(call.response?.response.type).toBe("response");
    expect(jsonScalars(call.response!.response.answers!)).toContain("allow");
    expect(call.failure).toBeUndefined();
  }, 30_000);
});
