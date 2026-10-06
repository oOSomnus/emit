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
import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import type {
  ApiErrorBody,
  MailboxItemDTO,
  ServerEvent,
  SessionExportRequestDTO,
  WorkContextDraftDTO,
  WorkContextPatchDTO,
  WorkNoteCreateDTO,
  WorkNoteDeleteDTO,
  WorkNotePatchDTO,
} from "../shared/contracts.ts";
import type { EmitRuntime } from "./runtime.ts";
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
import { SessionExportError, SessionExportService } from "./session-export.ts";
import { toMcpServerDTO } from "./mcp.ts";
import { ProviderAuthError } from "./provider-auth.ts";
import { CANONICAL_LOCALE } from "../shared/i18n.ts";
import { appMessages, fromError, type AppText } from "./messages.ts";
import { apiMessages } from "./messages/api.ts";
import { approvalMessages } from "./messages/approval.ts";
import {
  appendRoomMessageIn,
  createRoom,
  ensureEmployeeDm,
  findRoom,
  listRoomDTOs,
  listRoomMessages,
  mailEnvelope,
  messageData,
  roomDTOWithUnread,
  setMailFlag,
  toMessageDTO,
  toRoomDTO,
  type MailAddress,
  RoomError,
  isSentMailEntry,
  updateRoomMembers,
} from "./rooms.ts";
import {
  installEmployeeExtension,
  listWorks,
  stopWork,
  type Resume,
} from "./work.ts";
import { isTerminal } from "./work-queue.ts";
import { sendQueuedMail } from "./mail.ts";
import { sendQueuedMessage } from "./channel-messages.ts";
import { WorkExecutionCursorError, readWorkExecution } from "./work-execution.ts";
import {
  findApproval,
  invalidateStaleGrants,
  invalidateWorkContextDirectoryGrants,
  listApprovals,
  toApprovalDTO,
} from "./approval/state.ts";
import {
  createWorkContext,
  createWorkNote,
  deleteWorkNote,
  findWorkContext,
  findWorkNote,
  listWorkContexts,
  resolveUserNoteSource,
  toWorkContextDTO,
  updateWorkContext,
  updateWorkNote,
  WorkContextError,
} from "./work-contexts.ts";
import { toWorkDTO } from "./dto.ts";
import { ApprovalDoc, EmployeeDoc, type ApprovalRecord } from "./documents.ts";

export type ApiOptions = {
  resume: Resume;
  webRoot: string | undefined;
};

const MAX_BODY = 200_000;

/**
 * One application message as the HTTP layer sends it: the original text plus
 * its translation pair when one exists.
 */
function messageBody(value: AppText): ApiErrorBody {
  return { message: value.text, ...(value.localized === undefined ? {} : { messageLocalized: value.localized }) };
}

