import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ApprovalDTO, EmployeeDTO, MessageDTO, RoomDTO, WorkDTO } from "../../src/shared/contracts.ts";
import { createE2eFixture, type E2eFixture } from "../helpers/e2e-fixture.ts";
import { waitForFixture } from "../helpers/emit-fixture.ts";

type Sent = { message: MessageDTO; workIds: string[] };
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  const failures: unknown[] = [];
  for (const close of cleanup.splice(0).reverse()) {
    try { await close(); } catch (error) { failures.push(error); }
  }
  if (failures.length > 0) throw new AggregateError(failures, "Recovery fixture cleanup failed");
});

async function open(): Promise<E2eFixture> {
  const fixture = await createE2eFixture();
  cleanup.push(() => fixture.close());
  return fixture;
}

async function request<T>(fixture: E2eFixture, path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fixture.request<T>(path, method, body);
  expect(response.status, `${method} ${path}: ${JSON.stringify(response.body)}`).toBe(200);
  return response.body;
}

async function employee(fixture: E2eFixture, name: string, allowedTools: string[]): Promise<EmployeeDTO> {
  return request(fixture, "/api/employees", "POST", {
    name,
    role: "Fault recovery assistant",
    executionModel: { model: { providerId: "fake", modelId: "fake-chat" }, effort: "off" },
    toolPolicy: { allowedTools, trustedReadOnlyTools: [] },
    generateAddress: true,
  });
}

async function messages(fixture: E2eFixture, roomId: string): Promise<MessageDTO[]> {
  return (await request<{ messages: MessageDTO[] }>(fixture, `/api/rooms/${roomId}/messages`)).messages;
}

async function works(fixture: E2eFixture): Promise<WorkDTO[]> {
  return request<WorkDTO[]>(fixture, "/api/works");
}

async function waitWork(fixture: E2eFixture, id: string, status: WorkDTO["status"]): Promise<WorkDTO> {
  let observed: WorkDTO | undefined;
  await waitForFixture(async () => {
    observed = (await works(fixture)).find((work) => work.id === id);
    if (observed !== undefined && ["succeeded", "failed", "stopped"].includes(observed.status) && observed.status !== status) {
      throw new Error(`Work ${id} reached ${observed.status}; expected ${status}`);
    }
    return observed?.status === status;
  }, `recovered work ${id} to reach ${status}`, 45_000);
  if (observed === undefined) throw new Error(`Recovered work ${id} was not returned`);
  return observed;
}

async function providerGate(fixture: E2eFixture): Promise<void> {
  await waitForFixture(async () => {
    const response = await fetch(`${fixture.provider.url}/_stale_mail_ready`, { signal: AbortSignal.timeout(10_000) });
    expect(response.status).toBe(200);
    return (await response.json() as { ready: boolean }).ready;
  }, "the provider's held stale-mail response", 15_000);
}

async function providerControl(fixture: E2eFixture, path: string, method = "GET"): Promise<void> {
  const response = await fetch(`${fixture.provider.url}${path}`, { method, signal: AbortSignal.timeout(10_000) });
  expect(response.status).toBe(method === "GET" ? 200 : 204);
}

async function waitForPendingApproval(fixture: E2eFixture, workId: string): Promise<ApprovalDTO> {
  let pending: ApprovalDTO | undefined;
  await waitForFixture(async () => {
    pending = (await request<{ approvals: ApprovalDTO[] }>(fixture, "/api/approvals")).approvals.find(
      (approval) => approval.workId === workId && approval.status === "pending-human",
    );
    return pending !== undefined;
  }, `human approval for work ${workId}`, 45_000);
  if (pending === undefined) throw new Error(`Work ${workId} has no pending human approval`);
  return pending;
}

async function restartKilled(fixture: E2eFixture): Promise<void> {
  await fixture.emit.kill();
  const startedAt = Date.now();
  await fixture.emit.restart();
  expect(Date.now() - startedAt).toBeLessThan(45_000);
}

