/**
 * Consumer-visible invariants that need no provider and no harness.
 *
 * These cover approval identity, action policy, argument redaction, and whether
 * a tool path can escape the session's authorized directories.
 */

import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  approvalId,
  approvalVerdict,
  canonicalJson,
} from "../src/server/approval/state.ts";
import { redactArguments } from "../src/server/approval/evaluators.ts";
import { classifyTool, toThinkingLevel } from "../src/server/agents.ts";
import { assistantText } from "../src/server/work.ts";
import { ModelCatalog } from "../src/server/models.ts";
import { resolveWithin } from "../src/server/work-directories.ts";
import { allocateAddress, slugify } from "../src/server/workspace.ts";
import { mailAddresses, mailEnvelope } from "../src/server/rooms.ts";
import type { EmployeeRecord } from "../src/server/documents.ts";
import type { ApprovalRequest } from "../src/server/approval/state.ts";
import type { EvaluationOutcome } from "../src/server/approval/contracts.ts";

function employee(overrides: Partial<EmployeeRecord> = {}): EmployeeRecord {
  return {
    id: "emp1",
    name: "小柯",
    address: "ke@ws.test",
    addressSource: "manual",
    role: "助手",
    instructions: "",
    executionModel: { providerId: "p", modelId: "m", effort: "off" },
    skillIds: [],
    mcpServerIds: [],
    allowedTools: ["read_file", "write_file"],
    trustedReadOnlyTools: [],
    enabled: true,
    configVersion: 1,
    createdAt: 0,
    ...overrides,
  };
}

function request(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    toolTaskId: "t1",
    employeeId: "emp1",
    employeeName: "小柯",
    toolName: "write_file",
    toolKind: "file-write",
    arguments: { path: "a.txt", content: "hello" },
    cwd: "/tmp",
    directoryWorkContextId: "ctx-1",
    directoryRoomId: "room1",
    directoryVersion: 1,
    directoryPaths: ["/tmp"],
    targetPaths: ["/tmp/a.txt"],
    ...overrides,
  };
}

function evaluated(
  outcome: "allow" | "deny",
  risk: "low" | "medium" | "high" | "critical" | "unknown",
  userAuthorization: "high" | "medium" | "low" | "unknown" = "unknown",
): EvaluationOutcome {
  return {
    status: "evaluated",
    outcome,
    risk,
    evidence: {
      kind: "llm",
      criteriaVersion: 3,
      outcome,
      risk,
      rationale: "fixture evidence",
      readOnly: risk === "low",
      userAuthorization,
    },
    model: { providerId: "reviewer", modelId: "test" },
  };
}

describe("approval identity", () => {
  it("is stable when the same arguments arrive in a different key order", () => {
    const left = approvalId(request({ arguments: { path: "a.txt", content: "hello" } }), 1, 1);
    const right = approvalId(request({ arguments: { content: "hello", path: "a.txt" } }), 1, 1);
    expect(left).toBe(right);
  });

  it.each([
    ["task identity", request({ toolTaskId: "t2" }), 1, 1],
    ["employee identity", request({ employeeId: "emp2" }), 1, 1],
    ["tool identity", request({ toolName: "edit_file" }), 1, 1],
    ["arguments", request({ arguments: { path: "a.txt", content: "other" } }), 1, 1],
    ["working directory", request({ cwd: "/tmp/other" }), 1, 1],
    ["work context", request({ directoryWorkContextId: "ctx-2" }), 1, 1],
    ["room", request({ directoryRoomId: "room2" }), 1, 1],
    ["directory version", request({ directoryVersion: 2 }), 1, 1],
    ["directory snapshot", request({ directoryPaths: ["/tmp", "/var/tmp"] }), 1, 1],
    ["target paths", request({ targetPaths: ["/tmp/other.txt"] }), 1, 1],
    ["employee configuration version", request(), 2, 1],
    ["approval policy version", request(), 1, 2],
  ] as const)("changes when %s changes", (_field, changed, configVersion, policyVersion) => {
    expect(approvalId(changed, configVersion, policyVersion)).not.toBe(approvalId(request(), 1, 1));
  });

  it("preserves array order as part of an approval's action identity", () => {
    const forward = approvalId(request({ arguments: { sequence: ["first", "second"] } }), 1, 1);
    const reversed = approvalId(request({ arguments: { sequence: ["second", "first"] } }), 1, 1);
    expect(reversed).not.toBe(forward);
  });


  it("encodes equal values equally whatever their origin", () => {
    expect(canonicalJson({ b: 1, a: [1, { d: 2, c: 3 }] })).toBe(canonicalJson({ a: [1, { c: 3, d: 2 }], b: 1 }));
  });
});


