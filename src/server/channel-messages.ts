/**
 * Channel and direct-message sends: who a message wakes, and how the wake-ups
 * are queued atomically.
 *
 * Every routed group message — the user's composer, an employee's
 * `send_message`, a direct message — goes through `sendQueuedMessage`. One
 * commit appends the entry, resolves and stores the addressing, and creates one
 * queued work plus one durable dispatch task per recipient, so a crash leaves
 * either the whole send or nothing: no half-delivered wake-ups, and no wake-up
 * that a restart silently drops.
 *
 * The employee collaboration tools that must derive their work from the calling
 * conversation — addressing a channel, inviting members, reading and saving
 * shared notes — live here too, because they all share the same authorization
 * helper.
 */

import { randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { ConversationId, EntryRecord } from "@earendil-works/pi-durable";
import {
  AppDoc,
  CollaborationDoc,
  EmployeeDoc,
  MessageSendReceiptDoc,
  RoomDoc,
  RoomMessageEntry,
  WorkContextDoc,
  WorkContextMutationReceiptDoc,
  WorkDoc,
  type EmployeeRecord,
  type RoomRecord,
  type WorkContextRecord,
  type WorkNoteRecord,
  type WorkRecord,
} from "./documents.ts";
import type { EmitRuntime } from "./runtime.ts";
import {
  RoomError,
  appendRoomMessageIn,
  ensureEmployeeDm,
  findRoom,
  messageData,
  roomDTOWithUnread,
  toMessageDTO,
} from "./rooms.ts";
import {
  createQueuedWorkIn,
  findWork,
  type Resume,
} from "./work.ts";
import { toWorkDTO } from "./dto.ts";
import { MessageAddressingError, resolveMessageAddressing, type AddressableMember } from "../shared/message-addressing.ts";
import { appMessages } from "./messages.ts";
import { addressingErrorText } from "./messages/addressing.ts";
import {
  WorkContextError,
  createWorkNoteIn,
  findWorkNote,
  findWorkContext,
  resolveActiveWorkContextForTool,
  toWorkContextDTO,
  updateWorkNoteIn,
  workContextDirectorySnapshot,
} from "./work-contexts.ts";
import { listEmployees, resolveEmployee } from "./workspace.ts";
import { renderToolResult, toolTextResources } from "./prompts/index.ts";
import { toolError, toolText } from "./tools.ts";
import type { MessageAuthorDTO, MessageDTO } from "../shared/contracts.ts";

export type SendQueuedMessageInput = {
  roomId: string;
  author: MessageAuthorDTO;
  body: string;
  /** The explicitly selected recipients of a channel message. */
  recipientIds?: string[];
  /** The explicit "address everyone" toggle of a channel message. */
  mentionAll?: boolean;
  /** The sending employee's work; present for tool sends, absent for the user. */
  parentWorkId?: string;
  /** Tool task id, which makes a tool send replay-safe. */
  toolTaskId?: string;
};

export type SendQueuedMessageResult = { message: MessageDTO; workIds: string[] };

function isTerminalStatus(status: WorkRecord["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "stopped";
}

/** The message-addressing failure as a room-level 400. */
function addressingRoomError(error: unknown): unknown {
  if (error instanceof MessageAddressingError) {
    return new RoomError(400, addressingErrorText(error));
  }
  return error;
}

/** Every live member of a room as addressing facts, disabled ones included. */
function roomMembers(room: RoomRecord, employees: readonly EmployeeRecord[]): AddressableMember[] {
  const byId = new Map(employees.map((employee) => [employee.id, employee]));
  const members: AddressableMember[] = [];
  for (const id of room.memberIds) {
    const employee = byId.get(id);
    if (employee === undefined) continue;
    members.push({ id: employee.id, name: employee.name, address: employee.address, enabled: employee.enabled });
  }
  return members;
}

/** True when `employeeId` already appears among this work's ancestors. */
async function isAncestorWork(runtime: EmitRuntime, workId: string, employeeId: string): Promise<boolean> {
  let current = workId;
  const seen = new Set<string>();
  while (current.length > 0 && !seen.has(current)) {
    seen.add(current);
    const work = await findWork(runtime, current);
    if (work === undefined) return false;
    if (work.employeeId === employeeId) return true;
    current = work.parentWorkId;
  }
  return false;
}

async function readMessageReceipt(runtime: EmitRuntime, toolTaskId: string) {
  const key = `tool:${toolTaskId}`;
  return runtime.readFamily(MessageSendReceiptDoc, key, { key });
}

/**
 * Send one group or direct message and queue every recipient's work.
 *
 * A channel message carries the addressing it was resolved with, even when
 * that set is empty: everyone can read the message, and the stored recipient
 * list is what actually started an employee.
 */
export async function sendQueuedMessage(
  resume: Resume,
  input: SendQueuedMessageInput,
): Promise<SendQueuedMessageResult> {
  const { runtime } = resume;
  const room = await findRoom(runtime, input.roomId);
  if (room === undefined) throw new RoomError(404, appMessages.rooms.roomNotFoundWithId(input.roomId));
  if (room.kind === "mail") throw new RoomError(400, appMessages.rooms.mailNotByMessageSend);

  // A replay must not re-run validations the first call already consumed, and
  // must not pay for wakes twice.
  if (input.toolTaskId !== undefined && input.toolTaskId.length > 0) {
    const receipt = await readMessageReceipt(runtime, input.toolTaskId);
    if (receipt !== undefined) return replayedMessageSend(runtime, receipt);
  }

  const app = await runtime.readSession(AppDoc);
  const employees = await listEmployees(runtime);
  const workContext = await findWorkContext(runtime, room.workContextId);
  if (workContext === undefined) {
    throw new RoomError(404, appMessages.workContexts.notFound(room.workContextId));
  }

  let parent: WorkRecord | undefined;
  if (input.parentWorkId !== undefined && input.parentWorkId.length > 0) {
    parent = await findWork(runtime, input.parentWorkId);
    if (parent === undefined) throw new RoomError(404, appMessages.work.workNotFound(input.parentWorkId));
    if (isTerminalStatus(parent.status)) throw new RoomError(400, appMessages.workContexts.workFinished);
  }
  const byId = new Map(employees.map((employee) => [employee.id, employee]));
  const isEmployeeAuthor = input.author.type === "employee";

  let recipients: string[] = [];
  let mentionAll = false;
  if (room.kind === "dm") {
    if ((input.recipientIds?.length ?? 0) > 0 || input.mentionAll === true) {
      throw new RoomError(400, appMessages.rooms.dmNoAddressing);
    }
    if (!room.dmParticipantIds.includes(input.author.id)) {
      throw new RoomError(400, appMessages.rooms.notParticipant(input.author.name));
    }
    const other = room.dmParticipantIds.find((id) => id !== input.author.id) ?? "";
    if (other !== "" && other !== "user") {
      const target = byId.get(other);
      if (target === undefined) throw new RoomError(404, appMessages.workContexts.employeeNotFound(other));
      if (!target.enabled) throw new RoomError(400, appMessages.workContexts.employeeDisabled(target.name));
      recipients = [target.id];
    }
  } else {
    let resolved;
    try {
      resolved = resolveMessageAddressing(
        input.body,
        input.recipientIds ?? [],
        input.mentionAll === true,
        roomMembers(room, employees),
      );
    } catch (error) {
      throw addressingRoomError(error);
    }
    recipients = resolved.recipientIds;
    mentionAll = resolved.mentionAll;
  }

  if (isEmployeeAuthor && parent !== undefined) {
    if (recipients.includes(input.author.id)) {
      if (!mentionAll) throw new RoomError(400, appMessages.rooms.sendSelfNotAllowed);
      recipients = recipients.filter((id) => id !== input.author.id);
    }
    for (const id of recipients) {
      if (await isAncestorWork(runtime, parent.id, id)) {
        const name = byId.get(id)?.name ?? id;
        throw new RoomError(400, appMessages.rooms.ancestorRecipient(name));
      }
    }
  }

  const depth = parent !== undefined ? parent.depth + 1 : 0;
  if (parent !== undefined && depth > app.collaboration.maxDepth) {
    throw new RoomError(400, appMessages.work.depthOverLimit(app.collaboration.maxDepth));
  }
  const directoryScope = workContextDirectorySnapshot(workContext, room.id);
  const workIds: string[] = [];
  const now = Date.now();

  const committed = await runtime.harness.commit(async (tx) => {
    const doc = await tx.doc(RoomDoc, room.id, { id: room.id });
    if (doc.kind === "mail") throw new RoomError(400, appMessages.rooms.mailNotByMessageSend);
    // The work and its directory version must still be exactly what the send
    // was resolved against; a concurrent directory save cannot be silently
    // smuggled into the new run.
    const contextDoc = await tx.doc(WorkContextDoc, room.workContextId, { id: room.workContextId });
    if (contextDoc.createdAt === 0) {
      throw new RoomError(404, appMessages.workContexts.notFound(room.workContextId));
    }
    if (contextDoc.directories.version !== directoryScope.version) {
      throw new RoomError(409, appMessages.work.directoryChanged());
    }
    // Recipients are re-checked against the current member set and state.
    if (doc.kind === "channel") {
      for (const id of recipients) {
        if (!doc.memberIds.includes(id)) throw new RoomError(400, appMessages.rooms.memberNotFound(id));
      }
    } else if (doc.kind === "dm" && !doc.dmParticipantIds.includes(input.author.id)) {
      throw new RoomError(400, appMessages.rooms.notParticipant(input.author.name));
    }
    const entry = await appendRoomMessageIn(
      tx,
      doc,
      messageData({
        author: input.author,
        body: input.body,
        addressing: { recipientIds: [...recipients], mentionAll },
      }),
    );
    const created: string[] = [];
    for (const employeeId of recipients) {
      const workId = `wk_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
      await createQueuedWorkIn(tx, {
        roomId: doc.id,
        employeeId,
        workContextId: doc.workContextId,
        intent: input.body,
        kind: "message",
        sourceEntryId: String(entry.id),
        parentWorkId: parent?.id ?? "",
        rootWorkId: parent?.rootWorkId ?? "",
        depth,
        id: workId,
        directoryScope,
        now,
      });
      const taskId = await tx.createTask(
        resume.dispatch,
        { workId },
        {
          ownership: { kind: "conversation" },
          conversationId: doc.conversationId as ConversationId,
          background: true,
        },
      );
      const work = await tx.doc(WorkDoc, workId, { id: workId });
      work.dispatchTaskId = String(taskId);
      created.push(workId);
    }
    if (parent !== undefined && created.length > 0) {
      const scope = parent.rootWorkId.length > 0 ? parent.rootWorkId : parent.id;
      const collaboration = await tx.doc(CollaborationDoc, scope, { rootWorkId: scope });
      collaboration.rootWorkId = scope;
      collaboration.crossEmployeeWakes += created.length;
      if (collaboration.crossEmployeeWakes > app.collaboration.maxCrossEmployeeWakes) {
        throw new RoomError(409, appMessages.work.wakeLimit(app.collaboration.maxCrossEmployeeWakes));
      }
    }
    if (input.toolTaskId !== undefined && input.toolTaskId.length > 0) {
      const receiptKey = `tool:${input.toolTaskId}`;
      const receipt = await tx.doc(MessageSendReceiptDoc, receiptKey, { key: receiptKey });
      receipt.key = receiptKey;
      receipt.roomId = doc.id;
      receipt.entryId = String(entry.id);
      receipt.workIds = [...created];
    }
    return { entry, workIds: created };
  }, runtime.ctx);
  workIds.push(...committed.workIds);

  const dto = toMessageDTO(committed.entry);
  if (dto === undefined) throw new RoomError(400, appMessages.rooms.messageUnexpectedType);
  dto.roomId = room.id;
  runtime.emit({ type: "message", roomId: room.id, message: dto });
  const saved = await findRoom(runtime, room.id);
  if (saved !== undefined) runtime.emit({ type: "room", room: await roomDTOWithUnread(runtime, saved) });
  await emitWorks(runtime, workIds, saved ?? room);
  return { message: dto, workIds };
}

async function emitWorks(runtime: EmitRuntime, workIds: readonly string[], room: RoomRecord): Promise<void> {
  for (const workId of workIds) {
    const work = await findWork(runtime, workId);
    if (work === undefined) continue;
    const employee = await runtime.readFamily(EmployeeDoc, work.employeeId, { id: work.employeeId });
    runtime.emit({ type: "work", work: toWorkDTO(work, employee?.name ?? "", room.name) });
  }
}

/** Rebuild the recorded outcome of a replayed tool send. */
async function replayedMessageSend(
  runtime: EmitRuntime,
  receipt: { roomId: string; entryId: string; workIds: string[] },
): Promise<SendQueuedMessageResult> {
  const room = await findRoom(runtime, receipt.roomId);
  if (room === undefined) throw new RoomError(404, appMessages.rooms.roomNotFoundWithId(receipt.roomId));
  const conversation = await runtime.harness.conversation(room.conversationId as ConversationId, runtime.ctx);
  const entryId = Number(receipt.entryId);
  const page =
    conversation !== undefined && Number.isSafeInteger(entryId)
      ? await conversation.entries({ minEntryId: entryId as never, maxEntryId: entryId as never }, 1, undefined, runtime.ctx)
      : undefined;
  const entry = page?.items[0];
  const dto = entry !== undefined && RoomMessageEntry.is(entry) ? toMessageDTO(entry) : undefined;
  if (dto === undefined) throw new RoomError(404, appMessages.mail.replayRecordMissing());
  dto.roomId = room.id;
  return { message: dto, workIds: [...receipt.workIds] };
}

// ------------------------------------------------------------------- tools

/** One recorded work-context mutation of a tool call, when it already ran. */
async function readMutationReceipt(runtime: EmitRuntime, toolTaskId: string) {
  const key = `tool:${toolTaskId}`;
  return runtime.readFamily(WorkContextMutationReceiptDoc, key, { key });
}

type ActiveToolContext = {
  employee: EmployeeRecord;
  work: WorkRecord;
  workContext: WorkContextRecord;
  room: RoomRecord | undefined;
};

async function activeContext(conversationId: number, runtime: EmitRuntime): Promise<ActiveToolContext | string> {
  try {
    const active = await resolveActiveWorkContextForTool(runtime, conversationId);
    return { employee: active.employee, work: active.work, workContext: active.workContext, room: active.room };
  } catch (error) {
    if (error instanceof WorkContextError) return error.message;
    throw error;
  }
}

/**
 * The employee collaboration tools that act on messages and work notes.
 *
 * `send_message` addresses a channel or opens a direct message; the work
 * context and the caller's membership are derived from the calling
 * conversation, never from tool arguments.
 */
export function buildMessageTools(resume: Resume, employee: EmployeeRecord): ToolRegistration[] {
  const { runtime } = resume;

  const sendMessage = defineTool({
    name: "send_message",
    description: toolTextResources.send_message.description,
    parameters: Type.Object({
      to: Type.Optional(Type.String({ description: toolTextResources.send_message.parameters.to })),
      roomId: Type.Optional(Type.String({ description: toolTextResources.send_message.parameters.roomId })),
      body: Type.String({ description: toolTextResources.send_message.parameters.body }),
      recipientIds: Type.Optional(
        Type.Array(Type.String(), { description: toolTextResources.send_message.parameters.recipientIds }),
      ),
      mentionAll: Type.Optional(Type.Boolean({ description: toolTextResources.send_message.parameters.mentionAll })),
    }),
    execute: async (args, api, context) => {
      const hasTo = typeof args.to === "string" && args.to.trim().length > 0;
      const hasRoom = typeof args.roomId === "string" && args.roomId.trim().length > 0;
      if (hasTo === hasRoom) return toolError("请且仅请提供 to 或 roomId 之一");
      const active = await activeContext(api.conversationId, runtime);
      if (typeof active === "string") return toolError(active);
      const { work, workContext } = active;

      if (hasTo) {
        const target = await resolveEmployee(await listEmployees(runtime), args.to!.trim());
        if (target === undefined) return toolError(`找不到员工 ${args.to}`);
        if (target.id === employee.id) return toolError("不能给自己发消息");
        if (!target.enabled) return toolError(`员工 ${target.name} 已停用`);
        const { room } = await ensureEmployeeDm(runtime, {
          workContextId: workContext.id,
          participantIds: [employee.id, target.id],
          name: `${employee.name} ↔ ${target.name}`,
          topic: `私信：${target.name}`,
        });
        try {
          const result = await sendQueuedMessage(resume, {
            roomId: room.id,
            author: { type: "employee", id: employee.id, name: employee.name, address: employee.address },
            body: args.body,
            parentWorkId: work.id,
            toolTaskId: String(api.taskId),
          });
          return toolText(
            renderToolResult("send-message-ok", { name: target.name, workId: result.workIds[0] ?? "" }),
          );
        } catch (error) {
          return toolError(roomSendErrorText(error));
        }
      }

      const roomId = args.roomId!.trim();
      const room = await findRoom(runtime, roomId);
      if (room === undefined || room.kind !== "channel") return toolError(`找不到频道 ${roomId}`);
      if (room.workContextId !== workContext.id) return toolError("只能向同一工作下的频道发消息");
      try {
        const result = await sendQueuedMessage(resume, {
          roomId: room.id,
          author: { type: "employee", id: employee.id, name: employee.name, address: employee.address },
          body: args.body,
          ...(args.recipientIds !== undefined ? { recipientIds: args.recipientIds } : {}),
          ...(args.mentionAll !== undefined ? { mentionAll: args.mentionAll } : {}),
          parentWorkId: work.id,
          toolTaskId: String(api.taskId),
        });
        return toolText(
          result.workIds.length > 0
            ? renderToolResult("send-channel-ok", { roomName: room.name, count: result.workIds.length })
            : renderToolResult("send-channel-nobody", { roomName: room.name }),
        );
      } catch (error) {
        return toolError(roomSendErrorText(error));
      }
    },
  });

  const invite = defineTool({
    name: "invite_to_channel",
    description: toolTextResources.invite_to_channel.description,
    parameters: Type.Object({
      employeeIds: Type.Array(Type.String(), { description: toolTextResources.invite_to_channel.parameters.employeeIds }),
    }),
    execute: async (args, api) => {
      const active = await activeContext(api.conversationId, runtime);
      if (typeof active === "string") return toolError(active);
      const { work, workContext, room } = active;
      if (room === undefined || room.kind !== "channel" || room.workContextId !== workContext.id) {
        return toolError(appMessages.workContexts.inviteChannelOnly.text);
      }
      const ids = [...new Set(args.employeeIds.map((id) => id.trim()).filter((id) => id.length > 0))];
      if (ids.length === 0) return toolError("请提供要邀请的员工 id");
      if (ids.length > 20) return toolError(appMessages.workContexts.inviteLimit(20).text);
      const employees = await listEmployees(runtime);
      for (const id of ids) {
        const target = employees.find((entry) => entry.id === id);
        if (target === undefined) return toolError(appMessages.workContexts.employeeNotFound(id).text);
        if (!target.enabled) return toolError(appMessages.workContexts.inviteTargetNotEnabled(target.name).text);
      }
      const toolTaskId = String(api.taskId);
      const receipt = await readMutationReceipt(runtime, toolTaskId);
      if (receipt !== undefined && receipt.roomId === room.id) {
        return toolText(renderToolResult("invite-replay", {}));
      }
      const result = await inviteMembersIn(runtime, room.id, ids, employee.name, toolTaskId);
      return toolText(
        renderToolResult("invite-ok", {
          names: result.added.map((id) => employees.find((entry) => entry.id === id)?.name ?? id).join("、"),
          count: result.added.length,
        }),
      );
    },
  });

  const listNotes = defineTool({
    name: "list_work_notes",
    description: toolTextResources.list_work_notes.description,
    replay: "safe",
    parameters: Type.Object({}),
    execute: async (_args, api) => {
      const active = await activeContext(api.conversationId, runtime);
      if (typeof active === "string") return toolError(active);
      const context = active.workContext;
      const items = context.notes
        .map((note, index) =>
          `${index + 1}. ${note.title} · id=${note.id} · 作者=${note.authorId} · 更新=${new Date(note.updatedAt).toISOString()}`,
        )
        .join("\n");
      return toolText(
        renderToolResult("note-list", {
          version: context.version,
          count: context.notes.length,
          items: items.length > 0 ? items : "(还没有共享笔记)",
        }),
      );
    },
  });

  const readNote = defineTool({
    name: "read_work_note",
    description: toolTextResources.read_work_note.description,
    replay: "safe",
    parameters: Type.Object({
      noteId: Type.String({ description: toolTextResources.read_work_note.parameters.noteId }),
    }),
    execute: async (args, api) => {
      const active = await activeContext(api.conversationId, runtime);
      if (typeof active === "string") return toolError(active);
      const note = findWorkNote(active.workContext, args.noteId);
      if (note === undefined) return toolError(appMessages.workContexts.noteNotFound(args.noteId).text);
      return toolText(renderNote(note));
    },
  });

  const saveNote = defineTool({
    name: "save_work_note",
    description: toolTextResources.save_work_note.description,
    parameters: Type.Object({
      title: Type.String({ description: toolTextResources.save_work_note.parameters.title }),
      body: Type.String({ description: toolTextResources.save_work_note.parameters.body }),
      noteId: Type.Optional(Type.String({ description: toolTextResources.save_work_note.parameters.noteId })),
      expectedVersion: Type.Number({ description: toolTextResources.save_work_note.parameters.expectedVersion }),
    }),
    execute: async (args, api) => {
      const active = await activeContext(api.conversationId, runtime);
      if (typeof active === "string") return toolError(active);
      const { work, workContext, room } = active;
      const toolTaskId = String(api.taskId);
      const receipt = await readMutationReceipt(runtime, toolTaskId);
      if (receipt !== undefined && receipt.noteId.length > 0) {
        return toolText(
          renderToolResult("note-saved", { noteId: receipt.noteId, version: receipt.version, title: receipt.key }),
        );
      }
      const source = {
        authorId: employee.id,
        sourceRoomId: room?.id ?? work.roomId,
        sourceEntryId: work.sourceEntryId,
        sourceWorkId: work.id,
      };
      try {
        const result = await runtime.harness.commit(async (tx) => {
          const mutation =
            args.noteId !== undefined && args.noteId.length > 0
              ? await updateWorkNoteIn(tx, workContext.id, args.noteId, {
                  title: args.title,
                  body: args.body,
                  expectedVersion: args.expectedVersion,
                  ...source,
                })
              : await createWorkNoteIn(tx, workContext.id, {
                  title: args.title,
                  body: args.body,
                  expectedVersion: args.expectedVersion,
                  ...source,
                });
          const key = `tool:${toolTaskId}`;
          const receiptDoc = await tx.doc(WorkContextMutationReceiptDoc, key, { key });
          receiptDoc.key = args.title;
          receiptDoc.workContextId = workContext.id;
          receiptDoc.roomId = room?.id ?? "";
          receiptDoc.noteId = mutation.note.id;
          receiptDoc.version = mutation.version;
          return mutation;
        }, runtime.ctx);
        const updated = await findWorkContext(runtime, workContext.id);
        if (updated !== undefined) runtime.emit({ type: "work-context", workContext: toWorkContextDTO(updated) });
        return toolText(
          renderToolResult("note-saved", {
            noteId: result.note.id,
            version: result.version,
            title: result.note.title,
          }),
        );
      } catch (error) {
        if (error instanceof WorkContextError) return toolError(error.message);
        throw error;
      }
    },
  });

  return [sendMessage, invite, listNotes, readNote, saveNote];
}

/** The tool-visible text of one note. */
function renderNote(note: WorkNoteRecord): string {
  return [
    `标题：${note.title}`,
    `id=${note.id} · 作者=${note.authorId} · 来源会话=${note.sourceRoomId || "(无)"} · 来源消息=${note.sourceEntryId || "(无)"}`,
    "",
    note.body,
  ].join("\n");
}

/** A send failure as a tool message; an application message keeps its text. */
function roomSendErrorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Add members to one channel inside one commit, with the invitation notice and
 * the tool receipt.
 *
 * Adding is idempotent: an employee who is already a member is skipped, and a
 * call that adds nobody writes no notice. Inviting never starts the invitee.
 */
async function inviteMembersIn(
  runtime: EmitRuntime,
  roomId: string,
  employeeIds: readonly string[],
  actorName: string,
  toolTaskId: string,
): Promise<{ added: string[]; membershipVersion: number }> {
  const result = await runtime.harness.commit(async (tx) => {
    const doc = await tx.doc(RoomDoc, roomId, { id: roomId });
    if (doc.kind !== "channel") throw new RoomError(400, appMessages.workContexts.inviteChannelOnly);
    const added = employeeIds.filter((id) => !doc.memberIds.includes(id));
    let entry: EntryRecord | undefined;
    if (added.length > 0) {
      const names: string[] = [];
      for (const id of added) {
        const employee = await tx.doc(EmployeeDoc, id, { id });
        names.push(employee.name);
      }
      doc.memberIds = [...doc.memberIds, ...added];
      doc.membershipVersion += 1;
      const sentence = appMessages.rooms.membersInvited(actorName, names);
      entry = await appendRoomMessageIn(
        tx,
        JSON.parse(JSON.stringify(doc)) as RoomRecord,
        messageData({
          author: { type: "system", id: "system", name: "系统" },
          body: sentence.text,
          ...(sentence.localized === undefined ? {} : { bodyLocalized: sentence.localized }),
          notice: true,
        }),
      );
    }
    const key = `tool:${toolTaskId}`;
    const receipt = await tx.doc(WorkContextMutationReceiptDoc, key, { key });
    receipt.key = "";
    receipt.workContextId = doc.workContextId;
    receipt.roomId = roomId;
    receipt.noteId = "";
    receipt.version = doc.membershipVersion;
    return { added, membershipVersion: doc.membershipVersion, entry };
  }, runtime.ctx);

  if (result.entry !== undefined) {
    const saved = await findRoom(runtime, roomId);
    if (saved !== undefined) {
      runtime.emit({ type: "room", room: await roomDTOWithUnread(runtime, saved) });
      const dto = toMessageDTO(result.entry);
      if (dto !== undefined) {
        dto.roomId = roomId;
        runtime.emit({ type: "message", roomId, message: dto });
      }
    }
  }
  return { added: result.added, membershipVersion: result.membershipVersion };
}
