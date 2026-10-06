import { createServer } from "node:http";
import type { Socket } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ApprovalDTO, EmployeeDTO, MessageDTO, RoomDTO, WorkDTO, WorkExecutionDTO } from "../../src/shared/contracts.ts";
import { createE2eFixture, type E2eFixture } from "../helpers/e2e-fixture.ts";
import { FAKE_KEY_ENV, waitForFixture } from "../helpers/emit-fixture.ts";
import { startEmitProcess, type EmitProcessFixture } from "../helpers/process-fixture.ts";
import { startProviderProcess } from "../helpers/provider-process.ts";
import { seedTestWorkspace } from "../helpers/workspace-fixture.ts";

type Sent = { message: MessageDTO; workIds: string[] };
async function request<T>(fixture: E2eFixture, path: string, method = "GET", body?: unknown): Promise<T> {
  const result = await fixture.request<T>(path, method, body);
  expect(result.status, `${method} ${path}: ${JSON.stringify(result.body)}`).toBe(200);
  return result.body;
}
async function waitWork(fixture: E2eFixture, id: string, predicate: (work: WorkDTO) => boolean): Promise<WorkDTO> {
  let result: WorkDTO | undefined;
  await waitForFixture(async () => {
    result = (await request<WorkDTO[]>(fixture, "/api/works")).find(work => work.id === id);
    return result !== undefined && predicate(result);
  }, `work ${id} after cutpoint`);
  return result!;
}
async function employee(fixture: E2eFixture, name: string, allowedTools: string[]): Promise<EmployeeDTO> {
  const created = await request<EmployeeDTO>(fixture, "/api/employees", "POST", { name, role: "Recovery assistant",
    executionModel: { model: { providerId: "fake", modelId: "fake-chat" }, effort: "off" },
    toolPolicy: { allowedTools, trustedReadOnlyTools: [] }, generateAddress: true });
  const room = (await request<RoomDTO[]>(fixture, "/api/rooms")).find((item) => item.id === fixture.workspace.channelId)!;
  await request(fixture, `/api/rooms/${room.id}/members`, "PATCH", {
    memberIds: [...room.memberIds, created.id], expectedVersion: room.membershipVersion,
  });
  return created;
}
async function messages(fixture: E2eFixture, roomId: string): Promise<MessageDTO[]> {
  return (await request<{ messages: MessageDTO[] }>(fixture, `/api/rooms/${roomId}/messages`)).messages;
}
async function control(fixture: E2eFixture, path: string, method = "GET"): Promise<Response> {
  const response = await fetch(`${fixture.provider.url}${path}`, { method, signal: AbortSignal.timeout(10_000) });
  expect(response.status).toBe(method === "GET" ? 200 : 204);
  return response;
}
async function restartKilled(fixture: E2eFixture): Promise<void> {
  await fixture.emit.kill();
  const began = Date.now();
  await fixture.emit.restart();
  expect(Date.now() - began).toBeLessThan(45_000);
}

