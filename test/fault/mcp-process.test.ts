import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EmployeeDTO, McpServerDTO, MessageDTO, WorkDTO, WorkExecutionDTO } from "../../src/shared/contracts.ts";
import { createE2eFixture, type E2eFixture } from "../helpers/e2e-fixture.ts";
import { waitForFixture } from "../helpers/emit-fixture.ts";
import { mcpToolName } from "../../src/server/mcp.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  const failures: unknown[] = [];
  for (const close of cleanup.splice(0).reverse()) {
    try { await close(); } catch (error) { failures.push(error); }
  }
  if (failures.length > 0) throw new AggregateError(failures, "MCP fixture cleanup failed");
});

async function open(): Promise<E2eFixture> {
  const fixture = await createE2eFixture();
  cleanup.push(() => fixture.close());
  return fixture;
}

async function request<T>(
  fixture: E2eFixture,
  path: string,
  method = "GET",
  body?: unknown,
  timeoutMs = 10_000,
): Promise<{ status: number; body: T }> {
  const response = await fetch(new URL(path, fixture.emit.url), {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let parsed: T;
  try {
    parsed = JSON.parse(text) as T;
  } catch {
    parsed = text as T;
  }
  return { status: response.status, body: parsed };
}

async function createMcp(fixture: E2eFixture, name: string, mode: string): Promise<McpServerDTO> {
  const created = await request<McpServerDTO>(fixture, "/api/mcp", "POST", {
    name,
    transport: "stdio",
    command: process.execPath,
    args: [resolve(process.cwd(), "test/fixtures/fake-mcp.mjs"), `--mode=${mode}`],
    cwd: process.cwd(),
    enabled: true,
  });
  expect(created.status).toBe(200);
  expect(created.body).toMatchObject({ name, transport: "stdio", connection: { state: "unknown" }, tools: [] });
  return created.body;
}

async function failedConnection(fixture: E2eFixture, server: McpServerDTO, timeoutMs = 10_000): Promise<void> {
  const connected = await request<{ ok: boolean; message: string; tools: string[] }>(
    fixture,
    `/api/mcp/${server.id}/connect`,
    "POST",
    {},
    timeoutMs,
  );
  expect(connected.status).toBe(200);
  expect(connected.body.ok).toBe(false);
  expect(connected.body.tools).toEqual([]);
  const saved = await request<{ servers: McpServerDTO[] }>(fixture, "/api/mcp");
  expect(saved.status).toBe(200);
  expect(saved.body.servers.find(({ id }) => id === server.id)).toMatchObject({ connection: { state: "error" }, tools: [] });
}

async function deleteMcp(fixture: E2eFixture, serverId: string): Promise<void> {
  const removed = await request<{ ok: boolean }>(fixture, `/api/mcp/${serverId}`, "DELETE");
  expect(removed.status).toBe(200);
  expect(removed.body).toEqual({ ok: true });
  const listed = await request<{ servers: McpServerDTO[] }>(fixture, "/api/mcp");
  expect(listed.body.servers.some(({ id }) => id === serverId)).toBe(false);
}

async function waitForWork(fixture: E2eFixture, workId: string, expected: WorkDTO["status"]): Promise<WorkDTO> {
  let observed: WorkDTO | undefined;
  await waitForFixture(async () => {
    const response = await request<WorkDTO[]>(fixture, "/api/works");
    observed = response.body.find((work) => work.id === workId);
    if (observed !== undefined && ["succeeded", "failed", "stopped"].includes(observed.status) && observed.status !== expected) {
      throw new Error(`Work ${workId} reached ${observed.status}; expected ${expected}`);
    }
    return observed?.status === expected;
  }, `MCP work ${workId} to reach ${expected}`, 45_000);
  if (observed === undefined) throw new Error(`Work ${workId} disappeared after reaching ${expected}`);
  return observed;
}

describe("real stdio MCP failure recovery", () => {
  it.each(["fail-init", "crash", "invalid-json", "error-list"] as const)("records %s without retaining tools and permits a fresh connection after removal", async (mode) => {
    const fixture = await open();
    const server = await createMcp(fixture, `fault-${mode}`, mode);
    await failedConnection(fixture, server, 75_000);
    await deleteMcp(fixture, server.id);
    const replacement = await createMcp(fixture, `repaired-${mode}`, "normal");
    const connected = await request<{ ok: boolean; tools: string[] }>(fixture, `/api/mcp/${replacement.id}/connect`, "POST", {});
    expect(connected.body).toMatchObject({ ok: true, tools: ["echo_notes", "shout"] });
    await deleteMcp(fixture, replacement.id);
  }, 120_000);

  it("preserves a real MCP call error while delivering the employee's handled final answer once", async () => {
    const fixture = await open();

    const callFailure = await createMcp(fixture, "fixture", "error-call");
    expect(callFailure.id).toBe("fixture");
    const callConnect = await request<{ ok: boolean; tools: string[] }>(fixture, `/api/mcp/${callFailure.id}/connect`, "POST", {});
    expect(callConnect.status).toBe(200);
    expect(callConnect.body).toMatchObject({ ok: true, tools: ["echo_notes", "shout"] });

    const employeeId = fixture.workspace.employeeIds[0];
    if (employeeId === undefined) throw new Error("Seeded workspace did not include Alice");
    const mappedTool = mcpToolName(callFailure.id, "echo_notes");
    const patched = await request<EmployeeDTO>(fixture, `/api/employees/${employeeId}`, "PATCH", {
      mcpServerIds: [callFailure.id],
      toolPolicy: { allowedTools: [mappedTool], trustedReadOnlyTools: [`${callFailure.id}/echo_notes`] },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.mcpServerIds).toEqual([callFailure.id]);
    const sent = await request<{ workIds: string[] }>(fixture, `/api/rooms/${fixture.workspace.channelId}/messages`, "POST", {
      body: "MCP",
      recipientIds: [employeeId],
    });
    expect(sent.status).toBe(200);
    const workId = sent.body.workIds[0];
    if (workId === undefined) throw new Error("MCP error-call request created no work");
    const completed = await waitForWork(fixture, workId, "succeeded");
    const execution = await request<WorkExecutionDTO>(fixture, `/api/works/${workId}/execution`);
    expect(execution.status).toBe(200);
    expect(execution.body.steps.filter((step) => step.kind === "tool-result" && step.isError === true)
      .some((step) => step.text?.includes("Fixture tool failed"))).toBe(true);
    const room = await request<{ messages: MessageDTO[] }>(fixture, `/api/rooms/${fixture.workspace.channelId}/messages`);
    expect(room.body.messages.filter((message) => message.workId === workId && message.author.type === "employee"))
      .toEqual([expect.objectContaining({ body: completed.answer })]);
    await deleteMcp(fixture, callFailure.id);
  }, 60_000);

  it("times out a hung stdio child and reconnects a healthy replacement", async () => {
    const fixture = await open();

    const hanging = await createMcp(fixture, "fault-hang", "hang");
    await failedConnection(fixture, hanging, 75_000);

    // The timed-out connection must be fully closed: replacing it and connecting a fresh child succeeds.
    const repaired = await request<McpServerDTO>(fixture, "/api/mcp", "POST", {
      id: hanging.id,
      name: hanging.name,
      transport: "stdio",
      command: process.execPath,
      args: [resolve(process.cwd(), "test/fixtures/fake-mcp.mjs")],
      cwd: process.cwd(),
      enabled: true,
    });
    expect(repaired.status).toBe(200);
    expect(repaired.body.connection.state).toBe("unknown");
    const reconnected = await request<{ ok: boolean; tools: string[] }>(fixture, `/api/mcp/${hanging.id}/connect`, "POST", {});
    expect(reconnected.status).toBe(200);
    expect(reconnected.body).toMatchObject({ ok: true, tools: ["echo_notes", "shout"] });
    await deleteMcp(fixture, hanging.id);
  }, 120_000);
});