describe("owned-process fault recovery", () => {
  it("replays a held external response after SIGKILL with one delivery and no premature child effects", async () => {
    const fixture = await open();
    const caller = await employee(fixture, "Faulted mail caller", ["send_mail"]);
    await employee(fixture, "小柯二", ["write_file"]);
    const roomId = fixture.workspace.mailRoomId;
    const sent = await request<Sent>(fixture, `/api/rooms/${roomId}/messages`, "POST", {
      body: "STALE_MAIL_START",
      subject: "SIGKILL fault recovery",
      to: [caller.id],
    });
    expect(sent.workIds).toHaveLength(1);
    const workId = sent.workIds[0]!;
    await providerGate(fixture);
    expect((await waitWork(fixture, workId, "running")).status).toBe("running");
    expect((await works(fixture)).filter((work) => work.parentWorkId === workId)).toEqual([]);
    expect((await messages(fixture, roomId)).filter((message) => message.author.type === "employee" && message.workId === workId)).toEqual([]);
    expect(existsSync(join(fixture.workRoot, "stale-mail-marker.txt"))).toBe(false);

    await fixture.emit.kill();
    await providerControl(fixture, "/_release_stale_mail", "POST");
    await fixture.emit.restart();
    const completed = await waitWork(fixture, workId, "succeeded");
    let child: WorkDTO | undefined;
    await waitForFixture(async () => {
      const children = (await works(fixture)).filter((work) => work.parentWorkId === workId);
      expect(children.length).toBeLessThanOrEqual(1);
      child = children.find((work) => work.status === "succeeded");
      return child !== undefined;
    }, `the single post-recovery mail child for ${workId}`, 45_000);
    if (child === undefined) throw new Error(`Mail child for ${workId} did not complete`);

    const entries = await messages(fixture, roomId);
    expect(entries.filter((entry) => entry.workId === workId && entry.author.type === "employee" && entry.body === completed.answer)).toHaveLength(1);
    expect(entries.filter((entry) => entry.workId === child!.id && entry.author.type === "employee")).toHaveLength(1);
    expect((await works(fixture)).filter((work) => work.parentWorkId === workId)).toHaveLength(1);
    expect(readFileSync(join(fixture.workRoot, "stale-mail-marker.txt"), "utf8")).toBe("SMOKE-WRITTEN:stale-mail-marker.txt\n");
  }, 120_000);

  it("restores the same pending human authorization after SIGKILL and prevents the rejected write", async () => {
    const fixture = await open();
    const writer = await employee(fixture, "Faulted approval writer", ["write_file"]);
    const room = (await request<RoomDTO[]>(fixture, "/api/rooms")).find((item) => item.id === fixture.workspace.channelId)!;
    await request(fixture, `/api/rooms/${room.id}/members`, "PATCH", {
      memberIds: [...room.memberIds, writer.id], expectedVersion: room.membershipVersion,
    });
    const target = join(fixture.workRoot, "critical-settings.json");
    const sent = await request<Sent>(fixture, `/api/rooms/${fixture.workspace.channelId}/messages`, "POST", {
      body: "请写一个 critical-settings.json",
      recipientIds: [writer.id],
    });
    expect(sent.workIds).toHaveLength(1);
    const workId = sent.workIds[0]!;
    await waitWork(fixture, workId, "waiting-approval");
    const pending = await waitForPendingApproval(fixture, workId);
    expect(pending).toMatchObject({ toolName: "write_file", risk: "high", status: "pending-human", execution: { state: "not-started" } });
    expect(existsSync(target)).toBe(false);
    expect((await messages(fixture, fixture.workspace.channelId)).filter((message) => message.author.type === "employee" && message.workId === workId)).toEqual([]);

    await restartKilled(fixture);
    await waitWork(fixture, workId, "waiting-approval");
    const approvals = (await request<{ approvals: ApprovalDTO[] }>(fixture, "/api/approvals")).approvals.filter((item) => item.workId === workId);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ id: pending.id, status: "pending-human", execution: { state: "not-started" } });
    expect(existsSync(target)).toBe(false);
    expect((await messages(fixture, fixture.workspace.channelId)).filter((message) => message.author.type === "employee" && message.workId === workId)).toEqual([]);

    const rejected = await request<ApprovalDTO>(fixture, `/api/approvals/${pending.id}/decision`, "POST", { decision: "rejected" });
    expect(rejected).toMatchObject({ id: pending.id, status: "rejected", execution: { state: "not-started" } });
    const final = await waitWork(fixture, workId, "succeeded");
    expect(existsSync(target)).toBe(false);
    expect((await messages(fixture, fixture.workspace.channelId)).filter((message) => message.author.type === "employee" && message.workId === workId))
      .toEqual([expect.objectContaining({ body: final.answer })]);
    expect((await request<{ approvals: ApprovalDTO[] }>(fixture, "/api/approvals")).approvals.filter((item) => item.workId === workId)).toHaveLength(1);
  }, 120_000);
});
