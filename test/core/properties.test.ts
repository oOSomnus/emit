import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import * as fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import { classifyTool } from "../../src/server/agents.ts";
import { approvalId, approvalVerdict, canonicalJson, type ApprovalRequest } from "../../src/server/approval/state.ts";
import { redactApprovalText, redactArguments } from "../../src/server/approval/evaluators.ts";
import type { EvaluationOutcome } from "../../src/server/approval/contracts.ts";
import type { EmployeeRecord } from "../../src/server/documents.ts";
import { assistantText } from "../../src/server/work.ts";
import { resolveWithin } from "../../src/server/work-directories.ts";
import { allocateAddress, slugify } from "../../src/server/workspace.ts";
import { MessageAddressingError, resolveMessageAddressing, type AddressableMember } from "../../src/shared/message-addressing.ts";
import { formatText, resolveLocale, type Locale } from "../../src/shared/i18n.ts";
import type { WorkExecutionStepDTO } from "../../src/shared/contracts.ts";
import { mergeExecutionSteps } from "../../src/web/execution-steps.ts";
import { loadTestSettings } from "../helpers/test-settings.ts";

const settings = loadTestSettings();
const propertyOptions = () => ({
  seed: settings.seed,
  numRuns: settings.propertyRuns,
  ...(settings.path === undefined ? {} : { path: settings.path }),
});

function employee(overrides: Partial<EmployeeRecord> = {}): EmployeeRecord {
  return {
    id: "employee-a",
    name: "Employee A",
    address: "employee-a@workspace.test",
    addressSource: "manual",
    role: "assistant",
    instructions: "",
    executionModel: { providerId: "fixture", modelId: "chat", effort: "off" },
    skillIds: [],
    mcpServerIds: [],
    allowedTools: ["write_file"],
    trustedReadOnlyTools: [],
    enabled: true,
    configVersion: 1,
    createdAt: 0,
    ...overrides,
  };
}

function approvalRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    toolTaskId: "task-a",
    employeeId: "employee-a",
    employeeName: "Employee A",
    toolName: "write_file",
    toolKind: "file-write",
    arguments: { path: "notes.txt", content: "fixture" },
    cwd: "/private/work",
    directoryWorkContextId: "work-context-a",
    directoryRoomId: "room-a",
    directoryVersion: 1,
    directoryPaths: ["/private/work"],
    targetPaths: ["/private/work/notes.txt"],
    ...overrides,
  };
}

function evaluation(outcome: "allow" | "deny", risk: "low" | "medium" | "high" | "critical" | "unknown"): EvaluationOutcome {
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
      userAuthorization: "unknown",
    },
    model: { providerId: "fixture", modelId: "reviewer" },
  };
}

function assistantMessage(content: readonly unknown[]) {
  return {
    role: "assistant",
    api: "openai-completions",
    provider: "fixture",
    model: "chat",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    content,
  } as never;
}

function step(id: string, text: string, extra: Partial<WorkExecutionStepDTO> = {}): WorkExecutionStepDTO {
  return { id, entryId: `entry-${id}`, kind: "input", text, ...extra };
}

const filesystemRoot = mkdtempSync(join(tmpdir(), "emit-core-properties-"));
const authorizedRoot = join(filesystemRoot, "work");
const samePrefixSibling = `${authorizedRoot}-sibling`;
mkdirSync(authorizedRoot);
mkdirSync(samePrefixSibling);
writeFileSync(join(samePrefixSibling, "sentinel.txt"), "private outside sentinel");
const executionEnv = new NodeExecutionEnv({ cwd: authorizedRoot });
afterAll(() => rmSync(filesystemRoot, { recursive: true, force: true }));

