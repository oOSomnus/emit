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
  RoomMessageEntry,
  type MailEnvelope,
  type RoomMessageData,
  CollaborationDoc,
  ConversationContextDoc,
  EmployeeDoc,
  MailSendReceiptDoc,
  RoomDoc,
  WorkDoc,
  type EmployeeRecord,
  type MailSendReceiptRecord,
  type RoomRecord,
  type WorkRecord,
  type WorkDirectoryScopeRecord,
} from "./documents.ts";
import type { McpManager } from "./mcp.ts";
import type { MailTasks } from "./mail.ts";
import { buildEmployeeExtension, toThinkingLevel } from "./agents.ts";
import { cancelApprovalsForWork, type ToolRisk } from "./approval/state.ts";
import {
  ROOM_PAGE_SIZE,
  RoomDirectoryError,
  appendRoomMessageIn,
  appendRoomMessage,
  createRoom,
  findEmployeeDm,
  findRoom,
  isSentMailEntry,
  mailEnvelope,
  messageData,
  toMessageDTO,
  roomDTOWithUnread,
  type MailAddress,
} from "./rooms.ts";
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

export type WorkKind = "message" | "mail" | "delegation";

export type StartWorkInput = {
  roomId: string;
  employeeId: string;
  intent: string;
  kind: WorkKind;
  sourceEntryId: string;
  parentWorkId?: string;
  rootWorkId?: string;
  depth?: number;
};

