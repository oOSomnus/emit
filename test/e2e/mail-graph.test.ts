import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApprovalDTO, EmployeeDTO, MailboxItemDTO, MessageDTO, RoomDTO, WorkContextDTO, WorkDTO, WorkExecutionDTO } from "../../src/shared/contracts.ts";
import { createE2eFixture, type E2eFixture } from "../helpers/e2e-fixture.ts";
import { waitForFixture } from "../helpers/emit-fixture.ts";

type Sent = { message: MessageDTO; workIds: string[] };
let fixture: E2eFixture;

async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fixture.request<T>(path, method, body);
  expect(response.status, `${method} ${path}: ${JSON.stringify(response.body)}`).toBe(200);
  return response.body;
}
async function employee(name: string, allowedTools: string[], instructions = "Complete the requested task."): Promise<EmployeeDTO> {
  return request("/api/employees", "POST", { name, role: "Mail assistant", instructions,
    executionModel: { model: { providerId: "fake", modelId: "fake-chat" }, effort: "off" },
    toolPolicy: { allowedTools, trustedReadOnlyTools: [] }, generateAddress: true });
}
async function room(name: string, directory: string): Promise<RoomDTO> {
  mkdirSync(directory, { recursive: true });
  const context = await request<WorkContextDTO>("/api/work-contexts", "POST", {
    name, directories: { paths: [directory], defaultPath: directory },
  });
  return request("/api/rooms", "POST", { kind: "mail", name, workContextId: context.id });
}
async function messages(roomId: string): Promise<MessageDTO[]> {
  return (await request<{ messages: MessageDTO[] }>(`/api/rooms/${roomId}/messages`)).messages;
}
async function send(roomId: string, body: string, to: string[], extra: Record<string, unknown> = {}): Promise<Sent> {
  return request(`/api/rooms/${roomId}/messages`, "POST", { body, subject: body, to, ...extra });
}
async function findWork(predicate: (work: WorkDTO) => boolean): Promise<WorkDTO> {
  let found: WorkDTO | undefined;
  await waitForFixture(async () => {
    found = (await request<WorkDTO[]>("/api/works")).find(predicate);
    return found !== undefined;
  }, "public mail work");
  return found!;
}
async function finish(id: string): Promise<WorkDTO> {
  return findWork(work => work.id === id && work.status === "succeeded");
}
async function findMessage(roomId: string, predicate: (message: MessageDTO) => boolean): Promise<MessageDTO> {
  let found: MessageDTO | undefined;
  await waitForFixture(async () => { found = (await messages(roomId)).find(predicate); return found !== undefined; }, "public mail entry");
  return found!;
}
async function assertWrite(work: WorkDTO, source: RoomDTO, directory: string, file: string): Promise<void> {
  await finish(work.id);
  expect(work.roomId).toBe(source.id);
  expect(work.workContextId).toBe(source.workContextId);
  expect(readFileSync(join(directory, file), "utf8")).toBe(`SMOKE-WRITTEN:${file}\n`);
  const approval = (await request<{ approvals: ApprovalDTO[] }>("/api/approvals")).approvals.find(entry => entry.workId === work.id && entry.toolName === "write_file");
  expect(approval).toMatchObject({ status: "approved", directoryRoomId: source.id,
    directoryWorkContextId: source.workContextId, directoryPaths: [directory], cwd: directory,
    targetPaths: [join(directory, file)], execution: { state: "succeeded" } });
}
async function assertRead(id: string, marker: string): Promise<void> {
  await finish(id);
  const execution = await request<WorkExecutionDTO>(`/api/works/${id}/execution`);
  expect(execution.steps.filter(step => step.kind === "tool-result").map(step => step.text ?? "").join("\n")).toContain(marker);
  expect((await request<{ approvals: ApprovalDTO[] }>("/api/approvals")).approvals.filter(approval => approval.workId === id)).toEqual([]);
}

beforeEach(async () => { fixture = await createE2eFixture(); });
afterEach(async () => { await fixture?.close(); });

