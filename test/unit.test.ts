/**
 * Consumer-visible invariants that need no provider and no harness.
 *
 * These cover the parts where a wrong answer is invisible in normal use: the
 * identity of an approval, which tool calls are allowed through, how arguments
 * are redacted before a model sees them, and whether a tool path can escape the
 * employee's working directory.
 */

import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  approvalId,
  canonicalJson,
  classifierAutoApproves,
  describeClassifierEvidence,
  llmAutoApproves,
  toApprovalDTO,
} from "../src/server/approval/state.ts";
import { redactArguments } from "../src/server/approval/evaluators.ts";
import { classifyTool, toThinkingLevel } from "../src/server/agents.ts";
import { buildPrompt, assistantText } from "../src/server/work.ts";
import { ModelCatalog } from "../src/server/models.ts";
import { resolveWithin } from "../src/server/tools.ts";
import { allocateAddress, slugify } from "../src/server/workspace.ts";
import { mailAddresses, mailEnvelope } from "../src/server/rooms.ts";
import type { ApprovalRecord, EmployeeRecord } from "../src/server/documents.ts";
import type { ApprovalRequest } from "../src/server/approval/state.ts";

function employee(overrides: Partial<EmployeeRecord> = {}): EmployeeRecord {
  return {
    id: "emp1",
    name: "小柯",
    address: "ke@ws.test",
    addressSource: "manual",
    role: "助手",
    instructions: "",
    executionModel: { providerId: "p", modelId: "m", effort: "off" },
    cwd: "/tmp",
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
    ...overrides,
  };
}

describe("approval identity", () => {
  it("is stable when the same arguments arrive in a different key order", () => {
    const left = approvalId(request({ arguments: { path: "a.txt", content: "hello" } }), 1, 1);
    const right = approvalId(request({ arguments: { content: "hello", path: "a.txt" } }), 1, 1);
    expect(left).toBe(right);
  });

  it("changes when the arguments, directory, or either version changes", () => {
    const base = approvalId(request(), 1, 1);
    expect(approvalId(request({ arguments: { path: "a.txt", content: "other" } }), 1, 1)).not.toBe(base);
    expect(approvalId(request({ cwd: "/tmp/other" }), 1, 1)).not.toBe(base);
    expect(approvalId(request(), 2, 1)).not.toBe(base);
    expect(approvalId(request(), 1, 2)).not.toBe(base);
  });

  it("separates two calls that differ only by task", () => {
    expect(approvalId(request(), 1, 1)).not.toBe(approvalId(request({ toolTaskId: "t2" }), 1, 1));
  });

  it("encodes equal values equally whatever their origin", () => {
    expect(canonicalJson({ b: 1, a: [1, { d: 2, c: 3 }] })).toBe(canonicalJson({ a: [1, { c: 3, d: 2 }], b: 1 }));
  });
});

describe("tool policy", () => {
  it("lets a listed built-in through and blocks an unlisted one", () => {
    const allowed = classifyTool(employee(), "write_file");
    expect(allowed).toEqual({ risk: "gated", kind: "file-write" });
    expect(classifyTool(employee({ allowedTools: [] }), "write_file")).toHaveProperty("blocked");
  });

  it("always allows the collaboration tools", () => {
    expect(classifyTool(employee({ allowedTools: [] }), "send_message")).toEqual({ risk: "safe" });
    expect(classifyTool(employee({ allowedTools: [] }), "delegate_task")).toEqual({ risk: "safe" });
  });

  it("treats an MCP tool as gated until the employee trusts that exact reference", () => {
    const gated = employee({ mcpServerIds: ["srv"], trustedReadOnlyTools: [] });
    expect(classifyTool(gated, "mcp__srv__search")).toEqual({ risk: "gated", kind: "mcp" });
    const trusted = employee({ mcpServerIds: ["srv"], trustedReadOnlyTools: ["srv/search"] });
    expect(classifyTool(trusted, "mcp__srv__search")).toEqual({ risk: "safe" });
  });

  it("blocks a tool it cannot classify", () => {
    expect(classifyTool(employee(), "rm_rf")).toHaveProperty("blocked");
  });
});

describe("argument redaction", () => {
  it("hides credential-looking fields and keeps the rest", () => {
    const rendered = redactArguments({ path: "a.txt", apiKey: "sk-live-123", nested: { Authorization: "Bearer x" } });
    expect(rendered).toContain("a.txt");
    expect(rendered).not.toContain("sk-live-123");
    expect(rendered).not.toContain("Bearer x");
    expect(rendered).toContain("已隐去");
  });
});