describe("L1 fixed oracle examples", () => {
  it("canonicalizes nested object key order but preserves array order", () => {
    const left = { outer: { second: [1, { z: "last", a: "first" }], first: true } };
    const reordered = { outer: { first: true, second: [1, { a: "first", z: "last" }] } };
    expect(canonicalJson(left)).toBe(canonicalJson(reordered));
    expect(canonicalJson({ values: ["first", "second"] })).not.toBe(canonicalJson({ values: ["second", "first"] }));

    const forward = approvalId(approvalRequest({ arguments: { values: ["first", "second"] } }), 1, 1);
    const reverse = approvalId(approvalRequest({ arguments: { values: ["second", "first"] } }), 1, 1);
    expect(reverse).not.toBe(forward);
  });

  it.each([
    ["allow", "low", "approve"],
    ["allow", "medium", "approve"],
    ["allow", "high", "human"],
    ["allow", "critical", "reject"],
    ["allow", "unknown", "block"],
    ["deny", "low", "reject"],
    ["deny", "medium", "reject"],
    ["deny", "high", "reject"],
    ["deny", "critical", "reject"],
    ["deny", "unknown", "reject"],
  ] as const)("maps %s with %s risk to %s", (outcome, risk, expected) => {
    expect(approvalVerdict(evaluation(outcome, risk)).action).toBe(expected);
  });

  it.each([
    ["read_file", { risk: "safe" }],
    ["load_skill", { risk: "safe" }],
    ["list_employees", { risk: "safe" }],
    ["write_file", { risk: "gated", kind: "file-write" }],
    ["edit_file", { risk: "gated", kind: "file-write" }],
    ["run_shell", { risk: "gated", kind: "shell" }],
  ] as const)("classifies explicitly allowed built-in %s", (toolName, expected) => {
    expect(classifyTool(employee({ allowedTools: [toolName] }), toolName)).toEqual(expected);
    expect(classifyTool(employee({ allowedTools: [] }), toolName)).toHaveProperty("blocked");
  });

  it("blocks unavailable evaluations and requires the exact bound MCP reference for trust", () => {
    expect(approvalVerdict({ status: "unavailable", reason: "provider", message: "fixture unavailable" }).action).toBe("block");

    const bound = employee({ mcpServerIds: ["fixture-server"], trustedReadOnlyTools: ["fixture-server/search"] });
    expect(classifyTool(bound, "mcp__fixture-server__search")).toEqual({ risk: "safe" });
    expect(classifyTool(bound, "mcp__fixture-server__mutate")).toEqual({ risk: "gated", kind: "mcp" });
    expect(classifyTool(bound, "mcp__other-server__search")).toEqual({ risk: "gated", kind: "mcp" });
    expect(classifyTool(employee({ trustedReadOnlyTools: ["fixture-server/search"] }), "mcp__fixture-server__search"))
      .toEqual({ risk: "gated", kind: "mcp" });
    expect(classifyTool(employee(), "unknown_fixture_tool")).toHaveProperty("blocked");
  });

  it("redacts nested credential canaries and extracts text without thinking", () => {
    const redacted = redactArguments({
      path: "notes.txt",
      nested: {
        apiKey: "fixture-api-key-canary",
        authorization: "Bearer fixture-token-canary",
        ordinary: "preserved note",
      },
    });
    expect(redacted).toContain("notes.txt");
    expect(redacted).toContain("preserved note");
    expect(redacted).not.toContain("fixture-api-key-canary");
    expect(redacted).not.toContain("fixture-token-canary");
    expect(redactApprovalText("token=fixture-inline-canary; visible=value")).not.toContain("fixture-inline-canary");

    expect(assistantText(assistantMessage([
      { type: "thinking", thinking: "private thinking canary" },
      { type: "text", text: "" },
      { type: "text", text: "first visible answer" },
      { type: "thinking", thinking: "another private thought" },
      { type: "text", text: "second visible answer" },
    ]))).toBe("first visible answer\nsecond visible answer");
  });

  it("keeps Unicode slugs and allocates past occupied address suffixes", () => {
    expect(slugify("Alice Zhang")).toBe("alice-zhang");
    expect(slugify("小柯")).toBe("小柯");
    expect(slugify("   ")).toBe("workspace");
    expect(allocateAddress("postmaster", "workspace.test", new Set())).toBe("employee@workspace.test");
    expect(allocateAddress("ada", "workspace.test", new Set([
      "ada@workspace.test",
      "ada2@workspace.test",
      "ada3@workspace.test",
    ]))).toBe("ada4@workspace.test");
  });

  it("follows the first non-empty locale preference and preserves original content", () => {
    expect(resolveLocale("system", ["", "zh-TW", "en-US"])).toBe("zh-CN");
    expect(resolveLocale("system", ["en-US", "zh-CN"])).toBe("en");
    expect(resolveLocale("zh-CN", ["en-US"])).toBe("zh-CN");
    for (const locale of ["en", "zh-CN"] as const) {
      expect(formatText("user supplied text", locale)).toBe("user supplied text");
      expect(formatText("model answer with canary", locale)).toBe("model answer with canary");
      expect(formatText("third-party output", locale)).toBe("third-party output");
    }
  });

  it("merges overlapping live and older pages without dropping or moving existing IDs", () => {
    const current = [step("one", "old one"), step("two", "old two")];
    const newer = [step("two", "updated two", { taskStatus: "terminal", taskError: "fixture failure" }), step("three", "new three")];
    const refreshed = mergeExecutionSteps(current, newer, "newer");
    expect(refreshed.map(({ id }) => id)).toEqual(["one", "two", "three"]);
    expect(refreshed[1]).toEqual(newer[0]);

    const withHistory = mergeExecutionSteps(refreshed, [step("zero", "old zero"), step("one", "history overlap")], "older");
    expect(withHistory.map(({ id }) => id)).toEqual(["zero", "one", "two", "three"]);
    expect(new Set(withHistory.map(({ id }) => id)).size).toBe(withHistory.length);
  });

  it("deduplicates repeated IDs within a page and leaves current state unchanged for an empty page", () => {
    const repeated = [step("same", "first value"), step("other", "other value"), step("same", "last value")];
    const merged = mergeExecutionSteps([], repeated, "newer");

    expect(merged.map(({ id }) => id)).toEqual(["same", "other"]);
    expect(merged[0]?.text).toBe("last value");
    expect(mergeExecutionSteps(merged, [], "newer")).toEqual(merged);
    expect(mergeExecutionSteps([], [], "older")).toEqual([]);
  });


  it("rejects same-prefix siblings and file or directory symlinks escaping a private root", async () => {
    const sentinel = join(samePrefixSibling, "sentinel.txt");
    const sibling = await resolveWithin(executionEnv, BACKGROUND_CONTEXT, sentinel, [authorizedRoot], authorizedRoot);
    const relativeSibling = await resolveWithin(
      executionEnv,
      BACKGROUND_CONTEXT,
      `../${samePrefixSibling.slice(filesystemRoot.length + 1)}/sentinel.txt`,
      [authorizedRoot],
      authorizedRoot,
    );
    expect(sibling.ok).toBe(false);
    expect(relativeSibling.ok).toBe(false);

    const fileLink = join(authorizedRoot, "external-file");
    const directoryLink = join(authorizedRoot, "external-directory");
    symlinkSync(sentinel, fileLink);
    symlinkSync(samePrefixSibling, directoryLink, "dir");
    const fileEscape = await resolveWithin(executionEnv, BACKGROUND_CONTEXT, fileLink, [authorizedRoot], authorizedRoot);
    const directoryEscape = await resolveWithin(
      executionEnv,
      BACKGROUND_CONTEXT,
      join(directoryLink, "sentinel.txt"),
      [authorizedRoot],
      authorizedRoot,
    );
    expect(fileEscape.ok).toBe(false);
    expect(directoryEscape.ok).toBe(false);
    expect(readFileSync(sentinel, "utf8")).toBe("private outside sentinel");
  });

});

