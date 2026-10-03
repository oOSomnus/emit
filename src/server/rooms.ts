/**
 * Rooms: the shared transcript.
 *
 * A room is a conversation whose entries are Emit's own `emit.message` entries,
 * not model context. Every room — channel, direct message, and mail thread —
 * uses the same shape, so one message list, one unread model, and one
 * subscription drive all three views. Mail is only an envelope on a message.
 */

import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  AppDoc,
  MailFlagDoc,
  RoomDoc,
  RoomMessageEntry,
  type MailEnvelope,
  type RoomDirectoriesRecord,
  type RoomMessageData,
  type RoomRecord,
} from "./documents.ts";
import { configure } from "@earendil-works/pi-durable";
import type { ConversationId, EntryRecord, EntryId, Tx } from "@earendil-works/pi-durable";
import type { EmitRuntime } from "./runtime.ts";
import { AppError, type AppText } from "./messages.ts";
import { roomMessages } from "./messages/rooms.ts";
import type {
  MailMetaDTO,
  MessageAuthorDTO,
  MessageDTO,
  RoomDirectoryDraftDTO,
  RoomDirectoryPatchDTO,
  RoomDTO,
} from "../shared/contracts.ts";
import type { LocalizedText } from "../shared/i18n.ts";

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

export class RoomDirectoryError extends AppError {
  constructor(
    readonly status: 400 | 404 | 409,
    message: AppText,
  ) {
    super(message);
  }
}

async function canonicalDirectoryPath(path: string): Promise<string> {
  const trimmed = path.trim();
  if (trimmed.length === 0 || !isAbsolute(trimmed)) {
    throw new RoomDirectoryError(400, roomMessages.directoryNotAbsolutePath(trimmed));
  }
  try {
    const canonical = await realpath(trimmed);
    const info = await stat(canonical);
    if (!info.isDirectory()) throw new RoomDirectoryError(400, roomMessages.directoryNotADirectory(trimmed));
    return canonical;
  } catch (error) {
    if (error instanceof RoomDirectoryError) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new RoomDirectoryError(400, roomMessages.directoryUnreadable(trimmed, reason));
  }
}

async function canonicalizeRoomDirectories(draft: unknown): Promise<RoomDirectoriesRecord> {
  if (typeof draft !== "object" || draft === null || Array.isArray(draft)) {
    throw new RoomDirectoryError(400, roomMessages.directoriesNotAnObject);
  }
  const value = draft as Record<string, unknown>;
  if (!Array.isArray(value.paths)) throw new RoomDirectoryError(400, roomMessages.directoryPathsNotAnArray);
  if (typeof value.defaultPath !== "string") {
    throw new RoomDirectoryError(400, roomMessages.defaultDirectoryNotAString);
  }

  const paths: string[] = [];
  const seen = new Set<string>();
  for (const item of value.paths) {
    if (typeof item !== "string") throw new RoomDirectoryError(400, roomMessages.directoryPathNotAString);
    const path = await canonicalDirectoryPath(item);
    if (seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }

  const defaultInput = value.defaultPath.trim();
  if (paths.length === 0) {
    if (defaultInput.length > 0) {
      throw new RoomDirectoryError(400, roomMessages.defaultDirectoryNotAuthorized(defaultInput));
    }
    return { paths, defaultPath: "", version: 1 };
  }
  if (defaultInput.length === 0) {
    throw new RoomDirectoryError(400, roomMessages.chooseDefaultDirectory);
  }
  const defaultPath = await canonicalDirectoryPath(defaultInput);
  if (!seen.has(defaultPath)) {
    throw new RoomDirectoryError(400, roomMessages.defaultDirectoryNotAuthorized(defaultPath));
  }
  return { paths, defaultPath, version: 1 };
}

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
    memberIds: [...record.memberIds],
    employeeId: record.employeeId,
    directories: {
      paths: [...record.directories.paths],
      defaultPath: record.directories.defaultPath,
      version: record.directories.version,
    },
    createdAt: record.createdAt,
    lastMessageAt: record.lastMessageAt,
    messageCount: record.messageCount,
    conversationId: record.conversationId,
  };
}

