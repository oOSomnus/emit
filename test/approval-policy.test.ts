/**
 * TypeSafe's native System One protocol, exercised through the real pi-ai
 * provider and Emit's classifier evaluator at a local HTTP boundary.
 */

import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  InMemoryCredentialStore,
  type Provider,
} from "@earendil-works/pi-ai";
import { typesafeProvider } from "@earendil-works/pi-ai/providers/typesafe";
import { ModelCatalog } from "../src/server/models.ts";
import { createClassifierEvaluator } from "../src/server/approval/evaluators.ts";
import { approvalVerdict } from "../src/server/approval/state.ts";
import type { ApprovalCase, ApprovalEvaluatorConfig, EvaluationOutcome } from "../src/server/approval/contracts.ts";

const PROVIDER_ID = "typesafe";
const MODEL_ID = "jev-latest";

type RecordedRequest = {
  url: string | undefined;
  authorization: string | undefined;
  body: Record<string, unknown>;
};

type Fixture = {
  baseUrl: string;
  requests: RecordedRequest[];
  setAnswers: (answers: Record<string, unknown>) => void;
};

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch {
      // A failed cleanup must not hide the assertion failure.
    }
  }
});

function readBody(request: NodeJS.ReadableStream): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk: string) => {
    body += chunk;
  });
  request.on("end", () => resolve(body));
  request.on("error", reject);
  return promise;
}

async function startFixture(initialAnswers: Record<string, unknown>): Promise<Fixture> {
  let answers = initialAnswers;
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((request, response) => {
    void (async () => {
      if (request.method !== "POST" || request.url !== "/v1/systemone") {
        response.writeHead(404).end("not found");
        return;
      }
      const raw = await readBody(request);
      const body = JSON.parse(raw.length > 0 ? raw : "{}") as Record<string, unknown>;
      requests.push({
        url: request.url,
        authorization: typeof request.headers.authorization === "string" ? request.headers.authorization : undefined,
        body,
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ answers, usage: { input_tokens: 12, output_tokens: 4 } }));
    })().catch(() => {
      try {
        response.writeHead(500).end("fixture error");
      } catch {
        // The client may already have disconnected.
      }
    });
  });

  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", () => listening.resolve());
  await listening.promise;
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture: no TCP port");
  cleanups.push(() => {
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    return closed.promise;
  });
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    setAnswers: (next) => {
      answers = next;
    },
  };
}

/** Keep TypeSafe's classifier implementation; only point its model URL at the fixture. */
function localTypesafeProvider(fixture: Fixture): Provider {
  const native = typesafeProvider();
  return {
    ...native,
    getAllModels: () => native.getAllModels!().map((model) => ({ ...model, baseUrl: fixture.baseUrl })),
  };
}

async function localCatalog(fixture: Fixture): Promise<ModelCatalog> {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(PROVIDER_ID, async () => ({ type: "api_key", key: "local-fixture-key" }));
  const catalog = new ModelCatalog([], { credentials });
  catalog.models.setProvider(localTypesafeProvider(fixture));
  return catalog;
}

function approvalCase(id: string): ApprovalCase {
  return {
    schemaVersion: 3,
    id,
    toolTaskId: `task-${id}`,
    employee: { id: "employee", name: "员工", role: "助手" },
    tool: { name: "run_shell", kind: "shell", description: "Run a shell command in the session directory." },
    argumentsPreview: '{"command":"ls"}',
    arguments: '{"command":"ls -la"}',
    cwd: "/tmp/session",
    directories: { roomId: "room-1", workContextId: "ctx-1", version: 1, paths: ["/tmp/session"], defaultPath: "/tmp/session" },
    targetPaths: [],
    allowedTools: ["run_shell"],
    userIntent: {
      text: "列出当前会话目录",
      source: "room-message",
      truncated: false,
      authorization: "user",
      author: { id: "user", name: "你", type: "user" },
    },
    recentContext: [],
    executionContext: [
      {
        source: "execution-context",
        role: "assistant",
        toolName: "run_shell",
        toolCallId: "call-1",
        text: "live execution context marker",
        truncated: false,
      },
    ],
    contextBudget: { omittedEntries: 0, truncatedEntries: 0 },
    origin: { kind: "room", description: "channel" },
    configVersion: 1,
    policyVersion: 1,
  };
}