// No database writes or fabricated WorkDocs: every cutpoint is an accepted
// public request plus a durable public state and an external protocol gate.
describe("real-process crash recovery and data-directory ownership", () => {
  it("restores the same pending-human approval after SIGKILL and writes the approved file with one answer", async () => {
    const fixture = await createE2eFixture();
    try {
      const writer = await employee(fixture, "Approval recovery writer", ["write_file"]);
      const target = join(fixture.workRoot, "critical-settings.json");
      const sent = await request<Sent>(fixture, `/api/rooms/${fixture.workspace.channelId}/messages`, "POST", {
        body: "请写一个 critical-settings.json", recipientIds: [writer.id],
      });
      expect(sent.workIds).toHaveLength(1);
      const id = sent.workIds[0]!;
      await waitWork(fixture, id, work => work.status === "waiting-approval");
      let pending: ApprovalDTO | undefined;
      await waitForFixture(async () => {
        pending = (await request<{ approvals: ApprovalDTO[] }>(fixture, "/api/approvals")).approvals.find(approval => approval.workId === id && approval.status === "pending-human");
        return pending !== undefined;
      }, "pending-human approval");
      expect(pending).toMatchObject({ toolName: "write_file", risk: "high", execution: { state: "not-started" },
        evidence: { kind: "llm", outcome: "allow", risk: "high" } });
      expect(existsSync(target)).toBe(false);
      await restartKilled(fixture);
      await waitWork(fixture, id, work => work.status === "waiting-approval");
      const restored = (await request<{ approvals: ApprovalDTO[] }>(fixture, "/api/approvals")).approvals.filter(approval => approval.workId === id);
      expect(restored).toHaveLength(1);
      expect(restored[0]).toMatchObject({ id: pending!.id, status: "pending-human", execution: { state: "not-started" } });
      expect(existsSync(target)).toBe(false);
      expect((await messages(fixture, fixture.workspace.channelId)).filter(entry => entry.author.type === "employee" && entry.workId === id)).toEqual([]);
      await request(fixture, `/api/approvals/${pending!.id}/decision`, "POST", { decision: "approved" });
      await waitWork(fixture, id, work => work.status === "succeeded");
      expect(readFileSync(target, "utf8")).toBe("SMOKE-CRITICAL-CONTENT\n");
      const decided = (await request<{ approvals: ApprovalDTO[] }>(fixture, "/api/approvals")).approvals.find(approval => approval.id === pending!.id);
      expect(decided).toMatchObject({ status: "approved", execution: { state: "succeeded" } });
      expect((await messages(fixture, fixture.workspace.channelId)).filter(entry => entry.author.type === "employee" && entry.workId === id)).toHaveLength(1);
    } finally { await fixture.close(); }
  }, 120_000);

  it("holds the premature waiting-mail answer across SIGKILL and resumes the original parent exactly once after the real reply", async () => {
    const fixture = await createE2eFixture();
    try {
      const asker = await employee(fixture, "求助发起员工", ["send_mail"]);
      const answerer = await employee(fixture, "求助应答员工", []);
      const roomId = fixture.workspace.mailRoomId;
      const start = await request<Sent>(fixture, `/api/rooms/${roomId}/messages`, "POST", {
        body: "ASK_BACK_START", subject: "求助回信", to: [asker.id],
      });
      expect(start.workIds).toHaveLength(1);
      const id = start.workIds[0]!;
      const parent = await waitWork(fixture, id, work => work.status === "waiting-mail" && work.answer === "提前给出的答复（不应投递）。");
      expect(parent.awaitedMailWorkIds).toHaveLength(1);
      const childId = parent.awaitedMailWorkIds[0]!;
      const child = await waitWork(fixture, childId, work => work.status === "running");
      expect(child).toMatchObject({ employeeId: answerer.id, parentWorkId: id, roomId });
      await waitForFixture(async () => (await (await control(fixture, "/_ask_back_ready")).json() as { ready: boolean }).ready, "ask-back response gate");
      expect((await messages(fixture, roomId)).filter(entry => entry.author.type === "employee" && entry.workId === id && !entry.mail?.recipients.length)).toEqual([]);
      expect((await messages(fixture, roomId)).some(entry => entry.body === parent.answer)).toBe(false);
      await restartKilled(fixture);
      const restored = await waitWork(fixture, id, work => work.status === "waiting-mail");
      expect(restored.awaitedMailWorkIds).toEqual([childId]);
      expect(restored.answer).toBe(parent.answer);
      expect((await messages(fixture, roomId)).some(entry => entry.body === parent.answer)).toBe(false);
      await control(fixture, "/_release_ask_back", "POST");
      const done = await waitWork(fixture, id, work => work.status === "succeeded");
      expect(done.awaitedMailWorkIds).toEqual([]);
      expect(done.answer).toBe("最终答复：回信结果已使用。");
      const entries = await messages(fixture, roomId);
      expect(entries.filter(entry => entry.author.id === asker.id && entry.body === done.answer && entry.workId === id)).toHaveLength(1);
      expect(entries.filter(entry => entry.author.id === answerer.id && entry.body.includes("ASK_BACK_RESULT") && entry.workId === childId)).toHaveLength(1);
      expect(entries.some(entry => entry.body === parent.answer)).toBe(false);
      expect((await request<WorkDTO[]>(fixture, "/api/works")).filter(work => work.employeeId === answerer.id && work.roomId === roomId).map(work => work.id)).toEqual([childId]);
    } finally { await fixture.close(); }
  }, 120_000);

  it("recovers publicly accepted queued work through normal main after killing a deterministically paused scheduler", async () => {
    const root = mkdtempSync(join(tmpdir(), "emit-queued-recovery-"));
    const sockets = new Set<Socket>();
    let gateSeen = false;
    const gateServer = createServer(() => { gateSeen = true; });
    gateServer.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
    let provider: E2eFixture["provider"] | undefined;
    let paused: EmitProcessFixture | undefined;
    let recovered: EmitProcessFixture | undefined;
    try {
      await new Promise<void>((resolve, reject) => { gateServer.once("error", reject); gateServer.listen(0, "127.0.0.1", resolve); });
      const address = gateServer.address();
      if (address === null || typeof address === "string") throw new Error("Resume gate did not bind");
      const gateOrigin = `http://127.0.0.1:${address.port}`;
      provider = await startProviderProcess(root);
      const env = { [FAKE_KEY_ENV]: "queued-local-key", EMIT_TEST_ALLOWED_ORIGINS: JSON.stringify([provider.url, gateOrigin]), OPENCODE_FAKE_URL: `${provider.url}/zen/go` };
      const options = { root, dataDir: join(root, "data"), imports: ["test/fixtures/opencode-local-fetch.mjs"], env };
      paused = await startEmitProcess({ ...options, entrypoint: "test/fixtures/paused-runtime-server.ts", env: { ...env, EMIT_TEST_RESUME_GATE: `${gateOrigin}/resume` } });
      await waitForFixture(async () => gateSeen, "external scheduler gate request", 10_000);
      const workspace = await seedTestWorkspace({ url: paused.url, providerBaseUrl: provider.baseUrl, root });
      writeFileSync(join(root, "work", "notes.txt"), "QUEUED-RECOVERY-FILE\n");
      const sendResponse = await fetch(`${paused.url}/api/rooms/${workspace.channelId}/messages`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: "请读取 notes.txt", recipientIds: [workspace.employeeIds[0]] }), signal: AbortSignal.timeout(10_000),
      });
      expect(sendResponse.status).toBe(200);
      const sent = await sendResponse.json() as Sent;
      expect(sent.workIds).toHaveLength(1);
      const workResponse = await fetch(`${paused.url}/api/works`, { signal: AbortSignal.timeout(10_000) });
      expect(workResponse.status).toBe(200);
      const queued = (await workResponse.json() as WorkDTO[]).find(work => work.id === sent.workIds[0]);
      expect(queued).toMatchObject({ status: "queued", sourceEntryId: sent.message.id, roomId: workspace.channelId, dispatchTaskId: expect.any(String) });
      await paused.kill();
      const began = Date.now();
      recovered = await startEmitProcess(options);
      expect(Date.now() - began).toBeLessThan(45_000);
      const current = recovered;
      let done: WorkDTO | undefined;
      await waitForFixture(async () => {
        const response = await fetch(`${current.url}/api/works`, { signal: AbortSignal.timeout(10_000) });
        expect(response.status).toBe(200);
        done = (await response.json() as WorkDTO[]).find(work => work.id === sent.workIds[0]);
        return done?.status === "succeeded";
      }, "normal-main queued recovery");
      const entriesResponse = await fetch(`${current.url}/api/rooms/${workspace.channelId}/messages`, { signal: AbortSignal.timeout(10_000) });
      expect(entriesResponse.status).toBe(200);
      const entries = (await entriesResponse.json() as { messages: MessageDTO[] }).messages;
      expect(entries.some(entry => entry.id === sent.message.id)).toBe(true);
      expect(entries.filter(entry => entry.author.type === "employee" && entry.workId === done!.id)).toHaveLength(1);
      const executionResponse = await fetch(`${current.url}/api/works/${done!.id}/execution`, { signal: AbortSignal.timeout(10_000) });
      expect(executionResponse.status).toBe(200);
      const execution = await executionResponse.json() as WorkExecutionDTO;
      expect(execution.steps.filter(step => step.kind === "tool-result").map(step => step.text ?? "").join("\n")).toContain("QUEUED-RECOVERY-FILE");
    } finally {
      try { await recovered?.stop(); await paused?.stop(); }
      finally {
        try { await provider?.close(); }
        finally {
          for (const socket of sockets) socket.destroy();
          await new Promise<void>(resolve => gateServer.close(() => resolve()));
          rmSync(root, { recursive: true, force: true });
        }
      }
    }
  }, 120_000);

  it("resumes a provider-gated running work after SIGKILL and delivers its original work once", async () => {
    const fixture = await createE2eFixture();
    try {
      const caller = await employee(fixture, "Running recovery caller", ["send_mail"]);
      await employee(fixture, "小柯二", ["write_file"]);
      const roomId = fixture.workspace.mailRoomId;
      const sent = await request<Sent>(fixture, `/api/rooms/${roomId}/messages`, "POST", { body: "STALE_MAIL_START", subject: "Running cutpoint", to: [caller.id] });
      const id = sent.workIds[0]!;
      await waitForFixture(async () => (await (await control(fixture, "/_stale_mail_ready")).json() as { ready: boolean }).ready, "running provider gate");
      await waitWork(fixture, id, work => work.status === "running");
      expect(existsSync(join(fixture.workRoot, "stale-mail-marker.txt"))).toBe(false);
      await fixture.emit.kill();
      await control(fixture, "/_release_stale_mail", "POST");
      const began = Date.now();
      await fixture.emit.restart();
      expect(Date.now() - began).toBeLessThan(45_000);
      const completed = await waitWork(fixture, id, work => work.status === "succeeded");
      let child: WorkDTO | undefined;
      await waitForFixture(async () => {
        child = (await request<WorkDTO[]>(fixture, "/api/works")).find(work => work.parentWorkId === id && work.status === "succeeded");
        return child !== undefined;
      }, "running recovery child delivery");
      expect(readFileSync(join(fixture.workRoot, "stale-mail-marker.txt"), "utf8")).toBe("SMOKE-WRITTEN:stale-mail-marker.txt\n");
      const entries = await messages(fixture, roomId);
      expect(entries.filter(entry => entry.workId === id && entry.author.type === "employee" && entry.body === completed.answer)).toHaveLength(1);
      expect(entries.filter(entry => entry.workId === child!.id && entry.author.type === "employee")).toHaveLength(1);
    } finally { await fixture.close(); }
  }, 120_000);

  it("keeps publicly stopped work terminal across SIGKILL and rejects the released late model response", async () => {
    const fixture = await createE2eFixture();
    try {
      const caller = await employee(fixture, "Stopped recovery caller", ["send_mail"]);
      await employee(fixture, "小柯二", ["write_file"]);
      const roomId = fixture.workspace.mailRoomId;
      const sent = await request<Sent>(fixture, `/api/rooms/${roomId}/messages`, "POST", { body: "STALE_MAIL_START", subject: "Stopped cutpoint", to: [caller.id] });
      const id = sent.workIds[0]!;
      await waitForFixture(async () => (await (await control(fixture, "/_stale_mail_ready")).json() as { ready: boolean }).ready, "stopped-work provider gate");
      await waitWork(fixture, id, work => work.status === "running");
      await request(fixture, `/api/works/${id}/stop`, "POST");
      await waitWork(fixture, id, work => work.status === "stopped");
      await restartKilled(fixture);
      await control(fixture, "/_release_stale_mail", "POST");
      // A fresh independent work proves the recovered scheduler made progress;
      // this is not a sleep-based assertion that a late result did not arrive.
      writeFileSync(join(fixture.workRoot, "notes.txt"), "STOPPED-RECOVERY-CONTROL\n");
      const reader = await employee(fixture, "Stopped recovery control", ["read_file"]);
      const controlWork = await request<Sent>(fixture, `/api/rooms/${fixture.workspace.channelId}/messages`, "POST", { body: "请读取 notes.txt", recipientIds: [reader.id] });
      await waitWork(fixture, controlWork.workIds[0]!, work => work.status === "succeeded");
      const stopped = (await request<WorkDTO[]>(fixture, "/api/works")).find(work => work.id === id);
      expect(stopped?.status).toBe("stopped");
      expect((await request<WorkDTO[]>(fixture, "/api/works")).filter(work => work.parentWorkId === id)).toEqual([]);
      expect((await messages(fixture, roomId)).filter(entry => entry.author.type === "employee" && entry.workId === id)).toEqual([]);
      expect(existsSync(join(fixture.workRoot, "stale-mail-marker.txt"))).toBe(false);
      await request(fixture, `/api/works/${id}/stop`, "POST");
      expect((await request<WorkDTO[]>(fixture, "/api/works")).find(work => work.id === id)?.status).toBe("stopped");
    } finally { await fixture.close(); }
  }, 120_000);

  it("preserves a publicly final work and its single answer after SIGKILL before another client reads it", async () => {
    const fixture = await createE2eFixture();
    try {
      const reader = await employee(fixture, "Final recovery reader", ["read_file"]);
      writeFileSync(join(fixture.workRoot, "notes.txt"), "FINAL-RECOVERY-CONTROL\n");
      const sent = await request<Sent>(fixture, `/api/rooms/${fixture.workspace.channelId}/messages`, "POST", { body: "请读取 notes.txt", recipientIds: [reader.id] });
      const final = await waitWork(fixture, sent.workIds[0]!, work => work.status === "succeeded");
      // The cutpoint observes works only, not the delivered room answer.
      await restartKilled(fixture);
      const restored = (await request<WorkDTO[]>(fixture, "/api/works")).find(work => work.id === final.id);
      expect(restored).toMatchObject({ status: "succeeded", answer: final.answer, finishedAt: final.finishedAt });
      const delivered = (await messages(fixture, fixture.workspace.channelId)).filter(entry => entry.workId === final.id && entry.author.type === "employee");
      expect(delivered).toHaveLength(1);
      expect(delivered[0]?.body).toBe(final.answer);
    } finally { await fixture.close(); }
  }, 120_000);

  it("rejects a second live data-directory owner, permits clean handoff, and takes over a stale SIGKILL lock without deleting it", async () => {
    const fixture = await createE2eFixture();
    let successor: EmitProcessFixture | undefined;
    try {
      const options = { root: fixture.root, dataDir: join(fixture.root, "data"),
        imports: ["test/fixtures/opencode-local-fetch.mjs"],
        env: { [FAKE_KEY_ENV]: "owner-local-key", EMIT_TEST_ALLOWED_ORIGINS: JSON.stringify([fixture.provider.url]), OPENCODE_FAKE_URL: `${fixture.provider.url}/zen/go` } };
      const began = Date.now();
      let unexpected: EmitProcessFixture | undefined;
      let startupError: unknown;
      try { unexpected = await startEmitProcess(options); }
      catch (error) { startupError = error; }
      finally { await unexpected?.stop(); }
      expect(Date.now() - began).toBeLessThan(45_000);
      expect(startupError).toBeInstanceOf(Error);
      expect(String(startupError)).toContain("The data directory is locked by another Emit process");
      expect((await request<WorkDTO[]>(fixture, "/api/works"))).toEqual([]);
      const accepted = await request<Sent>(fixture, `/api/rooms/${fixture.workspace.channelId}/messages`, "POST", { body: "First owner still writes" });
      expect(accepted.workIds).toEqual([]);
      await fixture.emit.stop();
      successor = await startEmitProcess(options);
      const handoff = await fetch(`${successor.url}/api/rooms/${fixture.workspace.channelId}/messages`, { signal: AbortSignal.timeout(10_000) });
      expect(handoff.status).toBe(200);
      expect((await handoff.json() as { messages: MessageDTO[] }).messages.some(entry => entry.id === accepted.message.id)).toBe(true);
      const written = await fetch(`${successor.url}/api/rooms/${fixture.workspace.channelId}/messages`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: "Clean successor still writes" }), signal: AbortSignal.timeout(10_000),
      });
      expect(written.status).toBe(200);
      const successorMessage = await written.json() as Sent;
      await successor.kill();
      const killedAt = Date.now();
      await successor.restart();
      expect(Date.now() - killedAt).toBeLessThan(45_000);
      const recovered = await fetch(`${successor.url}/api/rooms/${fixture.workspace.channelId}/messages`, { signal: AbortSignal.timeout(10_000) });
      expect(recovered.status).toBe(200);
      const entries = (await recovered.json() as { messages: MessageDTO[] }).messages;
      expect(entries.filter(entry => entry.id === accepted.message.id)).toHaveLength(1);
      expect(entries.filter(entry => entry.id === successorMessage.message.id)).toHaveLength(1);
      const finalWrite = await fetch(`${successor.url}/api/rooms/${fixture.workspace.channelId}/messages`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: "Stale lock successor still writes" }), signal: AbortSignal.timeout(10_000),
      });
      expect(finalWrite.status).toBe(200);
    } finally { try { await successor?.stop(); } finally { await fixture.close(); } }
  }, 120_000);
});
