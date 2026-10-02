/**
 * The HTTP surface.
 *
 * One Fastify instance serves the built web client, the JSON API, and a single
 * Server-Sent Events stream. Every mutation goes through the documents and the
 * work layer; this module owns only validation, wiring, and event fan-out, so
 * nothing in the product depends on HTTP details.
 */

import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import type { MailboxItemDTO, ServerEvent, RoomDirectoryDraftDTO, RoomDirectoryPatchDTO } from "../shared/contracts.ts";
import type { EmitRuntime } from "./runtime.ts";
import type { McpManager } from "./mcp.ts";
import {
  createEmployee,
  findEmployee,
  listEmployees,
  ValidationError,
  readApp,
  setupWorkspace,
  toAppDTO,
  toEmployeeDTO,
  updateAppConfig,
  updateEmployee,
} from "./workspace.ts";
import { deleteSkill, importSkillDirectory, listSkills, toSkillDTO, type SkillImportResult } from "./skills.ts";
import { toMcpServerDTO } from "./mcp.ts";
import { ProviderAuthError } from "./provider-auth.ts";
import {
  appendRoomMessage,
  createRoom,
  findRoom,
  listRoomDTOs,
  listRoomMessages,
  mailEnvelope,
  messageData,
  roomDTOWithUnread,
  setMailFlag,
  toRoomDTO,
  type MailAddress,
  updateRoomDirectories,
  RoomDirectoryError,
  isSentMailEntry,
} from "./rooms.ts";
import {
  findWork,
  installEmployeeExtension,
  listWorks,
  reconcileWorks,
  startWork,
  stopWork,
  type Resume,
} from "./work.ts";
import { findApproval, invalidateStaleGrants, invalidateRoomDirectoryGrants, listApprovals, toApprovalDTO } from "./approval/state.ts";
import { toWorkDTO } from "./dto.ts";
import { ApprovalDoc, EmployeeDoc, type ApprovalRecord } from "./documents.ts";

export type ApiOptions = {
  runtime: EmitRuntime;
  mcp: McpManager;
  webRoot: string | undefined;
};

const MAX_BODY = 200_000;