const approvalConfig: ApprovalEvaluatorConfig = {
  kind: "classifier",
  model: { providerId: PROVIDER_ID, modelId: MODEL_ID },
  criteriaVersion: 3,
};
function evaluationContext(catalog: ModelCatalog, evaluationId: string) {
  const model = catalog.classifierModel({ providerId: PROVIDER_ID, modelId: MODEL_ID });
  if (model === undefined) throw new Error(`Missing classifier model ${MODEL_ID}`);
  return { evaluationId, contextWindow: model.contextWindow };
}

type AnswerOptions = {
  outcome?: string;
  risk?: string;
  outcomeProbabilities?: Record<string, number>;
  riskProbabilities?: Record<string, number>;
  readOnlyProbability?: number;
  authorizedProbability?: number;
  omit?: "outcome" | "risk" | "read_only" | "authorized";
};

function systemOneAnswers(options: AnswerOptions = {}): Record<string, unknown> {
  const answers: Record<string, unknown> = {};
  if (options.omit !== "outcome") {
    answers.outcome = {
      type: "choice",
      choice: options.outcome ?? "allow",
      probabilities: options.outcomeProbabilities ?? { allow: 0.99, deny: 0.01 },
      confidence: 0.99,
    };
  }
  if (options.omit !== "risk") {
    answers.risk = {
      type: "choice",
      choice: options.risk ?? "low",
      probabilities:
        options.riskProbabilities ?? { low: 0.99, medium: 0.01, high: 0, critical: 0, unknown: 0 },
      confidence: 0.99,
    };
  }
  if (options.omit !== "read_only") {
    answers.read_only = { type: "noul", noul: options.readOnlyProbability ?? 0.99 };
  }
  if (options.omit !== "authorized") {
    answers.authorized = { type: "noul", noul: options.authorizedProbability ?? 0.01 };
  }
  return answers;
}

function requireEvaluated(outcome: EvaluationOutcome): Extract<EvaluationOutcome, { status: "evaluated" }> {
  if (outcome.status !== "evaluated") throw new Error(`Expected evaluated result, received ${outcome.status}: ${outcome.message}`);
  return outcome;
}

