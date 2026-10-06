/**
 * Mail delivery as durable work.
 *
 * Sending a mail and starting its recipients used to be two independent
 * commits, so a crash in between silently dropped the wake-up. Here the send
 * transaction writes the entry, every recipient's queued work, and one
 * `emit.work-dispatch` task per recipient; the native task scheduler then
 * creates the execution conversation and admits the prompt, and re-schedules
 * both after a crash. A second task kind, `emit.mail-resume`, feeds a finished
 * child's reply back into a parent that asked for it (see `awaitReply`).
 *
 * Nothing here polls, waits a random interval, or queues outside the storage:
 * scheduling is Pi Durable's, and the phases only commit checkpoints.
 */
import { defineExtension, defineTask, type Extension, type Task } from "@earendil-works/pi-durable";
import type { ConversationId, EntryId, EntryRecord } from "@earendil-works/pi-durable";
import type { Draft } from "@earendil-works/chord/delta";
import type { EmitRuntime } from "./runtime.ts";
import {
  AppDoc,
  EmployeeDoc,
  MailFlagDoc,
  MailSendReceiptDoc,
  RoomDoc,
  RoomMessageEntry,
  WorkDoc,
  type MailSendReceiptRecord,
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
  projectMessageAddresses,
  readFlags,
  roomDTOWithUnread,
  toMessageDTO,
  type RoomCreateInput,
} from "./rooms.ts";
import { markFailed, type Resume } from "./work.ts";
import { findWork, isTerminal, WakeBudgetExceededError, enqueueWorksIn } from "./work-queue.ts";
import { commitTerminal } from "./work-dispatch.ts";
import { renderMailContinuation } from "./prompts/index.ts";
import { AppError, type AppText } from "./app-text.ts";
import { appMessages } from "./messages.ts";
import type { LocalizedText } from "../shared/i18n.ts";
import type { MessageDTO } from "../shared/contracts.ts";
import { findWorkContext, readWorkContextIn, workContextDirectorySnapshot } from "./work-contexts.ts";

export type MailResumeInput = {
  parentWorkId: string;
  childWorkId: string;
  roomId: string;
  entryId: string;
  outcome: "reply" | "failed" | "stopped";
  error: string;
  /** Display pair for an application-authored `error`; absent for raw reasons. */
  errorLocalized?: LocalizedText;
};
export type MailResumeState = { phase: "submit" };
export type MailResumeResult = { submitted: boolean };

export type MailTasks = {
  resumeTask: Task<MailResumeInput, MailResumeState, MailResumeResult, object>;
  /** The atomic send every mail entry point uses, bound to this process's resume. */
  sendQueuedMail: (input: SendQueuedMailInput) => Promise<SendQueuedMailResult>;
};

/**
 * The reply-resume task.
 *
 * `resolve` hands back the process `Resume` only when a phase actually runs,
 * so the task definition can be built before the rest of the application is
 * wired without module cycles.
 */
export function buildMailTasks(resolve: () => Resume): MailTasks {
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
          await commitTerminal(taskRuntime, { status: "failed", error: { message: appMessages.mail.parentWorkMissing().text } }, context);
          return;
        }
        if (parent.conversationId === 0) {
          await commitTerminal(taskRuntime, { status: "failed", error: { message: appMessages.mail.parentConversationMissing().text } }, context);
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
          await commitTerminal(taskRuntime, { status: "failed", error: { message: appMessages.mail.resumeRoomMissing().text } }, context);
          return;
        }
        if (parent.directoryScope.roomId === room.id) {
          const workContext = await findWorkContext(runtime, parent.workContextId);
          if (workContext === undefined || workContext.directories.version !== parent.directoryScope.version) {
            await markFailed(resume, parent, appMessages.mail.resumeDirectoryChanged());
            await commitTerminal(taskRuntime, { status: "completed", result: { submitted: false } }, context);
            return;
          }
        }
        const conversation = await taskRuntime.conversation(parent.conversationId as ConversationId, context);
        if (conversation === undefined) {
          await commitTerminal(taskRuntime, { status: "failed", error: { message: appMessages.mail.parentConversationMissing().text } }, context);
          return;
        }
        // A reply continues from the child's answer; a failure or a stop has
        // no answer entry, so it continues from the request the child received
        // and states the outcome instead of inventing a reply.
        const child = await findWork(runtime, task.input.childWorkId);
        const source =
          task.input.outcome === "reply"
            ? await readMessageEntry(runtime, room, task.input.entryId)
            : await readMessageEntry(runtime, room, child?.sourceEntryId ?? "");
        const mail = source?.data.mail ?? null;
        if (source === undefined || mail === null) {
          await commitTerminal(taskRuntime, { status: "failed", error: { message: appMessages.mail.resumeSourceMissing().text } }, context);
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
                  ? { name: source.data.authorName, address: source.data.address }
                  : { name: childEmployee?.name ?? child?.employeeId ?? "", address: childEmployee?.address ?? "" },
              to: mail.to,
              cc: mail.cc,
              inReplyTo: mail.inReplyTo,
              entryId: task.input.outcome === "reply" ? task.input.entryId : "",
              outcome: task.input.outcome,
              body: task.input.outcome === "reply" ? source.data.body : "",
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
          outcome: { status: "failed", error: { message: appMessages.mail.resumeStopped().text } },
        }),
        context,
      );
    },
  });

  return { resumeTask, sendQueuedMail: (input) => sendQueuedMail(resolve(), input) };
}