export async function buildServer(options: ApiOptions): Promise<FastifyInstance> {
  const { runtime, mcp } = options;
  const resume: Resume = { runtime, mcp };
  // The event stream is a connection that never ends on its own, so a plain
  // close would wait for it forever; connections are dropped on shutdown.
  const app = Fastify({ logger: false, bodyLimit: MAX_BODY, forceCloseConnections: true });

  // A rejected input answers 400 with its reason; anything else stays a 500.
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ValidationError) return reply.code(400).send({ message: error.message });
    if (error instanceof RoomDirectoryError) return reply.code(error.status).send({ message: error.message });
    if (error instanceof ProviderAuthError) return reply.code(error.status).send({ message: error.message });
    const message = error instanceof Error ? error.message : String(error);
    return reply.code(500).send({ message });
  });

  const employees = async () => listEmployees(runtime);
  const workDTOs = async () => {
    const [works, allEmployees, rooms] = await Promise.all([listWorks(runtime), employees(), listRoomDTOs(runtime, "user")]);
    const byEmployee = new Map(allEmployees.map((employee) => [employee.id, employee.name]));
    const byRoom = new Map(rooms.map((room) => [room.id, room.name]));
    return works.map((work) => toWorkDTO(work, byEmployee.get(work.employeeId) ?? "", byRoom.get(work.roomId) ?? ""));
  };

  app.get("/api/bootstrap", async () => {
    const appRecord = await readApp(runtime);
    return {
      app: toAppDTO(appRecord),
      employees: (await employees()).map(toEmployeeDTO),
      rooms: await listRoomDTOs(runtime, "user"),
      work: await workDTOs(),
      approvals: (await listApprovals(runtime)).map(toApprovalDTO),
      skills: (await listSkills(runtime)).map(toSkillDTO),
      mcpServers: (await mcp.listServers()).map(toMcpServerDTO),
      providers: await runtime.catalog.providerStatuses(),
      customProviders: runtime.customProviders(),
      storagePath: runtime.storagePath,
    };
  });

  app.get("/api/events", (request, reply) => {
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    reply.raw.write(": connected\n\n");
    const send = (event: ServerEvent) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const unsubscribe = runtime.subscribe(send);
    const keepAlive = setInterval(() => reply.raw.write(": ping\n\n"), 20_000);
    request.raw.on("close", () => {
      clearInterval(keepAlive);
      unsubscribe();
      reply.raw.end();
    });
    return reply;
  });

  // ---------------------------------------------------------------- workspace

  app.post("/api/setup", async (request, reply) => {
    const body = request.body as {
      workspaceName?: unknown;
      userName?: unknown;
      defaultExecutionModel?: unknown;
      approval?: unknown;
    };
    if (typeof body?.workspaceName !== "string" || typeof body?.userName !== "string") {
      return reply.code(400).send({ message: "缺少工作区名称或你的名字" });
    }
    const saved = await setupWorkspace(runtime, {
      workspaceName: body.workspaceName,
      userName: body.userName,
      defaultExecutionModel: (body.defaultExecutionModel as never) ?? null,
      approval: (body.approval as never) ?? null,
    });
    return toAppDTO(saved);
  });

  app.get("/api/app", async () => toAppDTO(await readApp(runtime)));

  app.patch("/api/app", async (request) => {
    const body = request.body as Parameters<typeof updateAppConfig>[1];
    return toAppDTO(await updateAppConfig(runtime, body ?? {}));
  });

  app.get("/api/models", async () => ({
    models: await runtime.catalog.catalog(),
    providers: await runtime.catalog.providerStatuses(),
  }));

  app.post("/api/models/check", async (request, reply) => {
    const body = request.body as { model?: { providerId?: string; modelId?: string }; kind?: "chat" | "classifier" };
    if (typeof body?.model?.providerId !== "string" || typeof body?.model.modelId !== "string") {
      return reply.code(400).send({ message: "缺少模型标识" });
    }
    return runtime.catalog.check(
      { providerId: body.model.providerId, modelId: body.model.modelId },
      body.kind === "classifier" ? "classifier" : "chat",
    );
  });

  // ---------------------------------------------------------------- employees

  app.post("/api/employees", async (request) => {
    const employee = await createEmployee(runtime, request.body as never);
    await installEmployeeExtension(resume, employee);
    return toEmployeeDTO(employee);
  });

  app.patch("/api/employees/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if ((await findEmployee(runtime, id)) === undefined) return reply.code(404).send({ message: "员工不存在" });
    const employee = await updateEmployee(runtime, id, request.body as never);
    await installEmployeeExtension(resume, employee);
    return toEmployeeDTO(employee);
  });

  app.delete("/api/employees/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if ((await findEmployee(runtime, id)) === undefined) return reply.code(404).send({ message: "员工不存在" });
    const employee = await findEmployee(runtime, id);
    await runtime.harness.commit((tx) => tx.retireDoc(EmployeeDoc, id), runtime.ctx);
    if (employee !== undefined) runtime.registry.uninstall({ name: `employee:${employee.id}` });
    runtime.emit({ type: "employees" });
    return { ok: true };
  });

  // -------------------------------------------------------------------- rooms

  app.get("/api/rooms", async () => listRoomDTOs(runtime, "user"));

  app.post("/api/rooms", async (request, reply) => {
    const body = request.body as {
      kind?: "channel" | "dm" | "mail";
      name?: string;
      topic?: string;
      employeeId?: string;
      directories?: RoomDirectoryDraftDTO;
    };
    if (body?.kind !== "channel" && body?.kind !== "dm" && body?.kind !== "mail") {
      return reply.code(400).send({ message: "会话类型无效" });
    }
    if (typeof body.name !== "string" || body.name.trim().length === 0) {
      return reply.code(400).send({ message: "缺少名称" });
    }
    if (body.employeeId !== undefined && body.employeeId.length > 0) {
      const employee = await findEmployee(runtime, body.employeeId);
      if (employee === undefined) return reply.code(404).send({ message: "员工不存在" });
      if (body.kind === "dm") {
        const existing = (await listRoomDTOs(runtime, "user")).find(
          (room) => room.employeeId === body.employeeId && room.kind === "dm",
        );
        if (existing !== undefined) return existing;
      }
      return toRoomDTO(
        await createRoom(runtime, {
          kind: body.kind,
          name: body.name,
          topic: body.topic ?? "",
          employeeId: body.employeeId,
          memberIds: [body.employeeId],
          directories: body.directories,
        }),
      );
    }
    return toRoomDTO(await createRoom(runtime, { kind: body.kind, name: body.name, topic: body.topic ?? "", directories: body.directories }));
  });

  app.patch("/api/rooms/:id/directories", async (request) => {
    const { id } = request.params as { id: string };
    const room = await updateRoomDirectories(runtime, id, request.body as RoomDirectoryPatchDTO);
    await invalidateRoomDirectoryGrants(runtime, room.id, room.directories.version);
    const dto = await roomDTOWithUnread(runtime, room, "user");
    runtime.emit({ type: "room", room: dto });
    return dto;
  });

  app.get("/api/rooms/:id/messages", async (request, reply) => {
    const { id } = request.params as { id: string };
    const room = await findRoom(runtime, id);
    if (room === undefined) return reply.code(404).send({ message: "会话不存在" });
    return { room: toRoomDTO(room), messages: await listRoomMessages(runtime, room) };
  });

  /**
   * Send a message, or write a mail.
   *
   * A mail names its own recipients: every employee in To is asked to work on
   * it (asynchronously, one work each), the people in CC only receive a copy,
   * and a draft is stored without addressing anyone at all.
   */
  app.post("/api/rooms/:id/messages", async (request, reply) => {
    const { id } = request.params as { id: string };
    const room = await findRoom(runtime, id);
    if (room === undefined) return reply.code(404).send({ message: "会话不存在" });
    const body = request.body as {
      body?: string;
      employeeId?: string;
      subject?: string;
      to?: string[];
      cc?: string[];
      draft?: boolean;
      inReplyTo?: string;
    };
    const text = typeof body?.body === "string" ? body.body.trim() : "";
    if (text.length === 0) return reply.code(400).send({ message: "消息内容为空" });

    const appRecord = await readApp(runtime);
    const author = {
      type: "user" as const,
      id: "user",
      name: appRecord.userName.length > 0 ? appRecord.userName : "你",
      address: appRecord.userAddress,
    };

    if (room.kind === "mail") {
      if (body.inReplyTo !== undefined && (typeof body.inReplyTo !== "string" ||
        (body.inReplyTo.length > 0 && !(await isSentMailEntry(runtime, room, body.inReplyTo))))) {
        return reply.code(400).send({ message: "inReplyTo 必须引用当前会话内的已发送邮件" });
      }
      const addressed = await resolveMailAddresses(runtime, body?.to ?? [], body?.cc ?? []);
      if (typeof addressed === "string") return reply.code(400).send({ message: addressed });
      const subject = (typeof body.subject === "string" ? body.subject : "").trim();
      const message = await appendRoomMessage(
        runtime,
        room,
        messageData({
          author,
          body: text,
          mail: mailEnvelope({
            subject: subject.length > 0 ? subject : room.name,
            ...addressed,
            sent: body?.draft !== true,
            draft: body?.draft === true,
            inReplyTo: body.inReplyTo,
          }),
        }),
      );
      if (body?.draft === true) return { message };
      const workIds = await wakeMailRecipients(resume, room, message, addressed.recipients, text);
      return { message, ...(workIds.length > 0 ? { workId: workIds[0] } : {}), workIds };
    }

    const message = await appendRoomMessage(runtime, room, messageData({ author, body: text }));
    const targetId = typeof body.employeeId === "string" && body.employeeId.length > 0 ? body.employeeId : room.employeeId;
    if (targetId.length === 0) return { message };
    try {
      const work = await startWork(resume, {
        roomId: room.id,
        employeeId: targetId,
        intent: text,
        kind: "message",
        sourceEntryId: message.id,
      });
      return { message, workId: work.id };
    } catch (error) {
      return { message, error: error instanceof Error ? error.message : String(error) };
    }
  });

  /** Send a stored draft: it becomes a delivered mail and its To wakes up. */
  app.post("/api/rooms/:id/mail-send", async (request, reply) => {
    const { id } = request.params as { id: string };
    const room = await findRoom(runtime, id);
    if (room === undefined) return reply.code(404).send({ message: "会话不存在" });
    const body = request.body as { entryId?: string };
    if (typeof body?.entryId !== "string" || body.entryId.length === 0) {
      return reply.code(400).send({ message: "缺少草稿 id" });
    }
    const messages = await listRoomMessages(runtime, room);
    const draft = messages.find((message) => message.id === body.entryId);
    if (draft?.mail === undefined) return reply.code(404).send({ message: "草稿不存在" });
    if (!draft.mail.draft) return reply.code(409).send({ message: "这封邮件已经发送" });

    const appRecord = await readApp(runtime);
    const addressed = {
      to: draft.mail.to,
      cc: draft.mail.cc,
      recipients: draft.mail.recipients,
      copies: draft.mail.copies,
    };
    const message = await appendRoomMessage(
      runtime,
      room,
      messageData({
        author: {
          type: "user",
          id: "user",
          name: appRecord.userName.length > 0 ? appRecord.userName : "你",
          address: appRecord.userAddress,
        },
        body: draft.body,
        mail: mailEnvelope({ subject: draft.mail.subject, ...addressed, sent: true, inReplyTo: draft.mail.inReplyTo }),
      }),
    );
    // The draft is retired rather than deleted: entries are immutable, so the
    // sent mail is a new entry and the draft stops being part of the thread.
    await setMailFlag(runtime, room.id, draft.id, { active: false });
    const workIds = await wakeMailRecipients(resume, room, message, addressed.recipients, draft.body);
    return { message, workIds, ...(workIds.length > 0 ? { workId: workIds[0] } : {}) };
  });

  app.post("/api/rooms/:id/mail-flag", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { entryId?: string; read?: boolean; archived?: boolean; active?: boolean };
    if (typeof body?.entryId !== "string") return reply.code(400).send({ message: "缺少邮件 id" });
    // "active" retires a draft: it is the only mutable part of a mail entry,
    // which is otherwise immutable.
    await setMailFlag(runtime, id, body.entryId, {
      read: body.read,
      archived: body.archived,
      active: body.active,
    });
    const room = await findRoom(runtime, id);
    if (room === undefined) return { ok: true, messages: [] };
    // The badge is recomputed here: emitting a room with a default count would
    // silently clear the sidebar's unread number on every flag change.
    const dto = await roomDTOWithUnread(runtime, room);
    runtime.emit({ type: "room", room: dto });
    return { ok: true, messages: await listRoomMessages(runtime, room), room: dto };
  });

  /**
   * Every mail the user is part of, newest first.
   *
   * Folders are a client-side view of this list: the server only decides what
   * belongs to the user's mailbox, which is mail they wrote or were addressed
   * in, including drafts nobody else can see yet.
   */
  app.get("/api/mail", async () => {
    const appRecord = await readApp(runtime);
    const items: MailboxItemDTO[] = [];
    const rooms = (await listRoomDTOs(runtime, "user")).filter((room) => room.kind === "mail");
    for (const room of rooms) {
      const record = await findRoom(runtime, room.id);
      if (record === undefined) continue;
      for (const message of await listRoomMessages(runtime, record)) {
        const mail = message.mail;
        if (mail === undefined) continue;
        const mine =
          message.author.id === "user" ||
          mail.to.some((entry) => entry.address === appRecord.userAddress) ||
          mail.cc.some((entry) => entry.address === appRecord.userAddress);
        if (!mine) continue;
        items.push({ roomId: room.id, roomName: room.name, message });
      }
    }
    return { items };
  });

  // -------------------------------------------------------------------- work

  app.get("/api/works", async () => workDTOs());

  app.post("/api/works/:id/stop", async (request, reply) => {
    const { id } = request.params as { id: string };
    const work = await stopWork(runtime, id);
    if (work === undefined) return reply.code(404).send({ message: "工作不存在" });
    return { ok: true };
  });

  // --------------------------------------------------------------- approvals

  app.get("/api/approvals", async () => {
    const appRecord = await readApp(runtime);
    await invalidateStaleGrants(runtime, appRecord.policyVersion);
    return { approvals: (await listApprovals(runtime)).map(toApprovalDTO), policyVersion: appRecord.policyVersion };
  });

  app.post("/api/approvals/:id/decision", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { decision?: string; comment?: string };
    if (body?.decision !== "approved" && body?.decision !== "rejected") {
      return reply.code(400).send({ message: "裁决必须是 approved 或 rejected" });
    }
    const record = await findApproval(runtime, id);
    if (record === undefined) return reply.code(404).send({ message: "审批不存在" });
    if (record.status !== "pending-human" && record.status !== "evaluating") {
      return reply.code(409).send({ message: `审批已处于 ${record.status} 状态` });
    }
    const updated = (await runtime.updateFamily(ApprovalDoc, id, { id }, (doc) => {
      if (doc.status !== "pending-human" && doc.status !== "evaluating") return;
      const now = Date.now();
      doc.status = body.decision === "approved" ? "approved" : "rejected";
      doc.decidedAt = now;
      doc.decidedBy = "user";
      doc.comment = body.comment ?? "";
      doc.updatedAt = now;
      doc.autoDecisionSource = "human";
      doc.autoDecisionReason = body.decision === "approved" ? "由你批准" : "由你拒绝";
      doc.timeline = [
        ...doc.timeline,
        { at: now, actor: "你", text: body.decision === "approved" ? "批准执行" : "拒绝执行" },
      ];
    })) as ApprovalRecord;
    runtime.emit({ type: "approval", approval: toApprovalDTO(updated) });
    return toApprovalDTO(updated);
  });

  // ------------------------------------------------------------------ skills

  app.get("/api/skills", async () => ({ skills: (await listSkills(runtime)).map(toSkillDTO) }));

  app.post("/api/skills/import", async (request, reply) => {
    const body = request.body as { directory?: string };
    if (typeof body?.directory !== "string" || body.directory.trim().length === 0) {
      return reply.code(400).send({ message: "缺少目录路径" });
    }
    const result: SkillImportResult = await importSkillDirectory(runtime, body.directory.trim());
    return result;
  });

  app.delete("/api/skills/:id", async (request) => {
    await deleteSkill(runtime, (request.params as { id: string }).id);
    return { ok: true };
  });

  // --------------------------------------------------------------------- mcp

  app.get("/api/mcp", async () => ({ servers: (await mcp.listServers()).map(toMcpServerDTO) }));

  app.post("/api/mcp", async (request) => toMcpServerDTO(await mcp.saveServer(request.body as never)));

  app.delete("/api/mcp/:id", async (request) => {
    await mcp.removeServer((request.params as { id: string }).id);
    return { ok: true };
  });

  app.post("/api/mcp/:id/connect", async (request) => mcp.connect((request.params as { id: string }).id));

  app.post("/api/mcp/connect-enabled", async () => {
    await mcp.connectEnabled();
    return { servers: (await mcp.listServers()).map(toMcpServerDTO) };
  });

  // --------------------------------------------------------------- providers

  app.get("/api/providers/custom", async () => ({ providers: runtime.customProviders() }));

  app.put("/api/providers/custom", async (request, reply) => {
    const body = request.body as { providers?: unknown };
    if (!Array.isArray(body?.providers)) return reply.code(400).send({ message: "缺少 providers" });
    const updated = await runtime.storeCustomProviders(body.providers);
    return {
      providers: updated.providers,
      statuses: await runtime.catalog.providerStatuses(),
    };
  });

  app.delete("/api/providers/:id/credential", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (runtime.catalog.models.getProvider(id) === undefined) {
      return reply.code(404).send({ message: "Provider 不存在" });
    }
    // Wait out a login before deleting: otherwise a late commit could put the
    // credential straight back after the user asked to remove it.
    await runtime.providerAuth.cancelProvider(id);
    await runtime.catalog.models.logout(id);
    return { ok: true };
  });

  app.post("/api/providers/:id/refresh", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (runtime.catalog.models.getProvider(id) === undefined) {
      return reply.code(404).send({ message: "Provider 不存在" });
    }
    const result = await runtime.catalog.refresh({ allowNetwork: true, providers: [id], force: true });
    const failure = result.errors.get(id);
    if (failure !== undefined) return { ok: false, message: failure.message };
    return { ok: true, message: "模型目录已刷新" };
  });

  // ------------------------------------------------------------ provider auth

  app.post("/api/auth/sessions", async (request, reply) => {
    const body = request.body as { providerId?: unknown; type?: unknown };
    if (typeof body?.providerId !== "string" || (body.type !== "api_key" && body.type !== "oauth")) {
      return reply.code(400).send({ message: "缺少 providerId 或认证方式无效" });
    }
    return reply.code(201).send(runtime.providerAuth.start(body.providerId, body.type));
  });

  app.get("/api/auth/sessions/:id", async (request) => {
    const { id } = request.params as { id: string };
    return runtime.providerAuth.get(id);
  });

  app.post("/api/auth/sessions/:id/respond", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { promptId?: unknown; value?: unknown };
    if (typeof body?.promptId !== "string" || typeof body.value !== "string") {
      return reply.code(400).send({ message: "缺少 promptId 或回答" });
    }
    return runtime.providerAuth.respond(id, body.promptId, body.value);
  });

  app.delete("/api/auth/sessions/:id", async (request) => {
    const { id } = request.params as { id: string };
    return runtime.providerAuth.cancel(id);
  });


