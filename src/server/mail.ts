/**
 * Mail delivery as durable work.
 *
 * Sending a mail and starting its recipients used to be two independent
 * commits, so a crash in between silently dropped the wake-up. Here the send
 * transaction writes the entry, every recipient's queued work, and one
 * `emit.mail-dispatch` task per recipient; the native task scheduler then
 * creates the execution conversation and admits the prompt, and re-schedules
 * both after a crash. A second task kind, `emit.mail-resume`, feeds a finished
 * child's reply back into a parent that asked for it (see `awaitReply`).
 *
 * Nothing here polls, waits a random interval, or queues outside the storage:
 * scheduling is Pi Durable's, and the phases only commit checkpoints.
 */
import { defineExtension, defineTask, type Extension, type Task, type TaskOutcome, type TaskRuntime } from "@earendil-works/pi-durable";
import type { ConversationId, EntryId } from "@earendil-works/pi-durable";
import type { Context as ChordContext } from "@earendil-works/chord";
import type { Draft } from "@earendil-works/chord/delta";
import { randomUUID } from "node:crypto";
import type { EmitRuntime } from "./runtime.ts";
import {
  AppDoc,
  CollaborationDoc,
  EmployeeDoc,
  MailFlagDoc,
  MailSendReceiptDoc,
  RoomDoc,
  RoomMessageEntry,
  WorkDoc,
  type MailSendReceiptRecord,
  type RoomDirectoriesRecord,
  type RoomMessageData,
  type RoomRecord,
  type WorkRecord,
} from "./documents.ts";
import {
  RoomDirectoryError,
  appendRoomMessageIn,
  createRoomIn,
  findRoom,
  plainRoom,
  roomDTOWithUnread,
  toMessageDTO,
  type RoomCreateInput,
} from "./rooms.ts";
import {
  WorkFinishedError,
  createQueuedWorkIn,
  ensureWorkConversationIn,
  findWork,
  installEmployeeExtension,
  isTerminal,
  markFailed,
  startQueuedWork,
  type Resume,
} from "./work.ts";
import { toWorkDTO } from "./dto.ts";
import { toThinkingLevel } from "./agents.ts";
import { renderMailContinuation } from "./prompts/index.ts";
import type { MessageDTO } from "../shared/contracts.ts";

export type MailDispatchInput = { workId: string };
export type MailDispatchState = { phase: "start" | "submit" };
export type MailDispatchResult = { workId: string };

export type MailResumeInput = {
  parentWorkId: string;
  childWorkId: string;
  roomId: string;
  entryId: string;
  outcome: "reply" | "failed" | "stopped";
  error: string;
};
export type MailResumeState = { phase: "submit" };
export type MailResumeResult = { submitted: boolean };

export type MailTasks = {
  dispatch: Task<MailDispatchInput, MailDispatchState, MailDispatchResult, object>;
  resumeTask: Task<MailResumeInput, MailResumeState, MailResumeResult, object>;
  /** The atomic send every mail entry point uses, bound to this process's resume. */
  sendQueuedMail: (input: SendQueuedMailInput) => Promise<SendQueuedMailResult>;
};

/** Commit one terminal outcome; a phase that ends without durable progress faults the task. */
async function commitTerminal<I, S extends { phase: string }, R>(
  taskRuntime: TaskRuntime<I, S, R, object>,
  outcome: TaskOutcome<R>,
  context: ChordContext,
): Promise<void> {
  await taskRuntime.commit(async () => ({ status: "terminal", outcome }), context);
}

/** Settle a dispatch failure: fail the work once with a notice, then the task. */
async function failDispatch(
  resume: Resume,
  taskRuntime: TaskRuntime<MailDispatchInput, MailDispatchState, MailDispatchResult, object>,
  work: WorkRecord,
  reason: string,
  context: ChordContext,
): Promise<void> {
  if (!isTerminal(work.status) && work.status !== "stopped") {
    await markFailed(resume, work, reason);
  }
  await commitTerminal(taskRuntime, { status: "failed", error: { message: reason } }, context);
}

/**
 * The two durable mail tasks.
 *
 * `resolve` hands back the process `Resume` only when a phase actually runs,
 * so the task definitions can be built before the rest of the application is
 * wired without module cycles.
 */