export function toRoomDTO(record: RoomRecord, unread = 0): RoomDTO {
  const directories = record.directories;
  return {
    id: record.id,
    kind: record.kind,
    name: record.name,
    topic: record.topic,
    memberIds: [...record.memberIds],
    directories: {
      paths: Array.isArray(directories?.paths) ? [...directories.paths] : [],
      defaultPath: typeof directories?.defaultPath === "string" ? directories.defaultPath : "",
      version: typeof directories?.version === "number" ? directories.version : 0,
    },
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

export function toMessageDTO(
  entry: EntryRecord,
  flags?: { read: boolean; archived: boolean; active: boolean },
): MessageDTO | undefined {
  if (!RoomMessageEntry.is(entry)) return undefined;
  const data = entry.data;
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
 * name the app wrote for an unnamed user. Employees and named users keep
 * their real name untranslated — it is record data, not application text.
 */
function authorNameLocalized(data: RoomMessageData): { nameLocalized?: LocalizedText } {
  if (data.authorType === "system") return { nameLocalized: roomMessages.systemAuthorName };
  if (data.authorType === "user" && data.authorName === roomMessages.userFallbackAuthorName["zh-CN"]) {
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

async function readFlags(
  runtime: EmitRuntime,
  roomId: string,
  entryId: EntryId,
): Promise<{ read: boolean; archived: boolean; active: boolean } | undefined> {
  const flag = await runtime.readFamily(MailFlagDoc, `${roomId}|${String(entryId)}`, {
    key: `${roomId}|${String(entryId)}`,
  });
  if (flag === undefined) return undefined;
  return { read: flag.read, archived: flag.archived, active: flag.active };
}

export async function listRooms(runtime: EmitRuntime): Promise<RoomRecord[]> {
  const members = await runtime.listFamily(RoomDoc, (id) => ({ id }));
  return members.map((member) => member.value).sort((a, b) => b.lastMessageAt - a.lastMessageAt);
}

/**
 * Rooms with their unread mail count.
 *
 * Only mail threads can be unread: a channel or direct message is read by
 * looking at it, while a mail carries a per-message flag the user controls.
 */
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
    const mail = entry.data.mail;
    if (mail === null || entry.data.authorId === userId) continue;
    if (mail.draft === true) continue;
    if (!mailAddresses(mail, userAddress)) continue;
    const flag = await readFlags(runtime, room.id, entry.id);
    if (flag?.active === false || flag?.archived === true) continue;
    if (flag?.read === true) continue;
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

/** The direct-message conversation addressed to one employee. */
export async function findEmployeeDm(runtime: EmitRuntime, employeeId: string): Promise<RoomRecord | undefined> {
  const rooms = await listRooms(runtime);
  return rooms.find((room) => room.employeeId === employeeId && room.kind === "dm");
}

let roomCounter = 0;

/** Room creation input: the record's identity fields the caller chooses. */
export type RoomCreateInput = {
  kind: RoomRecord["kind"];
  name: string;
  topic?: string;
  employeeId?: string;
  memberIds?: string[];
  directories?: RoomDirectoryDraftDTO;
};

/**
 * Create a room, its transcript conversation, and the room document inside one
 * caller-owned transaction.
 *
 * The caller validates directories before opening the transaction: this helper
 * does no filesystem or network work, so it is safe to compose with message
 * appends, work creation, and task creation in a single commit.
 */
export async function createRoomIn(
  tx: Tx,
  init: RoomCreateInput & { directories: RoomDirectoriesRecord },
): Promise<RoomRecord> {
  const id = `room_${Date.now().toString(36)}${(roomCounter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
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
    memberIds: init.memberIds ?? [],
    employeeId: init.employeeId ?? "",
    directories: { ...init.directories, paths: [...init.directories.paths] },
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
  const directories =
    init.directories === undefined
      ? { paths: [], defaultPath: "", version: 1 }
      : await canonicalizeRoomDirectories(init.directories);
  const record = await runtime.harness.commit((tx) => createRoomIn(tx, { ...init, directories }), runtime.ctx);
  const saved = await runtime.readFamily(RoomDoc, record.id, { id: record.id });
  runtime.emit({ type: "room", room: toRoomDTO(saved ?? record) });
  return saved ?? record;
}

export async function updateRoomDirectories(
  runtime: EmitRuntime,
  roomId: string,
  draft: RoomDirectoryPatchDTO,
): Promise<RoomRecord> {
  if (typeof draft !== "object" || draft === null || !Number.isInteger(draft.expectedVersion)) {
    throw new RoomDirectoryError(400, roomMessages.expectedVersionNotAnInteger);
  }
  const current = await findRoom(runtime, roomId);
  if (current === undefined) throw new RoomDirectoryError(404, roomMessages.roomNotFoundWithId(roomId));
  if (
    current.directories === undefined ||
    !Number.isInteger(current.directories.version) ||
    current.directories.version < 1 ||
    !Array.isArray(current.directories.paths) ||
    typeof current.directories.defaultPath !== "string"
  ) {
    throw new RoomDirectoryError(400, roomMessages.directoriesMissingRecreate);
  }
  if (current.directories.version !== draft.expectedVersion) {
    throw new RoomDirectoryError(409, roomMessages.directoriesChangedReload);
  }
  const normalized = await canonicalizeRoomDirectories(draft);
  return runtime.updateFamily(RoomDoc, roomId, { id: roomId }, (doc) => {
    const directories = doc.directories;
    if (
      directories === undefined ||
      !Number.isInteger(directories.version) ||
      directories.version < 1 ||
      !Array.isArray(directories.paths) ||
      typeof directories.defaultPath !== "string"
    ) {
      throw new RoomDirectoryError(400, roomMessages.directoriesMissingRecreate);
    }
    if (directories.version !== draft.expectedVersion) {
      throw new RoomDirectoryError(409, roomMessages.directoriesChangedReload);
    }
    const changed =
      directories.defaultPath !== normalized.defaultPath ||
      directories.paths.length !== normalized.paths.length ||
      directories.paths.some((path, index) => path !== normalized.paths[index]);
    doc.directories = {
      paths: [...normalized.paths],
      defaultPath: normalized.defaultPath,
      version: changed ? directories.version + 1 : directories.version,
    };
  });
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
