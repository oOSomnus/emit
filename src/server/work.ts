/**
 * Work: what an employee is doing, from the request to the answer.
 *
 * A room message, a mail, or a delegated task each create one work item. The
 * item gets its own execution conversation, whose every request, tool call, and
 * approval is a durable Pi Durable task. The room transcript stays the shared
 * history; the execution conversation is one work item's private scratch, which
 * is why the approval binding (`ConversationContextDoc`) can be exact.
 *
 * Delivery is where durability has to be earned. The answer is written back in
 * the same commit that marks the work finished, so a crash either leaves both
 * unwritten (and the resumed generation delivers again) or both written.
 */

import { randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import type { AssistantMessage, ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  configure,
  defineTool,
  GenerationTask,
  hook,
  UsageDoc,
  type Conversation,
  type ConversationId,
  type HookRegistration,
  type TaskId,
  type ToolExecutionApi,
  type ToolRegistration,
  type Tx,
} from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import type { Draft } from "@earendil-works/chord/delta";
import type { EmitRuntime } from "./runtime.ts";
import {
  AppDoc,
  CollaborationDoc,
  ConversationContextDoc,
  EmployeeDoc,
  MailSendReceiptDoc,
  RoomDoc,
  RoomMessageEntry,
  WorkDoc,
  type EmployeeRecord,
  type MailEnvelope,
  type MailSendReceiptRecord,
  type RoomMessageData,
  type RoomRecord,
  type WorkDirectoryScopeRecord,
  type WorkRecord,
} from "./documents.ts";
import type { McpManager } from "./mcp.ts";
import type { MailTasks } from "./mail.ts";
import type { WorkDispatchTask } from "./work-dispatch.ts";
import { buildEmployeeExtension, toThinkingLevel } from "./agents.ts";
import { cancelApprovalsForWork, type ToolRisk } from "./approval/state.ts";
import {
  ROOM_PAGE_SIZE,
  ROOM_WINDOW_LIMIT,
  RoomDirectoryError,
  appendRoomMessageIn,
  appendRoomMessage,
  ensureEmployeeDm,
  findRoom,
  isSentMailEntry,
  mailEnvelope,
  messageData,
  readRoomMessageWindow,
  roomDTOWithUnread,
  toMessageDTO,
  type MailAddress,
} from "./rooms.ts";
import { buildMessageTools, sendQueuedMessage } from "./channel-messages.ts";
import { toWorkDTO } from "./dto.ts";
import { listEmployees, resolveEmployee } from "./workspace.ts";
import { listSkills } from "./skills.ts";
import { toolError, toolText } from "./tools.ts";
import {
  HISTORY_BODY_LIMIT,
  HISTORY_MESSAGE_LIMIT,
  renderDelegationContinuation,
  renderToolResult,
  renderWorkInput,
  toolTextResources,
} from "./prompts/index.ts";
import type { MessageDTO } from "../shared/contracts.ts";
import { CANONICAL_LOCALE } from "../shared/i18n.ts";
import { AppError, rawText, type AppText } from "./app-text.ts";
import { appMessages } from "./messages.ts";
import { noticeOf } from "./messages/work.ts";
import { findWorkContext, workContextDirectorySnapshot } from "./work-contexts.ts";

export type WorkKind = "message" | "mail" | "delegation";

export type StartWorkInput = {
  roomId: string;
  employeeId: string;
  /** The work every run of this message belongs to. */
  workContextId: string;
  intent: string;
  kind: WorkKind;
  sourceEntryId: string;
  parentWorkId?: string;
  rootWorkId?: string;
  depth?: number;
  /** Conversation that owns the dispatch task; the room's, or the caller's for a delegation. */
  dispatchConversationId?: number;
};

/** One process's shared handles; the task sets resolve lazily to break the import cycle. */
export type Resume = {
  runtime: EmitRuntime;
  mcp: McpManager;
  dispatch: WorkDispatchTask;
  mail: MailTasks;
};

/** Build the extension for one employee, with its collaboration tools bound to it. */
async function extensionFor(
  resume0: Resume,
  employee: EmployeeRecord,
  parts?: { collaboration: readonly ToolRegistration[] },
): Promise<ReturnType<typeof buildEmployeeExtension>> {
  const { runtime, mcp } = resume0;
  const skills = await listSkills(runtime);
  const collaboration =
    parts?.collaboration ?? [...buildMessageTools(resume0, employee), ...buildCollaborationTools(resume0, employee)];
  const mcpTools = mcp.toolsFor(employee, runtime);
  return buildEmployeeExtension({
    runtime,
    employee,
    skills,
    tools: {
      collaboration,
      mcp: mcpTools,
      hooks: [buildDeliveryHook(resume0)],
    },
  });
}

/**
 * Install (or replace) one employee's extension in the registry.
 *
 * A conversation selects its extensions by name, so the objects live in the
 * registry rather than in the conversation: replacing an employee's extension
 * is what makes a configuration change take effect on that employee's next
 * request, without touching any stored conversation.
 */
export async function installEmployeeExtension(
  resume0: Resume,
  employee: EmployeeRecord,
): Promise<ReturnType<typeof buildEmployeeExtension>> {
  const extension = await extensionFor(resume0, employee);
  resume0.runtime.registry.install(extension);
  return extension;
}

/** Install every employee's extension, before interrupted runs are resumed. */
export async function installAllExtensions(resume0: Resume): Promise<number> {
  const employees = await listEmployees(resume0.runtime);
  for (const employee of employees) await installEmployeeExtension(resume0, employee);
  return employees.length;
}

/**
 * Enqueue one work item and its durable dispatch task in a single commit.
 *
 * The validations decide whether the request is acceptable at all; the record
 * is written `queued` and the `emit.work-dispatch` task that starts it is
 * created in the same commit, so "the request was accepted" and "the employee
 * will run" are the same fact. No conversation and no run happen here: the
 * scheduler's two-phase task does that, restartably.
 */
export async function createQueuedWork(resume0: Resume, input: StartWorkInput): Promise<WorkRecord> {
  const { runtime } = resume0;
  const employee = await runtime.readFamily(EmployeeDoc, input.employeeId, { id: input.employeeId });
  if (employee === undefined) throw new AppError(appMessages.work.employeeNotFound(input.employeeId));
  if (!employee.enabled) throw new AppError(appMessages.work.employeeDisabled(employee.name));
  // A model that no longer resolves stops the work here, with the employee and
  // model named, instead of failing deep inside the first request.
  const modelProblem = runtime.catalog.chatSelectionProblem({
    providerId: employee.executionModel.providerId,
    modelId: employee.executionModel.modelId,
    effort: employee.executionModel.effort,
  });
  if (modelProblem !== undefined) throw new AppError(appMessages.work.modelUnavailable(employee.name, modelProblem));
  const app = await runtime.readSession(AppDoc);

  const depth = input.depth ?? 0;
  if (depth > app.collaboration.maxDepth) {
    throw new AppError(appMessages.work.depthOverLimit(app.collaboration.maxDepth));
  }
  const workId = `wk_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const directoryScope = await directoriesForWork(runtime, input);
  const dispatchConversationId = input.dispatchConversationId;
  await runtime.harness.commit(async (tx) => {
    await createQueuedWorkIn(tx, {
      ...input,
      depth,
      id: workId,
      directoryScope,
      now: Date.now(),
    });
    const taskId = await tx.createTask(
      resume0.dispatch,
      { workId },
      {
        ownership: { kind: "conversation" },
        ...(dispatchConversationId !== undefined ? { conversationId: dispatchConversationId as ConversationId } : {}),
        background: true,
      },
    );
    const doc = await tx.doc(WorkDoc, workId, { id: workId });
    doc.dispatchTaskId = String(taskId);
  }, runtime.ctx);
  const record = await runtime.readFamily(WorkDoc, workId, { id: workId });
  if (record === undefined) throw new AppError(appMessages.work.workWriteFailed(workId));
  runtime.emit({ type: "work", work: toWorkDTO(record, employee.name, await roomName(runtime, input.roomId)) });
  return record;
}

/**
 * The transaction-level half shared by both creation entries.
 *
 * Callers validate first and pass exactly what they validated; this only does
 * the field assignment, so the two paths cannot drift apart.
 */
export async function createQueuedWorkIn(
  tx: Tx,
  input: StartWorkInput & { id: string; directoryScope: WorkDirectoryScopeRecord; now: number },
): Promise<void> {
  const doc = await tx.doc(WorkDoc, input.id, { id: input.id });
  doc.id = input.id;
  doc.employeeId = input.employeeId;
  doc.roomId = input.roomId;
  doc.workContextId = input.workContextId;
  doc.kind = input.kind;
  doc.status = "queued";
  doc.sourceEntryId = input.sourceEntryId;
  doc.parentWorkId = input.parentWorkId ?? "";
  doc.rootWorkId = (input.rootWorkId ?? "").length > 0 ? (input.rootWorkId ?? "") : input.id;
  doc.depth = input.depth ?? 0;
  doc.startedAt = input.now;
  doc.intent = input.intent;
  doc.directoryScope = { ...input.directoryScope, paths: [...input.directoryScope.paths] };
}

/**
 * Thrown when a work item finished while its start was pending: the task that
 * carries the start must settle quietly instead of marking anything.
 */
export class WorkFinishedError extends AppError {
  constructor(readonly status: WorkRecord["status"]) {
    super(appMessages.work.finished(status));
  }
}

/**
 * Transaction-level half of `ensureWorkConversation`; the caller validates the
 * employee and model and builds the extension first, so this stays one commit.
 */
export async function ensureWorkConversationIn(
  tx: Tx,
  workId: string,
  prepared: {
    extension: ReturnType<typeof buildEmployeeExtension>;
    model: { provider: string; modelId: string };
    thinkingLevel: ModelThinkingLevel;
    cwd: string | null;
  },
): Promise<number> {
  const current = await tx.doc(WorkDoc, workId, { id: workId });
  if (isTerminal(current.status) || current.status === "stopped") throw new WorkFinishedError(current.status);
  if (current.conversationId === 0) {
    const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
    await configure(tx, conversation.id, {
      extensions: [prepared.extension],
      model: prepared.model,
      thinkingLevel: prepared.thinkingLevel,
      cwd: prepared.cwd,
    });
    const binding = await tx.doc(ConversationContextDoc, conversation.id);
    binding.workId = current.id;
    binding.employeeId = current.employeeId;
    binding.roomId = current.roomId;
    binding.rootWorkId = current.rootWorkId;
    binding.depth = current.depth;
    current.conversationId = Number(conversation.id);
  }
  if (current.status === "queued") current.status = "running";
  return current.conversationId;
}

/**
 * Make sure a work item has its execution conversation, creating it when the
 * mail-dispatch task resumes it after a crash.
 *
 * The validations are the ones `startWork` used to run inline; only the
 * conversation creation, the agent configuration, the context binding, and the
 * `conversationId` write are one commit now.
 */
export async function ensureWorkConversation(resume0: Resume, workId: string): Promise<Conversation> {
  const { runtime } = resume0;
  const work = await findWork(runtime, workId);
  if (work === undefined) throw new AppError(appMessages.work.workNotFound(workId));
  if (work.conversationId !== 0) {
    const existing = await runtime.harness.conversation(work.conversationId as ConversationId, runtime.ctx);
    if (existing !== undefined) return existing;
  }
  const employee = await runtime.readFamily(EmployeeDoc, work.employeeId, { id: work.employeeId });
  if (employee === undefined) throw new AppError(appMessages.work.employeeNotFound(work.employeeId));
  if (!employee.enabled) throw new AppError(appMessages.work.employeeDisabled(employee.name));
  const modelProblem = runtime.catalog.chatSelectionProblem({
    providerId: employee.executionModel.providerId,
    modelId: employee.executionModel.modelId,
    effort: employee.executionModel.effort,
  });
  if (modelProblem !== undefined) throw new AppError(appMessages.work.modelUnavailable(employee.name, modelProblem));
  // The directories authorized when the work was queued are what this run may
  // use; the work context must still carry exactly that version.
  const workContext = await findWorkContext(runtime, work.workContextId);
  if (workContext === undefined || workContext.directories.version !== work.directoryScope.version) {
    throw new AppError(appMessages.work.directoryChanged());
  }
  if (!(await workStillAuthorized(runtime, work))) {
    throw new AppError(appMessages.work.removedFromConversation(employee.name));
  }
  const extension = await installEmployeeExtension(resume0, employee);
  const conversationId = await runtime.harness.commit(
    (tx) =>
      ensureWorkConversationIn(tx, workId, {
        extension,
        model: { provider: employee.executionModel.providerId, modelId: employee.executionModel.modelId },
        thinkingLevel: toThinkingLevel(employee.executionModel.effort),
        cwd: work.directoryScope.defaultPath || null,
      }),
    runtime.ctx,
  );
  const conversation = await runtime.harness.conversation(conversationId as ConversationId, runtime.ctx);
  if (conversation === undefined) throw new AppError(appMessages.work.conversationMissing(conversationId));
  const running = await findWork(runtime, workId);
  if (running !== undefined) {
    runtime.emit({ type: "work", work: toWorkDTO(running, employee.name, await roomName(runtime, running.roomId)) });
  }
  return conversation;
}

/** Start a queued work item: conversation, prompt, and admission. Idempotent by request id. */
export async function startQueuedWork(resume0: Resume, workId: string): Promise<WorkRecord> {
  const { runtime } = resume0;
  const conversation = await ensureWorkConversation(resume0, workId);
  const work = await findWork(runtime, workId);
  if (work === undefined) throw new AppError(appMessages.work.workNotFound(workId));
  let mailSource: { entryId: string; message: RoomMessageData } | undefined;
  if (work.kind === "mail") {
    const room = await findRoom(runtime, work.roomId);
    const source = room === undefined ? undefined : await sourceMessage(runtime, room, work.sourceEntryId);
    if (source?.mail === undefined || source.mail === null) throw new AppError(appMessages.work.mailSourceMissing());
    mailSource = { entryId: work.sourceEntryId, message: source };
  }

  const history =
    work.roomId.length > 0 ? await roomHistory(runtime, work.roomId, work.sourceEntryId, work.employeeId) : [];
  const prompt = renderWorkInput(history, work.intent, work.kind, mailSource);
  const submission = await conversation.submit(
    { type: "input", content: prompt, requestId: `work:${workId}` },
    runtime.ctx,
  );

  // A run that settles without answering (provider error, aborted tool, a model
  // that never yields) leaves work in "running" forever unless someone says so.
  // The watcher is a courtesy for the live process; a crash is covered by
  // reconciliation at the next startup.
  void submission
    .wait(runtime.ctx)
    .then(async (settled) => {
      if (settled.status === "done") return;
      const current = await findWork(runtime, workId);
      if (current === undefined || isTerminal(current.status)) return;
      await markFailed(resume0, current, appMessages.work.runNoAnswer());
    })
    .catch(() => undefined);

  return work;
}

async function roomName(runtime: EmitRuntime, roomId: string): Promise<string> {
  if (roomId.length === 0) return "";
  const room = await runtime.readFamily(RoomDoc, roomId, { id: roomId });
  return room?.name ?? "";
}

/**
 * Whether one work's employee may still act in the room it belongs to.
 *
 * Membership changes take effect immediately: a channel member removed while a
 * run is executing, or an employee disabled mid-run, must not read the room's
 * content or publish a result. Work with no room (a delegation) is authorized
 * by its own record.
 */
export async function workStillAuthorized(runtime: EmitRuntime, work: WorkRecord): Promise<boolean> {
  const employee = await runtime.readFamily(EmployeeDoc, work.employeeId, { id: work.employeeId });
  if (employee === undefined || !employee.enabled) return false;
  if (work.roomId.length === 0) return true;
  const room = await runtime.readFamily(RoomDoc, work.roomId, { id: work.roomId });
  if (room === undefined) return false;
  if (room.kind === "channel") return room.memberIds.includes(work.employeeId);
  if (room.kind === "dm") return room.dmParticipantIds.includes(work.employeeId);
  if (work.sourceEntryId.length === 0) return false;
  const source = await sourceMessage(runtime, room, work.sourceEntryId);
  return source?.mail !== null && source?.mail !== undefined
    ? source.mail.recipients.includes(work.employeeId) || source.mail.copies.includes(work.employeeId)
    : false;
}

/**
 * The room's visible messages before the one that started this work.
 *
 * The window is bounded to the source entry, so a busy room after the request
 * can never leak into a run that started earlier, and it is filtered by what
 * this employee may see: a private message of two other people is not history.
 */
async function roomHistory(
  runtime: EmitRuntime,
  roomId: string,
  sourceEntryId: string,
  employeeId: string,
): Promise<MessageDTO[]> {
  const room = await runtime.readFamily(RoomDoc, roomId, { id: roomId });
  if (room === undefined) return [];
  const window = await readRoomMessageWindow(runtime, room, sourceEntryId, employeeId);
  return window.messages.filter((message) => message.id !== sourceEntryId).slice(-HISTORY_MESSAGE_LIMIT);
}

/** Text of a final assistant answer, in the order the model produced it. */
export function assistantText(message: AssistantMessage): string {
  return message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter((text) => text.length > 0)
    .join("\n")
    .trim();
}

/**
 * The hook that delivers an answer.
 *
 * It runs inside the generation task, so it is reached again after a crash
 * exactly when the generation is resumed; the delivery commit is idempotent, so
 * being reached twice is harmless.
 */
export function buildDeliveryHook(resume0: Resume): HookRegistration {
  return hook(GenerationTask, {
    async beforeRequest(_request, api, context) {
      await consumeAwaitedReplies(resume0, api.conversationId, context);
      return undefined;
    },
    async onYield(answer, api, context) {
      return deliverAnswer(resume0, api.conversationId, assistantText(answer), context);
    },
    async afterResponse(_message, api, context) {
      // The turn budget is a loop breaker, not a cost opinion: a chain of
      // employees waking each other has to end somewhere the user can see.
      const runtime = resume0.runtime;
      const binding = await runtime.harness.snapshot(ConversationContextDoc, api.conversationId, context);
      if (binding === undefined || binding.rootWorkId.length === 0) return;
      const app = await runtime.readSession(AppDoc);
      const turns = await countTurn(runtime, binding.rootWorkId);
      if (turns <= app.collaboration.maxModelTurns) return;
      const conversation = await runtime.harness.conversation(api.conversationId, context);
      await conversation?.abort(context).catch(() => undefined);
      runtime.emit(noticeOf(appMessages.work.turnLimit(app.collaboration.maxModelTurns)));
    },
  });
}

/**
 * Consume the awaited replies whose continuation is part of a request.
 *
 * A submission that is only queued has not reached the model yet, so the child
 * stays awaited: the old turn must not finish as if the reply had been read.
 * Only a placed or answered continuation clears the child and, once the list
 * is empty, restores the paused work to running.
 */
async function consumeAwaitedReplies(resume0: Resume, conversationId: ConversationId, context: Context): Promise<void> {
  const { runtime } = resume0;
  const binding = await runtime.harness.snapshot(ConversationContextDoc, conversationId, context);
  if (binding === undefined || binding.workId.length === 0) return;
  const work = await runtime.readFamily(WorkDoc, binding.workId, { id: binding.workId });
  if (work === undefined || work.status !== "waiting-mail" || work.awaitedMailWorkIds.length === 0) return;
  const consumed: string[] = [];
  for (const childId of work.awaitedMailWorkIds) {
    const submission = await runtime.storage.submissionByRequest(conversationId, `mail-reply:${childId}`, context);
    if (submission !== undefined && (submission.status === "placed" || submission.status === "done")) consumed.push(childId);
  }
  if (consumed.length === 0) return;
  await runtime.harness.commit(async (tx) => {
    const doc = await tx.doc(WorkDoc, work.id, { id: work.id });
    if (doc.status !== "waiting-mail") return;
    doc.awaitedMailWorkIds = doc.awaitedMailWorkIds.filter((childId) => !consumed.includes(childId));
    if (doc.awaitedMailWorkIds.length === 0) doc.status = "running";
  }, context);
  const updated = await runtime.readFamily(WorkDoc, work.id, { id: work.id });
  if (updated !== undefined) {
    const employee = await runtime.readFamily(EmployeeDoc, updated.employeeId, { id: updated.employeeId });
    runtime.emit({ type: "work", work: toWorkDTO(updated, employee?.name ?? "", await roomName(runtime, updated.roomId)) });
  }
}

async function deliverAnswer(
  resume0: Resume,
  conversationId: ConversationId,
  text: string,
  context: Context,
): Promise<undefined> {
  const { runtime } = resume0;
  if (text.length === 0) return undefined;
  const binding = await runtime.harness.snapshot(ConversationContextDoc, conversationId, context);
  if (binding === undefined || binding.workId.length === 0) return undefined;

  const work = await runtime.readFamily(WorkDoc, binding.workId, { id: binding.workId });
  if (work === undefined || isTerminal(work.status)) return undefined;
  const employee = await runtime.readFamily(EmployeeDoc, work.employeeId, { id: work.employeeId });
  if (employee === undefined) return undefined;
  // A membership change takes effect immediately: an employee removed from the
  // room while running must not publish this answer there, and must not read
  // any more of the work's content.
  if (!(await workStillAuthorized(runtime, work))) {
    await stopForRemoval(resume0, work, employee.name);
    return undefined;
  }

  if (work.kind === "delegation") {
    await deliverToParent(runtime, work, employee, text, context);
    return undefined;
  }

  const room = await runtime.readFamily(RoomDoc, work.roomId, { id: work.roomId });
  if (room === undefined) return undefined;

  const usage = await workUsage(runtime, conversationId, context);
  const mail = room.kind === "mail" ? await replyEnvelope(runtime, room, work, employee) : undefined;
  const parent = work.parentWorkId.length > 0 ? await findWork(runtime, work.parentWorkId) : undefined;
  const awaitedByParent = parent !== undefined && parent.awaitedMailWorkIds.includes(work.id);

  const outcome = await runtime.harness.commit(async (tx) => {
    const doc = await tx.doc(WorkDoc, work.id, { id: work.id });
    if (isTerminal(doc.status)) return undefined;
    // A work that asked for a reply cannot finish while one is still owed:
    // the answer stays in the work record and the resumed run delivers the
    // real final answer once the reply has been read.
    if (doc.awaitedMailWorkIds.length > 0) {
      doc.status = "waiting-mail";
      doc.answer = text;
      return { waiting: true as const };
    }
    const appended = await appendRoomMessageIn(
      tx,
      room,
      messageData({
        author: { type: "employee", id: employee.id, name: employee.name, address: employee.address },
        body: text,
        workId: work.id,
        ...(mail !== undefined ? { mail } : {}),
      }),
    );
    doc.status = "succeeded";
    doc.answer = text;
    doc.finishedAt = Date.now();
    doc.inputTokens = usage.input;
    doc.outputTokens = usage.output;
    doc.cost = usage.cost;
    // The parent who asked for this reply is continued from the entry just
    // written; the task is created here, in the same commit as the answer, so
    // a crash cannot leave an answer nobody reads.
    if (awaitedByParent && parent !== undefined && doc.mailResumeTaskId.length === 0) {
      const taskId = await tx.createTask(
        resume0.mail.resumeTask,
        {
          parentWorkId: parent.id,
          childWorkId: work.id,
          roomId: room.id,
          entryId: String(appended.id),
          outcome: "reply" as const,
          error: "",
        },
        {
          ownership: { kind: "conversation" },
          conversationId: parent.conversationId as ConversationId,
          background: true,
        },
      );
      doc.mailResumeTaskId = String(taskId);
    }
    return { waiting: false as const, entry: appended };
  }, context);

  const updated = await runtime.readFamily(WorkDoc, work.id, { id: work.id });
  if (updated !== undefined) {
    runtime.emit({ type: "work", work: toWorkDTO(updated, employee.name, room.name) });
  }
  if (outcome === undefined || outcome.waiting) return undefined;
  const dto = toMessageDTO(outcome.entry);
  if (dto !== undefined) {
    dto.roomId = room.id;
    runtime.emit({ type: "message", roomId: room.id, message: dto });
  }
  runtime.emit({ type: "room", room: await roomDTOWithUnread(runtime, room) });
  return undefined;
}

/**
 * The envelope of an answer written into a mail thread.
 *
 * It answers the message the work started from, so the reply is addressed to
 * that message's author (the user, or the employee who wrote in) and keeps the
 * original CC list. Nothing here starts work: routing only happens when a mail
 * is sent, not when an answer is filed.
 */
async function replyEnvelope(
  runtime: EmitRuntime,
  room: RoomRecord,
  work: WorkRecord,
  employee: EmployeeRecord,
): Promise<MailEnvelope> {
  const subject = work.kind === "mail" ? await mailSubject(runtime, room) : room.name;
  const source = await sourceMessage(runtime, room, work.sourceEntryId);
  const app = await runtime.readSession(AppDoc);
  const author: MailAddress =
    source !== undefined && source.address.length > 0
      ? { name: source.authorName, address: source.address }
      : { name: app.userName.length > 0 ? app.userName : appMessages.rooms.userFallbackAuthorName[CANONICAL_LOCALE], address: app.userAddress };
  // Everyone else who was addressed on the message being answered stays in the
  // loop: that is what makes "reply all" on an answer reach the other
  // recipients instead of only the person who wrote it.
  const cc: MailAddress[] = [];
  for (const entry of [...(source?.mail?.to ?? []), ...(source?.mail?.cc ?? [])]) {
    if (entry.address.length === 0 || entry.address === author.address || entry.address === employee.address) continue;
    if (!cc.some((existing) => existing.address === entry.address)) cc.push(entry);
  }
  const answeredByEmployee = source !== undefined && source.authorType === "employee";
  const copies = [...new Set([...(source?.mail?.recipients ?? []), ...(source?.mail?.copies ?? [])])].filter(
    (id) => id !== employee.id && (!answeredByEmployee || id !== source.authorId),
  );
  return mailEnvelope({
    subject,
    to: [author],
    cc,
    recipients: answeredByEmployee ? [source.authorId] : [],
    copies,
    inReplyTo: work.sourceEntryId,
    sent: true,
  });
}

/** One room entry by its id, when it is still a readable message. */
async function sourceMessage(
  runtime: EmitRuntime,
  room: RoomRecord,
  entryId: string,
): Promise<RoomMessageData | undefined> {
  if (entryId.length === 0) return undefined;
  const conversation = await runtime.harness.conversation(room.conversationId as ConversationId, runtime.ctx);
  if (conversation === undefined) return undefined;
  const page = await conversation.entries({}, ROOM_PAGE_SIZE, undefined, runtime.ctx);
  const entry = page.items.find((item) => String(item.id) === entryId);
  if (entry === undefined || !RoomMessageEntry.is(entry)) return undefined;
  return entry.data as RoomMessageData;
}

async function mailSubject(runtime: EmitRuntime, room: RoomRecord): Promise<string> {
  const conversation = await runtime.harness.conversation(room.conversationId as ConversationId, runtime.ctx);
  if (conversation === undefined) return room.name;
  const page = await conversation.entries({}, 1, undefined, runtime.ctx);
  const data = page.items[0]?.data as { mail?: { subject?: string } } | undefined;
  const subject = data?.mail?.subject ?? "";
  return subject.startsWith("Re: ") ? subject : `Re: ${subject.length > 0 ? subject : room.name}`;
}

/** Hand a delegated answer back to the delegating conversation, deduplicated by request id. */
async function deliverToParent(
  runtime: EmitRuntime,
  work: WorkRecord,
  employee: EmployeeRecord,
  text: string,
  context: Context,
): Promise<void> {
  if (work.parentWorkId.length === 0) return;
  const parent = await runtime.readFamily(WorkDoc, work.parentWorkId, { id: work.parentWorkId });
  if (parent === undefined || parent.conversationId === 0) return;
  const conversation = await runtime.harness.conversation(parent.conversationId as ConversationId, context);
  if (conversation === undefined) return;

  await conversation.submit(
    { type: "input", content: renderDelegationContinuation(employee.name, text), requestId: `deliver:${work.id}` },
    context,
  );
  const updated = await runtime.updateFamily(WorkDoc, work.id, { id: work.id }, (doc) => {
    if (isTerminal(doc.status)) return;
    doc.status = "succeeded";
    doc.answer = text;
    doc.finishedAt = Date.now();
  });
  runtime.emit({ type: "work", work: toWorkDTO(updated, employee.name, "") });
}

async function workUsage(
  runtime: EmitRuntime,
  conversationId: ConversationId,
  context: Context,
): Promise<{ input: number; output: number; cost: number }> {
  const usage = await runtime.harness.snapshot(UsageDoc, conversationId, context);
  if (usage === undefined) return { input: 0, output: 0, cost: 0 };
  let input = 0;
  let output = 0;
  let cost = 0;
  for (const entry of Object.values(usage.models)) {
    const counters = entry as { input?: number; output?: number; cost?: { total?: number } };
    input += counters.input ?? 0;
    output += counters.output ?? 0;
    cost += counters.cost?.total ?? 0;
  }
  return { input, output, cost };
}

export function isTerminal(status: WorkRecord["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "stopped";
}

export async function listWorks(runtime: EmitRuntime): Promise<WorkRecord[]> {
  const members = await runtime.listFamily(WorkDoc, (id) => ({ id }));
  return members.map((member) => member.value).sort((a, b) => b.startedAt - a.startedAt);
}

export async function findWork(runtime: EmitRuntime, id: string): Promise<WorkRecord | undefined> {
  return runtime.readFamily(WorkDoc, id, { id });
}

/** Stop a running work: mark it stopped, unwind its start task, cancel approvals, then abort the run. */
export async function stopWork(resume0: Resume, workId: string): Promise<WorkRecord | undefined> {
  const { runtime } = resume0;
  const work = await findWork(runtime, workId);
  if (work === undefined) return undefined;
  if (isTerminal(work.status)) return work;

  // Record the decision before unwinding the run. Aborting ends the run in
  // failure, and that failure must not overwrite what the user asked for.
  const stoppedByUser = appMessages.work.stoppedByUser();
  await runtime.harness.commit(async (tx) => {
    const doc = await tx.doc(WorkDoc, workId, { id: workId });
    if (isTerminal(doc.status)) return;
    doc.status = "stopped";
    doc.finishedAt = Date.now();
    doc.error = stoppedByUser.text;
    doc.errorLocalized = stoppedByUser.localized;
    // The replies it was waiting for belong to a task that is over; keeping
    // the link would leave a stopped work advertising a wait it will never
    // resume from.
    doc.awaitedMailWorkIds = [];
    // Stopping a child is also an outcome for the parent that asked for it.
    await handOffToAwaitingParent(tx, resume0, doc, "stopped", stoppedByUser);
  }, runtime.ctx);
  const updated = await runtime.readFamily(WorkDoc, workId, { id: workId });
  if (updated === undefined) return undefined;
  const employee = await runtime.readFamily(EmployeeDoc, updated.employeeId, { id: updated.employeeId });
  runtime.emit({ type: "work", work: toWorkDTO(updated, employee?.name ?? "", await roomName(runtime, updated.roomId)) });

  // A queued work has a live dispatch task that must not submit a run for a
  // stopped work: abort it and wait for its terminal receipt first, so the
  // late-submit window is closed before anything else is unwound.
  if (updated.dispatchTaskId.length > 0) {
    const dispatchTaskId = Number(updated.dispatchTaskId) as TaskId;
    const dispatch = await runtime.harness.getTask(dispatchTaskId, runtime.ctx);
    if (dispatch !== undefined && dispatch.state.status !== "terminal") {
      await runtime.harness.abortTask(dispatchTaskId, runtime.ctx);
      await runtime.harness.waitForTask(dispatchTaskId, runtime.ctx).catch(() => undefined);
    }
  }

  // Cancelling first releases a call that is waiting for a human decision, so
  // the abort below is not left waiting for a run that waits for the human.
  await cancelApprovalsForWork(runtime, workId);
  if (updated.conversationId !== 0) {
    const conversation = await runtime.harness.conversation(updated.conversationId as ConversationId, runtime.ctx);
    if (conversation !== undefined) await conversation.abort(runtime.ctx).catch(() => undefined);
  }

  if (updated.roomId.length > 0) {
    const room = await runtime.readFamily(RoomDoc, updated.roomId, { id: updated.roomId });
    if (room !== undefined) {
      const stopBody = appMessages.work.stopNotice(employee?.name ?? "");
      await appendRoomMessage(
        runtime,
        room,
        messageData({
          author: { type: "system", id: "system", name: appMessages.rooms.systemAuthorName[CANONICAL_LOCALE] },
          body: stopBody.text,
          bodyLocalized: stopBody.localized,
          workId,
          notice: true,
        }),
      );
    }
  }
  return updated;
}

/**
 * Reconcile work left behind by an unclean shutdown.
 *
 * `resume()` re-schedules every interrupted run, so anything still live appears
 * in the inspection. A work item whose conversation has no live task and no
 * unsettled submission did not survive, and is reported as such rather than
 * left spinning forever.
 */
export async function reconcileWorks(resume0: Resume): Promise<number> {
  const { runtime } = resume0;
  const works = await listWorks(runtime);
  const pending = works.filter((work) => !isTerminal(work.status));
  if (pending.length === 0) return 0;
  const inspection = await runtime.harness.inspect(runtime.ctx);
  const liveConversations = new Set<string>();
  const inspectionTasks = new Map<string, (typeof inspection.tasks)[number]>();
  for (const task of inspection.tasks) {
    liveConversations.add(String(task.record.conversationId));
    inspectionTasks.set(String(task.record.id), task);
  }
  for (const submission of inspection.submissions) liveConversations.add(String(submission.conversationId));

  let failed = 0;
  for (const work of pending) {
    // A queued or mid-dispatch work is owned by its durable dispatch task.
    // The two-phase task creates the conversation before it submits the
    // prompt, so a crash in that window leaves a "running" work whose only
    // owner is the task; the native scheduler resumes it and must not be
    // preempted by the liveness check below.
    if (work.dispatchTaskId.length > 0 && (work.status === "queued" || work.status === "running")) {
      const dispatch = inspectionTasks.get(work.dispatchTaskId);
      const record = await runtime.harness.getTask(Number(work.dispatchTaskId) as TaskId, runtime.ctx);
      const terminal = record !== undefined && record.state.status === "terminal";
      if (!terminal) {
        if (dispatch !== undefined && dispatch.state.kind !== "blocked" && dispatch.state.kind !== "completing") continue;
        if (dispatch === undefined || dispatch.state.kind === "blocked") {
          await markFailed(resume0, work, appMessages.work.dispatchLost());
          failed += 1;
          continue;
        }
        continue;
      }
      const outcome = record?.state.outcome;
      if (outcome?.status === "failed") {
        await markFailed(resume0, work, rawText(outcome.error.message));
        failed += 1;
        continue;
      }
      // The dispatch task completed: the work's own liveness decides below.
    }
    // Waiting for another employee's reply is a valid idle state, not an
    // interrupted run; the awaited child works decide what happens next.
    if (work.status === "waiting-mail") {
      const liveTaskIds = new Set(inspection.tasks.map((task) => String(task.record.id)));
      const broken = await brokenAwait(runtime, work, liveTaskIds);
      if (broken !== undefined) {
        await markFailed(resume0, work, appMessages.work.awaitUnreachable(broken));
        failed += 1;
      }
      continue;
    }
    if (work.conversationId === 0) {
      if (work.status === "queued") {
        await markFailed(resume0, work, appMessages.work.startInterrupted());
        failed += 1;
      }
      continue;
    }
    if (liveConversations.has(String(work.conversationId))) continue;
    await cancelApprovalsForWork(runtime, work.id);
    await markFailed(resume0, work, appMessages.work.processInterrupted());
    failed += 1;
  }
  return failed;
}

/**
 * Why a waiting work can never continue, or undefined while it still can.
 *
 * A child that is still producing its reply is normal waiting. Once every
 * awaited child is terminal the hand-off has to exist: a missing or failed
 * resume task means the reply will never reach this conversation, so the work
 * is failed here instead of waiting forever.
 */
async function brokenAwait(
  runtime: EmitRuntime,
  work: WorkRecord,
  liveTaskIds: ReadonlySet<string>,
): Promise<AppText | undefined> {
  const awaited = await Promise.all(work.awaitedMailWorkIds.map((id) => findWork(runtime, id)));
  for (const child of awaited) {
    if (child === undefined) return appMessages.work.awaitChildMissing();
    if (!isTerminal(child.status)) return undefined;
  }
  for (const child of awaited) {
    if (child === undefined) continue;
    if (child.mailResumeTaskId.length === 0) return appMessages.work.awaitResumeTaskMissing(child.id);
    if (liveTaskIds.has(child.mailResumeTaskId)) continue;
    const record = await runtime.harness.getTask(Number(child.mailResumeTaskId) as TaskId, runtime.ctx);
    if (record === undefined) return appMessages.work.awaitResumeTaskRecordMissing(child.id);
    if (record.state.status !== "terminal") continue;
    if (record.state.outcome?.status === "failed") return rawText(record.state.outcome.error.message);
    const submission = await runtime.storage.submissionByRequest(
      work.conversationId as ConversationId,
      `mail-reply:${child.id}`,
      runtime.ctx,
    );
    if (submission === undefined) return appMessages.work.awaitReplyNotSubmitted(child.id);
  }
  return undefined;
}

/**
 * Stop a running work because its employee lost access to the room.
 *
 * The answer is not published: the employee is no longer a participant of this
 * conversation, and their output must not appear in it. The work record keeps
 * the outcome visible to the user.
 */
async function stopForRemoval(resume0: Resume, work: WorkRecord, employeeName: string): Promise<void> {
  const { runtime } = resume0;
  const reason = appMessages.work.removedFromConversation(employeeName);
  const updated = await runtime.updateFamily(WorkDoc, work.id, { id: work.id }, (doc) => {
    if (isTerminal(doc.status)) return;
    doc.status = "stopped";
    doc.finishedAt = Date.now();
    doc.error = reason.text;
    doc.errorLocalized = reason.localized;
    doc.awaitedMailWorkIds = [];
  });
  runtime.emit({
    type: "work",
    work: toWorkDTO(updated, employeeName, await roomName(runtime, updated.roomId)),
  });
  await cancelApprovalsForWork(runtime, work.id);
  if (work.conversationId !== 0) {
    const conversation = await runtime.harness.conversation(work.conversationId as ConversationId, runtime.ctx);
    if (conversation !== undefined) await conversation.abort(runtime.ctx).catch(() => undefined);
  }
}

/**
 * Hand one child's terminal outcome to the parent that asked for it.
 *
 * The task is created in the same transaction as the child's terminal status,
 * so a parent is continued exactly once per awaited child, and a child nobody
 * awaited hands nothing back.
 */
async function handOffToAwaitingParent(
  tx: Tx,
  resume0: Resume,
  child: Draft<WorkRecord>,
  outcome: "failed" | "stopped",
  error: AppText,
): Promise<void> {
  if (child.parentWorkId.length === 0 || child.mailResumeTaskId.length > 0) return;
  const parent = await tx.doc(WorkDoc, child.parentWorkId, { id: child.parentWorkId });
  if (parent === undefined) return;
  if (!parent.awaitedMailWorkIds.includes(child.id)) return;
  if (isTerminal(parent.status) || parent.status === "stopped" || parent.conversationId === 0) return;
  const taskId = await tx.createTask(
    resume0.mail.resumeTask,
    {
      parentWorkId: parent.id,
      childWorkId: child.id,
      roomId: child.roomId,
      entryId: "",
      outcome,
      error: error.text,
      ...(error.localized ? { errorLocalized: error.localized } : {}),
    },
    {
      ownership: { kind: "conversation" },
      conversationId: parent.conversationId as ConversationId,
      background: true,
    },
  );
  child.mailResumeTaskId = String(taskId);
}

export async function markFailed(resume0: Resume, work: WorkRecord, reason: AppText): Promise<void> {
  const runtime = resume0.runtime;
  await runtime.harness.commit(async (tx) => {
    const doc = await tx.doc(WorkDoc, work.id, { id: work.id });
    if (isTerminal(doc.status)) return;
    doc.status = "failed";
    doc.finishedAt = Date.now();
    doc.error = reason.text;
    doc.errorLocalized = reason.localized;
    // A failure is an outcome too: the parent waiting for this child must hear
    // that it failed instead of waiting forever.
    await handOffToAwaitingParent(tx, resume0, doc, "failed", reason);
  }, runtime.ctx);
  const updated = await runtime.readFamily(WorkDoc, work.id, { id: work.id });
  if (updated === undefined) return;
  const employee = await runtime.readFamily(EmployeeDoc, updated.employeeId, { id: updated.employeeId });
  runtime.emit({ type: "work", work: toWorkDTO(updated, employee?.name ?? "", await roomName(runtime, updated.roomId)) });
  if (updated.roomId.length === 0) return;
  const room = await runtime.readFamily(RoomDoc, updated.roomId, { id: updated.roomId });
  if (room === undefined) return;
  const failBody = appMessages.work.failNotice(employee?.name ?? "", reason);
  await appendRoomMessage(
    runtime,
    room,
    messageData({
      author: { type: "system", id: "system", name: appMessages.rooms.systemAuthorName[CANONICAL_LOCALE] },
      body: failBody.text,
      bodyLocalized: failBody.localized,
      workId: work.id,
      notice: true,
    }),
  );
}

/**
 * The collaboration tools the message layer does not own: mail and delegation.
 *
 * `send_message`, `invite_to_channel`, and the shared-note tools live in
 * `channel-messages.ts` beside the send path they use.
 */
export function buildCollaborationTools(resume0: Resume, employee: EmployeeRecord): ToolRegistration[] {
  const { runtime } = resume0;

  const sendMail = defineTool({
    name: "send_mail",
    description: toolTextResources.send_mail.description,
    replay: "safe",
    parameters: Type.Object({
      to: Type.String({ description: toolTextResources.send_mail.parameters.to }),
      subject: Type.String({ description: toolTextResources.send_mail.parameters.subject }),
      body: Type.String({ description: toolTextResources.send_mail.parameters.body }),
      cc: Type.Optional(Type.String({ description: toolTextResources.send_mail.parameters.cc })),
      newSession: Type.Optional(Type.Boolean({ description: toolTextResources.send_mail.parameters.newSession })),
      inReplyTo: Type.Optional(Type.String({ description: toolTextResources.send_mail.parameters.inReplyTo })),
      awaitReply: Type.Optional(Type.Boolean({ description: toolTextResources.send_mail.parameters.awaitReply })),
    }),
    execute: async (args, api, context) => {
      // Replay first: a call that already sent returns the recorded outcome
      // and must not re-run validations whose inputs have since changed.
      const toolTaskId = String(api.taskId);
      const receiptKey = `tool:${toolTaskId}`;
      const receipt = await runtime.readFamily(MailSendReceiptDoc, receiptKey, { key: receiptKey });
      if (receipt !== undefined) {
        const target = await resolveTarget(runtime, args.to);
        return toolText(
          renderToolResult("send-mail-ok", { name: target?.name ?? args.to, workId: receipt.workIds[0] ?? "" }),
        );
      }
      const target = await resolveTarget(runtime, args.to);
      if (target === undefined) return toolError(`Employee not found: ${args.to}`);
      const callerId = await workOf(runtime, api, context);
      const caller = await findWork(runtime, callerId);
      if (caller === undefined) return toolError("The current work was not found");
      const awaiting = args.awaitReply === true;
      if (awaiting) {
        // Waiting is a dependency, so it obeys the same loop and depth rules
        // as a delegation; the wake and layer budget are spent with the send.
        if (target.id === employee.id) return toolError("You cannot wait for a reply from yourself");
        if (await isAncestor(runtime, caller.id, target.id)) {
          return toolError(`Cannot ask ${target.name} for a reply: they are an ancestor of this task and it would form a loop`);
        }
        const app = await runtime.readSession(AppDoc);
        if (caller.depth + 1 > app.collaboration.maxDepth) {
          return toolError(`Asking would exceed the depth limit (${app.collaboration.maxDepth} levels)`);
        }
      }
      const sourceRoom = await findRoom(runtime, caller.directoryScope.roomId);
      if (sourceRoom === undefined) return toolError(appMessages.work.sourceRoomMissing().text);
      const sourceContext = await findWorkContext(runtime, caller.workContextId);
      if (sourceContext === undefined || sourceContext.directories.version !== caller.directoryScope.version) {
        return toolError(appMessages.work.directoryChanged().text);
      }
      const continuation = sourceRoom.kind === "mail" && args.newSession !== true;
      if (!continuation && args.inReplyTo) return toolError("A new mail conversation cannot reference an old conversation's inReplyTo");
      let inReplyTo = "";
      if (continuation) {
        inReplyTo = args.inReplyTo ?? await mailParent(runtime, caller, sourceRoom);
        if (!(await isSentMailEntry(runtime, sourceRoom, inReplyTo))) {
          return toolError("The current mail parent could not be determined; specify an inReplyTo from the current conversation");
        }
      }
      const cc: { name: string; address: string }[] = [];
      const copied: string[] = [];
      for (const token of (args.cc ?? "").split(",").map((part) => part.trim())) {
        if (token.length === 0) continue;
        const ccEmployee = await resolveTarget(runtime, token);
        if (ccEmployee === undefined) continue;
        cc.push({ name: ccEmployee.name, address: ccEmployee.address });
        copied.push(ccEmployee.id);
      }
      // The atomic send: entry, queued work, dispatch task, and replay
      // receipt land in one commit; the receipt above makes replays safe.
      let result;
      try {
        result = await resume0.mail.sendQueuedMail({
          room:
            continuation
              ? { id: sourceRoom.id }
              : {
                  create: {
                    kind: "mail",
                    name: args.subject,
                    workContextId: caller.workContextId,
                    employeeId: target.id,
                    memberIds: [employee.id, target.id],
                  },
                },
          data: messageData({
            author: { type: "employee", id: employee.id, name: employee.name, address: employee.address },
            body: args.body,
            mail: mailEnvelope({
              subject: args.subject,
              to: [{ name: target.name, address: target.address }],
              cc,
              recipients: [target.id],
              copies: copied,
              sent: true,
              inReplyTo,
            }),
          }),
          intent: `Subject: ${args.subject}\n\n${args.body}`,
          parentWorkId: caller.id,
          toolTaskId,
          ...(awaiting ? { awaitReply: true } : {}),
        });
      } catch (error) {
        // The wake budget is spent inside the send transaction; a refusal
        // there is a tool-level answer, not a broken call.
        if (awaiting && error instanceof RoomDirectoryError) return toolError(error.message);
        throw error;
      }
      return toolText(
        renderToolResult("send-mail-ok", { name: target.name, workId: result.workIds[0] ?? "" }),
      );
    },
  });

  const delegate = defineTool({
    name: "delegate_task",
    description: toolTextResources.delegate_task.description,
    parameters: Type.Object({
      employee: Type.String({ description: toolTextResources.delegate_task.parameters.employee }),
      task: Type.String({ description: toolTextResources.delegate_task.parameters.task }),
    }),
    execute: async (args, api, context) => {
      const target = await resolveTarget(runtime, args.employee);
      if (target === undefined) return toolError(`Employee not found: ${args.employee}`);
      if (target.id === employee.id) return toolError("You cannot delegate a task to yourself");
      const app = await runtime.readSession(AppDoc);
      const depth = (await depthOf(runtime, api, context)) + 1;
      if (depth > app.collaboration.maxDepth) {
        return toolError(`Delegation would exceed the depth limit (${app.collaboration.maxDepth} levels)`);
      }
      const rootWorkId = await rootOf(runtime, api, context);
      const currentWork = await workOf(runtime, api, context);
      // Handing work back up the chain is a loop, not a collaboration: it would
      // ping-pong until the depth or wake limit ran out, so it is refused here
      // where the reason is still clear.
      if (await isAncestor(runtime, currentWork, target.id)) {
        return toolError(`Cannot delegate to ${target.name}: they are an ancestor of this task and it would form a loop`);
      }
      if (!(await reserveWake(runtime, rootWorkId, app.collaboration.maxCrossEmployeeWakes))) {
        return toolError(appMessages.work.wakeLimit(app.collaboration.maxCrossEmployeeWakes).text);
      }
      const callerWork = await findWork(runtime, currentWork);
      if (callerWork === undefined) return toolError(appMessages.work.workNotFound(currentWork).text);
      const work = await createQueuedWork(resume0, {
        roomId: "",
        employeeId: target.id,
        workContextId: callerWork.workContextId,
        intent: args.task,
        kind: "delegation",
        sourceEntryId: "",
        parentWorkId: currentWork,
        rootWorkId,
        depth,
        dispatchConversationId: api.conversationId,
      });
      return toolText(
        renderToolResult("delegate-ok", { name: target.name, workId: work.id }),
      );
    },
  });

  return [sendMail, delegate];
}

/** True when `employeeId` already appears among this work's ancestors. */
async function isAncestor(runtime: EmitRuntime, workId: string, employeeId: string): Promise<boolean> {
  let current = workId;
  const seen = new Set<string>();
  while (current.length > 0 && !seen.has(current)) {
    seen.add(current);
    const work = await runtime.readFamily(WorkDoc, current, { id: current });
    if (work === undefined) return false;
    if (work.employeeId === employeeId) return true;
    current = work.parentWorkId;
  }
  return false;
}

/** Reserve one cross-employee wake against the root work's budget. */
async function reserveWake(runtime: EmitRuntime, rootWorkId: string, max: number): Promise<boolean> {
  if (rootWorkId.length === 0) return true;
  const used = await runtime.updateFamily(CollaborationDoc, rootWorkId, { rootWorkId }, (doc) => {
    doc.rootWorkId = rootWorkId;
    // Count first, then compare: capping the counter at `max` made every later
    // call look affordable and let the budget be exceeded indefinitely.
    doc.crossEmployeeWakes += 1;
  });
  return used.crossEmployeeWakes <= max;
}

/** Count one model response against the root work's turn budget. */
async function countTurn(runtime: EmitRuntime, rootWorkId: string): Promise<number> {
  const doc = await runtime.updateFamily(CollaborationDoc, rootWorkId, { rootWorkId }, (doc) => {
    doc.rootWorkId = rootWorkId;
    doc.modelTurns += 1;
  });
  return doc.modelTurns;
}

async function workOf(runtime: EmitRuntime, api: ToolExecutionApi, context: Context): Promise<string> {
  const binding = await api.snapshot(ConversationContextDoc, api.conversationId, context);
  return binding?.workId ?? "";
}

async function rootOf(runtime: EmitRuntime, api: ToolExecutionApi, context: Context): Promise<string> {
  const workId = await workOf(runtime, api, context);
  if (workId.length === 0) return "";
  const work = await findWork(runtime, workId);
  return work?.rootWorkId ?? "";
}

async function depthOf(runtime: EmitRuntime, api: ToolExecutionApi, context: Context): Promise<number> {
  const workId = await workOf(runtime, api, context);
  if (workId.length === 0) return 0;
  const work = await findWork(runtime, workId);
  return work?.depth ?? 0;
}

async function resolveTarget(runtime: EmitRuntime, token: string): Promise<EmployeeRecord | undefined> {
  return resolveEmployee(await listEmployees(runtime), token);
}

/**
 * The directory snapshot a new work may use.
 *
 * A child inherits its parent's snapshot verbatim — a delegation must not see
 * directories the parent never had — while a root work snapshots its work
 * context's current configuration. Either way the snapshot's version must
 * still be the context's live version, so a concurrent directory save fails
 * the send instead of silently widening the run.
 */
async function directoriesForWork(runtime: EmitRuntime, input: StartWorkInput): Promise<WorkDirectoryScopeRecord> {
  const parent = input.parentWorkId ? await findWork(runtime, input.parentWorkId) : undefined;
  if (parent !== undefined) {
    if (parent.workContextId !== input.workContextId) {
      throw new AppError(appMessages.work.directoryChanged());
    }
    const context = await findWorkContext(runtime, parent.workContextId);
    if (context === undefined || context.directories.version !== parent.directoryScope.version) {
      throw new AppError(appMessages.work.directoryChanged());
    }
    return { ...parent.directoryScope, paths: [...parent.directoryScope.paths] };
  }
  const context = await findWorkContext(runtime, input.workContextId);
  if (context === undefined) throw new AppError(appMessages.workContexts.notFound(input.workContextId));
  return workContextDirectorySnapshot(context, input.roomId);
}

async function mailParent(runtime: EmitRuntime, caller: WorkRecord, room: RoomRecord): Promise<string> {
  const app = await runtime.readSession(AppDoc);
  const seen = new Set<string>();
  let current: WorkRecord | undefined = caller;
  for (let depth = 0; current && depth <= app.collaboration.maxDepth && !seen.has(current.id); depth++) {
    seen.add(current.id);
    if (current.directoryScope.roomId !== room.id) break;
    if (await isSentMailEntry(runtime, room, current.sourceEntryId)) return current.sourceEntryId;
    current = current.parentWorkId ? await findWork(runtime, current.parentWorkId) : undefined;
  }
  return "";
}