export async function buildServer(options: ApiOptions): Promise<FastifyInstance> {
  const { resume } = options;
  const { runtime, mcp } = resume;
  // The event stream is a connection that never ends on its own, so a plain
  // close would wait for it forever; connections are dropped on shutdown.
  const app = Fastify({ logger: false, bodyLimit: MAX_BODY, forceCloseConnections: true });

  // A rejected input answers with its reason; non-client errors stay 500.
  app.setErrorHandler((error, _request, reply) => {
    const message = fromError(error);
    if (error instanceof ValidationError) return reply.code(400).send(messageBody(message));
    if (error instanceof RoomError || error instanceof WorkContextError) {
      return reply.code(error.status).send(messageBody(message));
    }
    if (error instanceof ProviderAuthError) return reply.code(error.status).send(messageBody(message));
    if (error instanceof SessionExportError) return reply.code(error.status).send(messageBody(message));
    if (typeof error === "object" && error !== null && "statusCode" in error) {
      const { statusCode } = error;
      if (typeof statusCode === "number" && Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 500) {
        return reply.code(statusCode).send(messageBody(message));
      }
    }
    return reply.code(500).send(messageBody(message));
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
      workContexts: (await listWorkContexts(runtime)).map(toWorkContextDTO),
      work: await workDTOs(),
      approvals: (await listApprovals(runtime)).map(toApprovalDTO),
      skills: (await listSkills(runtime)).map(toSkillDTO),
      mcpServers: (await mcp.listServers()).map(toMcpServerDTO),
      providers: await runtime.catalog.providerStatuses(),
      customProviders: runtime.customProviders(),
      storagePath: runtime.storagePath,
    };
  });
  // -------------------------------------------------------- work contexts

  app.get("/api/work-contexts", async () => ({
    workContexts: (await listWorkContexts(runtime)).map(toWorkContextDTO),
  }));

  app.post("/api/work-contexts", async (request) =>
    toWorkContextDTO(await createWorkContext(runtime, request.body as WorkContextDraftDTO)),
  );

  app.get("/api/work-contexts/:id", async (request) => {
    const { id } = request.params as { id: string };
    const workContext = await findWorkContext(runtime, id);
    if (workContext === undefined) throw new WorkContextError(404, appMessages.workContexts.notFound(id));
    return toWorkContextDTO(workContext);
  });

  app.patch("/api/work-contexts/:id", async (request) => {
    const { id } = request.params as { id: string };
    const patch = request.body as WorkContextPatchDTO;
    if (!Number.isInteger(patch?.expectedVersion)) {
      throw new WorkContextError(400, appMessages.workContexts.expectedVersionNotAnInteger);
    }
    const before = await findWorkContext(runtime, id);
    if (before === undefined) throw new WorkContextError(404, appMessages.workContexts.notFound(id));
    const updated = await updateWorkContext(runtime, id, patch);
    if (before.directories.version !== updated.directories.version) {
      await invalidateWorkContextDirectoryGrants(runtime, id, updated.directories.version);
    }
    return toWorkContextDTO(updated);
  });
  app.post("/api/work-contexts/:id/notes", async (request) => {
    const { id } = request.params as { id: string };
    const body = request.body as WorkNoteCreateDTO;
    if (!Number.isInteger(body?.expectedVersion)) {
      throw new WorkContextError(400, appMessages.workContexts.expectedVersionNotAnInteger);
    }
    if ((await findWorkContext(runtime, id)) === undefined) {
      throw new WorkContextError(404, appMessages.workContexts.notFound(id));
    }
    if (body.source !== undefined && (typeof body.source !== "object" || body.source === null)) {
      throw new WorkContextError(400, appMessages.workContexts.noteSourceInvalid);
    }
    const source = await resolveUserNoteSource(runtime, id, body?.source);
    return createWorkNote(runtime, id, {
      title: body?.title,
      body: body?.body,
      expectedVersion: body.expectedVersion,
      ...source,
    });
  });
  app.patch("/api/work-contexts/:id/notes/:noteId", async (request) => {
    const { id, noteId } = request.params as { id: string; noteId: string };
    const body = request.body as WorkNotePatchDTO;
    if (!Number.isInteger(body?.expectedVersion)) {
      throw new WorkContextError(400, appMessages.workContexts.expectedVersionNotAnInteger);
    }
    const workContext = await findWorkContext(runtime, id);
    if (workContext === undefined) throw new WorkContextError(404, appMessages.workContexts.notFound(id));
    const current = findWorkNote(workContext, noteId);
    if (current === undefined) throw new WorkContextError(404, appMessages.workContexts.noteNotFound(noteId));
    return updateWorkNote(runtime, id, noteId, {
      title: body?.title,
      body: body?.body,
      expectedVersion: body.expectedVersion,
      authorId: "user",
      sourceRoomId: current.sourceRoomId,
      sourceEntryId: current.sourceEntryId,
      sourceWorkId: current.sourceWorkId,
    });
  });
  app.delete("/api/work-contexts/:id/notes/:noteId", async (request) => {
    const { id, noteId } = request.params as { id: string; noteId: string };
    const body = request.body as WorkNoteDeleteDTO;
    if (!Number.isInteger(body?.expectedVersion)) {
      throw new WorkContextError(400, appMessages.workContexts.expectedVersionNotAnInteger);
    }
    return toWorkContextDTO(await deleteWorkNote(runtime, id, noteId, body.expectedVersion));
  });

  app.get("/api/work-contexts/:id/notes/:noteId", async (request) => {
    const { id, noteId } = request.params as { id: string; noteId: string };
    const workContext = await findWorkContext(runtime, id);
    if (workContext === undefined) throw new WorkContextError(404, appMessages.workContexts.notFound(id));
    const note = findWorkNote(workContext, noteId);
    if (note === undefined) throw new WorkContextError(404, appMessages.workContexts.noteNotFound(noteId));
    return note;
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
      userName?: unknown;
      defaultExecutionModel?: unknown;
      approval?: unknown;
    };
    if (typeof body?.userName !== "string") {
      return reply.code(400).send(messageBody(apiMessages.missingUserName));
    }
    const saved = await setupWorkspace(runtime, {
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
      return reply.code(400).send(messageBody(apiMessages.missingModelRef));
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
    if ((await findEmployee(runtime, id)) === undefined) return reply.code(404).send(messageBody(apiMessages.employeeNotFound));
    const employee = await updateEmployee(runtime, id, request.body as never);
    await installEmployeeExtension(resume, employee);
    return toEmployeeDTO(employee);
  });

  app.delete("/api/employees/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if ((await findEmployee(runtime, id)) === undefined) return reply.code(404).send(messageBody(apiMessages.employeeNotFound));
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
      workContextId?: unknown;
      employeeId?: string;
      memberIds?: string[];
    };
    if (body?.kind !== "channel" && body?.kind !== "dm" && body?.kind !== "mail") {
      return reply.code(400).send(messageBody(apiMessages.invalidRoomKind));
    }
    if (typeof body.name !== "string" || body.name.trim().length === 0) {
      return reply.code(400).send(messageBody(apiMessages.missingRoomName));
    }
    if (body.memberIds !== undefined && !Array.isArray(body.memberIds)) {
      return reply.code(400).send(messageBody(appMessages.rooms.membersNotAnArray));
    }
    if (body.memberIds?.some((memberId) => typeof memberId !== "string")) {
      return reply.code(400).send(messageBody(appMessages.rooms.messageUnexpectedType));
    }
    if (typeof body.workContextId !== "string" || body.workContextId.length === 0) {
      return reply.code(400).send(messageBody(appMessages.rooms.workContextMissing("")));
    }
    const workContextId = body.workContextId;
    if (body.kind === "dm") {
      if (typeof body.employeeId !== "string" || body.employeeId.length === 0) {
        throw new RoomError(400, appMessages.rooms.dmParticipantsInvalid);
      }
      const employee = await findEmployee(runtime, body.employeeId);
      if (employee === undefined) return reply.code(404).send(messageBody(apiMessages.employeeNotFound));
      if (!employee.enabled) {
        return reply.code(400).send(messageBody(appMessages.workContexts.employeeDisabled(employee.name)));
      }
      const { room } = await ensureEmployeeDm(runtime, {
        workContextId,
        participantIds: ["user", body.employeeId],
        name: body.name,
        topic: body.topic ?? "",
        employeeId: body.employeeId,
      });
      return toRoomDTO(room);
    }
    return toRoomDTO(
      await createRoom(runtime, {
        kind: body.kind,
        name: body.name,
        topic: body.topic ?? "",
        workContextId,
        memberIds: body.kind === "channel" ? body.memberIds : [],
      }),
    );
  });

  app.patch("/api/rooms/:id/members", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { memberIds?: unknown; expectedVersion?: unknown };
    if (!Array.isArray(body?.memberIds)) {
      return reply.code(400).send(messageBody(appMessages.rooms.membersNotAnArray));
    }
    if (!body.memberIds.every((memberId) => typeof memberId === "string")) {
      return reply.code(400).send(messageBody(appMessages.rooms.messageUnexpectedType));
    }
    if (!Number.isInteger(body.expectedVersion)) {
      return reply.code(400).send(messageBody(appMessages.rooms.expectedVersionNotAnInteger));
    }
    const result = await updateRoomMembers(
      runtime,
      id,
      body.memberIds,
      body.expectedVersion,
    );
    if (result.removed.length > 0) {
      const removed = new Set(result.removed);
      const activeWorks = (await listWorks(runtime)).filter(
        (work) => work.roomId === id && removed.has(work.employeeId) && !isTerminal(work.status),
      );
      for (const work of activeWorks) await stopWork(resume, work.id);
    }
    return roomDTOWithUnread(runtime, result.room, "user");
  });

  app.get("/api/rooms/:id/messages", async (request, reply) => {
    const { id } = request.params as { id: string };
    const room = await findRoom(runtime, id);
    if (room === undefined) return reply.code(404).send(messageBody(apiMessages.roomNotFound));
    return { room: toRoomDTO(room), messages: await listRoomMessages(runtime, room) };
  });

  /**
   * Send a message, or write a mail.
   *
   * A mail names its own recipients: every employee in To is asked to work on
   * it (asynchronously, one work each), the people in CC only receive a copy,
   * and a draft is stored without waking any recipients.
   */
  app.post("/api/rooms/:id/messages", async (request, reply) => {
    const { id } = request.params as { id: string };
    const room = await findRoom(runtime, id);
    if (room === undefined) return reply.code(404).send(messageBody(apiMessages.roomNotFound));
    const body = request.body as {
      body?: unknown;
      recipientIds?: unknown;
      mentionAll?: unknown;
      subject?: string;
      to?: string[];
      cc?: string[];
      draft?: boolean;
      inReplyTo?: string;
    };
    if (typeof body?.body !== "string") {
      return reply.code(400).send(messageBody(appMessages.rooms.messageUnexpectedType));
    }
    const text = body.body.trim();
    if (text.length === 0) return reply.code(400).send(messageBody(apiMessages.emptyMessageBody));
    if (
      body.recipientIds !== undefined &&
      (!Array.isArray(body.recipientIds) || !body.recipientIds.every((recipientId) => typeof recipientId === "string"))
    ) {
      return reply.code(400).send(messageBody(appMessages.rooms.messageUnexpectedType));
    }
    if (body.mentionAll !== undefined && typeof body.mentionAll !== "boolean") {
      return reply.code(400).send(messageBody(appMessages.rooms.messageUnexpectedType));
    }
    if (
      room.kind === "mail" &&
      ((body.to !== undefined && (!Array.isArray(body.to) || !body.to.every((recipient) => typeof recipient === "string"))) ||
        (body.cc !== undefined && (!Array.isArray(body.cc) || !body.cc.every((recipient) => typeof recipient === "string"))))
    ) {
      return reply.code(400).send(messageBody(appMessages.rooms.messageUnexpectedType));
    }

    const appRecord = await readApp(runtime);
    const author = {
      type: "user" as const,
      id: "user",
      name: appRecord.userName.length > 0 ? appRecord.userName : appMessages.rooms.userFallbackAuthorName[CANONICAL_LOCALE],
      address: appRecord.userAddress,
    };

    if (room.kind === "mail") {
      const subject = (typeof body.subject === "string" ? body.subject : "").trim();
      if (body.draft === true) {
        if (body.inReplyTo !== undefined && (typeof body.inReplyTo !== "string" ||
          (body.inReplyTo.length > 0 && !(await isSentMailEntry(runtime, room, body.inReplyTo))))) {
          return reply.code(400).send(messageBody(apiMessages.inReplyToNotSentMail));
        }
        const addressedDraft = await resolveMailAddresses(runtime, body.to ?? [], body.cc ?? []);
        if ("text" in addressedDraft) return reply.code(400).send(messageBody(addressedDraft));
        const data = messageData({
          author,
          body: text,
          mail: mailEnvelope({
            subject: subject.length > 0 ? subject : room.name,
            ...addressedDraft,
            sent: false,
            draft: true,
            inReplyTo: body.inReplyTo,
          }),
        });
        const entry = await runtime.harness.commit(
          (tx) => appendRoomMessageIn(tx, room, data),
          runtime.ctx,
        );
        const message = toMessageDTO(entry);
        if (message === undefined) throw new RoomError(400, appMessages.rooms.messageUnexpectedType);
        message.roomId = room.id;
        runtime.emit({ type: "message", roomId: room.id, message });
        const savedRoom = await findRoom(runtime, room.id);
        if (savedRoom !== undefined) {
          runtime.emit({ type: "room", room: await roomDTOWithUnread(runtime, savedRoom) });
        }
        return { message, workIds: [] };
      }
      if (body.inReplyTo !== undefined && (typeof body.inReplyTo !== "string" ||
        (body.inReplyTo.length > 0 && !(await isSentMailEntry(runtime, room, body.inReplyTo))))) {
        return reply.code(400).send(messageBody(apiMessages.inReplyToNotSentMail));
      }
      const addressed = await resolveMailAddresses(runtime, body.to ?? [], body.cc ?? []);
      if ("text" in addressed) return reply.code(400).send(messageBody(addressed));
      return sendQueuedMail(resume, {
        room: { id: room.id },
        data: messageData({
          author,
          body: text,
          mail: mailEnvelope({
            subject: subject.length > 0 ? subject : room.name,
            ...addressed,
            sent: true,
            draft: false,
            inReplyTo: body.inReplyTo,
          }),
        }),
      });
    }

    return sendQueuedMessage(resume, {
      roomId: room.id,
      author,
      body: text,
      recipientIds: body.recipientIds as string[] | undefined,
      mentionAll: body.mentionAll as boolean | undefined,
    });
  });

  /** Send a stored draft or compose a new mail thread. */
  app.post("/api/rooms/:id/mail-send", async (request, reply) => {
    const { id } = request.params as { id: string };
    const room = await findRoom(runtime, id);
    const body = request.body as {
      entryId?: unknown;
      workContextId?: string;
      subject?: string;
      body?: unknown;
      to?: unknown;
      cc?: unknown;
      draft?: boolean;
      inReplyTo?: string;
    };
    if (typeof body?.entryId === "string" && body.entryId.length > 0) {
      if (room === undefined) return reply.code(404).send(messageBody(apiMessages.roomNotFound));
      const messages = await listRoomMessages(runtime, room);
      const draft = messages.find((message) => message.id === body.entryId);
      if (draft?.mail === undefined) return reply.code(404).send(messageBody(apiMessages.draftNotFound));
      if (!draft.mail.draft) return reply.code(409).send(messageBody(apiMessages.mailAlreadySent));
      const appRecord = await readApp(runtime);
      return sendQueuedMail(resume, {
        room: { id: room.id },
        data: messageData({
          author: {
            type: "user",
            id: "user",
            name: appRecord.userName.length > 0 ? appRecord.userName : appMessages.rooms.userFallbackAuthorName[CANONICAL_LOCALE],
            address: appRecord.userAddress,
          },
          body: draft.body,
          mail: mailEnvelope({
            subject: draft.mail.subject,
            to: draft.mail.to,
            cc: draft.mail.cc,
            recipients: draft.mail.recipients,
            copies: draft.mail.copies,
            sent: true,
            inReplyTo: draft.mail.inReplyTo,
          }),
        }),
        retireDraftId: draft.id,
      });
    }
    if (body?.entryId !== undefined) {
      return reply.code(400).send(messageBody(apiMessages.missingDraftId));
    }
    if (body?.draft !== undefined && typeof body.draft !== "boolean") {
      return reply.code(400).send(messageBody(appMessages.rooms.messageUnexpectedType));
    }
    if (body?.subject !== undefined && typeof body.subject !== "string") {
      return reply.code(400).send(messageBody(appMessages.rooms.messageUnexpectedType));
    }
    if (body?.inReplyTo !== undefined && typeof body.inReplyTo !== "string") {
      return reply.code(400).send(messageBody(apiMessages.inReplyToNotSentMail));
    }
    if (room === undefined && body?.workContextId !== undefined && typeof body.workContextId !== "string") {
      return reply.code(400).send(messageBody(appMessages.rooms.messageUnexpectedType));
    }
    if (room === undefined && typeof body?.workContextId !== "string") {
      return reply.code(400).send(messageBody(appMessages.rooms.workContextMissing("")));
    }
    if (room !== undefined && room.kind !== "mail") {
      return reply.code(400).send(messageBody(apiMessages.invalidRoomKind));
    }
    if (typeof body?.body !== "string") {
      return reply.code(400).send(messageBody(appMessages.rooms.messageUnexpectedType));
    }
    const text = body.body.trim();
    if (text.length === 0) return reply.code(400).send(messageBody(apiMessages.emptyMessageBody));
    if (
      (body.to !== undefined && (!Array.isArray(body.to) || !body.to.every((recipient) => typeof recipient === "string"))) ||
      (body.cc !== undefined && (!Array.isArray(body.cc) || !body.cc.every((recipient) => typeof recipient === "string")))
    ) {
      return reply.code(400).send(messageBody(appMessages.rooms.messageUnexpectedType));
    }
    const to = (body.to ?? []) as string[];
    const cc = (body.cc ?? []) as string[];
    const addressed = await resolveMailAddresses(runtime, to, cc);
    if ("text" in addressed) return reply.code(400).send(messageBody(addressed));
    if (
      room !== undefined &&
      body.inReplyTo !== undefined &&
      (typeof body.inReplyTo !== "string" ||
        (body.inReplyTo.length > 0 && !(await isSentMailEntry(runtime, room, body.inReplyTo))))
    ) {
      return reply.code(400).send(messageBody(apiMessages.inReplyToNotSentMail));
    }
    if (room === undefined && body.inReplyTo !== undefined && body.inReplyTo.length > 0) {
      return reply.code(400).send(messageBody(apiMessages.inReplyToNotSentMail));
    }
    const appRecord = await readApp(runtime);
    const author = {
      type: "user" as const,
      id: "user",
      name: appRecord.userName.length > 0 ? appRecord.userName : appMessages.rooms.userFallbackAuthorName[CANONICAL_LOCALE],
      address: appRecord.userAddress,
    };
    const subject = typeof body.subject === "string" ? body.subject.trim() : "";
    const envelope = mailEnvelope({
      subject: subject.length > 0 ? subject : room?.name ?? "",
      ...addressed,
      sent: body.draft !== true,
      draft: body.draft === true,
      inReplyTo: body.inReplyTo,
    });
    const data = messageData({ author, body: text, mail: envelope });
    if (body.draft === true) {
      const draftRoom =
        room ??
        (await createRoom(runtime, {
          kind: "mail",
          name: envelope.subject,
          workContextId: typeof body.workContextId === "string" ? body.workContextId : "",
          employeeId: "",
          memberIds: [...new Set([...addressed.recipients, ...addressed.copies])],
        }));
      const entry = await runtime.harness.commit(
        (tx) => appendRoomMessageIn(tx, draftRoom, data),
        runtime.ctx,
      );
      const message = toMessageDTO(entry);
      if (message === undefined) throw new RoomError(400, appMessages.rooms.messageUnexpectedType);
      message.roomId = draftRoom.id;
      runtime.emit({ type: "message", roomId: draftRoom.id, message });
      const savedRoom = await findRoom(runtime, draftRoom.id);
      if (savedRoom !== undefined) {
        runtime.emit({ type: "room", room: await roomDTOWithUnread(runtime, savedRoom) });
      }
      return { message, workIds: [] };
    }
    return sendQueuedMail(resume, {
      room:
        room === undefined
          ? {
              create: {
                kind: "mail",
                name: envelope.subject,
                memberIds: [...new Set([...addressed.recipients, ...addressed.copies])],
                workContextId: typeof body.workContextId === "string" ? body.workContextId : "",
                employeeId: "",
              },
            }
          : { id: room.id },
      data,
    });
  });


  app.post("/api/rooms/:id/mail-flag", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { entryId?: string; read?: boolean; archived?: boolean; active?: boolean };
    if (typeof body?.entryId !== "string") return reply.code(400).send(messageBody(apiMessages.missingMailEntryId));
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

  /** The durable record of one work: what it did, what failed, what it waits for. */
  app.get("/api/works/:id/execution", async (request, reply) => {
    const { id } = request.params as { id: string };
    const raw = (request.query as { cursor?: unknown }).cursor;
    if (raw !== undefined && typeof raw !== "string") return reply.code(400).send(messageBody(apiMessages.malformedCursor));
    try {
      const execution = await readWorkExecution(runtime, id, raw);
      if (execution === undefined) return reply.code(404).send(messageBody(apiMessages.workNotFound));
      return execution;
    } catch (error) {
      if (error instanceof WorkExecutionCursorError) return reply.code(400).send(messageBody(fromError(error)));
      throw error;
    }
  });

  app.post("/api/works/:id/stop", async (request, reply) => {
    const { id } = request.params as { id: string };
    const work = await stopWork(resume, id);
    if (work === undefined) return reply.code(404).send(messageBody(apiMessages.workNotFound));
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
      return reply.code(400).send(messageBody(approvalMessages.decisionInvalid));
    }
    const record = await findApproval(runtime, id);
    if (record === undefined) return reply.code(404).send(messageBody(approvalMessages.notFound));
    if (record.status !== "pending-human" && record.status !== "evaluating") {
      return reply.code(409).send(messageBody(approvalMessages.alreadyInStatus(record.status)));
    }
    const approved = body.decision === "approved";
    const reason = approved ? approvalMessages.humanApproved : approvalMessages.humanRejected;
    const timelineText = approved ? approvalMessages.humanTimelineApproved : approvalMessages.humanTimelineRejected;
    const updated = (await runtime.updateFamily(ApprovalDoc, id, { id }, (doc) => {
      if (doc.status !== "pending-human" && doc.status !== "evaluating") return;
      const now = Date.now();
      doc.status = approved ? "approved" : "rejected";
      doc.decidedAt = now;
      doc.decidedBy = "user";
      doc.comment = body.comment ?? "";
      doc.updatedAt = now;
      doc.autoDecisionSource = "human";
      doc.autoDecisionReason = reason.text;
      if (reason.localized !== undefined) doc.autoDecisionReasonLocalized = reason.localized;
      doc.timeline = [
        ...doc.timeline,
        {
          at: now,
          actor: approvalMessages.actorYou.text,
          text: timelineText.text,
          ...(approvalMessages.actorYou.localized === undefined
            ? {}
            : { actorLocalized: approvalMessages.actorYou.localized }),
          ...(timelineText.localized === undefined ? {} : { textLocalized: timelineText.localized }),
        },
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
      return reply.code(400).send(messageBody(apiMessages.missingSkillDirectory));
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
    if (!Array.isArray(body?.providers)) return reply.code(400).send(messageBody(apiMessages.missingProviders));
    const updated = await runtime.storeCustomProviders(body.providers);
    return {
      providers: updated.providers,
      statuses: await runtime.catalog.providerStatuses(),
    };
  });

  app.delete("/api/providers/:id/credential", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (runtime.catalog.models.getProvider(id) === undefined) {
      return reply.code(404).send(messageBody(apiMessages.providerNotFound));
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
      return reply.code(404).send(messageBody(apiMessages.providerNotFound));
    }
    const result = await runtime.catalog.refresh({ allowNetwork: true, providers: [id], force: true });
    const failure = result.errors.get(id);
    // A native refresh failure keeps its raw reason; the success line is ours.
    if (failure !== undefined) return { ok: false, message: failure.message };
    return { ok: true, ...messageBody(apiMessages.catalogRefreshed) };
  });

  // ------------------------------------------------------------ provider auth

  app.post("/api/auth/sessions", async (request, reply) => {
    const body = request.body as { providerId?: unknown; type?: unknown };
    if (typeof body?.providerId !== "string" || (body.type !== "api_key" && body.type !== "oauth")) {
      return reply.code(400).send(messageBody(apiMessages.missingAuthInput));
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
      return reply.code(400).send(messageBody(apiMessages.missingAuthResponse));
    }
    return runtime.providerAuth.respond(id, body.promptId, body.value);
  });

  app.delete("/api/auth/sessions/:id", async (request) => {
    const { id } = request.params as { id: string };
    return runtime.providerAuth.cancel(id);
  });

  // ---------------------------------------------------------- session exports

  // One coherent debug snapshot per request: the receipt names the private file
  // on disk, and the download URL lasts only for this process.
  const sessionExports = new SessionExportService(runtime);

  app.post("/api/session-exports", async (request, reply) => {
    const receipt = await sessionExports.create(request.body as SessionExportRequestDTO);
    reply.header("cache-control", "no-store");
    return reply.code(201).send(receipt);
  });

  app.get("/api/session-exports/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const artifact = sessionExports.file(id);
    if (artifact === undefined) return reply.code(404).send(messageBody(apiMessages.sessionExportNotFound));
    let size: number;
    try {
      size = (await stat(artifact.path)).size;
    } catch {
      return reply.code(404).send(messageBody(apiMessages.sessionExportNotFound));
    }
    reply
      .header("content-type", "application/json; charset=utf-8")
      .header("content-disposition", `attachment; filename="${artifact.filename}"`)
      .header("cache-control", "no-store")
      .header("content-length", size);
    return reply.send(createReadStream(artifact.path));
  });


/**
 * Resolve the employee ids on a mail into addresses and wake ids.
 *
 * The user is a valid recipient and never starts work; an unknown id is a
 * client error rather than something silently dropped. A failed resolution
 * returns the application message instead of the addressed envelope.
 */
async function resolveMailAddresses(
  runtime: EmitRuntime,
  to: readonly string[],
  cc: readonly string[],
): Promise<
  | AppText
  | { to: MailAddress[]; cc: MailAddress[]; recipients: string[]; copies: string[] }
> {
  const app = await readApp(runtime);
  const employees = await listEmployees(runtime);
  const resolve = (ids: readonly string[]): MailAddress[] | AppText => {
    const addresses: MailAddress[] = [];
    for (const id of ids) {
      if (id === "user") {
        addresses.push({ name: app.userName.length > 0 ? app.userName : appMessages.rooms.userFallbackAuthorName[CANONICAL_LOCALE], address: app.userAddress });
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
      return apiMessages.unknownRecipient(id);
    }
    return addresses;
  };
  const toAddresses = resolve(to);
  if ("text" in toAddresses) return toAddresses;
  const ccAddresses = resolve(cc);
  if ("text" in ccAddresses) return ccAddresses;
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

  // ------------------------------------------------------------------ static

  if (options.webRoot !== undefined && existsSync(options.webRoot)) {
    // Serve whatever is on disk: a rebuild changes the hashed asset names, and
    // a route-per-file registration would keep serving the previous build's
    // HTML against files that no longer exist.
    await app.register(fastifyStatic, { root: options.webRoot, index: ["index.html"] });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) return reply.code(404).send(messageBody(apiMessages.apiRouteNotFound));
      return reply.sendFile("index.html");
    });
  }

  return app;
}