/**
 * Resolve the employee ids on a mail into addresses and wake ids.
 *
 * The user is a valid recipient and never starts work; an unknown id is a
 * client error rather than something silently dropped.
 */
async function resolveMailAddresses(
  runtime: EmitRuntime,
  to: readonly string[],
  cc: readonly string[],
): Promise<
  | string
  | { to: MailAddress[]; cc: MailAddress[]; recipients: string[]; copies: string[] }
> {
  const app = await readApp(runtime);
  const employees = await listEmployees(runtime);
  const resolve = (ids: readonly string[]): MailAddress[] | string => {
    const addresses: MailAddress[] = [];
    for (const id of ids) {
      if (id === "user") {
        addresses.push({ name: app.userName.length > 0 ? app.userName : "你", address: app.userAddress });
        continue;
      }
      const employee = employees.find((entry) => entry.id === id);
      if (employee !== undefined) {
        addresses.push({ name: employee.name, address: employee.address });
        continue;
      }
      // A typed address is kept as written: it is a place the mail was sent,
      // not an employee that can be woken.
      if (isTypedAddress(id)) {
        addresses.push({ name: "", address: id });
        continue;
      }
      return `找不到收件人 ${id}`;
    }
    return addresses;
  };
  const toAddresses = resolve(to);
  if (typeof toAddresses === "string") return toAddresses;
  const ccAddresses = resolve(cc);
  if (typeof ccAddresses === "string") return ccAddresses;
  const employeesOnly = (ids: readonly string[]): string[] =>
    ids.filter((id) => id !== "user" && employees.some((employee) => employee.id === id));
  return {
    to: toAddresses,
    cc: ccAddresses,
    recipients: employeesOnly(to),
    copies: employeesOnly(cc),
  };
}

