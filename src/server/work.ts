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
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  defineTool,
  GenerationTask,
  hook,
  UsageDoc,
  type ConversationId,
  type HookRegistration,
  type ToolExecutionApi,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import type { EmitRuntime } from "./runtime.ts";
import {
  AppDoc,
  RoomMessageEntry,
  type MailEnvelope,
  type RoomMessageData,
  CollaborationDoc,
  ConversationContextDoc,
  EmployeeDoc,
  RoomDoc,
  WorkDoc,
  type EmployeeRecord,
  type RoomRecord,
  type WorkRecord,
} from "./documents.ts";
import type { McpManager } from "./mcp.ts";
import { buildEmployeeExtension, toThinkingLevel } from "./agents.ts";
import { cancelApprovalsForWork, type ToolRisk } from "./approval/state.ts";
import {
  ROOM_PAGE_SIZE,
  appendRoomMessageIn,
  appendRoomMessage,
  createRoom,
  findEmployeeRoom,
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
import type { MessageDTO } from "../shared/contracts.ts";

const HISTORY_MESSAGE_LIMIT = 40;
const HISTORY_BODY_LIMIT = 2_000;

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
  /** Mail subject, for the answer's envelope. */
  subject?: string;
  /** Entry the mail answers, for the answer's envelope. */
  inReplyTo?: string;
};