describe("prompt assembly", () => {
  it("carries the room history and then the request", () => {
    const prompt = buildPrompt(
      [
        {
          id: "1",
          roomId: "r",
          author: { type: "user", id: "user", name: "你" },
          body: "先看看设计稿",
          createdAt: 0,
        },
      ],
      "现在实现它",
      "message",
    );
    expect(prompt).toContain("先看看设计稿");
    expect(prompt).toContain("现在实现它");
    expect(prompt.indexOf("先看看设计稿")).toBeLessThan(prompt.indexOf("现在实现它"));
  });

  it("labels a delegated task as a handoff", () => {
    expect(buildPrompt([], "把报表发我", "delegation")).toContain("交办");
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

  it("accepts a path inside the working directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "emit-paths-"));
    const env = new NodeExecutionEnv({ cwd: root });
    const resolved = await resolveWithin(env, context, "notes.txt", [root]);
    expect(resolved.ok).toBe(true);
  });

  it("rejects a relative escape and an absolute path outside", async () => {
    const root = mkdtempSync(join(tmpdir(), "emit-paths-"));
    const env = new NodeExecutionEnv({ cwd: root });
    const relative = await resolveWithin(env, context, "../outside.txt", [root]);
    expect(relative.ok).toBe(false);
    const absolute = await resolveWithin(env, context, "/etc/passwd", [root]);
    expect(absolute.ok).toBe(false);
  });

  it("rejects a symlink that points outside the working directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "emit-paths-"));
    const outside = mkdtempSync(join(tmpdir(), "emit-outside-"));
    writeFileSync(join(outside, "secret.txt"), "top secret");
    mkdirSync(join(root, "sub"));
    symlinkSync(join(outside, "secret.txt"), join(root, "sub", "link.txt"));
    const env = new NodeExecutionEnv({ cwd: root });
    const resolved = await resolveWithin(env, context, "sub/link.txt", [root]);
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
    expect(problem).toContain("不支持");
    expect(problem).toContain("off");
  });

  it("rejects a model the catalog cannot resolve, and an empty selection", () => {
    expect(catalog.chatSelectionProblem({ providerId: "local-test", modelId: "gone", effort: "off" })).toContain("找不到");
    expect(catalog.chatSelectionProblem({ providerId: "local-test", modelId: "gone", effort: "off" })).toContain("gone");
    expect(catalog.chatSelectionProblem({ providerId: "", modelId: "", effort: "off" })).toContain("请选择");
  });

  it("keeps a chat model out of the classifier slot", () => {
    expect(
      catalog.approvalProblem({ kind: "llm", providerId: "local-test", modelId: "plain", effort: "off" }),
    ).toBeUndefined();
    expect(
      catalog.approvalProblem({ kind: "llm", providerId: "local-test", modelId: "plain", effort: "high" }),
    ).toContain("不支持");
    expect(
      catalog.approvalProblem({ kind: "classifier", providerId: "local-test", modelId: "plain", effort: "off" }),
    ).toContain("分类模型");
  });
});