export function buildMailTasks(resolve: () => Resume): MailTasks {
  const dispatch = defineTask<MailDispatchInput, MailDispatchState, MailDispatchResult, object>({
    name: "emit.mail-dispatch",
    version: 1,
    initial: () => ({ phase: "start" }),
    phases: {
      start: async (task, taskRuntime, context) => {
        const resume = resolve();
        const { runtime } = resume;
        const work = await findWork(runtime, task.input.workId);
        if (work === undefined) {
          await commitTerminal(taskRuntime, { status: "failed", error: { message: `找不到邮件工作 ${task.input.workId}` } }, context);
          return;
        }
        // A work stopped before its start must not be started by the
        // scheduler that just recovered the task.
        if (work.status === "stopped" || isTerminal(work.status)) {
          await commitTerminal(taskRuntime, { status: "completed", result: { workId: task.input.workId } }, context);
          return;
        }
        const app = await runtime.readSession(AppDoc);
        if (work.depth > app.collaboration.maxDepth) {
          await failDispatch(resume, taskRuntime, work, `交办层数超过上限（${app.collaboration.maxDepth} 层）`, context);
          return;
        }
        const employee = await runtime.readFamily(EmployeeDoc, work.employeeId, { id: work.employeeId });
        if (employee === undefined) {
          await failDispatch(resume, taskRuntime, work, `找不到员工 ${work.employeeId}`, context);
          return;
        }
        if (!employee.enabled) {
          await failDispatch(resume, taskRuntime, work, `员工 ${employee.name} 已停用`, context);
          return;
        }
        const modelProblem = runtime.catalog.chatSelectionProblem({
          providerId: employee.executionModel.providerId,
          modelId: employee.executionModel.modelId,
          effort: employee.executionModel.effort,
        });
        if (modelProblem !== undefined) {
          await failDispatch(resume, taskRuntime, work, `员工 ${employee.name} 的模型不可用：${modelProblem}`, context);
          return;
        }
        try {
          // The extension must be built and installed before the commit: the
          // agent configuration inside the transaction stores it by name.
          const extension = work.conversationId === 0 ? await installEmployeeExtension(resume, employee) : undefined;
          await taskRuntime.commit(async (tx) => {
            if (work.conversationId === 0) {
              // The send-time directory snapshot is what this run may use;
              // later authorization must not leak into a queued mail.
              const room = await tx.doc(RoomDoc, work.directoryScope.roomId, { id: work.directoryScope.roomId });
              if (
                room === undefined ||
                room.directories === undefined ||
                room.directories.version !== work.directoryScope.version
              ) {
                throw new Error("会话工作目录已变更，请停止并重新发送任务");
              }
              await ensureWorkConversationIn(tx, work.id, {
                extension: extension!,
                model: { provider: employee.executionModel.providerId, modelId: employee.executionModel.modelId },
                thinkingLevel: toThinkingLevel(employee.executionModel.effort),
                cwd: work.directoryScope.defaultPath || null,
              });
            }
            return { status: "running", checkpoint: { phase: "submit" } };
          }, context);
        } catch (error) {
          if (error instanceof WorkFinishedError) {
            await commitTerminal(taskRuntime, { status: "completed", result: { workId: task.input.workId } }, context);
            return;
          }
          const reason = error instanceof Error ? error.message : String(error);
          const current = await findWork(runtime, task.input.workId);
          if (current !== undefined && !isTerminal(current.status) && current.status !== "stopped") {
            await failDispatch(resume, taskRuntime, current, reason, context);
            return;
          }
          await commitTerminal(taskRuntime, { status: "failed", error: { message: reason } }, context);
        }
      },
      submit: async (task, taskRuntime, context) => {
        const resume = resolve();
        try {
          await startQueuedWork(resume, task.input.workId);
        } catch (error) {
          if (error instanceof WorkFinishedError) {
            await commitTerminal(taskRuntime, { status: "completed", result: { workId: task.input.workId } }, context);
            return;
          }
          const reason = error instanceof Error ? error.message : String(error);
          const current = await findWork(resume.runtime, task.input.workId);
          if (current !== undefined && !isTerminal(current.status) && current.status !== "stopped") {
            await failDispatch(resume, taskRuntime, current, reason, context);
            return;
          }
          await commitTerminal(taskRuntime, { status: "failed", error: { message: reason } }, context);
          return;
        }
        await commitTerminal(taskRuntime, { status: "completed", result: { workId: task.input.workId } }, context);
      },
    },
    abort: async (_task, taskRuntime, context) => {
      // The work itself was already marked stopped by `stopWork`; the task
      // only records that it will never submit.
      await taskRuntime.commit(
        async () => ({
          status: "terminal",
          outcome: { status: "failed", error: { message: "邮件投递已被停止" } },
        }),
        context,
      );
    },
  });

  const resumeTask = defineTask<MailResumeInput, MailResumeState, MailResumeResult, object>({
    name: "emit.mail-resume",
    version: 1,
    initial: () => ({ phase: "submit" }),
    phases: {
      submit: async (task, taskRuntime, context) => {
        const resume = resolve();
        const { runtime } = resume;
        const parent = await findWork(runtime, task.input.parentWorkId);
        if (parent === undefined) {
          await commitTerminal(taskRuntime, { status: "failed", error: { message: "原任务不存在，无法续接回信" } }, context);
          return;
        }
        if (parent.conversationId === 0) {
          await commitTerminal(taskRuntime, { status: "failed", error: { message: "原任务执行会话不存在" } }, context);
          return;
        }
        // A parent that already ended must not be revived by a late reply. A
        // parent that is still running is fine: the follow-up waits in its
        // conversation until the current turn ends.
        if (isTerminal(parent.status) || parent.status === "stopped") {
          await commitTerminal(taskRuntime, { status: "completed", result: { submitted: false } }, context);
          return;
        }
        const room = await findRoom(runtime, task.input.roomId);
        if (room === undefined) {
          await commitTerminal(taskRuntime, { status: "failed", error: { message: "邮件会话不存在" } }, context);
          return;
        }
        if (
          parent.directoryScope.roomId === room.id &&
          room.directories !== undefined &&
          room.directories.version !== parent.directoryScope.version
        ) {
          await markFailed(resume, parent, "会话工作目录已变更，回信无法续接原任务");
          await commitTerminal(taskRuntime, { status: "completed", result: { submitted: false } }, context);
          return;
        }
        const conversation = await taskRuntime.conversation(parent.conversationId as ConversationId, context);
        if (conversation === undefined) {
          await commitTerminal(taskRuntime, { status: "failed", error: { message: "原任务执行会话不存在" } }, context);
          return;
        }
        // A reply continues from the child's answer; a failure or a stop has
        // no answer entry, so it continues from the request the child received
        // and states the outcome instead of inventing a reply.
        const child = await findWork(runtime, task.input.childWorkId);
        const source =
          task.input.outcome === "reply"
            ? await readMessageEntry(runtime, room, task.input.entryId, context)
            : await readMessageEntry(runtime, room, child?.sourceEntryId ?? "", context);
        const mail = source?.mail ?? null;
        if (source === undefined || mail === null) {
          await commitTerminal(taskRuntime, { status: "failed", error: { message: "找不到回信原文，无法续接" } }, context);
          return;
        }
        const childEmployee =
          child !== undefined ? await runtime.readFamily(EmployeeDoc, child.employeeId, { id: child.employeeId }) : undefined;
        // The reply is one employee's text about another employee's work:
        // visible evidence, never user authorization.
        await conversation.submit(
          {
            type: "input",
            content: renderMailContinuation({
              subject: mail.subject,
              from:
                task.input.outcome === "reply"
                  ? { name: source.authorName, address: source.address }
                  : { name: childEmployee?.name ?? child?.employeeId ?? "", address: childEmployee?.address ?? "" },
              to: mail.to,
              cc: mail.cc,
              inReplyTo: mail.inReplyTo,
              entryId: task.input.outcome === "reply" ? task.input.entryId : "",
              outcome: task.input.outcome,
              body: task.input.outcome === "reply" ? source.body : "",
              error: task.input.error,
            }),
            whenBusy: "followUp",
            requestId: `mail-reply:${task.input.childWorkId}`,
          },
          context,
        );
        await commitTerminal(taskRuntime, { status: "completed", result: { submitted: true } }, context);
      },
    },
    abort: async (_task, taskRuntime, context) => {
      await taskRuntime.commit(
        async () => ({
          status: "terminal",
          outcome: { status: "failed", error: { message: "回信续接已被停止" } },
        }),
        context,
      );
    },
  });

  return { dispatch, resumeTask, sendQueuedMail: (input) => sendQueuedMail(resolve(), input) };
}

