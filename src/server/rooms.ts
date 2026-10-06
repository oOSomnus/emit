/**
 * Rooms: the shared transcript.
 *
 * A room is a conversation whose entries are Emit's own `emit.message` entries,
 * not model context. Every room — channel, direct message, and mail thread —
 * uses the same shape, so one message list, one unread model, and one
 * subscription drive all three views. Mail is only an envelope on a message.
 *
 * Every room is fixed to exactly one work context. Directories live on that
 * work, never on a room, so two rooms of one work share one authorization and
 * rooms of different works never leak into each other.
 */

import { randomUUID } from "node:crypto";

import {
  AppDoc,
  EmployeeDoc,
  MailFlagDoc,
  RoomDoc,
  RoomMessageEntry,
  WorkContextDoc,
  type MailEnvelope,
  type MailFlagRecord,
  type RoomMessageData,
  type RoomMessageAddressing,
  type RoomRecord,
} from "./documents.ts";
import { configure } from "@earendil-works/pi-durable";
import type { ConversationId, Cursor, EntryId, EntryRecord, Tx } from "@earendil-works/pi-durable";
import type { EmitRuntime } from "./runtime.ts";
import { AppError, type AppText } from "./messages.ts";
import { roomMessages } from "./messages/rooms.ts";
import type {
  MailMetaDTO,
  MessageAuthorDTO,
  MessageDTO,
  RoomDTO,
} from "../shared/contracts.ts";
import { CANONICAL_LOCALE, type DisplayText, type LocalizedText } from "../shared/i18n.ts";

/** One address on a mail envelope. */
export type MailAddress = { name: string; address: string };

/**
 * Build a mail envelope.
 *
 * "recipients" and "copies" hold the employee ids the mail routes to: To is the
 * wake set, CC is a copy that never starts work. Keeping the ids beside the
 * addresses means routing never has to resolve an address back to an employee.
 */
export function mailEnvelope(input: {
  subject: string;
  to?: MailAddress[];
  cc?: MailAddress[];
  recipients?: string[];
  copies?: string[];
  inReplyTo?: string;
  sent?: boolean;
  draft?: boolean;
}): MailEnvelope {
  return {
    subject: input.subject,
    to: input.to ?? [],
    cc: input.cc ?? [],
    recipients: input.recipients ?? [],
    copies: input.copies ?? [],
    inReplyTo: input.inReplyTo ?? "",
    sent: input.sent ?? true,
    draft: input.draft ?? false,
  };
}

/** Whether an address appears in the To or CC list of an envelope. */
export function mailAddresses(envelope: MailEnvelope, address: string): boolean {
  if (address.length === 0) return false;
  return (
    envelope.to.some((entry) => entry.address === address) || envelope.cc.some((entry) => entry.address === address)
  );
}
export const ROOM_PAGE_SIZE = 200;

/** How many visible messages one history window returns, at most. */
export const ROOM_WINDOW_LIMIT = 40;

/** A mail-send or room-operation failure with an HTTP status. */
export class RoomError extends AppError {
  constructor(
    readonly status: 400 | 404 | 409,
    message: AppText,
  ) {
    super(message);
  }
}

/** Kept for the mail wake-budget refusals that predate this class. */
export class RoomDirectoryError extends RoomError {}

/**
 * Detach a room record from a transaction overlay.
 *
 * A record read or written inside a commit points into that transaction's
 * overlay, which is settled the moment the commit resolves. Callers that keep
 * the record past the commit — to build a DTO or emit an event — must take a
 * plain copy first, or the first property read throws.
 */
export function plainRoom(record: RoomRecord): RoomRecord {
  return {
    id: record.id,
    kind: record.kind,
    name: record.name,
    topic: record.topic,
    workContextId: record.workContextId,
    memberIds: [...record.memberIds],
    membershipVersion: record.membershipVersion,
    dmParticipantIds: [...record.dmParticipantIds],
    employeeId: record.employeeId,
    createdAt: record.createdAt,
    lastMessageAt: record.lastMessageAt,
    messageCount: record.messageCount,
    conversationId: record.conversationId,
  };
}