describe("auto-approval thresholds", () => {
  it("lets low-risk readonly LLM decisions through without per-argument authorization", () => {
    expect(
      llmAutoApproves({
        recommendation: "approve",
        risk: "low",
        readOnly: true,
        userAuthorization: "unknown",
      }),
    ).toBe(true);
    expect(
      llmAutoApproves({
        recommendation: "approve",
        risk: "high",
        readOnly: true,
        userAuthorization: "low",
      }),
    ).toBe(false);
    expect(
      llmAutoApproves({
        recommendation: "deny",
        risk: "low",
        readOnly: true,
        userAuthorization: "unknown",
      }),
    ).toBe(false);
    expect(
      llmAutoApproves({
        recommendation: "approve",
        risk: "unknown",
        readOnly: false,
        userAuthorization: "high",
      }),
    ).toBe(true);
    expect(
      llmAutoApproves({
        recommendation: "approve",
        risk: "high",
        readOnly: false,
        userAuthorization: "high",
      }),
    ).toBe(false);
    expect(
      llmAutoApproves({
        recommendation: "approve",
        risk: "medium",
        readOnly: true,
        userAuthorization: "unknown",
      }),
    ).toBe(true);
  });

  it("allows low-risk readonly classifier decisions at both inclusive thresholds without authorization", () => {
    const config = { minApproveProbability: 0.9, minAuthorizedProbability: 0.8, requireAuthorized: true };
    expect(
      classifierAutoApproves(
        { choice: "approve", probability: 0.9, readOnlyProbability: 0.9, authorizedProbability: 0.1 },
        config,
      ),
    ).toBe(true);
    expect(
      classifierAutoApproves(
        { choice: "approve", probability: 0.8999, readOnlyProbability: 0.99, authorizedProbability: 0.99 },
        config,
      ),
    ).toBe(false);
    expect(
      classifierAutoApproves(
        { choice: "approve", probability: 0.99, readOnlyProbability: 0.8999, authorizedProbability: 0.99 },
        config,
      ),
    ).toBe(true);
    expect(
      classifierAutoApproves(
        { choice: "approve", probability: 0.99, readOnlyProbability: 0.99, authorizedProbability: 0.99 },
        config,
      ),
    ).toBe(true);
  });

  it("never lets readonly probability override a deny decision", () => {
    expect(
      classifierAutoApproves(
        { choice: "deny", probability: 0.99, readOnlyProbability: 0.99, authorizedProbability: 0.99 },
        { minApproveProbability: 0.5, minAuthorizedProbability: 0.5, requireAuthorized: false },
      ),
    ).toBe(false);
  });

  it("does not let missing or invalid probabilities pass either classifier branch", () => {
    const config = { minApproveProbability: 0.5, minAuthorizedProbability: 0.5, requireAuthorized: true };
    expect(
      classifierAutoApproves({ choice: "approve", probability: Number.NaN, readOnlyProbability: 0.99 }, config),
    ).toBe(false);
    expect(classifierAutoApproves({ choice: "approve", probability: 0.99 }, config)).toBe(false);
    expect(
      classifierAutoApproves({ choice: "approve", probability: 0.99, readOnlyProbability: Number.NaN }, config),
    ).toBe(false);
    expect(
      classifierAutoApproves({ choice: "approve", probability: 1.01, readOnlyProbability: 0.99 }, config),
    ).toBe(false);
    expect(
      classifierAutoApproves({ choice: "approve", probability: 0.99, readOnlyProbability: -0.01 }, config),
    ).toBe(false);
    expect(
      classifierAutoApproves(
        { choice: "approve", probability: 0.99, readOnlyProbability: 0.1, authorizedProbability: Number.NaN },
        config,
      ),
    ).toBe(false);
  });

  it("keeps authorization thresholds for non-readonly classifier calls", () => {
    const config = { minApproveProbability: 0.5, minAuthorizedProbability: 0.8, requireAuthorized: true };
    expect(
      classifierAutoApproves(
        { choice: "approve", probability: 0.99, readOnlyProbability: 0.1, authorizedProbability: 0.8 },
        config,
      ),
    ).toBe(true);
    expect(
      classifierAutoApproves(
        { choice: "approve", probability: 0.99, readOnlyProbability: 0.1, authorizedProbability: 0.7999 },
        config,
      ),
    ).toBe(false);
    expect(
      classifierAutoApproves(
        { choice: "approve", probability: 0.99, readOnlyProbability: 0.1 },
        config,
      ),
    ).toBe(false);
    expect(
      classifierAutoApproves(
        { choice: "approve", probability: 0.99, readOnlyProbability: 0.1 },
        { ...config, requireAuthorized: false },
      ),
    ).toBe(true);
  });
  it("describes legacy classifier evidence without inventing missing probabilities", () => {
    expect(describeClassifierEvidence({ choice: "review", probability: 0.4 })).toBe(
      "分类器选择 review（概率 0.4000，只读概率 未记录，授权概率 未记录）",
    );
  });


  it("keeps legacy evidence renderable without guessing readonly or authorization", () => {
    const legacy: ApprovalRecord = {
      id: "legacy",
      toolTaskId: "task",
      workId: "",
      rootWorkId: "",
      employeeId: "employee",
      employeeName: "员工",
      toolName: "run_shell",
      argsHash: "",
      argumentsPreview: "{}",
      cwd: "/tmp",
      risk: "unknown",
      status: "pending-human",
      executionState: "not-started",
      executionDetail: "",
      createdAt: 1,
      updatedAt: 1,
      decidedAt: 0,
      decidedBy: "",
      comment: "",
      autoDecisionSource: "",
      autoDecisionReason: "",
      evidence: {
        kind: "classifier",
        criteriaVersion: 1,
        choice: "approve",
        questions: "{}",
        probability: 0.9,
        authorizedProbability: null,
      },
      originKind: "room",
      originRoomId: "room",
      originRoomName: "会话",
      originEntryId: "1",
      originParentWorkId: "",
      configVersion: 1,
      policyVersion: 1,
      timeline: [],
    };
    const dto = toApprovalDTO(legacy);
    expect(dto.evidence?.kind).toBe("classifier");
    if (dto.evidence?.kind === "classifier") {
      expect(dto.evidence.readOnlyProbability).toBeUndefined();
      expect(dto.evidence.authorizedProbability).toBeUndefined();
    }
    const legacyLlm: ApprovalRecord = {
      ...legacy,
      id: "legacy-llm",
      evidence: { kind: "llm", rationale: "旧依据", risk: "low", recommendation: "approve" },
    };
    const llmDto = toApprovalDTO(legacyLlm);
    expect(llmDto.evidence?.kind).toBe("llm");
    if (llmDto.evidence?.kind === "llm") {
      expect(llmDto.evidence.criteriaVersion).toBeUndefined();
      expect(llmDto.evidence.readOnly).toBeUndefined();
      expect(llmDto.evidence.userAuthorization).toBeUndefined();
    }
  });
});