describe("native TypeSafe classifier policy", () => {
  it("uses the native System One wire protocol and auto-approves low risk with low authorization evidence", async () => {
    const fixture = await startFixture(systemOneAnswers({ authorizedProbability: 0.01 }));
    const catalog = await localCatalog(fixture);
    const evaluator = createClassifierEvaluator(catalog);
    const result = await evaluator.evaluate(approvalCase("low"), approvalConfig, evaluationContext(catalog, "low"));

    expect(result.status).toBe("evaluated");
    if (result.status !== "evaluated") return;
    expect(result.outcome).toBe("allow");
    expect(result.risk).toBe("low");
    if (result.evidence.kind === "classifier") {
      expect(result.evidence).toMatchObject({
        outcomeProbability: 0.99,
        outcomeProbabilities: { allow: 0.99, deny: 0.01 },
        riskProbability: 0.99,
        riskProbabilities: { low: 0.99, medium: 0.01, high: 0, critical: 0, unknown: 0 },
        readOnly: true,
        readOnlyProbability: 0.99,
        authorized: false,
        authorizedProbability: 0.01,
      });
    }
    expect(approvalVerdict(result)).toEqual({ action: "approve" });

    const request = fixture.requests[0];
    expect(request?.url).toBe("/v1/systemone");
    expect(request?.authorization).toBe("Bearer local-fixture-key");
    expect(request?.body.model).toBe(MODEL_ID);
    const serializedState = JSON.stringify(request?.body.state ?? null);
    expect(serializedState).toContain("/tmp/session");
    expect(serializedState).toContain("Run a shell command in the session directory.");
    expect(serializedState).toContain("live execution context marker");
    expect(serializedState).toContain("ls");
    expect(serializedState).toContain("command");
    expect(serializedState).toContain("ls -la");
    const questions = request?.body.questions as Record<string, { type?: string }> | undefined;
    expect(questions?.outcome?.type).toBe("choice");
    expect(questions?.risk?.type).toBe("choice");
    expect(questions?.read_only?.type).toBe("noul");
    expect(questions?.authorized?.type).toBe("noul");
  }, 20_000);

  it("routes an actual high-risk classifier result to a human", async () => {
    const fixture = await startFixture(systemOneAnswers({
      risk: "high",
      riskProbabilities: { low: 0.01, medium: 0.01, high: 0.97, critical: 0.01, unknown: 0 },
    }));
    const catalog = await localCatalog(fixture);
    const result = await createClassifierEvaluator(catalog).evaluate(
      approvalCase("high"),
      approvalConfig,
      evaluationContext(catalog, "high"),
    );

    const evaluated = requireEvaluated(result);
    expect(evaluated.risk).toBe("high");
    expect(approvalVerdict(evaluated).action).toBe("human");
  }, 20_000);

  it("blocks unknown risk instead of converting it to a review recommendation", async () => {
    const fixture = await startFixture(systemOneAnswers({
      risk: "unknown",
      riskProbabilities: { low: 0, medium: 0, high: 0, critical: 0, unknown: 1 },
    }));
    const catalog = await localCatalog(fixture);
    const result = await createClassifierEvaluator(catalog).evaluate(
      approvalCase("unknown"),
      approvalConfig,
      evaluationContext(catalog, "unknown"),
    );

    const evaluated = requireEvaluated(result);
    expect(evaluated.risk).toBe("unknown");
    expect(approvalVerdict(evaluated).action).toBe("block");
  }, 20_000);

  it("blocks missing fields, illegal choices, and any malformed probability map values", async () => {
    const fixture = await startFixture(systemOneAnswers());
    const catalog = await localCatalog(fixture);
    const evaluator = createClassifierEvaluator(catalog);
    const cases: Array<{ id: string; answers: Record<string, unknown> }> = [
      { id: "missing-risk", answers: systemOneAnswers({ omit: "risk" }) },
      { id: "invalid-choice", answers: systemOneAnswers({ risk: "not-a-risk" }) },
      {
        id: "negative-probability",
        answers: systemOneAnswers({ riskProbabilities: { low: 0.99, medium: -0.01, high: 0, critical: 0, unknown: 0 } }),
      },
      {
        id: "over-one-probability",
        answers: systemOneAnswers({ riskProbabilities: { low: 0.99, medium: 1.01, high: 0, critical: 0, unknown: 0 } }),
      },
      {
        id: "nan-probability",
        answers: systemOneAnswers({ outcomeProbabilities: { allow: 0.99, deny: Number.NaN } }),
      },
      { id: "missing-native-bool", answers: systemOneAnswers({ omit: "read_only" }) },
    ];

    for (const { id, answers } of cases) {
      fixture.setAnswers(answers);
      const result = await evaluator.evaluate(approvalCase(id), approvalConfig, evaluationContext(catalog, id));
      expect(approvalVerdict(result).action, id).toBe("block");
      expect(result.status, id).toBe("unavailable");
      if (["invalid-choice", "negative-probability", "over-one-probability"].includes(id)) {
        expect(result).toMatchObject({ status: "unavailable", reason: "invalid-output" });
      }
    }
    expect(fixture.requests).toHaveLength(cases.length);
  }, 30_000);
});