export function toRoomDTO(record: RoomRecord, unread = 0): RoomDTO {
  return {
    id: record.id,
    kind: record.kind,
    name: record.name,
    topic: record.topic,
    workContextId: record.workContextId,
    memberIds: [...record.memberIds],
    membershipVersion: Number.isInteger(record.membershipVersion) ? record.membershipVersion : 1,
    dmParticipantIds: Array.isArray(record.dmParticipantIds) ? [...record.dmParticipantIds] : [],
    ...(record.kind === "dm" && record.employeeId.length > 0 ? { employeeId: record.employeeId } : {}),
    createdAt: record.createdAt,
    lastMessageAt: record.lastMessageAt,
    messageCount: record.messageCount,
    unread,
  };
}

export function messageData(input: {
  author: MessageAuthorDTO;
  body: string;
  workId?: string;
  /** The resolved wake set of a routed group message. */
  addressing?: RoomMessageAddressing;
  notice?: boolean;
  mail?: MailEnvelope;
  /** Display pair for application-authored notice bodies; raw bodies carry none. */
  bodyLocalized?: LocalizedText;
}): RoomMessageData {
  return {
    authorType: input.author.type,
    authorId: input.author.id,
    authorName: input.author.name,
    address: input.author.address ?? "",
    body: input.body,
    createdAt: Date.now(),
    workId: input.workId ?? "",
    addressing: input.addressing === undefined ? null : { ...input.addressing, recipientIds: [...input.addressing.recipientIds] },
    notice: input.notice === true,
    mail: input.mail ?? null,
    ...(input.bodyLocalized === undefined ? {} : { bodyLocalized: input.bodyLocalized }),
  };
}

function toMailMeta(envelope: MailEnvelope): MailMetaDTO {
  const meta: MailMetaDTO = {
    subject: envelope.subject,
    to: envelope.to.map((entry) => ({ name: entry.name, address: entry.address })),
    cc: envelope.cc.map((entry) => ({ name: entry.name, address: entry.address })),
    recipients: [...envelope.recipients],
    copies: [...envelope.copies],
    read: false,
    archived: false,
    sent: envelope.sent,
    draft: envelope.draft,
  };
  if (envelope.inReplyTo.length > 0) meta.inReplyTo = envelope.inReplyTo;
  return meta;
}

/** The stored state a message DTO is built from. */
export type MessageFlags = Pick<MailFlagRecord, "read" | "archived" | "active" | "addresses">;

/**
 * Overlay the addresses a historical message actually carries on the entry a
 * reader sees.
 *
 * Message entries are immutable, so the one-time internal-address migration
 * cannot rewrite their headers; it stores the rewritten headers on the
 * message's flag document instead, and every reader goes through here so old
 * mail is addressed to the new internal addresses. An entry without an
 * override projects to itself.
 */
export function projectMessageAddresses(
  entry: EntryRecord,
  flags?: Pick<MailFlagRecord, "addresses">,
): EntryRecord {
  const overrides = flags?.addresses;
  if (overrides === undefined || !RoomMessageEntry.is(entry)) return entry;
  const data = entry.data;
  const mail = data.mail;
  return {
    ...entry,
    data: {
      ...data,
      address: overrides.address,
      ...(mail === null ? {} : { mail: { ...mail, to: overrides.to, cc: overrides.cc } }),
    },
  };
}

export function toMessageDTO(entry: EntryRecord, flags?: MessageFlags): MessageDTO | undefined {
  const projected = projectMessageAddresses(entry, flags);
  if (!RoomMessageEntry.is(projected)) return undefined;
  const data = projected.data;
  const dto: MessageDTO = {
    id: String(entry.id),
    roomId: "",
    author: {
      type: data.authorType,
      id: data.authorId,
      name: data.authorName,
      ...authorNameLocalized(data),
      ...(data.address.length > 0 ? { address: data.address } : {}),
    },
    body: data.body,
    ...(data.bodyLocalized === undefined ? {} : { bodyLocalized: data.bodyLocalized }),
    createdAt: data.createdAt,
  };
  if (data.workId.length > 0) dto.workId = data.workId;
  if (data.addressing !== null && data.addressing !== undefined) {
    dto.addressing = { recipientIds: [...data.addressing.recipientIds], mentionAll: data.addressing.mentionAll };
  }
  if (data.notice) dto.notice = true;
  if (data.mail !== null) {
    const meta = toMailMeta(data.mail);
    meta.read = flags?.read === true;
    meta.archived = flags?.archived === true;
    dto.mail = meta;
  }
  return dto;
}