describe("L1 fast-check properties", () => {
  it("keeps canonical object identity invariant under nested key reordering", () => {
    fc.assert(
      fc.property(fc.tuple(fc.integer(), fc.integer(), fc.integer()), ([first, second, third]) => {
        const left = { z: [first, { nestedZ: second, nestedA: third }], a: { y: third, x: first } };
        const reordered = { a: { x: first, y: third }, z: [first, { nestedA: third, nestedZ: second }] };
        expect(canonicalJson(left)).toBe(canonicalJson(reordered));
      }),
      propertyOptions(),
    );
  });

  it("changes approval identity when an action parameter changes", () => {
    fc.assert(
      fc.property(fc.integer({ min: -1_000_000, max: 1_000_000 }), (first) => {
        const second = first + 1;
        const left = approvalId(approvalRequest({ arguments: { values: [first] } }), 1, 1);
        const right = approvalId(approvalRequest({ arguments: { values: [second] } }), 1, 1);
        expect(right).not.toBe(left);
      }),
      propertyOptions(),
    );
  });

  it("honors the approval verdict truth table for every generated outcome and risk", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("allow" as const, "deny" as const),
        fc.constantFrom("low" as const, "medium" as const, "high" as const, "critical" as const, "unknown" as const),
        (outcome, risk) => {
          const expected = outcome === "deny"
            ? "reject"
            : risk === "low" || risk === "medium"
              ? "approve"
              : risk === "high"
                ? "human"
                : risk === "critical"
                  ? "reject"
                  : "block";
          expect(approvalVerdict(evaluation(outcome, risk)).action).toBe(expected);
        },
      ),
      propertyOptions(),
    );
  });

  it("deduplicates repeated explicit recipients without waking unselected members", () => {
    const members: AddressableMember[] = [
      { id: "employee-0", name: "Member Zero", address: "zero@example.test", enabled: true },
      { id: "employee-1", name: "Member One", address: "one@example.test", enabled: true },
      { id: "employee-2", name: "Member Two", address: "two@example.test", enabled: false },
      { id: "employee-3", name: "Member Three", address: "three@example.test", enabled: true },
    ];
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 2 }), { maxLength: 40 }), (indexes) => {
        const enabledIds = members.filter(({ enabled }) => enabled).map(({ id }) => id);
        const requestedIds = indexes.map((index) => enabledIds[index]!);
        const resolved = resolveMessageAddressing(requestedIds, false, members);
        const expectedIds = [...new Set(requestedIds)];
        expect([...resolved.recipientIds].sort()).toEqual([...expectedIds].sort());
        expect(new Set(resolved.recipientIds).size).toBe(resolved.recipientIds.length);
        expect(resolved.mentionAll).toBe(false);
      }),
      propertyOptions(),
    );
  });

  it("expands mention-all to exactly the generated enabled-member set", () => {
    fc.assert(
      fc.property(fc.array(fc.boolean(), { minLength: 1, maxLength: 20 }), (enabledFlags) => {
        const members: AddressableMember[] = enabledFlags.map((enabled, index) => ({
          id: `employee-${index}`,
          name: `Member ${index}`,
          address: `member-${index}@example.test`,
          enabled,
        }));
        const expectedIds = members.filter(({ enabled }) => enabled).map(({ id }) => id);
        if (expectedIds.length === 0) {
          let caught: unknown;
          try {
            resolveMessageAddressing([], true, members);
          } catch (error) {
            caught = error;
          }
          expect(caught).toBeInstanceOf(MessageAddressingError);
          expect(caught).toMatchObject({ code: "empty-all" });
          return;
        }

        const resolved = resolveMessageAddressing([], true, members);
        expect([...resolved.recipientIds].sort()).toEqual([...expectedIds].sort());
        expect(resolved.mentionAll).toBe(true);
      }),
      propertyOptions(),
    );
  });

  it("never exposes generated nested credential values in redacted arguments", () => {
    const suffix = fc.stringMatching(/^[A-Za-z0-9]{1,24}$/);
    fc.assert(
      fc.property(suffix, (value) => {
        const apiCanary = `fixture-api-${value}-private`;
        const bearerCanary = `fixture-bearer-${value}-private`;
        const visible = `ordinary-${value}-value`;
        const rendered = redactArguments({
          nested: { apiKey: apiCanary, details: { Authorization: `Bearer ${bearerCanary}`, note: visible } },
        });
        expect(rendered).not.toContain(apiCanary);
        expect(rendered).not.toContain(bearerCanary);
        expect(rendered).toContain(visible);
      }),
      propertyOptions(),
    );
  });

  it("extracts generated final text without exposing thinking content", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Za-z0-9_-]{1,40}$/), (value) => {
        const visible = `answer-${value}`;
        const privateThinking = `thinking-${value}`;
        const extracted = assistantText(assistantMessage([
          { type: "thinking", thinking: privateThinking },
          { type: "text", text: visible },
        ]));
        expect(extracted).toBe(visible);
        expect(extracted).not.toContain(privateThinking);
      }),
      propertyOptions(),
    );
  });

  it("allocates the next unused numeric address suffix", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z][a-z0-9_-]{0,20}$/),
        fc.integer({ min: 0, max: 20 }),
        (base, occupiedSuffixes) => {
          const localPart = `member-${base}`;
          const taken = new Set(
            Array.from({ length: occupiedSuffixes + 1 }, (_, index) =>
              `${index === 0 ? localPart : `${localPart}${index + 1}`}@workspace.test`,
            ),
          );
          const allocated = allocateAddress(localPart, "workspace.test", taken);
          expect(allocated).toBe(`${localPart}${occupiedSuffixes + 2}@workspace.test`);
          expect(taken.has(allocated)).toBe(false);
        },
      ),
      propertyOptions(),
    );
  });

  it("allocates unique addresses for a generated employee batch", () => {
    fc.assert(
      fc.property(fc.array(fc.stringMatching(/^[a-z][a-z0-9_-]{0,20}$/), { maxLength: 40 }), (names) => {
        const taken = new Set(["preexisting@workspace.test"]);
        const allocated: string[] = [];
        for (const name of names) {
          const address = allocateAddress(name, "workspace.test", taken);
          expect(taken.has(address)).toBe(false);
          expect(address.endsWith("@workspace.test")).toBe(true);
          taken.add(address);
          allocated.push(address);
        }
        expect(new Set(allocated).size).toBe(allocated.length);
      }),
      propertyOptions(),
    );
  });

  it("resolves locale preference from the first non-empty browser language and preserves raw text", () => {
    const locales: Locale[] = ["en", "zh-CN"];
    fc.assert(
      fc.property(
        fc.constantFrom("system" as const, "en" as const, "zh-CN" as const),
        fc.array(fc.string(), { maxLength: 8 }),
        fc.string(),
        (preference, languages, raw) => {
          const first = languages.find((language) => language.length > 0);
          const expected = preference !== "system"
            ? preference
            : first?.toLowerCase().startsWith("zh") === true
              ? "zh-CN"
              : "en";
          expect(resolveLocale(preference, languages)).toBe(expected);
          for (const locale of locales) expect(formatText(raw, locale)).toBe(raw);
        },
      ),
      propertyOptions(),
    );
  });

  it("preserves stable ID order, keeps one copy, and applies the newest page's state", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 8 }), { maxLength: 30 }),
        fc.array(fc.integer({ min: 0, max: 8 }), { maxLength: 30 }),
        (currentNumbers, pageNumbers) => {
          const currentIds = currentNumbers.map((number) => `step-${number}`);
          const pageIds = pageNumbers.map((number) => `step-${number}`);
          const current = currentIds.map((id, index) => step(id, `current-${index}`));
          const page = pageIds.map((id, index) => step(id, `page-${index}`));
          const merged = mergeExecutionSteps(current, page, "newer");
          const expectedIds = [...new Set([...currentIds, ...pageIds])];
          expect(merged.map(({ id }) => id)).toEqual(expectedIds);
          expect(new Set(merged.map(({ id }) => id)).size).toBe(merged.length);
          for (const id of expectedIds) {
            const latestPageStep = [...page].reverse().find((candidate) => candidate.id === id);
            const expectedStep = latestPageStep ?? [...current].reverse().find((candidate) => candidate.id === id);
            expect(merged.find((candidate) => candidate.id === id)).toEqual(expectedStep);
          }
          expect(mergeExecutionSteps(merged, page, "newer")).toEqual(merged);
        },
      ),
      propertyOptions(),
    );
  });

  it("keeps generated relative targets inside the real private root", async () => {
    const segment = fc.stringMatching(/^[a-z][a-z0-9_-]{0,19}$/);
    await fc.assert(
      fc.asyncProperty(segment, async (name) => {
        const target = `generated/${name}.txt`;
        const inside = await resolveWithin(executionEnv, BACKGROUND_CONTEXT, target, [authorizedRoot], authorizedRoot);
        expect(inside).toEqual({ ok: true, path: join(authorizedRoot, target) });

        const outside = await resolveWithin(
          executionEnv,
          BACKGROUND_CONTEXT,
          join(samePrefixSibling, `${name}.txt`),
          [authorizedRoot],
          authorizedRoot,
        );
        expect(outside.ok).toBe(false);
      }),
      propertyOptions(),
    );
  });
});