/** Extension that registers the mail tasks globally; conversations do not select it. */
export function buildMailExtension(tasks: MailTasks): Extension {
  return defineExtension({ name: "emit.mail", tasks: [tasks.dispatch, tasks.resumeTask] });
}

export type SendQueuedMailInput = {
  /** Existing room, or a room created inside the same send transaction. */
  room: { id: string } | { create: RoomCreateInput & { directories: RoomDirectoriesRecord } };
  /** The sent message: author, body, and the mail envelope. */
  data: RoomMessageData;
  /** The plain-text request stored on each recipient's work; defaults to the body. */
  intent?: string;
  /** Caller work for tool sends; the recipients' works hang below it. */
  parentWorkId?: string;
  /** Draft entry retired in the same commit. */
  retireDraftId?: string;
  /** Tool task id, which makes the send replay-safe. */
  toolTaskId?: string;
  /**
   * The caller needs this recipient's answer to finish. The recipient works
   * are added to the caller's awaited list and the caller's pause happens in
   * the delivery hook, not here; the wake budget is spent in this commit.
   */
  awaitReply?: boolean;
};

export type SendQueuedMailResult = { message: MessageDTO; workIds: string[] };

/**
 * Receive one sent mail and queue one work per To recipient — atomically.
 *
 * Every already-sent mail goes through here: the user's compose, a draft
 * send, and the employee `send_mail` tool. The single commit covers the
 * entry, the queued works, the dispatch tasks, the draft retirement, and the
 * replay receipt, so a crash leaves either everything or nothing behind.
 * Per-recipient start failures are the dispatch task's business and never
 * fail the send itself.
 */
