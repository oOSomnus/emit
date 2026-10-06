import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApprovalDTO, EmployeeDTO, McpServerDTO, SkillDTO, WorkDTO, WorkExecutionDTO, WorkStatusDTO } from "../../src/shared/contracts.ts";
import { mcpToolName, mcpToolReference } from "../../src/server/mcp.ts";
import { FAKE_KEY_ENV, waitForFixture, type FixtureAnswer } from "../helpers/emit-fixture.ts";
import {
  jsonInit as json,
  openSeededApiFixture,
  requestJson as request,
  type SeededApiFixture as TestApi,
} from "../helpers/api-fixture.ts";

const cleanup: Array<() => Promise<void> | void> = [];
let previousApiKey: string | undefined;

beforeEach(() => {
  previousApiKey = process.env[FAKE_KEY_ENV];
  process.env[FAKE_KEY_ENV] = "api-skills-mcp-fixture-key";
});

afterEach(async () => {
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


function lowRiskReview(): FixtureAnswer {
  return {
    content: JSON.stringify({
      outcome: "allow",
      risk: "low",
      rationale: "Local MCP fixture",
      readOnly: true,
      userAuthorization: "unknown",
    }),
  };
}

function highRiskReview(): FixtureAnswer {
  return {
    content: JSON.stringify({
      outcome: "allow",
      risk: "high",
      rationale: "Untrusted MCP calls need human approval in this test.",
      readOnly: false,
      userAuthorization: "unknown",
    }),
  };
}

async function sendWork(api: TestApi, body: string): Promise<string> {
  const response = await request<{ workIds: string[] }>(api.http.url, `/api/rooms/${api.workspace.channelId}/messages`, {
    ...json("POST", { body, recipientIds: [api.workspace.employeeIds[0]] }),
  });
  expect(response.status).toBe(200);
  const id = response.body.workIds[0];
  if (id === undefined) throw new Error(`${body} did not create a work`);
  return id;
}

async function waitForWorkStatus(api: TestApi, id: string, status: WorkStatusDTO): Promise<void> {
  await waitForFixture(async () => {
    const response = await request<WorkDTO[]>(api.http.url, "/api/works");
    return response.body.some((work) => work.id === id && work.status === status);
  }, `work ${id} to become ${status}`, 45_000);
}

async function waitForTerminalWork(api: TestApi, id: string): Promise<void> {
  await waitForFixture(async () => {
    const response = await request<WorkDTO[]>(api.http.url, "/api/works");
    const work = response.body.find((item) => item.id === id);
    return work !== undefined && ["succeeded", "failed", "stopped"].includes(work.status);
  }, `work ${id} to finish`, 45_000);
}

async function waitForPendingApproval(api: TestApi, workId: string): Promise<ApprovalDTO> {
  let found: ApprovalDTO | undefined;
  await waitForFixture(async () => {
    const response = await request<{ approvals: ApprovalDTO[] }>(api.http.url, "/api/approvals");
    found = response.body.approvals.find((item) => item.workId === workId && item.status === "pending-human");
    return found !== undefined;
  }, `pending approval for ${workId}`, 45_000);
  if (found === undefined) throw new Error(`No pending approval for work ${workId}`);
  return found;
}

async function patchEmployee(
  api: TestApi,
  patch: { mcpServerIds: string[]; toolPolicy: { allowedTools: string[]; trustedReadOnlyTools: string[] } },
): Promise<EmployeeDTO> {
  const response = await request<EmployeeDTO>(api.http.url, `/api/employees/${api.workspace.employeeIds[0]}`, json("PATCH", patch));
  expect(response.status).toBe(200);
  return response.body;
}

/** Required checked-in local stdio dependency; a missing or broken fixture is a failure, never a skip. */
const MCP_FIXTURE = resolve(process.cwd(), "test/fixtures/fake-mcp.mjs");

/**
 * Raw tool names whose sanitized display names collide or truncate into one
 * another; each one must stay separately addressable and trusted by raw name.
 */
const IDENTITY_RAW_TOOLS = [
  "read.notes",
  "read-notes",
  `read_${"x".repeat(80)}a`,
  `read_${"x".repeat(80)}b`,
  "read__notes",
] as const;
/** Trusted read-only declarations: the dot name, the first long name, and the doubled-underscore name. */
const IDENTITY_TRUSTED_INDEXES = [0, 2, 4] as const;
/** Untrusted names: the hyphen name and the second long name; both need a human. */
const IDENTITY_GATED_INDEXES = [1, 3] as const;

/** Wait for the first observable branch, so a wrong branch fails fast with its actual shape. */
async function waitForWorkBranch(api: TestApi, id: string): Promise<WorkStatusDTO | "pending-approval"> {
  let branch: WorkStatusDTO | "pending-approval" | undefined;
  await waitForFixture(async () => {
    const [works, approvals] = await Promise.all([
      request<WorkDTO[]>(api.http.url, "/api/works"),
      request<{ approvals: ApprovalDTO[] }>(api.http.url, "/api/approvals"),
    ]);
    const work = works.body.find((entry) => entry.id === id);
    if (work !== undefined && ["succeeded", "failed", "stopped"].includes(work.status)) {
      branch = work.status;
      return true;
    }
    if (approvals.body.approvals.some((entry) => entry.workId === id && entry.status === "pending-human")) {
      branch = "pending-approval";
      return true;
    }
    return false;
  }, `work ${id} to finish or wait for a human`, 45_000);
  if (branch === undefined) throw new Error(`Work ${id} reached neither a terminal status nor a pending approval`);
  return branch;
}

describe("skills and stdio MCP API contract", () => {
  it("imports valid skills with diagnostics, deduplicates repeated imports, and deletes the skill", async () => {
    const api = await openSeededApiFixture({
      prefix: "emit-api-skills-",
      cleanups: cleanup,
      decide: (_root, request) => request.model === "fake-reviewer" ? lowRiskReview() : { content: "ready" },
    });
    const skillRoot = join(api.root, "skills");
    const validDirectory = join(skillRoot, "fixture-guide");
    const invalidDirectory = join(skillRoot, "malformed");
    mkdirSync(validDirectory, { recursive: true });
    mkdirSync(invalidDirectory, { recursive: true });
    writeFileSync(
      join(validDirectory, "SKILL.md"),
      ["---", "name: fixture-guide", "description: A local skill used by the API test.", "---", "", "Only the fixture uses this skill."].join("\n"),
      "utf8",
    );
    writeFileSync(join(invalidDirectory, "SKILL.md"), ["---", "name: malformed", "---", "", "Missing a required description."].join("\n"), "utf8");

    const imported = await request<{ imported: SkillDTO[]; diagnostics: Array<{ severity: string; message: string; path: string }> }>(
      api.http.url,
      "/api/skills/import",
      json("POST", { directory: skillRoot }),
    );
    expect(imported.status).toBe(200);
    expect(imported.body.imported).toHaveLength(1);
    expect(imported.body.imported[0]).toMatchObject({ name: "fixture-guide", filePath: join(validDirectory, "SKILL.md") });
    expect(imported.body.diagnostics.length).toBeGreaterThan(0);
    const importedId = imported.body.imported[0]?.id;
    if (importedId === undefined) throw new Error("The valid skill did not receive an id");

    const repeated = await request<{ imported: SkillDTO[]; diagnostics: Array<{ severity: string; message: string; path: string }> }>(
      api.http.url,
      "/api/skills/import",
      json("POST", { directory: skillRoot }),
    );
    expect(repeated.body.imported.map((skill) => skill.id)).toEqual([importedId]);
    const listed = await request<{ skills: SkillDTO[] }>(api.http.url, "/api/skills");
    expect(listed.body.skills.map((skill) => skill.id)).toEqual([importedId]);

    const deleted = await request<{ ok: boolean }>(api.http.url, `/api/skills/${importedId}`, json("DELETE"));
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ ok: true });
    const afterDelete = await request<{ skills: SkillDTO[] }>(api.http.url, "/api/skills");
    expect(afterDelete.body.skills).toEqual([]);
  }, 30_000);

  it("discovers both stdio tools, gates hinted read-only tools until trusted, and exposes connection/call failures", async () => {
    let serverId = "";
    let errorServerId = "";
    const api = await openSeededApiFixture({
      prefix: "emit-api-mcp-",
      cleanups: cleanup,
      decide: (_root, request) => {
        if (request.model === "fake-reviewer") return highRiskReview();
        const markers = [...request.prompt.matchAll(/MCP_TOOL_(?:UNTRUSTED_ECHO|TRUSTED_ECHO|SHOUT|ERROR_CALL)/g)];
        const marker = markers.at(-1)?.[0];
        if (marker === undefined || request.prompt.includes('"role":"tool"')) return { content: "MCP result handled." };
        if (marker === "MCP_TOOL_SHOUT") return { toolCall: { name: mcpToolName(serverId, "shout"), args: { message: "be loud" } } };
        if (marker === "MCP_TOOL_ERROR_CALL") return { toolCall: { name: mcpToolName(errorServerId, "echo_notes"), args: { path: "error.txt" } } };
        return { toolCall: { name: mcpToolName(serverId, "echo_notes"), args: { path: marker } } };
      },
    });
    const normal = await request<McpServerDTO>(api.http.url, "/api/mcp", json("POST", {
      name: "fixture",
      transport: "stdio",
      command: process.execPath,
      args: [MCP_FIXTURE],
      cwd: process.cwd(),
      enabled: true,
    }));
    expect(normal.status).toBe(200);
    serverId = normal.body.id;
    const connected = await request<{ ok: boolean; message: string; tools: string[] }>(api.http.url, `/api/mcp/${serverId}/connect`, json("POST", {}));
    expect(connected.status).toBe(200);
    expect(connected.body.ok).toBe(true);
    expect(connected.body.tools.sort()).toEqual(["echo_notes", "shout"]);
    const discovered = await request<{ servers: McpServerDTO[] }>(api.http.url, "/api/mcp");
    const saved = discovered.body.servers.find((server) => server.id === serverId);
    expect(saved).toMatchObject({ connection: { state: "connected" } });
    expect(saved?.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "echo_notes", readOnly: true }),
      expect.objectContaining({ name: "shout", readOnly: false }),
    ]));

    const broken = await request<McpServerDTO>(api.http.url, "/api/mcp", json("POST", {
      name: "broken",
      transport: "stdio",
      command: process.execPath,
      args: [MCP_FIXTURE, "--mode=fail-init"],
      cwd: process.cwd(),
      enabled: true,
    }));
    expect(broken.status).toBe(200);
    const failedConnect = await request<{ ok: boolean; message: string; tools: string[] }>(
      api.http.url,
      `/api/mcp/${broken.body.id}/connect`,
      json("POST", {}),
    );
    expect(failedConnect.status).toBe(200);
    expect(failedConnect.body.ok).toBe(false);
    expect(failedConnect.body.message.length).toBeGreaterThan(0);
    const failedState = await request<{ servers: McpServerDTO[] }>(api.http.url, "/api/mcp");
    expect(failedState.body.servers.find((server) => server.id === broken.body.id)?.connection.state).toBe("error");
    await request(api.http.url, `/api/mcp/${broken.body.id}`, json("DELETE"));
    const missingConnect = await request<{ ok: boolean; tools: string[] }>(api.http.url, "/api/mcp/no-such-server/connect", json("POST", {}));
    expect(missingConnect.status).toBe(200);
    expect(missingConnect.body).toMatchObject({ ok: false, tools: [] });

    const employeeId = api.workspace.employeeIds[0]!;
    const mappedEcho = mcpToolName(serverId, "echo_notes");
    const mappedShout = mcpToolName(serverId, "shout");
    await patchEmployee(api, {
      mcpServerIds: [serverId],
      toolPolicy: { allowedTools: [mappedEcho, mappedShout], trustedReadOnlyTools: [] },
    });

    const untrustedWork = await sendWork(api, "MCP_TOOL_UNTRUSTED_ECHO");
    const untrustedApproval = await waitForPendingApproval(api, untrustedWork);
    const beforeTrust = await request<WorkExecutionDTO>(api.http.url, `/api/works/${untrustedWork}/execution`);
    expect(beforeTrust.body.steps.some((step) => step.kind === "tool-result" && step.text?.includes("来自 MCP fixture"))).toBe(false);
    const denied = await request<ApprovalDTO>(api.http.url, `/api/approvals/${untrustedApproval.id}/decision`, json("POST", { decision: "rejected" }));
    expect(denied.body.status).toBe("rejected");
    await waitForTerminalWork(api, untrustedWork);

    await patchEmployee(api, {
      mcpServerIds: [serverId],
      toolPolicy: { allowedTools: [mappedEcho, mappedShout], trustedReadOnlyTools: [`${serverId}/echo_notes`] },
    });
    const trustedWork = await sendWork(api, "MCP_TOOL_TRUSTED_ECHO");
    await waitForWorkStatus(api, trustedWork, "succeeded");
    const trustedExecution = await request<WorkExecutionDTO>(api.http.url, `/api/works/${trustedWork}/execution`);
    expect(trustedExecution.body.steps.some((step) => step.kind === "tool-result" && step.text?.includes("来自 MCP fixture 的笔记：MCP_TOOL_TRUSTED_ECHO"))).toBe(true);
    const approvalsAfterTrust = await request<{ approvals: ApprovalDTO[] }>(api.http.url, "/api/approvals");
    expect(approvalsAfterTrust.body.approvals.some((approval) => approval.workId === trustedWork)).toBe(false);

    const shoutWork = await sendWork(api, "MCP_TOOL_SHOUT");
    const shoutApproval = await waitForPendingApproval(api, shoutWork);
    const shoutDecision = await request<ApprovalDTO>(api.http.url, `/api/approvals/${shoutApproval.id}/decision`, json("POST", { decision: "approved" }));
    expect(shoutDecision.body.status).toBe("approved");
    await waitForWorkStatus(api, shoutWork, "succeeded");
    const shoutExecution = await request<WorkExecutionDTO>(api.http.url, `/api/works/${shoutWork}/execution`);
    expect(shoutExecution.body.steps.some((step) => step.kind === "tool-result" && step.text === "BE LOUD")).toBe(true);

    const errorServer = await request<McpServerDTO>(api.http.url, "/api/mcp", json("POST", {
      name: "mcp-failure",
      transport: "stdio",
      command: process.execPath,
      args: [MCP_FIXTURE, "--mode=error-call"],
      cwd: process.cwd(),
      enabled: true,
    }));
    expect(errorServer.status).toBe(200);
    const errorConnected = await request<{ ok: boolean }>(api.http.url, `/api/mcp/${errorServer.body.id}/connect`, json("POST", {}));
    expect(errorConnected.status).toBe(200);
    errorServerId = errorServer.body.id;
    const errorTool = mcpToolName(errorServerId, "echo_notes");
    await patchEmployee(api, {
      mcpServerIds: [serverId, errorServer.body.id],
      toolPolicy: { allowedTools: [mappedEcho, mappedShout, errorTool], trustedReadOnlyTools: [`${serverId}/echo_notes`] },
    });
    const errorWork = await sendWork(api, "MCP_TOOL_ERROR_CALL");
    const errorApproval = await waitForPendingApproval(api, errorWork);
    const errorDecision = await request<ApprovalDTO>(api.http.url, `/api/approvals/${errorApproval.id}/decision`, json("POST", { decision: "approved" }));
    expect(errorDecision.body.status).toBe("approved");
    await waitForWorkStatus(api, errorWork, "succeeded");
    const errorExecution = await request<WorkExecutionDTO>(api.http.url, `/api/works/${errorWork}/execution`);
    expect(errorExecution.body.steps.some((step) => step.kind === "tool-result" && step.isError === true)).toBe(true);
    expect(errorExecution.body.steps.some((step) => step.kind === "tool-result" && step.text?.includes("MCP fixture"))).toBe(false);

    const employees = await request<{ employees: EmployeeDTO[] }>(api.http.url, "/api/bootstrap");
    expect(employees.body.employees.find((employee) => employee.id === employeeId)?.mcpServerIds).toEqual([serverId, errorServer.body.id]);
  }, 120_000);

  it("keeps MCP trust and raw tool identity consistent across lossy display names", async () => {
    let serverId = "";
    const api = await openSeededApiFixture({
      prefix: "emit-api-mcp-identity-",
      cleanups: cleanup,
      decide: (_root, request) => {
        if (request.model === "fake-reviewer") return highRiskReview();
        const markers = [...request.prompt.matchAll(/MCP_IDENTITY_CASE:(\d)/g)];
        const marker = markers.at(-1);
        if (marker === undefined || request.prompt.includes('"role":"tool"')) return { content: "Identity case handled." };
        const index = Number(marker[1]);
        const raw = IDENTITY_RAW_TOOLS[index];
        if (raw === undefined) return { content: "Identity case handled." };
        return { toolCall: { name: mcpToolName(serverId, raw), args: { path: `identity-${index}` } } };
      },
    });
    const created = await request<McpServerDTO>(api.http.url, "/api/mcp", json("POST", {
      name: "fixture",
      transport: "stdio",
      command: process.execPath,
      args: [MCP_FIXTURE, "--identity-tools"],
      cwd: process.cwd(),
      enabled: true,
    }));
    expect(created.status).toBe(200);
    serverId = created.body.id;
    const connected = await request<{ ok: boolean; tools: string[] }>(api.http.url, `/api/mcp/${serverId}/connect`, json("POST", {}));
    expect(connected.status).toBe(200);
    expect(connected.body.ok).toBe(true);
    expect([...connected.body.tools].sort()).toEqual([...IDENTITY_RAW_TOOLS].sort());

    const displayNames = IDENTITY_RAW_TOOLS.map((raw) => mcpToolName(serverId, raw));
    await patchEmployee(api, {
      mcpServerIds: [serverId],
      toolPolicy: {
        allowedTools: displayNames,
        trustedReadOnlyTools: IDENTITY_TRUSTED_INDEXES.map((index) => mcpToolReference(serverId, IDENTITY_RAW_TOOLS[index])),
      },
    });

    const observedNames: string[] = [];
    for (const index of IDENTITY_TRUSTED_INDEXES) {
      const workId = await sendWork(api, `MCP_IDENTITY_CASE:${index}`);
      expect(await waitForWorkBranch(api, workId)).toBe("succeeded");
      const execution = await request<WorkExecutionDTO>(api.http.url, `/api/works/${workId}/execution`);
      expect(execution.body.steps).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "tool-result", isError: false, text: `MCP_IDENTITY:${IDENTITY_RAW_TOOLS[index]}:identity-${index}` }),
      ]));
      const approvals = await request<{ approvals: ApprovalDTO[] }>(api.http.url, "/api/approvals");
      expect(approvals.body.approvals.some((approval) => approval.workId === workId)).toBe(false);
      observedNames.push(...execution.body.steps.filter((step) => step.kind === "tool-call").map((step) => step.toolName ?? ""));
    }

    for (const index of IDENTITY_GATED_INDEXES) {
      const workId = await sendWork(api, `MCP_IDENTITY_CASE:${index}`);
      expect(await waitForWorkBranch(api, workId)).toBe("pending-approval");
      const approval = await waitForPendingApproval(api, workId);
      const before = await request<WorkExecutionDTO>(api.http.url, `/api/works/${workId}/execution`);
      expect(before.body.steps.some((step) => step.kind === "tool-result" && step.text?.includes("MCP_IDENTITY:"))).toBe(false);
      const decision = await request<ApprovalDTO>(api.http.url, `/api/approvals/${approval.id}/decision`, json("POST", { decision: "approved" }));
      expect(decision.body.status).toBe("approved");
      await waitForWorkStatus(api, workId, "succeeded");
      const execution = await request<WorkExecutionDTO>(api.http.url, `/api/works/${workId}/execution`);
      expect(execution.body.steps).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "tool-result", isError: false, text: `MCP_IDENTITY:${IDENTITY_RAW_TOOLS[index]}:identity-${index}` }),
      ]));
      const approvals = await request<{ approvals: ApprovalDTO[] }>(api.http.url, "/api/approvals");
      expect(approvals.body.approvals.find((entry) => entry.workId === workId)?.execution.state).toBe("succeeded");
      observedNames.push(...execution.body.steps.filter((step) => step.kind === "tool-call").map((step) => step.toolName ?? ""));
    }

    expect(observedNames).toHaveLength(IDENTITY_RAW_TOOLS.length);
    expect([...new Set(observedNames)].sort()).toEqual([...displayNames].sort());
    for (const name of observedNames) {
      expect(name).toMatch(/^[A-Za-z0-9_]+$/);
      expect(name.length).toBeLessThanOrEqual(64);
    }
  }, 180_000);
});