export type Resume = {
  runtime: EmitRuntime;
  mcp: McpManager;
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
      hooks: [buildDeliveryHook(runtime)],
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
export async function installAllExtensions(runtime: EmitRuntime, mcp: McpManager): Promise<number> {
  const resume0: Resume = { runtime, mcp };
  const employees = await listEmployees(runtime);
  for (const employee of employees) await installEmployeeExtension(resume0, employee);
  return employees.length;
}

/** The prompt handed to the employee: the room so far, then the new request. */
export function buildPrompt(history: readonly MessageDTO[], intent: string, kind: WorkKind): string {
  const parts: string[] = [];
  if (history.length > 0) {
    parts.push("以下是这段会话最近的内容，供你了解上下文：");
    for (const message of history.slice(-HISTORY_MESSAGE_LIMIT)) {
      const label = message.author.type === "user" ? "用户" : message.author.type === "employee" ? message.author.name : "系统";
      const body = message.body.length > HISTORY_BODY_LIMIT ? `${message.body.slice(0, HISTORY_BODY_LIMIT)}…` : message.body;
      parts.push(`${label}：${body}`);
    }
    parts.push("");
  }
  parts.push(kind === "mail" ? "现在请你回复这封邮件：" : kind === "delegation" ? "另一位员工把这件事交办给你：" : "现在请你处理这条消息：");
  parts.push(intent);
  return parts.join("\n");
}

/** Create the work item, its execution conversation, and start the run. */
export async function startWork(resume0: Resume, input: StartWorkInput): Promise<WorkRecord> {
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
  const rootWorkId = input.rootWorkId ?? "";
  const parentWorkId = input.parentWorkId ?? "";
  const workId = `wk_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const now = Date.now();

  const work = await runtime.updateFamily(WorkDoc, workId, { id: workId }, (doc) => {
    doc.id = workId;
    doc.employeeId = employee.id;
    doc.roomId = input.roomId;
    doc.kind = input.kind;
    doc.status = "queued";
    doc.sourceEntryId = input.sourceEntryId;
    doc.parentWorkId = parentWorkId;
    doc.rootWorkId = rootWorkId.length > 0 ? rootWorkId : workId;
    doc.depth = depth;
    doc.startedAt = now;
    doc.intent = input.intent;
  });
  runtime.emit({ type: "work", work: toWorkDTO(work, employee.name, await roomName(runtime, input.roomId)) });

  const extension = await installEmployeeExtension(resume0, employee);
  const conversation = await runtime.harness.createConversation(
    {
      ownership: { kind: "ownerless" },
      agent: {
        extensions: [extension],
        model: { provider: employee.executionModel.providerId, modelId: employee.executionModel.modelId },
        thinkingLevel: toThinkingLevel(employee.executionModel.effort),
        cwd: employee.cwd.length > 0 ? employee.cwd : null,
      },
      init: async (tx, conversationId) => {
        const binding = await tx.doc(ConversationContextDoc, conversationId);
        binding.workId = workId;
        binding.employeeId = employee.id;
        binding.roomId = input.roomId;
        binding.rootWorkId = work.rootWorkId;
        binding.depth = depth;
      },
    },
    runtime.ctx,
  );

  const running = await runtime.updateFamily(WorkDoc, workId, { id: workId }, (doc) => {
    doc.conversationId = Number(conversation.id);
    doc.status = "running";
  });
  runtime.emit({ type: "work", work: toWorkDTO(running, employee.name, await roomName(runtime, input.roomId)) });

  const history = input.roomId.length > 0 ? await roomHistory(runtime, input.roomId, input.sourceEntryId) : [];
  const prompt = buildPrompt(history, input.intent, input.kind);
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
      await markFailed(runtime, current, "本次运行没有产生回答（模型或工具出错，详情见该次运行记录）");
    })
    .catch(() => undefined);

  return running;
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
export function buildDeliveryHook(runtime: EmitRuntime): HookRegistration {
  return hook(GenerationTask, {
    async onYield(answer, api, context) {
      return deliverAnswer(runtime, api.conversationId, assistantText(answer), context);
    },
    async afterResponse(_message, api, context) {
      // The turn budget is a loop breaker, not a cost opinion: a chain of
      // employees waking each other has to end somewhere the user can see.
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

async function deliverAnswer(
  runtime: EmitRuntime,
  conversationId: ConversationId,
  text: string,
  context: Context,
): Promise<undefined> {
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

  const entry = await runtime.harness.commit(async (tx) => {
    const doc = await tx.doc(WorkDoc, work.id, { id: work.id });
    if (isTerminal(doc.status)) return undefined;
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
    return appended;
  }, context);

  const updated = await runtime.readFamily(WorkDoc, work.id, { id: work.id });
  if (updated !== undefined) {
    runtime.emit({ type: "work", work: toWorkDTO(updated, employee.name, room.name) });
  }
  if (entry !== undefined) {
    const dto = toMessageDTO(entry);
    if (dto !== undefined) {
      dto.roomId = room.id;
      runtime.emit({ type: "message", roomId: room.id, message: dto });
    }
    runtime.emit({ type: "room", room: await roomDTOWithUnread(runtime, room) });
  }
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
    { type: "input", content: `【${employee.name} 的交办结果】\n${text}`, requestId: `deliver:${work.id}` },
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

/** Stop a running work: mark it stopped, cancel its approvals, then abort its conversation. */
export async function stopWork(runtime: EmitRuntime, workId: string): Promise<WorkRecord | undefined> {
  const work = await findWork(runtime, workId);
  if (work === undefined) return undefined;
  if (isTerminal(work.status)) return work;

  // Record the decision before unwinding the run. Aborting ends the run in
  // failure, and that failure must not overwrite what the user asked for.
  const updated = await runtime.updateFamily(WorkDoc, workId, { id: workId }, (doc) => {
    if (isTerminal(doc.status)) return;
    doc.status = "stopped";
    doc.finishedAt = Date.now();
    doc.error = "已被用户停止";
  });
  const employee = await runtime.readFamily(EmployeeDoc, updated.employeeId, { id: updated.employeeId });
  runtime.emit({ type: "work", work: toWorkDTO(updated, employee?.name ?? "", await roomName(runtime, updated.roomId)) });

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
export async function reconcileWorks(runtime: EmitRuntime): Promise<number> {
  const works = await listWorks(runtime);
  const pending = works.filter((work) => !isTerminal(work.status));
  if (pending.length === 0) return 0;
  const inspection = await runtime.harness.inspect(runtime.ctx);
  const liveConversations = new Set<string>();
  for (const task of inspection.tasks) liveConversations.add(String(task.record.conversationId));
  for (const submission of inspection.submissions) liveConversations.add(String(submission.conversationId));

  let failed = 0;
  for (const work of pending) {
    if (work.conversationId === 0) {
      if (work.status === "queued") {
        await markFailed(runtime, work, "启动过程中断，未能创建执行会话");
        failed += 1;
      }
      continue;
    }
    if (liveConversations.has(String(work.conversationId))) continue;
    await cancelApprovalsForWork(runtime, work.id);
    await markFailed(runtime, work, "进程中断，该次运行未能恢复");
    failed += 1;
  }
  return failed;
}

async function markFailed(runtime: EmitRuntime, work: WorkRecord, reason: string): Promise<void> {
  const updated = await runtime.updateFamily(WorkDoc, work.id, { id: work.id }, (doc) => {
    if (isTerminal(doc.status)) return;
    doc.status = "failed";
    doc.finishedAt = Date.now();
    doc.error = reason;
  });
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
    description: "Send an in-app message to another employee. It starts their work and their answer arrives as a message.",
    parameters: Type.Object({
      to: Type.String({ description: "Employee name, id, or address" }),
      body: Type.String({ description: "Message text" }),
    }),
    execute: async (args, api, context) => {
      const target = await resolveTarget(runtime, args.to);
      if (target === undefined) return toolError(`找不到员工 ${args.to}`);
      const room = await ensureEmployeeRoom(resume0, employee, target, "dm");
      await appendRoomMessage(
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
        sourceEntryId: "",
        rootWorkId: await rootOf(runtime, api, context),
        depth: await depthOf(runtime, api, context),
      });
      return toolText(`已发送给 ${target.name}，工作 ${work.id} 已开始；对方的回复会出现在你们的私信里。`);
    },
  });

  const sendMail = defineTool({
    name: "send_mail",
    description: "Send an in-app mail to another employee. It starts their work and their reply arrives as a mail.",
    parameters: Type.Object({
      to: Type.String({ description: "Employee name, id, or address" }),
      subject: Type.String({ description: "Mail subject" }),
      body: Type.String({ description: "Mail body" }),
      cc: Type.Optional(Type.String({ description: "Comma-separated employee names to copy" })),
    }),
    execute: async (args, api, context) => {
      const target = await resolveTarget(runtime, args.to);
      if (target === undefined) return toolError(`找不到员工 ${args.to}`);
      const room = await ensureEmployeeRoom(resume0, employee, target, "mail");
      const cc: { name: string; address: string }[] = [];
      const copied: string[] = [];
      for (const token of (args.cc ?? "").split(",").map((part) => part.trim())) {
        if (token.length === 0) continue;
        const ccEmployee = await resolveTarget(runtime, token);
        if (ccEmployee === undefined) continue;
        cc.push({ name: ccEmployee.name, address: ccEmployee.address });
        copied.push(ccEmployee.id);
      }
      await appendRoomMessage(
        runtime,
        room,
        messageData({
          author: { type: "employee", id: employee.id, name: employee.name, address: employee.address },
          body: args.body,
          mail: mailEnvelope({
            subject: args.subject,
            to: [{ name: target.name, address: target.address }],
            cc,
            recipients: [target.id],
            copies: copied,
            sent: true,
          }),
        }),
      );
      const work = await startWork(resume0, {
        roomId: room.id,
        employeeId: target.id,
        intent: `主题：${args.subject}\n\n${args.body}`,
        kind: "mail",
        sourceEntryId: "",
        rootWorkId: await rootOf(runtime, api, context),
        depth: await depthOf(runtime, api, context),
        subject: args.subject,
      });
      return toolText(`已发送邮件给 ${target.name}，工作 ${work.id} 已开始。`);
    },
  });

  const delegate = defineTool({
    name: "delegate_task",
    description:
      "Hand a task to another employee and let them own it. Their result comes back to you as a message in this conversation.",
    parameters: Type.Object({
      employee: Type.String({ description: "Employee name, id, or address" }),
      task: Type.String({ description: "What to do, and what to return" }),
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
        `已把任务交办给 ${target.name}（工作 ${work.id}）。结果会以消息形式出现在本会话中，你可以继续别的工作或等待。`,
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

/** Find or create the direct-message or mail thread between the user and one employee. */
async function ensureEmployeeRoom(
  resume0: Resume,
  from: EmployeeRecord,
  target: EmployeeRecord,
  kind: "dm" | "mail",
): Promise<RoomRecord> {
  const existing = await findEmployeeRoom(resume0.runtime, target.id, kind);
  if (existing !== undefined) return existing;
  const app = await resume0.runtime.readSession(AppDoc);
  const label = kind === "mail" ? "邮件" : "私信";
  void from;
  return createRoom(resume0.runtime, {
    kind,
    name: kind === "mail" ? `${target.name}` : `${from.name} ↔ ${target.name}`,
    topic: `${label}：${target.name}（${app.workspaceName}）`,
    employeeId: target.id,
    memberIds: [from.id, target.id],
  });
}