export async function sendQueuedMail(resume: Resume, input: SendQueuedMailInput): Promise<SendQueuedMailResult> {
  const { runtime } = resume;
  const envelope = input.data.mail;
  if (envelope === null || envelope === undefined || envelope.draft) {
    throw new Error("sendQueuedMail 只接受已发送的邮件");
  }
  const recipients = [...new Set(envelope.recipients)];

  // A replay must not re-run validations the first call already consumed.
  if (input.toolTaskId !== undefined && input.toolTaskId.length > 0) {
    const receipt = await readSendReceipt(runtime, input.toolTaskId);
    if (receipt !== undefined) return replayedSend(runtime, receipt);
  }

  const intent = input.intent ?? input.data.body;
  const committed = await runtime.harness.commit(async (tx) => {
    // Reads before the first table write: the entry table rejects reads that
    // follow a write inside the same transaction.
    if ("create" in input.room && envelope.inReplyTo.length > 0) {
      throw new RoomDirectoryError(400, "新邮件会话不能引用旧会话的 inReplyTo");
    }
    let room: RoomRecord | undefined;
    if (!("create" in input.room)) {
      const doc = await tx.doc(RoomDoc, input.room.id, { id: input.room.id });
      if (doc === undefined) throw new RoomDirectoryError(404, `会话不存在：${input.room.id}`);
      room = plainRoom(doc);
    }

    // A draft send retires the draft in the same transaction that appends the
    // sent entry, so two concurrent sends cannot both pass the check.
    if (input.retireDraftId !== undefined && input.retireDraftId.length > 0) {
      if (room === undefined) throw new RoomDirectoryError(400, "新邮件会话不能退役草稿");
      const draftEntry = await tx.entry(Number(input.retireDraftId) as EntryId);
      if (
        draftEntry === undefined ||
        draftEntry.conversationId !== (room.conversationId as ConversationId) ||
        !RoomMessageEntry.is(draftEntry) ||
        draftEntry.data.mail === null ||
        !draftEntry.data.mail.draft
      ) {
        throw new RoomDirectoryError(409, "草稿不存在或已失效，请刷新后重试");
      }
      const flagKey = `${room.id}|${input.retireDraftId}`;
      const flag = await tx.doc(MailFlagDoc, flagKey, { key: flagKey });
      if (flag.active === false) throw new RoomDirectoryError(409, "这封邮件已经发送");
    }

    // The envelope's parent must be a sent mail of this very room.
    if (envelope.inReplyTo.length > 0) {
      if (room === undefined) throw new RoomDirectoryError(400, "新邮件会话不能引用旧会话的 inReplyTo");
      const parent = await tx.entry(Number(envelope.inReplyTo) as EntryId);
      if (
        parent === undefined ||
        parent.conversationId !== (room.conversationId as ConversationId) ||
        !RoomMessageEntry.is(parent) ||
        parent.data.mail === null ||
        !parent.data.mail.sent ||
        parent.data.mail.draft
      ) {
        throw new RoomDirectoryError(400, "inReplyTo 必须引用当前会话内的已发送邮件");
      }
    }

    // The parent work anchors root and depth; it must still be live.
    let depth: number | undefined;
    let rootWorkId: string | undefined;
    let parentDraft: Draft<WorkRecord> | undefined;
    if (input.parentWorkId !== undefined && input.parentWorkId.length > 0) {
      const parentWork = await tx.doc(WorkDoc, input.parentWorkId, { id: input.parentWorkId });
      if (parentWork === undefined) throw new Error(`找不到当前工作 ${input.parentWorkId}`);
      if (isTerminal(parentWork.status) || parentWork.status === "stopped") {
        throw new Error("当前工作已结束，不能再发送邮件");
      }
      parentDraft = parentWork;
      depth = input.awaitReply === true ? parentWork.depth + 1 : parentWork.depth;
      rootWorkId = parentWork.rootWorkId;
      if (input.awaitReply === true) {
        const app = await tx.doc(AppDoc);
        if (depth > app.collaboration.maxDepth) {
          throw new RoomDirectoryError(400, `交办层数超过上限（${app.collaboration.maxDepth} 层）`);
        }
      }
      // A continuation shares the caller's room: the send-time snapshot must
      // still be the live configuration, or the mail would silently gain
      // directories that were added after the caller started.
      if (
        room !== undefined &&
        parentWork.directoryScope.roomId === room.id &&
        room.directories.version !== parentWork.directoryScope.version
      ) {
        throw new RoomDirectoryError(409, "会话工作目录已变更，请停止并重新发送任务");
      }
    } else if (input.awaitReply === true) {
      throw new RoomDirectoryError(400, "只有员工之间的邮件才能等待回信");
    }

    if (room === undefined) {
      if (!("create" in input.room)) throw new RoomDirectoryError(404, `会话不存在：${input.room.id}`);
      room = await createRoomIn(tx, { ...input.room.create, directories: input.room.create.directories });
    }

    const entry = await appendRoomMessageIn(tx, room, input.data);

    const directoryScope = {
      roomId: room.id,
      version: room.directories.version,
      paths: [...room.directories.paths],
      defaultPath: room.directories.defaultPath,
    };
    const now = Date.now();
    const workIds: string[] = [];
    for (const employeeId of recipients) {
      const workId = `wk_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
      await createQueuedWorkIn(tx, {
        roomId: room.id,
        employeeId,
        intent,
        kind: "mail",
        sourceEntryId: String(entry.id),
        parentWorkId: input.parentWorkId,
        rootWorkId,
        depth,
        id: workId,
        directoryScope,
        now,
      });
      const taskId = await tx.createTask(
        resume.mail.dispatch,
        { workId },
        {
          ownership: { kind: "conversation" },
          conversationId: room.conversationId as ConversationId,
          background: true,
        },
      );
      const work = await tx.doc(WorkDoc, workId, { id: workId });
      work.mailDispatchTaskId = String(taskId);
      workIds.push(workId);
    }

    if (input.awaitReply === true) {
      // The caller waits for every recipient of this send. Both the awaited
      // list and the wake budget land with the mail, so a crash cannot leave a
      // reply with nobody waiting or a wake that was never paid for.
      const app = await tx.doc(AppDoc);
      const scope = rootWorkId ?? input.parentWorkId!;
      const collaboration = await tx.doc(CollaborationDoc, scope, { rootWorkId: scope });
      collaboration.rootWorkId = scope;
      collaboration.crossEmployeeWakes += workIds.length;
      if (collaboration.crossEmployeeWakes > app.collaboration.maxCrossEmployeeWakes) {
        throw new RoomDirectoryError(409, `本次协作已达到跨员工唤醒上限（${app.collaboration.maxCrossEmployeeWakes} 次）`);
      }
      parentDraft!.awaitedMailWorkIds = [...parentDraft!.awaitedMailWorkIds, ...workIds];
    }

    if (input.retireDraftId !== undefined && input.retireDraftId.length > 0) {
      const flagKey = `${room.id}|${input.retireDraftId}`;
      const flag = await tx.doc(MailFlagDoc, flagKey, { key: flagKey });
      flag.active = false;
    }

    if (input.toolTaskId !== undefined && input.toolTaskId.length > 0) {
      const receiptKey = `tool:${input.toolTaskId}`;
      const receipt = await tx.doc(MailSendReceiptDoc, receiptKey, { key: receiptKey });
      receipt.roomId = room.id;
      receipt.entryId = String(entry.id);
      receipt.workIds = [...workIds];
    }

    return { room, entry, workIds };
  }, runtime.ctx);

  const dto = toMessageDTO(committed.entry);
  if (dto === undefined) throw new Error("写入的消息类型不正确");
  dto.roomId = committed.room.id;
  runtime.emit({ type: "message", roomId: committed.room.id, message: dto });
  runtime.emit({ type: "room", room: await roomDTOWithUnread(runtime, committed.room) });
  for (const workId of committed.workIds) {
    const work = await findWork(runtime, workId);
    if (work === undefined) continue;
    const employee = await runtime.readFamily(EmployeeDoc, work.employeeId, { id: work.employeeId });
    runtime.emit({ type: "work", work: toWorkDTO(work, employee?.name ?? "", committed.room.name) });
  }
  return { message: dto, workIds: committed.workIds };
}

/** The receipt of a tool send, when one is already committed. */
async function readSendReceipt(
  runtime: EmitRuntime,
  toolTaskId: string,
): Promise<MailSendReceiptRecord | undefined> {
  const key = `tool:${toolTaskId}`;
  return runtime.readFamily(MailSendReceiptDoc, key, { key });
}

/** Rebuild the recorded outcome for a replayed tool send. */
async function replayedSend(
  runtime: EmitRuntime,
  receipt: MailSendReceiptRecord,
): Promise<SendQueuedMailResult> {
  const room = await findRoom(runtime, receipt.roomId);
  const conversation =
    room !== undefined
      ? await runtime.harness.conversation(room.conversationId as ConversationId, runtime.ctx)
      : undefined;
  const entryId = Number(receipt.entryId) as EntryId;
  const page =
    conversation !== undefined
      ? await conversation.entries({ minEntryId: entryId, maxEntryId: entryId }, 1, undefined, runtime.ctx)
      : undefined;
  const entry = page?.items[0];
  const dto = entry !== undefined ? toMessageDTO(entry) : undefined;
  if (room === undefined || dto === undefined) throw new Error("找不到已发送的邮件记录，无法重放发送结果");
  dto.roomId = room.id;
  return { message: dto, workIds: [...receipt.workIds] };
}

/** One room entry's message data by id, for reading a reply back. */
async function readMessageEntry(
  runtime: EmitRuntime,
  room: RoomRecord,
  entryId: string,
  context: ChordContext,
): Promise<RoomMessageData | undefined> {
  if (entryId.length === 0) return undefined;
  const conversation = await runtime.harness.conversation(room.conversationId as ConversationId, context);
  if (conversation === undefined) return undefined;
  const page = await conversation.entries(
    { minEntryId: Number(entryId) as EntryId, maxEntryId: Number(entryId) as EntryId },
    1,
    undefined,
    context,
  );
  const entry = page.items[0];
  return entry !== undefined && RoomMessageEntry.is(entry) ? entry.data : undefined;
}