describe("tool policy", () => {
  it("lets a listed built-in through and blocks an unlisted one", () => {
    const allowed = classifyTool(employee(), "write_file", undefined);
    expect(allowed).toEqual({ risk: "gated", kind: "file-write" });
    expect(classifyTool(employee({ allowedTools: [] }), "write_file", undefined)).toHaveProperty("blocked");
  });

  it("always allows the collaboration tools", () => {
    expect(classifyTool(employee({ allowedTools: [] }), "send_message", undefined)).toEqual({ risk: "safe" });
    expect(classifyTool(employee({ allowedTools: [] }), "delegate_task", undefined)).toEqual({ risk: "safe" });
  });

  it("blocks a tool it cannot classify", () => {
    expect(classifyTool(employee(), "rm_rf", undefined)).toHaveProperty("blocked");
    // MCP trust is a binding fact: without one, even a bound server's tool stays unknown.
    expect(classifyTool(employee({ mcpServerIds: ["srv"] }), "mcp__srv__search", undefined)).toHaveProperty("blocked");
  });
});

describe("argument redaction", () => {
  it("removes nested credential canaries while preserving ordinary arguments", () => {
    const rendered = redactArguments({
      path: "notes.txt",
      apiKey: "fixture-api-key-canary",
      nested: {
        Authorization: "Bearer fixture-bearer-canary",
        password: "fixture-password-canary",
        details: "token: fixture-inline-canary",
        note: "keep this explanatory text",
      },
    });
    expect(rendered).toContain("notes.txt");
    expect(rendered).toContain("keep this explanatory text");
    expect(rendered).not.toContain("fixture-api-key-canary");
    expect(rendered).not.toContain("fixture-bearer-canary");
    expect(rendered).not.toContain("fixture-password-canary");
    expect(rendered).not.toContain("fixture-inline-canary");
  });
});


describe("answer extraction", () => {
  it("keeps only the text parts of a final answer", () => {
    const text = assistantText({
      role: "assistant",
      api: "openai-completions",
      provider: "p",
      model: "m",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      content: [
        { type: "thinking", thinking: "想一想" },
        { type: "text", text: "第一段" },
        { type: "text", text: "第二段" },
      ],
    } as never);
    expect(text).toBe("第一段\n第二段");
  });
});

describe("thinking level mapping", () => {
  it("passes through a supported level and falls back to off", () => {
    expect(toThinkingLevel("high")).toBe("high");
    expect(toThinkingLevel("dangerously-high")).toBe("off");
    expect(toThinkingLevel("")).toBe("off");
  });
});

describe("mailbox addresses", () => {
  it("keeps a name in any alphabet as the local part", () => {
    expect(slugify("小柯")).toBe("小柯");
    expect(slugify("Alice Zhang")).toBe("alice-zhang");
    expect(slugify("  ")).toBe("workspace");
  });

  it("gives colliding names distinct addresses", () => {
    const taken = new Set(["小柯@ws.test"]);
    expect(allocateAddress(slugify("小柯"), "ws.test", taken)).toBe("小柯2@ws.test");
    expect(allocateAddress(slugify("小柯"), "ws.test", new Set())).toBe("小柯@ws.test");
  });

  it("will not hand a reserved local part to anybody", () => {
    expect(allocateAddress("postmaster", "ws.test", new Set())).toBe("employee@ws.test");
  });

  it("counts a mail as the user's when they are only copied in", () => {
    const envelope = mailEnvelope({
      subject: "s",
      to: [{ name: "小柯", address: "ke@ws.test" }],
      cc: [{ name: "我", address: "me@ws.test" }],
    });
    expect(mailAddresses(envelope, "me@ws.test")).toBe(true);
    expect(mailAddresses(envelope, "other@ws.test")).toBe(false);
    expect(mailAddresses(envelope, "")).toBe(false);
  });
});