/**
 * The display pair of a message author.
 *
 * Only application-generated labels are localized: a system author is known by
 * its type (never by its stored name), and the user's fallback label is the
 * name the app wrote for an unnamed user. Older records stored the Chinese
 * fallback label and newer ones the canonical English label, so both are
 * recognized. Employees and named users keep their real name untranslated — it
 * is record data, not application text.
 */
function authorNameLocalized(data: RoomMessageData): { nameLocalized?: LocalizedText } {
  if (data.authorType === "system") return { nameLocalized: roomMessages.systemAuthorName };
  if (
    data.authorType === "user" &&
    (data.authorName === roomMessages.userFallbackAuthorName["zh-CN"] ||
      data.authorName === roomMessages.userFallbackAuthorName[CANONICAL_LOCALE])
  ) {
    return { nameLocalized: roomMessages.userFallbackAuthorName };
  }
  return {};
}

/** Append one message to a room transcript inside an existing transaction. */
export async function appendRoomMessageIn(tx: Tx, room: RoomRecord, data: RoomMessageData): Promise<EntryRecord> {
  const entry = await tx.appendEntry(RoomMessageEntry, room.conversationId as ConversationId, { data });
  const doc = await tx.doc(RoomDoc, room.id, { id: room.id });
  doc.messageCount += 1;
  doc.lastMessageAt = data.createdAt;
  return entry;
}

/**
 * A room DTO carrying the unread count the inbox would show.
 *
 * Every event that publishes a room must go through this: emitting a room with
 * a default count of zero would silently clear the mailbox badge.
 */
export async function roomDTOWithUnread(
  runtime: EmitRuntime,
  room: RoomRecord,
  userId = "user",
): Promise<RoomDTO> {
  const app = await runtime.readSession(AppDoc);
  return toRoomDTO(room, await countMailUnread(runtime, room, userId, app.userAddress));
}

/** Append one message in its own commit, then publish it. */
export async function appendRoomMessage(
  runtime: EmitRuntime,
  room: RoomRecord,
  data: RoomMessageData,
): Promise<MessageDTO> {
  const entry = await runtime.harness.commit((tx) => appendRoomMessageIn(tx, room, data), runtime.ctx);
  const dto = toMessageDTO(entry);
  if (dto === undefined) throw new AppError(roomMessages.messageUnexpectedType);
  dto.roomId = room.id;
  runtime.emit({ type: "message", roomId: room.id, message: dto });
  runtime.emit({
    type: "room",
    room: await roomDTOWithUnread(runtime, {
      ...room,
      messageCount: room.messageCount + 1,
      lastMessageAt: data.createdAt,
    }),
  });
  return dto;
}

/** Read a room's newest messages, oldest first. */
export async function listRoomMessages(
  runtime: EmitRuntime,
  room: RoomRecord,
  limit = ROOM_PAGE_SIZE,
): Promise<MessageDTO[]> {
  const conversation = await runtime.harness.conversation(room.conversationId as ConversationId, runtime.ctx);
  if (conversation === undefined) return [];
  const page = await conversation.entries({}, limit, undefined, runtime.ctx);
  const messages: MessageDTO[] = [];
  for (const entry of page.items) {
    const flags = await readFlags(runtime, room.id, entry.id);
    // A retired draft (already sent, or replaced by an edit) stays in storage
    // but is no longer part of the thread.
    if (RoomMessageEntry.is(entry) && entry.data.mail?.draft === true && flags?.active === false) continue;
    const dto = toMessageDTO(entry, flags);
    if (dto === undefined) continue;
    dto.roomId = room.id;
    messages.push(dto);
  }
  return messages.reverse();
}