/** One process's shared handles; the mail tasks resolve lazily to break the import cycle. */
export type Resume = {
  runtime: EmitRuntime;
  mcp: McpManager;
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
  const collaboration = parts?.collaboration ?? buildCollaborationTools(resume0, employee);
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
 * Create the work record: the validations that decide whether the request is
 * acceptable at all, then the queued record. No conversation and no run —
 * starting is a separate, restartable step.
 */
export async function createQueuedWork(resume0: Resume, input: StartWorkInput): Promise<WorkRecord> {
  const { runtime } = resume0;
  const employee = await runtime.readFamily(EmployeeDoc, input.employeeId, { id: input.employeeId });
  if (employee === undefined) throw new Error(`找不到员工 ${input.employeeId}`);
  if (!employee.enabled) throw new Error(`员工 ${employee.name} 已停用`);
  // A model that no longer resolves stops the work here, with the employee and
  // model named, instead of failing deep inside the first request.
  const modelProblem = runtime.catalog.chatSelectionProblem({
    providerId: employee.executionModel.providerId,
    modelId: employee.executionModel.modelId,
    effort: employee.executionModel.effort,
  });
  if (modelProblem !== undefined) throw new Error(`员工 ${employee.name} 的模型不可用：${modelProblem}`);
  const app = await runtime.readSession(AppDoc);

  const depth = input.depth ?? 0;
  if (depth > app.collaboration.maxDepth) {
    throw new Error(`交办层数超过上限（${app.collaboration.maxDepth} 层）`);
  }
  const workId = `wk_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const directoryScope = await directoriesForWork(runtime, input);
  const work = await runtime.harness.commit(
    (tx) =>
      createQueuedWorkIn(tx, {
        ...input,
        depth,
        id: workId,
        directoryScope,
        now: Date.now(),
      }),
    runtime.ctx,
  );
  const record = await runtime.readFamily(WorkDoc, workId, { id: workId });
  if (record === undefined) throw new Error(`工作记录写入失败 ${workId}`);
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
export class WorkFinishedError extends Error {
  constructor(readonly status: WorkRecord["status"]) {
    super(`工作已结束（${status}），不再启动执行`);
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
  if (work === undefined) throw new Error(`找不到工作 ${workId}`);
  if (work.conversationId !== 0) {
    const existing = await runtime.harness.conversation(work.conversationId as ConversationId, runtime.ctx);
    if (existing !== undefined) return existing;
  }
  const employee = await runtime.readFamily(EmployeeDoc, work.employeeId, { id: work.employeeId });
  if (employee === undefined) throw new Error(`找不到员工 ${work.employeeId}`);
  if (!employee.enabled) throw new Error(`员工 ${employee.name} 已停用`);
  const modelProblem = runtime.catalog.chatSelectionProblem({
    providerId: employee.executionModel.providerId,
    modelId: employee.executionModel.modelId,
    effort: employee.executionModel.effort,
  });
  if (modelProblem !== undefined) throw new Error(`员工 ${employee.name} 的模型不可用：${modelProblem}`);
  // The directories authorized when the mail was received are what this run
  // may use; a version that no longer matches the room must fail loudly here.
  if (work.directoryScope.roomId.length > 0) {
    const room = await findRoom(runtime, work.directoryScope.roomId);
    if (room === undefined || room.directories === undefined || room.directories.version !== work.directoryScope.version) {
      throw new Error("会话工作目录已变更，请停止并重新发送任务");
    }
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
  if (conversation === undefined) throw new Error(`执行会话不存在 ${conversationId}`);
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
  if (work === undefined) throw new Error(`找不到工作 ${workId}`);
  let mailSource: { entryId: string; message: RoomMessageData } | undefined;
  if (work.kind === "mail") {
    const room = await findRoom(runtime, work.roomId);
    const source = room === undefined ? undefined : await sourceMessage(runtime, room, work.sourceEntryId);
    if (source?.mail === undefined || source.mail === null) throw new Error("找不到本次邮件原文，无法生成回复任务");
    mailSource = { entryId: work.sourceEntryId, message: source };
  }

  const history = work.roomId.length > 0 ? await roomHistory(runtime, work.roomId, work.sourceEntryId) : [];
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
      await markFailed(resume0, current, "本次运行没有产生回答（模型或工具出错，详情见该次运行记录）");
    })
    .catch(() => undefined);

  return work;
}

/** Create the work item and start the run, for the paths that send and run together. */
export async function startWork(resume0: Resume, input: StartWorkInput): Promise<WorkRecord> {
  const work = await createQueuedWork(resume0, input);
  return startQueuedWork(resume0, work.id);
}

async function roomName(runtime: EmitRuntime, roomId: string): Promise<string> {
  if (roomId.length === 0) return "";
  const room = await runtime.readFamily(RoomDoc, roomId, { id: roomId });
  return room?.name ?? "";
}

/** The room's messages before the one that started this work. */
async function roomHistory(runtime: EmitRuntime, roomId: string, sourceEntryId: string): Promise<MessageDTO[]> {
  const room = await runtime.readFamily(RoomDoc, roomId, { id: roomId });
  if (room === undefined) return [];
  const conversation = await runtime.harness.conversation(room.conversationId as ConversationId, runtime.ctx);
  if (conversation === undefined) return [];
  const page = await conversation.entries({}, HISTORY_MESSAGE_LIMIT, undefined, runtime.ctx);
  const messages: MessageDTO[] = [];
  for (const entry of page.items) {
    const id = String(entry.id);
    if (id === sourceEntryId) continue;
    if (!RoomMessageEntry.is(entry)) continue;
    const data = entry.data;
    messages.push({
      id,
      roomId,
      author: {
        type: data.authorType,
        id: data.authorId,
        name: data.authorName,
        ...(data.address.length > 0 ? { address: data.address } : {}),
      },
      body: data.body,
      createdAt: data.createdAt,
    });
  }
  return messages.reverse();
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
      runtime.emit({
        type: "notice",
        text: `协作已达到模型轮次上限（${app.collaboration.maxModelTurns} 轮），本次工作已停止。`,
      });
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
      : { name: app.userName.length > 0 ? app.userName : "你", address: app.userAddress };
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
  return entry !== undefined && RoomMessageEntry.is(entry) ? entry.data : undefined;
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
  await runtime.harness.commit(async (tx) => {
    const doc = await tx.doc(WorkDoc, workId, { id: workId });
    if (isTerminal(doc.status)) return;
    doc.status = "stopped";
    doc.finishedAt = Date.now();
    doc.error = "已被用户停止";
    // The replies it was waiting for belong to a task that is over; keeping
    // the link would leave a stopped work advertising a wait it will never
    // resume from.
    doc.awaitedMailWorkIds = [];
    // Stopping a child is also an outcome for the parent that asked for it.
    await handOffToAwaitingParent(tx, resume0, doc, "stopped", "已被用户停止");
  }, runtime.ctx);
  const updated = await runtime.readFamily(WorkDoc, workId, { id: workId });
  if (updated === undefined) return undefined;
  const employee = await runtime.readFamily(EmployeeDoc, updated.employeeId, { id: updated.employeeId });
  runtime.emit({ type: "work", work: toWorkDTO(updated, employee?.name ?? "", await roomName(runtime, updated.roomId)) });

  // A queued mail has a live dispatch task that must not submit a run for a
  // stopped work: abort it and wait for its terminal receipt first, so the
  // late-submit window is closed before anything else is unwound.
  if (updated.mailDispatchTaskId.length > 0) {
    const dispatchTaskId = Number(updated.mailDispatchTaskId) as TaskId;
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
      await appendRoomMessage(
        runtime,
        room,
        messageData({
          author: { type: "system", id: "system", name: "系统" },
          body: `已停止 ${employee?.name ?? "员工"} 的工作。`,
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
    // A mail recipient's start is carried by a durable dispatch task. While it
    // is live the native scheduler owns the work; a blocked, missing, or
    // failed task is an explicit failure instead of a silent hang.
    if (work.kind === "mail" && work.status === "queued" && work.mailDispatchTaskId.length > 0) {
      const dispatch = inspectionTasks.get(work.mailDispatchTaskId);
      if (dispatch !== undefined && dispatch.state.kind !== "blocked" && dispatch.state.kind !== "completing") continue;
      const record = await runtime.harness.getTask(Number(work.mailDispatchTaskId) as TaskId, runtime.ctx);
      const outcome = record !== undefined && record.state.status === "terminal" ? record.state.outcome : undefined;
      if (outcome?.status === "failed") {
        await markFailed(resume0, work, outcome.error.message);
        failed += 1;
        continue;
      }
      if (dispatch === undefined || dispatch.state.kind === "blocked") {
        await markFailed(resume0, work, "邮件投递任务丢失，该收件人的工作未能开始");
        failed += 1;
        continue;
      }
      continue;
    }
    // Waiting for another employee's reply is a valid idle state, not an
    // interrupted run; the awaited child works decide what happens next.
    if (work.status === "waiting-mail") {
      const liveTaskIds = new Set(inspection.tasks.map((task) => String(task.record.id)));
      const broken = await brokenAwait(runtime, work, liveTaskIds);
      if (broken !== undefined) {
        await markFailed(resume0, work, `等待的回信无法续接原任务：${broken}`);
        failed += 1;
      }
      continue;
    }
    if (work.conversationId === 0) {
      if (work.status === "queued") {
        await markFailed(resume0, work, "启动过程中断，未能创建执行会话");
        failed += 1;
      }
      continue;
    }
    if (liveConversations.has(String(work.conversationId))) continue;
    await cancelApprovalsForWork(runtime, work.id);
    await markFailed(resume0, work, "进程中断，该次运行未能恢复");
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
): Promise<string | undefined> {
  const awaited = await Promise.all(work.awaitedMailWorkIds.map((id) => findWork(runtime, id)));
  for (const child of awaited) {
    if (child === undefined) return "等待的回信工作记录丢失";
    if (!isTerminal(child.status)) return undefined;
  }
  for (const child of awaited) {
    if (child === undefined) continue;
    if (child.mailResumeTaskId.length === 0) return `回信任务缺失（${child.id}）`;
    if (liveTaskIds.has(child.mailResumeTaskId)) continue;
    const record = await runtime.harness.getTask(Number(child.mailResumeTaskId) as TaskId, runtime.ctx);
    if (record === undefined) return `回信任务记录丢失（${child.id}）`;
    if (record.state.status !== "terminal") continue;
    if (record.state.outcome?.status === "failed") return record.state.outcome.error.message;
    const submission = await runtime.storage.submissionByRequest(
      work.conversationId as ConversationId,
      `mail-reply:${child.id}`,
      runtime.ctx,
    );
    if (submission === undefined) return `回信没有进入原任务（${child.id}）`;
  }
  return undefined;
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
  error: string,
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
      error,
    },
    {
      ownership: { kind: "conversation" },
      conversationId: parent.conversationId as ConversationId,
      background: true,
    },
  );
  child.mailResumeTaskId = String(taskId);
}

export async function markFailed(resume0: Resume, work: WorkRecord, reason: string): Promise<void> {
  const runtime = resume0.runtime;
  await runtime.harness.commit(async (tx) => {
    const doc = await tx.doc(WorkDoc, work.id, { id: work.id });
    if (isTerminal(doc.status)) return;
    doc.status = "failed";
    doc.finishedAt = Date.now();
    doc.error = reason;
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
  await appendRoomMessage(
    runtime,
    room,
    messageData({
      author: { type: "system", id: "system", name: "系统" },
      body: `${employee?.name ?? "员工"} 的这次工作未能完成：${reason}。请重新发送。`,
      workId: work.id,
      notice: true,
    }),
  );
}

/** The collaboration tools every employee has, bound to that employee. */
export function buildCollaborationTools(resume0: Resume, employee: EmployeeRecord): ToolRegistration[] {
  const { runtime } = resume0;

  const sendMessage = defineTool({
    name: "send_message",
    description: toolTextResources.send_message.description,
    parameters: Type.Object({
      to: Type.String({ description: toolTextResources.send_message.parameters.to }),
      body: Type.String({ description: toolTextResources.send_message.parameters.body }),
    }),
    execute: async (args, api, context) => {
      const target = await resolveTarget(runtime, args.to);
      if (target === undefined) return toolError(`找不到员工 ${args.to}`);
      const room = await ensureEmployeeDm(resume0, employee, target);
      const message = await appendRoomMessage(
        runtime,
        room,
        messageData({
          author: { type: "employee", id: employee.id, name: employee.name, address: employee.address },
          body: args.body,
        }),
      );
      const work = await startWork(resume0, {
        roomId: room.id,
        employeeId: target.id,
        intent: args.body,
        kind: "message",
        sourceEntryId: message.id,
        rootWorkId: await rootOf(runtime, api, context),
        depth: await depthOf(runtime, api, context),
      });
      return toolText(renderToolResult("send-message-ok", { name: target.name, workId: work.id }));
    },
  });

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
      if (target === undefined) return toolError(`找不到员工 ${args.to}`);
      const callerId = await workOf(runtime, api, context);
      const caller = await findWork(runtime, callerId);
      if (caller === undefined) return toolError("找不到当前工作");
      const awaiting = args.awaitReply === true;
      if (awaiting) {
        // Waiting is a dependency, so it obeys the same loop and depth rules
        // as a delegation; the wake and layer budget are spent with the send.
        if (target.id === employee.id) return toolError("不能等待自己给自己发信");
        if (await isAncestor(runtime, caller.id, target.id)) {
          return toolError(`不能向本任务的上级 ${target.name} 求助回信，这会形成循环`);
        }
        const app = await runtime.readSession(AppDoc);
        if (caller.depth + 1 > app.collaboration.maxDepth) {
          return toolError(`求助层数会超过上限（${app.collaboration.maxDepth} 层）`);
        }
      }
      const sourceRoom = await findRoom(runtime, caller.directoryScope.roomId);
      if (sourceRoom === undefined || sourceRoom.directories?.version !== caller.directoryScope.version) {
        return toolError("会话工作目录已变更，请停止并重新发送任务");
      }
      const continuation = sourceRoom.kind === "mail" && args.newSession !== true;
      if (!continuation && args.inReplyTo) return toolError("新邮件会话不能引用旧会话的 inReplyTo");
      let inReplyTo = "";
      if (continuation) {
        inReplyTo = args.inReplyTo ?? await mailParent(runtime, caller, sourceRoom);
        if (!(await isSentMailEntry(runtime, sourceRoom, inReplyTo))) {
          return toolError("无法确定当前邮件父节点，请指定当前会话内的 inReplyTo");
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
                    employeeId: target.id,
                    memberIds: [employee.id, target.id],
                    directories: { paths: [], defaultPath: "", version: 1 },
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
          intent: `主题：${args.subject}\n\n${args.body}`,
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
      if (target === undefined) return toolError(`找不到员工 ${args.employee}`);
      if (target.id === employee.id) return toolError("不能把任务交办给自己");
      const app = await runtime.readSession(AppDoc);
      const depth = (await depthOf(runtime, api, context)) + 1;
      if (depth > app.collaboration.maxDepth) {
        return toolError(`交办层数会超过上限（${app.collaboration.maxDepth} 层）`);
      }
      const rootWorkId = await rootOf(runtime, api, context);
      const currentWork = await workOf(runtime, api, context);
      // Handing work back up the chain is a loop, not a collaboration: it would
      // ping-pong until the depth or wake limit ran out, so it is refused here
      // where the reason is still clear.
      if (await isAncestor(runtime, currentWork, target.id)) {
        return toolError(`不能把任务交办给本任务的上级 ${target.name}，这会形成循环`);
      }
      if (!(await reserveWake(runtime, rootWorkId, app.collaboration.maxCrossEmployeeWakes))) {
        return toolError(`本次协作已达到跨员工唤醒上限（${app.collaboration.maxCrossEmployeeWakes} 次）`);
      }
      const work = await startWork(resume0, {
        roomId: "",
        employeeId: target.id,
        intent: args.task,
        kind: "delegation",
        sourceEntryId: "",
        parentWorkId: currentWork,
        rootWorkId,
        depth,
      });
      return toolText(
        renderToolResult("delegate-ok", { name: target.name, workId: work.id }),
      );
    },
  });

  return [sendMessage, sendMail, delegate];
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

/** Find or create the target's direct-message conversation. */
async function ensureEmployeeDm(resume0: Resume, from: EmployeeRecord, target: EmployeeRecord): Promise<RoomRecord> {
  const existing = await findEmployeeDm(resume0.runtime, target.id);
  if (existing !== undefined) return existing;
  const app = await resume0.runtime.readSession(AppDoc);
  return createRoom(resume0.runtime, {
    kind: "dm",
    name: `${from.name} ↔ ${target.name}`,
    topic: `私信：${target.name}（${app.workspaceName}）`,
    employeeId: target.id,
    memberIds: [from.id, target.id],
  });
}

async function directoriesForWork(runtime: EmitRuntime, input: StartWorkInput): Promise<WorkDirectoryScopeRecord> {
  const parent = input.parentWorkId ? await findWork(runtime, input.parentWorkId) : undefined;
  if (!input.roomId) {
    if (!parent?.directoryScope?.roomId) throw new Error("交办任务没有有效来源会话");
    const room = await findRoom(runtime, parent.directoryScope.roomId);
    if (!room?.directories || room.directories.version !== parent.directoryScope.version) {
      throw new Error("会话工作目录已变更，请停止并重新发送任务");
    }
    return { ...parent.directoryScope, paths: [...parent.directoryScope.paths] };
  }
  const room = await findRoom(runtime, input.roomId);
  if (!room) throw new Error("来源会话不存在");
  if (!room.directories) throw new Error("该会话缺少目录配置，请重新创建会话");
  if (parent?.directoryScope?.roomId === room.id && parent.directoryScope.version !== room.directories.version) {
    throw new Error("会话工作目录已变更，请停止并重新发送任务");
  }
  return { roomId: room.id, ...room.directories, paths: [...room.directories.paths] };
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