describe("real-process mail delivery and graph", () => {
  it("stores and edits drafts without work, sends every To once, and preserves reply-all and mailbox flags", async () => {
    const alice = await employee("Mail reader", ["read_file", "run_shell"]);
    const bob = await employee("小柯二", ["read_file", "write_file"]);
    const directory = join(fixture.workRoot, "D");
    const source = await room("Draft and reply-all", directory);
    writeFileSync(join(directory, "notes.txt"), "MAIL-DIRECTORY-D\n");
    const before = await request<WorkDTO[]>("/api/works");
    const draft = await send(source.id, "请读取 notes.txt", [alice.id], { cc: [bob.id], draft: true });
    expect(draft.workIds).toEqual([]);
    expect((await messages(source.id))[0]?.mail).toMatchObject({ draft: true, sent: false });
    const edited = await send(source.id, "请读取 notes.txt（edited）", [alice.id, bob.id], { draft: true });
    await request(`/api/rooms/${source.id}/mail-flag`, "POST", { entryId: draft.message.id, active: false });
    expect((await messages(source.id)).filter(entry => entry.mail?.draft).map(entry => entry.id)).toEqual([edited.message.id]);
    expect(await request<WorkDTO[]>("/api/works")).toEqual(before);
    const sent = await request<Sent>(`/api/rooms/${source.id}/mail-send`, "POST", { entryId: edited.message.id });
    expect(sent.workIds).toHaveLength(2);
    expect(sent.message.mail).toMatchObject({ recipients: [alice.id, bob.id], sent: true, draft: false });
    expect(sent.message.mail?.to.map(address => address.address)).toEqual([alice.address, bob.address]);
    for (const id of sent.workIds) {
      const work = await finish(id);
      expect(work).toMatchObject({ roomId: source.id, kind: "mail", sourceEntryId: sent.message.id });
      await assertRead(id, "MAIL-DIRECTORY-D");
    }
    const replies = (await messages(source.id)).filter(entry => entry.author.type === "employee");
    expect(replies).toHaveLength(2);
    expect(new Set(replies.map(entry => entry.author.id))).toEqual(new Set([alice.id, bob.id]));
    const userAddress = (await request<{ user: { address: string } }>("/api/app")).user.address;
    expect(userAddress.length).toBeGreaterThan(0);
    for (const reply of replies) {
      expect(reply.mail).toMatchObject({ inReplyTo: sent.message.id, to: [expect.objectContaining({ address: userAddress })] });
      expect(reply.mail?.copies).toContain(reply.author.id === alice.id ? bob.id : alice.id);
    }
    const markedId = replies[0]!.id;
    await request(`/api/rooms/${source.id}/mail-flag`, "POST", { entryId: markedId, read: true, archived: true });
    expect((await messages(source.id)).find(entry => entry.id === markedId)?.mail).toMatchObject({ read: true, archived: true });
    expect((await messages(source.id)).some(entry => entry.mail?.draft)).toBe(false);
    const keptDraft = await send(source.id, "Saved mailbox draft", [alice.id], { draft: true });
    const mailbox = (await request<{ items: MailboxItemDTO[] }>("/api/mail")).items;
    expect(mailbox.some(item => item.message.id === keptDraft.message.id && item.message.mail?.draft)).toBe(true);
    expect(mailbox.some(item => item.message.author.address === bob.address)).toBe(true);
    expect(mailbox.filter(item => item.message.author.id !== "user" &&
      ![...(item.message.mail?.to ?? []), ...(item.message.mail?.cc ?? [])].some(address => address.address === userAddress))).toEqual([]);
    await fixture.emit.restart();
    expect((await messages(source.id)).find(entry => entry.id === markedId)?.mail).toMatchObject({ read: true, archived: true });
    expect((await messages(source.id)).filter(entry => entry.author.type === "employee")).toHaveLength(2);
    const shell = await send(source.id, "请用 run_shell 执行 pwd > cwd-proof.txt", [alice.id]);
    const shellWork = await finish(shell.workIds[0]!);
    expect(shellWork).toMatchObject({ roomId: source.id, workContextId: source.workContextId });
    expect(readFileSync(join(directory, "cwd-proof.txt"), "utf8").trim()).toBe(directory);
  });

  it("records CC, self delivery, and external addresses without waking copies or creating phantom work", async () => {
    const reader = await employee("Recipient", ["read_file"]);
    const copy = await employee("Copy only", []);
    writeFileSync(join(fixture.workRoot, "notes.txt"), "MAIL-RECIPIENT\n");
    const source = await room("Delivery addressing", fixture.workRoot);
    const sent = await send(source.id, "请读取 notes.txt", [reader.id], { cc: [copy.id] });
    expect(sent.workIds).toHaveLength(1);
    await finish(sent.workIds[0]!);
    expect((await request<WorkDTO[]>("/api/works")).filter(work => work.roomId === source.id).map(work => work.employeeId)).toEqual([reader.id]);
    expect(sent.message.mail).toMatchObject({ recipients: [reader.id], copies: [copy.id], cc: [expect.objectContaining({ address: copy.address })] });
    const before = await request<WorkDTO[]>("/api/works");
    const self = await send(source.id, "Self delivery", ["user"]);
    const external = await send(source.id, "External delivery", ["someone@elsewhere.test"], { cc: ["watch@elsewhere.test"] });
    expect(self.workIds).toEqual([]);
    expect(external.workIds).toEqual([]);
    expect(external.message.mail).toMatchObject({ to: [expect.objectContaining({ address: "someone@elsewhere.test" })],
      cc: [expect.objectContaining({ address: "watch@elsewhere.test" })], recipients: [], copies: [] });
    expect(await request<WorkDTO[]>("/api/works")).toEqual(before);
    const ids = (await messages(source.id)).map(entry => entry.id);
    expect((await fixture.request(`/api/rooms/${source.id}/messages`, "POST", { body: "Invalid recipient", subject: "Invalid", to: ["没有这个人"] })).status).toBe(400);
    expect((await messages(source.id)).map(entry => entry.id)).toEqual(ids);
    expect(await request<WorkDTO[]>("/api/works")).toEqual(before);
    expect((await request<{ items: MailboxItemDTO[] }>("/api/mail")).items.some(item => item.message.id === external.message.id)).toBe(true);
  });

  it("keeps same-parent branches in the D mail session with one recipient work and reply per branch", async () => {
    const caller = await employee("邮件图员工", ["send_mail"]);
    const recipient = await employee("小柯二", ["read_file", "write_file"]);
    const directory = join(fixture.workRoot, "D");
    const source = await room("Shared D branches", directory);
    const root = await send(source.id, "员工续发邮件", [caller.id]);
    const branch = await findMessage(source.id, entry => entry.author.id === caller.id && entry.mail?.subject === "员工续发邮件");
    expect(branch.mail?.inReplyTo).toBe(root.message.id);
    const child = await findWork(work => work.sourceEntryId === branch.id && work.kind === "mail");
    expect(child.parentWorkId).toBe(root.workIds[0]);
    await assertWrite(child, source, directory, "graph-marker.txt");
    await finish(root.workIds[0]!);
    await findMessage(source.id, entry => entry.author.id === recipient.id && entry.mail?.inReplyTo === branch.id);
    const multi = await send(source.id, "MAIL_TWO_BRANCHES", [caller.id]);
    for (const [subject, file] of [["同 parent 分支一", "multi-branch-one.txt"], ["同 parent 分支二", "multi-branch-two.txt"]]) {
      const entry = await findMessage(source.id, message => message.author.id === caller.id && message.mail?.subject === subject);
      expect(entry.mail?.inReplyTo).toBe(multi.message.id);
      const work = await findWork(candidate => candidate.sourceEntryId === entry.id && candidate.kind === "mail");
      expect(work.parentWorkId).toBe(multi.workIds[0]);
      await assertWrite(work, source, directory, file!);
      expect((await messages(source.id)).filter(message => message.author.type === "employee" && message.workId === work.id)).toHaveLength(1);
    }
    await finish(multi.workIds[0]!);
    const userAddress = (await request<{ user: { address: string } }>("/api/app")).user.address;
    const mailbox = (await request<{ items: MailboxItemDTO[] }>("/api/mail")).items;
    expect(mailbox.filter(item => item.message.author.id !== "user" &&
      ![...(item.message.mail?.to ?? []), ...(item.message.mail?.cc ?? [])].some(address => address.address === userAddress))).toEqual([]);
  });

  it("delegated send_mail replies to the nearest ancestor sent entry and inherits the D context", async () => {
    const caller = await employee("邮件链起始员工", ["send_mail"]);
    const forwarder = await employee("邮件委托中转", ["delegate_task"], "交办->邮件发信子员工\n");
    const sender = await employee("邮件发信子员工", ["send_mail"]);
    await employee("小柯二", ["write_file"]);
    const directory = join(fixture.workRoot, "D");
    const source = await room("Delegated D mail", directory);
    const root = await send(source.id, "MAIL_DELEGATION_CHAIN_START", [caller.id]);
    const forwarded = await findMessage(source.id, entry => entry.author.id === caller.id && entry.mail?.subject === "委托邮件中转");
    expect(forwarded.mail?.inReplyTo).toBe(root.message.id);
    const forwardWork = await findWork(work => work.employeeId === forwarder.id && work.sourceEntryId === forwarded.id);
    expect(forwardWork.parentWorkId).toBe(root.workIds[0]);
    const delegated = await findWork(work => work.kind === "delegation" && work.employeeId === sender.id && work.parentWorkId === forwardWork.id);
    const last = await findMessage(source.id, entry => entry.author.id === sender.id && entry.mail?.subject === "邮件委托链末端");
    expect(last.mail?.inReplyTo).toBe(forwarded.id);
    const target = await findWork(work => work.kind === "mail" && work.sourceEntryId === last.id);
    expect(target.parentWorkId).toBe(delegated.id);
    await assertWrite(target, source, directory, "delegated-mail-marker.txt");
    for (const id of [root.workIds[0]!, forwardWork.id, delegated.id]) await finish(id);
  });

  it("rejects stale-directory send_mail without creating a branch or recipient work", async () => {
    const caller = await employee("过期 session 发信员工", ["send_mail"]);
    await employee("小柯二", ["write_file"]);
    const d = join(fixture.workRoot, "D");
    const e = join(fixture.workRoot, "E");
    mkdirSync(e, { recursive: true });
    const source = await room("Stale directory session", d);
    const root = await send(source.id, "STALE_MAIL_START", [caller.id]);
    await waitForFixture(async () => (await (await fetch(`${fixture.provider.url}/_stale_mail_ready`, { signal: AbortSignal.timeout(10_000) })).json() as { ready: boolean }).ready, "stale-mail provider gate");
    const before = await request<WorkContextDTO>(`/api/work-contexts/${source.workContextId}`);
    const updated = await request<WorkContextDTO>(`/api/work-contexts/${source.workContextId}`, "PATCH", {
      expectedVersion: before.version, directories: { paths: [e], defaultPath: e },
    });
    expect(updated.directories.version).toBe(before.directories.version + 1);
    expect(updated.directories.defaultPath).toBe(e);
    expect((await fetch(`${fixture.provider.url}/_release_stale_mail`, { method: "POST", signal: AbortSignal.timeout(10_000) })).status).toBe(204);
    await finish(root.workIds[0]!);
    expect((await messages(source.id)).some(entry => entry.mail?.subject === "过期目录续发")).toBe(false);
    expect((await request<RoomDTO[]>("/api/rooms")).some(entry => entry.name === "过期目录续发")).toBe(false);
    expect((await request<WorkDTO[]>("/api/works")).filter(work => work.roomId === source.id)).toHaveLength(1);
  });

  it("shares D for newSession, isolates independent E, and keeps user replies in their original session", async () => {
    const caller = await employee("邮件图员工", ["send_mail"]);
    const recipient = await employee("小柯二", ["read_file"]);
    const d = join(fixture.workRoot, "D");
    const e = join(fixture.workRoot, "E");
    const source = await room("Original D session", d);
    const independent = await room("Independent E session", e);
    writeFileSync(join(d, "notes.txt"), "MAIL-DIRECTORY-D\n");
    writeFileSync(join(e, "notes.txt"), "MAIL-DIRECTORY-E\n");
    const original = await send(source.id, "原始邮件", [recipient.id]);
    await finish(original.workIds[0]!);
    const bad = await send(source.id, `新会话错误父引用 entry=${original.message.id}`, [caller.id]);
    await finish(bad.workIds[0]!);
    expect((await request<RoomDTO[]>("/api/rooms")).some(entry => entry.name === "新会话错误父引用")).toBe(false);
    const start = await send(source.id, "员工续发新会话", [caller.id]);
    let created: RoomDTO | undefined;
    await waitForFixture(async () => {
      created = (await request<RoomDTO[]>("/api/rooms")).find(entry => entry.kind === "mail" && entry.name === "员工续发新会话" && entry.id !== source.id);
      return created !== undefined;
    }, "newSession mail room");
    expect(created!.workContextId).toBe(source.workContextId);
    expect((await request<WorkContextDTO>(`/api/work-contexts/${created!.workContextId}`)).directories.paths).toEqual([d]);
    const branch = await findMessage(created!.id, entry => entry.author.id === caller.id && entry.mail?.subject === "员工续发新会话");
    expect(branch.mail?.inReplyTo).toBeUndefined();
    const child = await findWork(work => work.sourceEntryId === branch.id && work.roomId === created!.id);
    expect(child.parentWorkId).toBe(start.workIds[0]);
    await assertRead(child.id, "MAIL-DIRECTORY-D");
    await finish(start.workIds[0]!);
    const before = (await messages(independent.id)).map(entry => entry.id);
    expect((await fixture.request(`/api/rooms/${independent.id}/messages`, "POST", {
      body: "Cross-session reply", subject: "Rejected", to: [recipient.id], inReplyTo: original.message.id,
    })).status).toBe(400);
    expect((await messages(independent.id)).map(entry => entry.id)).toEqual(before);
    const separate = await send(independent.id, "请读取 notes.txt", [recipient.id]);
    const separateWork = await finish(separate.workIds[0]!);
    expect(separateWork).toMatchObject({ roomId: independent.id, workContextId: independent.workContextId });
    expect(independent.workContextId).not.toBe(source.workContextId);
    await assertRead(separateWork.id, "MAIL-DIRECTORY-E");
    const reply = await send(source.id, "用户回复原信", [recipient.id], { inReplyTo: original.message.id });
    expect(reply.message.mail?.inReplyTo).toBe(original.message.id);
    await finish(reply.workIds[0]!);
    const answer = await findMessage(source.id, entry => entry.author.id === recipient.id && entry.workId === reply.workIds[0]);
    expect(answer.mail?.inReplyTo).toBe(reply.message.id);
  });
});