/** Extension that registers the mail task; the shared dispatch is its own extension. */
export function buildMailExtension(tasks: MailTasks): Extension {
  return defineExtension({ name: "emit.mail", tasks: [tasks.resumeTask] });
}

export type SendQueuedMailInput = {
  /** Existing room, or a room created inside the same send transaction. */
  room: { id: string } | { create: RoomCreateInput };
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
    throw new AppError(appMessages.mail.sentMailInvariant());
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
      throw new RoomDirectoryError(400, appMessages.mail.newSessionInReplyTo());
    }
    let room: RoomRecord | undefined;
    if (!("create" in input.room)) {
      const doc = await tx.doc(RoomDoc, input.room.id, { id: input.room.id });
      if (doc === undefined) throw new RoomDirectoryError(404, appMessages.rooms.roomNotFoundWithId(input.room.id));
      room = plainRoom(doc);
    }

    // A draft send retires the draft in the same transaction that appends the
    // sent entry, so two concurrent sends cannot both pass the check.
    if (input.retireDraftId !== undefined && input.retireDraftId.length > 0) {
      if (room === undefined) throw new RoomDirectoryError(400, appMessages.mail.draftNeedsExistingRoom());
      const draftEntry = await tx.entry(Number(input.retireDraftId) as EntryId);
      if (
        draftEntry === undefined ||
        draftEntry.conversationId !== (room.conversationId as ConversationId) ||
        !RoomMessageEntry.is(draftEntry) ||
        draftEntry.data.mail === null ||
        !draftEntry.data.mail.draft
      ) {
        throw new RoomDirectoryError(409, appMessages.mail.draftGone());
      }
      const flagKey = `${room.id}|${input.retireDraftId}`;
      const flag = await tx.doc(MailFlagDoc, flagKey, { key: flagKey });
      if (flag.active === false) throw new RoomDirectoryError(409, appMessages.api.mailAlreadySent);
    }

    // The envelope's parent must be a sent mail of this very room.
    if (envelope.inReplyTo.length > 0) {
      if (room === undefined) throw new RoomDirectoryError(400, appMessages.mail.newSessionInReplyTo());
      const parent = await tx.entry(Number(envelope.inReplyTo) as EntryId);
      if (
        parent === undefined ||
        parent.conversationId !== (room.conversationId as ConversationId) ||
        !RoomMessageEntry.is(parent) ||
        parent.data.mail === null ||
        !parent.data.mail.sent ||
        parent.data.mail.draft
      ) {
        throw new RoomDirectoryError(400, appMessages.api.inReplyToNotSentMail);
      }
    }

    // The parent work anchors root and depth; it must still be live.
    let depth: number | undefined;
    let rootWorkId: string | undefined;
    let parentDraft: Draft<WorkRecord> | undefined;
    let workContextId = "create" in input.room ? input.room.create.workContextId : "";
    if (input.parentWorkId !== undefined && input.parentWorkId.length > 0) {
      const parentWork = await tx.doc(WorkDoc, input.parentWorkId, { id: input.parentWorkId });
      if (parentWork === undefined) throw new AppError(appMessages.mail.callerWorkMissing(input.parentWorkId));
      if (isTerminal(parentWork.status) || parentWork.status === "stopped") {
        throw new AppError(appMessages.mail.callerWorkFinished());
      }
      parentDraft = parentWork;
      depth = input.awaitReply === true ? parentWork.depth + 1 : parentWork.depth;
      rootWorkId = parentWork.rootWorkId;
      workContextId = parentWork.workContextId;
      if (input.awaitReply === true) {
        const app = await tx.doc(AppDoc);
        if (depth > app.collaboration.maxDepth) {
          throw new RoomDirectoryError(400, appMessages.work.depthOverLimit(app.collaboration.maxDepth));
        }
      }
      // A continuation shares the caller's room: the send-time snapshot must
      // still be the live configuration, or the mail would silently gain
      // directories that were added after the caller started.
      if (room !== undefined && parentWork.directoryScope.roomId === room.id) {
        const context = await readWorkContextIn(tx, parentWork.workContextId);
        if (context.directories.version !== parentWork.directoryScope.version) {
          throw new RoomDirectoryError(409, appMessages.work.directoryChanged());
        }
      }
    } else if (input.awaitReply === true) {
      throw new RoomDirectoryError(400, appMessages.mail.awaitReplyEmployeeOnly());
    }

    if (room === undefined) {
      if (!("create" in input.room)) throw new RoomDirectoryError(404, appMessages.rooms.roomNotFoundWithId(input.room.id));
      room = await createRoomIn(tx, input.room.create);
    }
    if (workContextId.length === 0) workContextId = room.workContextId;

    const entry = await appendRoomMessageIn(tx, room, input.data);

    // The scope is the parent's snapshot when the parent shares this room;
    // otherwise it is the work context's current configuration, snapshotted
    // now so the queued run cannot silently gain directories later.
    const context = await readWorkContextIn(tx, workContextId);
    const directoryScope =
      parentDraft !== undefined && parentDraft.directoryScope.roomId === room.id
        ? { ...parentDraft.directoryScope, paths: [...parentDraft.directoryScope.paths] }
        : workContextDirectorySnapshot(context, room.id);
    const now = Date.now();
    // The caller waits for every recipient of an awaited send; its budget max
    // is read while the send's own transaction is open.
    const wakeBudget =
      input.awaitReply === true
        ? {
            rootWorkId: rootWorkId ?? input.parentWorkId!,
            max: (await tx.doc(AppDoc)).collaboration.maxCrossEmployeeWakes,
          }
        : undefined;
    const workIds = await enqueueWorksIn(tx, resume.dispatch, {
      employeeIds: recipients,
      roomId: room.id,
      workContextId,
      intent,
      kind: "mail",
      sourceEntryId: String(entry.id),
      parentWorkId: input.parentWorkId ?? "",
      rootWorkId: rootWorkId ?? "",
      depth: depth ?? 0,
      dispatchConversationId: room.conversationId,
      directoryScope,
      now,
      ...(wakeBudget === undefined ? {} : { wakeBudget }),
    });

    if (input.awaitReply === true) {
      // The awaited list and the wake budget land with the mail, so a crash
      // cannot leave a reply with nobody waiting or a wake that was never
      // paid for.
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
      receipt.workIds = workIds;
    }

    return { room, entry, workIds };
  }, runtime.ctx).catch((error: unknown) => {
    // A wake-budget refusal is a room-level answer, not a broken send; the
    // budget, works, and message rolled back together.
    if (error instanceof WakeBudgetExceededError) {
      throw new RoomDirectoryError(409, appMessages.work.wakeLimit(error.limit));
    }
    throw error;
  });

  const dto = toMessageDTO(committed.entry);
  if (dto === undefined) throw new AppError(appMessages.mail.sentMailInvariant());
  const unread = await roomDTOWithUnread(runtime, committed.room);
  runtime.emit({ type: "message", roomId: committed.room.id, message: dto });
  runtime.emit({ type: "room", room: unread });
  return { message: dto, workIds: committed.workIds };
}