/**
 * The flags of one message, including any address override the migration may
 * have written. Exported because the mail, channel, and work readers must all
 * project through the same document.
 */
export async function readFlags(
  runtime: EmitRuntime,
  roomId: string,
  entryId: EntryId,
): Promise<MessageFlags | undefined> {
  const flag = await runtime.readFamily(MailFlagDoc, `${roomId}|${String(entryId)}`, {
    key: `${roomId}|${String(entryId)}`,
  });
  if (flag === undefined) return undefined;
  return { read: flag.read, archived: flag.archived, active: flag.active, addresses: flag.addresses };
}

export async function listRooms(runtime: EmitRuntime): Promise<RoomRecord[]> {
  const members = await runtime.listFamily(RoomDoc, (id) => ({ id }));
  return members.map((member) => member.value).sort((a, b) => b.lastMessageAt - a.lastMessageAt);
}

/**
 * The unread mail count of one thread, as the inbox defines it.
 *
 * A message counts only when it is mail (not a channel post), was not written
 * by the user, is not a draft, is addressed to the user in To or CC, is still
 * part of the thread (an edited or sent draft is retired), is not archived, and
 * has not been read. The sidebar badge and the inbox list therefore agree.
 */
export async function countMailUnread(
  runtime: EmitRuntime,
  room: RoomRecord,
  userId: string,
  userAddress: string,
): Promise<number> {
  if (room.kind !== "mail") return 0;
  const conversation = await runtime.harness.conversation(room.conversationId as ConversationId, runtime.ctx);
  if (conversation === undefined) return 0;
  const page = await conversation.entries({}, ROOM_PAGE_SIZE, undefined, runtime.ctx);
  let unread = 0;
  for (const entry of page.items) {
    if (!RoomMessageEntry.is(entry)) continue;
    if (entry.data.authorId === userId) continue;
    // The flags are read before the envelope is judged: a historical message's
    // headers live in its flag document.
    const flag = await readFlags(runtime, room.id, entry.id);
    if (flag?.active === false || flag?.archived === true || flag?.read === true) continue;
    const projected = projectMessageAddresses(entry, flag);
    if (!RoomMessageEntry.is(projected)) continue;
    const mail = projected.data.mail;
    if (mail === null || mail.draft === true) continue;
    if (!mailAddresses(mail, userAddress)) continue;
    unread += 1;
  }
  return unread;
}

export async function listRoomDTOs(runtime: EmitRuntime, userId: string): Promise<RoomDTO[]> {
  const rooms = await listRooms(runtime);
  const app = await runtime.readSession(AppDoc);
  const dtos: RoomDTO[] = [];
  for (const room of rooms) {
    const unread = await countMailUnread(runtime, room, userId, app.userAddress);
    dtos.push(toRoomDTO(room, unread));
  }
  return dtos;
}

export async function findRoom(runtime: EmitRuntime, id: string): Promise<RoomRecord | undefined> {
  return runtime.readFamily(RoomDoc, id, { id });
}

export async function isSentMailEntry(runtime: EmitRuntime, room: RoomRecord, entryId: string): Promise<boolean> {
  if (room.kind !== "mail" || entryId.length === 0) return false;
  if (!Number.isSafeInteger(Number(entryId)) || Number(entryId) <= 0) return false;
  const conversation = await runtime.harness.conversation(room.conversationId as ConversationId, runtime.ctx);
  if (conversation === undefined) return false;
  const page = await conversation.entries(
    { minEntryId: Number(entryId) as EntryId, maxEntryId: Number(entryId) as EntryId },
    1,
    undefined,
    runtime.ctx,
  );
  const entry = page.items[0];
  return (
    entry !== undefined &&
    RoomMessageEntry.is(entry) &&
    String(entry.id) === entryId &&
    entry.data.mail !== null &&
    entry.data.mail.sent &&
    !entry.data.mail.draft
  );
}