/** A typed recipient: one "@" and no whitespace, which is all in-app mail needs. */
function isTypedAddress(value: string): boolean {
  const parts = value.split("@");
  return parts.length === 2 && parts[0]!.length > 0 && parts[1]!.length > 0 && !/\s/.test(value);
}

/** Ask every employee addressed in To to work on one mail; CC is never woken. */
async function wakeMailRecipients(
  resume: Resume,
  room: { id: string },
  message: { id: string },
  recipients: readonly string[],
  body: string,
): Promise<string[]> {
  const { runtime } = resume;
  const unique = [...new Set(recipients)];
  const workIds: string[] = [];
  const failures: string[] = [];
  for (const employeeId of unique) {
    try {
      const work = await startWork(resume, {
        roomId: room.id,
        employeeId,
        intent: body,
        kind: "mail",
        sourceEntryId: message.id,
      });
      workIds.push(work.id);
    } catch (error) {
      // One recipient who cannot start (disabled, missing model) must not
      // swallow the mail for the others, but it must not be silent either.
      const employee = await runtime.readFamily(EmployeeDoc, employeeId, { id: employeeId });
      failures.push(`${employee?.name ?? employeeId}：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length > 0) {
    const record = await findRoom(runtime, room.id);
    if (record !== undefined) {
      await appendRoomMessage(
        runtime,
        record,
        messageData({
          author: { type: "system", id: "system", name: "系统" },
          body: `这封邮件有收件人无法开始处理：\n${failures.join("\n")}`,
          notice: true,
        }),
      );
    }
  }
  return workIds;
}

  // ------------------------------------------------------------------ static

  if (options.webRoot !== undefined && existsSync(options.webRoot)) {
    // Serve whatever is on disk: a rebuild changes the hashed asset names, and
    // a route-per-file registration would keep serving the previous build's
    // HTML against files that no longer exist.
    await app.register(fastifyStatic, { root: options.webRoot, index: ["index.html"] });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) return reply.code(404).send({ message: "接口不存在" });
      return reply.sendFile("index.html");
    });
  }

  return app;
}