async function readSendReceipt(runtime: EmitRuntime, toolTaskId: string): Promise<MailSendReceiptRecord | undefined> {
  const key = `tool:${toolTaskId}`;
  return runtime.readFamily(MailSendReceiptDoc, key, { key });
}

async function replayedSend(runtime: EmitRuntime, receipt: MailSendReceiptRecord): Promise<SendQueuedMailResult> {
  const room = await findRoom(runtime, receipt.roomId);
  if (room === undefined) throw new AppError(appMessages.mail.replayRecordMissing());
  const data = await readMessageEntry(runtime, room, receipt.entryId);
  const entry = data === undefined ? undefined : data.entry;
  const dto = entry === undefined ? undefined : toMessageDTO(entry);
  if (dto === undefined) throw new AppError(appMessages.mail.replayRecordMissing());
  dto.roomId = room.id;
  return { message: dto, workIds: [...receipt.workIds] };
}

/** Read one message entry out of a room's transcript, with migrated headers applied. */
async function readMessageEntry(
  runtime: EmitRuntime,
  room: RoomRecord,
  entryId: string,
): Promise<{ entry: EntryRecord; data: RoomMessageData } | undefined> {
  const id = Number(entryId);
  if (entryId.length === 0 || !Number.isSafeInteger(id) || id <= 0) return undefined;
  const conversation = await runtime.harness.conversation(room.conversationId as ConversationId, runtime.ctx);
  if (conversation === undefined) return undefined;
  const page = await conversation.entries(
    { minEntryId: id as EntryId, maxEntryId: id as EntryId },
    1,
    undefined,
    runtime.ctx,
  );
  const entry = page.items[0];
  if (entry === undefined || !RoomMessageEntry.is(entry)) return undefined;
  // A historical entry may carry an address override from the one-time
  // migration; continuing a reply from the stored headers would address the
  // retired domain, so the projection is what a reader ever sees.
  const flags = await readFlags(runtime, room.id, entry.id);
  const projected = projectMessageAddresses(entry, flags);
  if (!RoomMessageEntry.is(projected)) return undefined;
  return { entry: projected, data: projected.data };
}