describe("path containment", () => {
  const context = BACKGROUND_CONTEXT;

  it("accepts a path inside an authorized root", async () => {
    const root = mkdtempSync(join(tmpdir(), "emit-paths-"));
    const env = new NodeExecutionEnv({ cwd: root });
    const resolved = await resolveWithin(env, context, "notes.txt", [root], root);
    expect(resolved.ok).toBe(true);
  });

  it("accepts an absolute target inside an authorized root without a default directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "emit-paths-"));
    const env = new NodeExecutionEnv({ cwd: root });
    const target = join(root, "notes.txt");
    const resolved = await resolveWithin(env, context, target, [root], "");
    expect(resolved).toMatchObject({ ok: true, path: target });
  });

  it("rejects a relative escape and an absolute path outside every authorized root", async () => {
    const root = mkdtempSync(join(tmpdir(), "emit-paths-"));
    const env = new NodeExecutionEnv({ cwd: root });
    const relative = await resolveWithin(env, context, "../outside.txt", [root], root);
    expect(relative).toMatchObject({
      ok: false,
      message: expect.stringContaining("is outside the directories allowed for this conversation"),
    });
    expect(relative.ok).toBe(false);
    const outside = join(mkdtempSync(join(tmpdir(), "emit-outside-")), "sentinel.txt");
    writeFileSync(outside, "private outside sentinel");
    const absolute = await resolveWithin(env, context, outside, [root], root);
    expect(absolute.ok).toBe(false);
  });

  it("accepts a target inside any one of multiple authorized roots", async () => {
    const first = mkdtempSync(join(tmpdir(), "emit-paths-a-"));
    const second = mkdtempSync(join(tmpdir(), "emit-paths-b-"));
    const env = new NodeExecutionEnv({ cwd: first });
    const resolved = await resolveWithin(env, context, "notes.txt", [first, second], second);
    expect(resolved).toMatchObject({ ok: true, path: join(second, "notes.txt") });
  });

  it("rejects relative targets when the session has no default directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "emit-paths-"));
    const env = new NodeExecutionEnv({ cwd: root });
    const resolved = await resolveWithin(env, context, "notes.txt", [], "");
    expect(resolved.ok).toBe(false);
  });

  it("rejects a symlink that points outside the authorized roots", async () => {
    const root = mkdtempSync(join(tmpdir(), "emit-paths-"));
    const outside = mkdtempSync(join(tmpdir(), "emit-outside-"));
    writeFileSync(join(outside, "secret.txt"), "top secret");
    mkdirSync(join(root, "sub"));
    symlinkSync(join(outside, "secret.txt"), join(root, "sub", "link.txt"));
    const env = new NodeExecutionEnv({ cwd: root });
    const resolved = await resolveWithin(env, context, "sub/link.txt", [root], root);
    expect(resolved.ok).toBe(false);
  });
});

describe("employee model selection", () => {
  const catalog = new ModelCatalog([
    {
      id: "local-test",
      name: "Local Test",
      baseUrl: "http://127.0.0.1:1/v1",
      api: "openai-completions",
      apiKeyEnv: "",
      models: [
        { id: "reasoner", name: "Reasoner", contextWindow: 128000, maxTokens: 4096, reasoning: true, input: ["text"] },
        { id: "plain", name: "Plain", contextWindow: 128000, maxTokens: 4096, reasoning: false, input: ["text"] },
      ],
    },
  ]);

  it("accepts a chat model at an effort it supports", () => {
    expect(catalog.chatSelectionProblem({ providerId: "local-test", modelId: "reasoner", effort: "high" })).toBeUndefined();
    expect(catalog.chatSelectionProblem({ providerId: "local-test", modelId: "plain", effort: "off" })).toBeUndefined();
  });

  it("rejects an effort the model cannot reason with, naming the choices", () => {
    const problem = catalog.chatSelectionProblem({ providerId: "local-test", modelId: "plain", effort: "high" });
    expect(problem?.text).toContain("high");
    expect(problem?.text).toContain("off");
  });

  it("rejects a model the catalog cannot resolve, and an empty selection", () => {
    expect(catalog.chatSelectionProblem({ providerId: "local-test", modelId: "gone", effort: "off" })?.text).toContain("gone");
    expect(catalog.chatSelectionProblem({ providerId: "", modelId: "", effort: "off" })).toBeDefined();
  });

  it("keeps a chat model out of the classifier slot", () => {
    expect(
      catalog.approvalProblem({ kind: "llm", providerId: "local-test", modelId: "plain", effort: "off" }),
    ).toBeUndefined();
    expect(
      catalog.approvalProblem({ kind: "llm", providerId: "local-test", modelId: "plain", effort: "high" }),
    ).toBeDefined();
    expect(
      catalog.approvalProblem({ kind: "classifier", providerId: "local-test", modelId: "plain", effort: "off" }),
    ).toBeDefined();
  });
});

describe("automatic approval verdict", () => {
  it("approves low-readonly and medium-write calls without requiring strong authorization evidence", () => {
    expect(approvalVerdict(evaluated("allow", "low")).action).toBe("approve");
    expect(approvalVerdict(evaluated("allow", "medium", "low")).action).toBe("approve");
  });

  it("routes high risk to a human reviewer", () => {
    expect(approvalVerdict(evaluated("allow", "high")).action).toBe("human");
  });

  it("rejects explicit denies and critical risk", () => {
    expect(approvalVerdict(evaluated("deny", "low")).action).toBe("reject");
    expect(approvalVerdict(evaluated("allow", "critical")).action).toBe("reject");
  });

  it("blocks unknown risk and unavailable evaluations", () => {
    expect(approvalVerdict(evaluated("allow", "unknown")).action).toBe("block");
    expect(
      approvalVerdict({
        status: "unavailable",
        reason: "provider",
        message: "reviewer unavailable",
      }).action,
    ).toBe("block");
  });
});