function sameParticipants(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/** The two sorted participants of a direct-message room. */
export function sortedParticipants(first: string, second: string): string[] {
  return [first, second].sort();
}

/** The direct-message conversation of one participant pair inside one work. */
export async function findEmployeeDm(
  runtime: EmitRuntime,
  workContextId: string,
  participantIds: readonly [string, string],
): Promise<RoomRecord | undefined> {
  const expected = sortedParticipants(participantIds[0], participantIds[1]);
  const rooms = await listRooms(runtime);
  return rooms.find(
    (room) =>
      room.kind === "dm" &&
      room.workContextId === workContextId &&
      sameParticipants(room.dmParticipantIds, expected),
  );
}

/** Whether one employee family member is a live, enabled employee. */
async function readEmployeeIn(
  tx: Tx,
  id: string,
): Promise<{ exists: boolean; enabled: boolean; name: string }> {
  const doc = await tx.doc(EmployeeDoc, id, { id });
  return { exists: doc.name.length > 0, enabled: doc.enabled, name: doc.name };
}

/** Whether one work-context family member exists (creation always stamps `createdAt`). */
async function workContextExistsIn(tx: Tx, id: string): Promise<boolean> {
  if (id.length === 0) return false;
  const doc = await tx.doc(WorkContextDoc, id, { id });
  return doc.createdAt !== 0;
}

/** Room creation input: the record's identity fields the caller chooses. */
export type RoomCreateInput = {
  kind: RoomRecord["kind"];
  name: string;
  topic?: string;
  /** The work this conversation is fixed to; required and never rebound. */
  workContextId: string;
  /** Employee id used to identify a user DM. */
  employeeId?: string;
  /** Channel members; every id must be a live enabled employee. */
  memberIds?: string[];
  /** For DMs: exactly two participant ids ("user" or an employee id). */
  dmParticipantIds?: string[];
};

/**
 * Create a room, its transcript conversation, and the room document inside one
 * caller-owned transaction.
 *
 * The caller validates what it can before opening the transaction, but the work
 * context and every member are re-checked here so a room can never point at a
 * work that does not exist or at an employee who is disabled.
 */
export async function createRoomIn(tx: Tx, init: RoomCreateInput): Promise<RoomRecord> {
  if (init.workContextId.length === 0 || !(await workContextExistsIn(tx, init.workContextId))) {
    throw new RoomError(404, roomMessages.workContextMissing(init.workContextId));
  }
  const memberIds: string[] = [];
  for (const id of init.memberIds ?? []) {
    if (typeof id !== "string" || id.length === 0) continue;
    if (memberIds.includes(id)) continue;
    const employee = await readEmployeeIn(tx, id);
    if (!employee.exists) throw new RoomError(404, roomMessages.memberNotFound(id));
    if (!employee.enabled) throw new RoomError(400, roomMessages.memberDisabled(employee.name));
    memberIds.push(id);
  }
  let dmParticipantIds: string[] = [];
  if (init.kind === "dm") {
    const participants = [...new Set(init.dmParticipantIds ?? [])].sort();
    if (participants.length !== 2) throw new RoomError(400, roomMessages.dmParticipantsInvalid);
    for (const id of participants) {
      if (id === "user") continue;
      const employee = await readEmployeeIn(tx, id);
      if (!employee.exists) throw new RoomError(404, roomMessages.memberNotFound(id));
      if (!employee.enabled) throw new RoomError(400, roomMessages.memberDisabled(employee.name));
    }
    dmParticipantIds = participants;
  }
  const id = `room_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const now = Date.now();
  const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
  // A transcript conversation runs no agent; employee extensions are selected
  // on the execution conversations their work creates.
  await configure(tx, conversation.id, { extensions: [] });
  const record: RoomRecord = {
    id,
    kind: init.kind,
    name: init.name,
    topic: init.topic ?? "",
    workContextId: init.workContextId,
    memberIds,
    membershipVersion: 1,
    dmParticipantIds,
    employeeId: init.employeeId ?? "",
    createdAt: now,
    lastMessageAt: now,
    messageCount: 0,
    conversationId: Number(conversation.id),
  };
  const doc = await tx.doc(RoomDoc, id, { id });
  Object.assign(doc, record);
  return record;
}

/** Create a room and its transcript conversation in one commit. */
export async function createRoom(runtime: EmitRuntime, init: RoomCreateInput): Promise<RoomRecord> {
  const record = await runtime.harness.commit((tx) => createRoomIn(tx, init), runtime.ctx);
  const saved = await runtime.readFamily(RoomDoc, record.id, { id: record.id });
  runtime.emit({ type: "room", room: toRoomDTO(saved ?? record) });
  return saved ?? record;
}

/**
 * Find or create the direct-message room of one participant pair in one work.
 *
 * The deduplication re-reads every candidate inside the creation transaction,
 * so two callers racing the same pair converge on one room instead of leaving
 * two private threads for the same two people.
 */
export async function ensureEmployeeDm(
  runtime: EmitRuntime,
  input: {
    workContextId: string;
    participantIds: readonly [string, string];
    name: string;
    topic: string;
    employeeId?: string;
  },
): Promise<{ room: RoomRecord; created: boolean }> {
  const expected = sortedParticipants(input.participantIds[0], input.participantIds[1]);
  const result = await runtime.harness.commit(async (tx) => {
    const candidates = (await listRooms(runtime)).filter(
      (room) =>
        room.kind === "dm" &&
        room.workContextId === input.workContextId &&
        sameParticipants(room.dmParticipantIds, expected),
    );
    for (const candidate of candidates) {
      const doc = await tx.doc(RoomDoc, candidate.id, { id: candidate.id });
      if (
        doc.kind === "dm" &&
        doc.workContextId === input.workContextId &&
        sameParticipants(doc.dmParticipantIds, expected)
      ) {
        return { record: plainRoom(doc), created: false };
      }
    }
    const record = await createRoomIn(tx, {
      kind: "dm",
      name: input.name,
      topic: input.topic,
      workContextId: input.workContextId,
      employeeId: input.employeeId ?? "",
      memberIds: [input.participantIds[0], input.participantIds[1]].filter((id) => id !== "user"),
      dmParticipantIds: [...expected],
    });
    return { record, created: true };
  }, runtime.ctx);
  if (result.created) runtime.emit({ type: "room", room: toRoomDTO(result.record) });
  return { room: result.record, created: result.created };
}

export type RoomMembersResult = {
  room: RoomRecord;
  added: string[];
  removed: string[];
};

/**
 * Replace a channel's member set.
 *
 * Members are employees only; adding or removing takes effect immediately.
 * One localized system notice records who changed the set, and only a real
 * change bumps `membershipVersion` — a draft that matches the stored set is a
 * no-op, not a conflict.
 */
export async function updateRoomMembers(
  runtime: EmitRuntime,
  roomId: string,
  memberIds: readonly string[],
  expectedVersion: unknown,
): Promise<RoomMembersResult> {
  if (!Number.isInteger(expectedVersion)) {
    throw new RoomError(400, roomMessages.expectedVersionNotAnInteger);
  }
  const current = await findRoom(runtime, roomId);
  if (current === undefined) throw new RoomError(404, roomMessages.roomNotFoundWithId(roomId));
  if (current.kind !== "channel") throw new RoomError(400, roomMessages.membersChannelOnly);
  if (!Array.isArray(memberIds)) throw new RoomError(400, roomMessages.membersNotAnArray);
  if (current.membershipVersion !== expectedVersion) {
    throw new RoomError(409, roomMessages.membersChangedReload(current.membershipVersion));
  }
  const requested: string[] = [];
  for (const id of memberIds) {
    if (typeof id !== "string" || id.length === 0) throw new RoomError(400, roomMessages.memberNotFound(String(id)));
    if (requested.includes(id)) continue;
    requested.push(id);
  }
  const app = await runtime.readSession(AppDoc);
  const actor: DisplayText = app.userName.length > 0 ? app.userName : roomMessages.userFallbackAuthorName;
  const expected = expectedVersion;
  const committed = await runtime.harness.commit(async (tx) => {
    const doc = await tx.doc(RoomDoc, roomId, { id: roomId });
    if (doc.kind !== "channel") throw new RoomError(400, roomMessages.membersChannelOnly);
    if (doc.membershipVersion !== expected) {
      throw new RoomError(409, roomMessages.membersChangedReload(doc.membershipVersion));
    }
    for (const id of requested) {
      const employee = await readEmployeeIn(tx, id);
      if (!employee.exists) throw new RoomError(404, roomMessages.memberNotFound(id));
      if (!employee.enabled) throw new RoomError(400, roomMessages.memberDisabled(employee.name));
    }
    const added = requested.filter((id) => !doc.memberIds.includes(id));
    const removed = doc.memberIds.filter((id) => !requested.includes(id));
    if (added.length === 0 && removed.length === 0) {
      return { room: plainRoom(doc), added, removed, changed: false, entry: undefined };
    }
    const names = new Map<string, string>();
    for (const id of [...added, ...removed]) {
      const employee = await readEmployeeIn(tx, id);
      names.set(id, employee.name);
    }
    doc.memberIds = [...requested];
    doc.membershipVersion += 1;
    const sentences: { text: string; localized: LocalizedText }[] = [];
    if (added.length > 0) {
      const sentence = roomMessages.membersInvited(actor, added.map((id) => names.get(id) ?? id));
      sentences.push({ text: sentence.text, localized: sentence.localized ?? { en: sentence.text, "zh-CN": sentence.text } });
    }
    if (removed.length > 0) {
      const sentence = roomMessages.membersRemoved(actor, removed.map((id) => names.get(id) ?? id));
      sentences.push({ text: sentence.text, localized: sentence.localized ?? { en: sentence.text, "zh-CN": sentence.text } });
    }
    const body = sentences.map((sentence) => sentence.text).join("; ");
    const bodyLocalized: LocalizedText = {
      en: sentences.map((sentence) => sentence.localized.en).join("; "),
      "zh-CN": sentences.map((sentence) => sentence.localized["zh-CN"]).join("；"),
    };
    const entry = await appendRoomMessageIn(
      tx,
      plainRoom(doc),
      messageData({
        author: { type: "system", id: "system", name: roomMessages.systemAuthorName[CANONICAL_LOCALE] },
        body,
        bodyLocalized,
        notice: true,
      }),
    );
    return { room: { ...plainRoom(doc), messageCount: doc.messageCount, lastMessageAt: doc.lastMessageAt }, added, removed, changed: true, entry };
  }, runtime.ctx);
  if (committed.changed) {
    const saved = await findRoom(runtime, roomId);
    const room = saved ?? committed.room;
    runtime.emit({ type: "room", room: await roomDTOWithUnread(runtime, room) });
    if (committed.entry !== undefined) {
      const dto = toMessageDTO(committed.entry);
      if (dto !== undefined) {
        dto.roomId = roomId;
        runtime.emit({ type: "message", roomId, message: dto });
      }
    }
    return { room, added: committed.added, removed: committed.removed };
  }
  return { room: committed.room, added: [], removed: [] };
}

export async function setMailFlag(
  runtime: EmitRuntime,
  roomId: string,
  entryId: string,
  change: { read?: boolean; archived?: boolean; active?: boolean },
): Promise<void> {
  const key = `${roomId}|${entryId}`;
  await runtime.updateFamily(MailFlagDoc, key, { key }, (doc) => {
    doc.key = key;
    if (change.read !== undefined) doc.read = change.read;
    if (change.archived !== undefined) doc.archived = change.archived;
    if (change.active !== undefined) doc.active = change.active;
  });
}

// ------------------------------------------------------------ history window

/** One visible history window of a room, centred on a source entry. */
export type RoomMessageWindow = {
  /** Visible messages up to and including the trigger, oldest first. */
  messages: MessageDTO[];
  /** The source message itself, when it is visible in this room. */
  trigger?: MessageDTO;
  /** Visible messages of this room that fell before the returned window. */
  omittedBeforeTrigger: number;
};

/**
 * Whether one message is visible to a specific employee.
 *
 * A channel's public transcript is visible to every member, including a member
 * added later — membership gates being addressed now, not reading history. A
 * direct message is visible only to its two participants. A mail is visible to
 * its author and to the employees actually addressed in To or CC; a draft or a
 * mail addressed to somebody else is not this employee's business.
 */
export function messageVisibleTo(room: RoomRecord, data: RoomMessageData, employeeId: string | undefined): boolean {
  if (employeeId === undefined) return true;
  if (room.kind === "channel") return true;
  if (room.kind === "dm") return room.dmParticipantIds.includes(employeeId);
  if (data.authorId === employeeId) return true;
  const mail = data.mail;
  if (mail === null || mail.draft || !mail.sent) return false;
  return mail.recipients.includes(employeeId) || mail.copies.includes(employeeId);
}

/**
 * Read the visible history before (and including) one source entry.
 *
 * Pages walk backward until the window is full or the room begins, so a page
 * of drafts cannot hide older visible messages. The trigger is returned
 * separately as well, because a caller that asked for "history before X" must
 * never treat X as history.
 */
export async function readRoomMessageWindow(
  runtime: EmitRuntime,
  room: RoomRecord,
  sourceEntryId: string,
  employeeId?: string,
): Promise<RoomMessageWindow> {
  const conversation = await runtime.harness.conversation(room.conversationId as ConversationId, runtime.ctx);
  if (conversation === undefined) return { messages: [], omittedBeforeTrigger: 0 };
  const sourceId =
    sourceEntryId.length > 0 && Number.isSafeInteger(Number(sourceEntryId)) && Number(sourceEntryId) > 0
      ? (Number(sourceEntryId) as EntryId)
      : undefined;

  const newestFirst: MessageDTO[] = [];
  let trigger: MessageDTO | undefined;
  let visibleBeforeWindow = 0;
  let cursor: Cursor | undefined;
  let scanned = 0;
  for (;;) {
    const page = await conversation.entries(
      sourceId !== undefined ? { maxEntryId: sourceId } : {},
      ROOM_PAGE_SIZE,
      cursor,
      runtime.ctx,
    );
    if (page.items.length === 0) break;
    scanned += page.items.length;
    for (const entry of page.items) {
      if (!RoomMessageEntry.is(entry)) continue;
      const data = entry.data;
      const id = String(entry.id);
      const flagKey = `${room.id}|${id}`;
      const flags = await runtime.readFamily(MailFlagDoc, flagKey, { key: flagKey });
      if (data.mail?.draft === true && flags?.active === false) continue;
      if (!messageVisibleTo(room, data, employeeId)) continue;
      if (sourceId !== undefined && id === sourceEntryId) {
        const message = toMessageDTO(entry, flags);
        if (message === undefined) continue;
        message.roomId = room.id;
        trigger = message;
        continue;
      }
      if (newestFirst.length >= ROOM_WINDOW_LIMIT) {
        visibleBeforeWindow += 1;
        continue;
      }
      const message = toMessageDTO(entry, flags);
      if (message === undefined) continue;
      message.roomId = room.id;
      newestFirst.push(message);
    }
    if (page.next === undefined) break;
    cursor = page.next;
    if (cursor === undefined) break;
    // A defensive bound: the window never needs more than a few thousand
    // entries, and a pathological transcript must not pin the request.
    if (scanned >= ROOM_PAGE_SIZE * 50) break;
  }

  const window = newestFirst.reverse();
  if (sourceId === undefined) {
    return { messages: window, omittedBeforeTrigger: visibleBeforeWindow };
  }
  if (trigger === undefined) {
    // The source itself is invisible (a retired draft, another employee's
    // mail): the window still reports the visible history before it.
    return { messages: window, omittedBeforeTrigger: visibleBeforeWindow };
  }
  return {
    messages: [...window, trigger],
    trigger,
    omittedBeforeTrigger: visibleBeforeWindow,
  };
}
