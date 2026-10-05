/**
 * One-click debug-session export.
 *
 * A complete session snapshot is captured as a single coherent state: every
 * durable read happens inside one read-only `harness.commit` callback, which
 * runs on the same serialized mutation line as every write, so the exported
 * records all belong to one committed state. The callback stages no writes, so
 * the commit settles empty and no storage transaction is opened.
 *
 * The snapshot is then streamed to a private file under the OS temporary
 * directory, where the exact bytes remain available for inspection after the
 * server restarts. This module owns capture, selection, artifact persistence,
 * and the process-local artifact registry; the HTTP layer only forwards IDs.
 */

import { createWriteStream, type WriteStream } from "node:fs";
import { lstat, mkdtemp, open, realpath, rename, rm, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { JsonValue } from "@earendil-works/chord";
import type {
  ConversationId,
  ConversationRecord,
  Cursor,
  DocumentRecord,
  EntryRecord,
  Page,
  StoredDocument,
  SubmissionRecord,
  TaskId,
  TaskRecord,
  Tx,
} from "@earendil-works/pi-durable";
import type { EmitRuntime } from "./runtime.ts";
import { AppError, type AppText } from "./app-text.ts";
import { apiMessages } from "./messages/api.ts";
import {
  AppDoc,
  ApprovalDoc,
  CollaborationDoc,
  EmployeeDoc,
  MailFlagDoc,
  MailSendReceiptDoc,
  McpDoc,
  MessageSendReceiptDoc,
  RoomDoc,
  SkillDoc,
  WorkContextDoc,
  WorkContextMutationReceiptDoc,
  WorkDoc,
  type ApprovalRecord,
  type MailFlagRecord,
  type MailSendReceiptRecord,
  type MessageSendReceiptRecord,
  type RoomRecord,
  type WorkContextMutationReceiptRecord,
  type WorkRecord,
} from "./documents.ts";
import { REDACTION_MARKER, redactApprovalText, redactJsonValue } from "./approval/evaluators.ts";
import { renderToolResult } from "./prompts/index.ts";
import type { SessionExportReceiptDTO, SessionExportRequestDTO } from "../shared/contracts.ts";

/** Exports per read; the storage cursors are opaque and always round-tripped. */
const SCAN_LIMIT = 500;
/** Bounded closure loops: a malformed record cycle must fail loudly, not spin. */
const MAX_CLOSURE_ROUNDS = 16;

/** One export failure with the HTTP status the route answers. */
export class SessionExportError extends AppError {
  readonly status: number;

  constructor(status: number, message: AppText) {
    super(message);
    this.name = "SessionExportError";
    this.status = status;
  }
}

type ExportScope = { roomId: string } | { workId: string };

type ExportedConversation = {
  id: number;
  parent?: ConversationRecord["parent"];
  owner?: ConversationRecord["owner"];
  role: "room" | "execution";
  coverage: "full" | "related";
  entryIds: number[];
  maxEntryId: number | null;
};

type ExportedArtifact = {
  entryId: number;
  toolCallId: string;
  path: string;
  readAt: number;
  status: "included" | "missing" | "unsafe" | "unparsed" | "read-error";
  reason?: string;
  encoding?: "utf8" | "base64";
  sensitive?: true;
  content?: string;
  bytes?: number;
};

type MissingReference = { kind: string; id: string; reason: string };

type SessionSnapshot = {
  format: "emit.session-debug";
  schemaVersion: 1;
  capturedAt: number;
  scope: ExportScope;
  conversations: ExportedConversation[];
  entries: EntryRecord[];
  tasks: TaskRecord<JsonValue, JsonValue, JsonValue>[];
  submissions: SubmissionRecord[];
  documents: StoredDocument[];
  artifacts: ExportedArtifact[];
  missing: MissingReference[];
  redaction: { marker: string; applied: true };
};

type ArtifactRequest = { entryId: number; toolCallId: string; path: string; unparsed?: true };

type CapturedSnapshot = {
  snapshot: SessionSnapshot;
  artifactRequests: ArtifactRequest[];
};

/** Materialized session documents, keyed by their logical identity. */
type SessionDocuments = {
  app: StoredDocument | undefined;
  rooms: Map<string, StoredDocument>;
  works: Map<string, StoredDocument>;
  approvals: Map<string, StoredDocument>;
  employees: Map<string, StoredDocument>;
  workContexts: Map<string, StoredDocument>;
  collaborations: Map<string, StoredDocument>;
  mailFlags: Map<string, StoredDocument>;
  mailReceipts: Map<string, StoredDocument>;
  messageReceipts: Map<string, StoredDocument>;
  mutationReceipts: Map<string, StoredDocument>;
  skills: Map<string, StoredDocument>;
  mcps: Map<string, StoredDocument>;
};

function valueOf<T>(doc: StoredDocument): T {
  return doc.value as unknown as T;
}

/** Round-trip one opaque scan cursor and refuse a cursor that does not advance. */
async function scanToExhaustion<T>(
  scan: (cursor: Cursor | undefined) => Promise<Page<T, Cursor>>,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: Cursor | undefined;
  for (;;) {
    const page = await scan(cursor);
    items.push(...page.items);
    if (page.next === undefined) return items;
    if (cursor !== undefined && JSON.stringify(page.next) === JSON.stringify(cursor)) {
      throw new Error("A storage scan cursor did not advance");
    }
    cursor = page.next;
  }
}

async function scanDocuments(
  runtime: EmitRuntime,
  kind: string | undefined,
  scope: DocumentRecord["scope"],
): Promise<StoredDocument[]> {
  const records = await scanToExhaustion<DocumentRecord>((cursor) =>
    runtime.storage.scanDocuments(
      { scope, at: "current", ...(kind === undefined ? {} : { kind }) },
      SCAN_LIMIT,
      cursor,
      runtime.ctx,
    ),
  );
  const documents: StoredDocument[] = [];
  for (const record of records) {
    const doc = await runtime.storage.document(record.id, "current", runtime.ctx);
    if (doc === undefined) throw new Error(`Document ${record.id} (${record.kind}) could not be materialized`);
    documents.push(doc);
  }
  return documents;
}

/** MCP server definitions keep their keys but never their secret values. */
function redactMcpDocument(doc: StoredDocument): StoredDocument {
  if (doc.record.kind !== McpDoc.definition.kind) return doc;
  const value = { ...doc.value } as { env?: Record<string, string>; headers?: Record<string, string> };
  const redactRecord = (input: Record<string, string> | undefined): Record<string, string> | undefined => {
    if (input === undefined) return undefined;
    return Object.fromEntries(Object.keys(input).map((key) => [key, REDACTION_MARKER]));
  };
  const env = redactRecord(value.env);
  const headers = redactRecord(value.headers);
  return {
    ...doc,
    value: {
      ...doc.value,
      ...(env === undefined ? {} : { env }),
      ...(headers === undefined ? {} : { headers }),
    },
  };
}

/**
 * One-click debug snapshots.
 *
 * The service selects a room's or work's full scope, captures it in one
 * coherent durable read, persists the snapshot as a private file, and keeps a
 * process-local registry so the HTTP layer can serve the exact saved bytes.
 */
export class SessionExportService {
  readonly #runtime: EmitRuntime;
  readonly #registry = new Map<string, { path: string; filename: string }>();
  #directory: string | undefined;

  constructor(runtime: EmitRuntime) {
    this.#runtime = runtime;
  }

  /** The saved file behind one receipt ID, if this process still knows it. */
  file(id: string): { path: string; filename: string } | undefined {
    return this.#registry.get(id);
  }

  /** Capture, persist, and register one complete session snapshot. */
  async create(scope: SessionExportRequestDTO): Promise<SessionExportReceiptDTO> {
    const roomId = typeof scope?.roomId === "string" && scope.roomId.length > 0 ? scope.roomId : undefined;
    const workId = typeof scope?.workId === "string" && scope.workId.length > 0 ? scope.workId : undefined;
    if ((roomId === undefined) === (workId === undefined)) {
      throw new SessionExportError(400, apiMessages.sessionExportInvalidTarget);
    }
    const target: ExportScope = roomId === undefined ? { workId: workId! } : { roomId };
    const captured = await this.#capture(target);
    captured.snapshot.artifacts = await this.#readArtifacts(captured.artifactRequests);
    const receipt = await this.#persist(captured.snapshot);
    return receipt;
  }

  /**
   * One coherent durable read.
   *
   * Everything the snapshot contains is read inside this callback: the
   * `harness.commit` empty-write path runs it on the serialized mutation line
   * without opening a storage transaction, so the export cannot observe a
   * torn state and stages no writes of its own.
   */
  async #capture(scope: ExportScope): Promise<CapturedSnapshot> {
    const runtime = this.#runtime;
    return runtime.harness.commit(async (tx) => {
      const session = await this.#readSessionDocuments();
      const conversations = await scanToExhaustion<ConversationRecord>((cursor) =>
        tx.scanConversations({}, SCAN_LIMIT, cursor),
      );
      const tasks = await scanToExhaustion<TaskRecord<JsonValue, JsonValue, JsonValue>>((cursor) =>
        tx.scanTasks({}, SCAN_LIMIT, cursor),
      );

      const missing: MissingReference[] = [];
      const requestedRoom = "roomId" in scope ? session.rooms.get(scope.roomId) : undefined;
      const requestedWork = "workId" in scope ? session.works.get(scope.workId) : undefined;
      if ("roomId" in scope && requestedRoom === undefined) {
        throw new SessionExportError(404, apiMessages.roomNotFound);
      }
      if ("workId" in scope && requestedWork === undefined) {
        throw new SessionExportError(404, apiMessages.workNotFound);
      }

      const roomValues = new Map<string, RoomRecord>();
      for (const [id, doc] of session.rooms) roomValues.set(id, valueOf<RoomRecord>(doc));
      const workValues = new Map<string, WorkRecord>();
      for (const [id, doc] of session.works) workValues.set(id, valueOf<WorkRecord>(doc));
      const requestedRoomRecord = requestedRoom === undefined ? undefined : valueOf<RoomRecord>(requestedRoom);

      // ---- selected works: the requested room's works (or the requested
      // work), expanded through the collaboration tree to a fixed point.
      const selectedWorks = new Set<string>();
      const selectedRoots = new Set<string>();
      const addWork = (id: string): void => {
        const work = workValues.get(id);
        if (work === undefined || selectedWorks.has(id)) return;
        selectedWorks.add(id);
        selectedRoots.add(work.rootWorkId.length > 0 ? work.rootWorkId : work.id);
      };
      if ("workId" in scope) addWork(scope.workId);
      if (requestedRoomRecord !== undefined) {
        for (const work of workValues.values()) {
          if (work.roomId === requestedRoomRecord.id) addWork(work.id);
        }
      }

      // ---- conversations and tasks: one shared closure, because receipts
      // live on tasks and tasks live on conversations.
      const selectedConversations = new Set<number>();
      const selectedTasks = new Set<number>();
      const conversationById = new Map<number, ConversationRecord>(
        conversations.map((record) => [record.id as number, record]),
      );
      const tasksByConversation = new Map<number, TaskRecord<JsonValue, JsonValue, JsonValue>[]>();
      for (const task of tasks) {
        const list = tasksByConversation.get(task.conversationId) ?? [];
        list.push(task);
        tasksByConversation.set(task.conversationId, list);
      }
      const taskById = new Map<number, TaskRecord<JsonValue, JsonValue, JsonValue>>(
        tasks.map((task) => [task.id, task]),
      );

      const receiptWorkIds = (): string[] => {
        const ids: string[] = [];
        for (const taskId of selectedTasks) {
          const key = `tool:${taskId}`;
          for (const receipt of [session.mailReceipts.get(key), session.messageReceipts.get(key)]) {
            if (receipt === undefined) continue;
            const record = valueOf<MailSendReceiptRecord | MessageSendReceiptRecord>(receipt);
            ids.push(...record.workIds);
          }
        }
        return ids;
      };

      let rounds = 0;
      let changed = true;
      while (changed) {
        if (++rounds > MAX_CLOSURE_ROUNDS) throw new Error("Session export selection did not reach a fixed point");
        changed = false;
        // Work tree: every work sharing a selected root, child, or parent, and
        // every awaited mail child, joins the selection.
        for (const work of workValues.values()) {
          if (selectedWorks.has(work.id)) continue;
          if (
            selectedRoots.has(work.rootWorkId) ||
            (work.parentWorkId.length > 0 && selectedWorks.has(work.parentWorkId))
          ) {
            addWork(work.id);
            changed = true;
          }
        }
        for (const id of [...selectedWorks]) {
          const work = workValues.get(id);
          if (work === undefined) continue;
          for (const awaited of work.awaitedMailWorkIds) {
            if (!selectedWorks.has(awaited)) {
              addWork(awaited);
              changed = true;
            }
          }
        }
        // Execution conversations: the works' conversations, recursively owned
        // children, and fork ancestry.
        for (const id of selectedWorks) {
          const work = workValues.get(id);
          if (work !== undefined && work.conversationId !== 0) selectedConversations.add(work.conversationId);
        }
        for (const record of conversations) {
          const ownerConversation = record.owner?.conversationId;
          if (ownerConversation !== undefined && selectedConversations.has(ownerConversation)) {
            if (!selectedConversations.has(record.id)) {
              selectedConversations.add(record.id);
              changed = true;
            }
          }
          const parent = record.parent?.conversationId;
          if (parent !== undefined && selectedConversations.has(record.id) && !selectedConversations.has(parent)) {
            selectedConversations.add(parent);
            changed = true;
          }
          const ownerTask = record.owner?.taskId;
          if (ownerTask !== undefined && selectedTasks.has(ownerTask) && !selectedConversations.has(record.id)) {
            selectedConversations.add(record.id);
            changed = true;
          }
        }
        // Tasks: every task of a selected conversation, plus the dispatch and
        // resume tasks a selected work still points at.
        for (const id of selectedConversations) {
          for (const task of tasksByConversation.get(id) ?? []) {
            if (!selectedTasks.has(task.id)) {
              selectedTasks.add(task.id);
              changed = true;
            }
          }
        }
        for (const id of selectedWorks) {
          const work = workValues.get(id);
          if (work === undefined) continue;
          for (const taskId of [work.dispatchTaskId, work.mailResumeTaskId]) {
            if (taskId.length === 0) continue;
            const numeric = Number(taskId);
            if (Number.isFinite(numeric) && taskById.has(numeric) && !selectedTasks.has(numeric)) {
              selectedTasks.add(numeric);
              changed = true;
            }
          }
        }
        // Receipts written by selected tasks can name further works (a send
        // wakes recipients), which expands the tree again.
        for (const id of receiptWorkIds()) {
          if (!selectedWorks.has(id) && workValues.has(id)) {
            addWork(id);
            changed = true;
          }
        }
      }

      // ---- room coverage: the requested room is complete; rooms reached
      // through selected works only carry their relevant entries.
      const requestedRoomId = requestedRoomRecord?.id;
      const relatedRooms = new Set<string>();
      for (const id of selectedWorks) {
        const work = workValues.get(id);
        if (work === undefined || work.roomId.length === 0 || work.roomId === requestedRoomId) continue;
        relatedRooms.add(work.roomId);
      }
      for (const roomId of [...relatedRooms]) {
        if (!session.rooms.has(roomId)) {
          missing.push({ kind: "room", id: roomId, reason: "not-found" });
          relatedRooms.delete(roomId);
        }
      }

      // ---- raw entries per conversation.
      const entriesByConversation = new Map<number, EntryRecord[]>();
      const scanConversationEntries = async (conversationId: number): Promise<EntryRecord[]> => {
        const cached = entriesByConversation.get(conversationId);
        if (cached !== undefined) return cached;
        const scanned = await scanToExhaustion<EntryRecord>((cursor) =>
          tx.scanEntries({ conversationId: conversationId as ConversationId }, SCAN_LIMIT, cursor),
        );
        scanned.sort((left, right) => left.id - right.id);
        entriesByConversation.set(conversationId, scanned);
        return scanned;
      };

      const fullRoomEntries = new Map<string, EntryRecord[]>();
      if (requestedRoomRecord !== undefined) {
        fullRoomEntries.set(
          requestedRoomRecord.id,
          await scanConversationEntries(requestedRoomRecord.conversationId),
        );
      }

      // Related-room relevance: a work's source entry, entries carrying a
      // selected work id, a selected task's send receipt, and every mail
      // parent those reference.
      const relatedEntryIds = new Map<string, Set<number>>();
      const markRelated = (roomId: string, entryId: string): void => {
        const numeric = Number(entryId);
        if (!Number.isFinite(numeric)) return;
        const set = relatedEntryIds.get(roomId) ?? new Set<number>();
        set.add(numeric);
        relatedEntryIds.set(roomId, set);
      };
      for (const id of selectedWorks) {
        const work = workValues.get(id);
        if (work === undefined || !relatedRooms.has(work.roomId)) continue;
        if (work.sourceEntryId.length > 0) markRelated(work.roomId, work.sourceEntryId);
      }
      for (const roomId of relatedRooms) {
        const room = roomValues.get(roomId);
        if (room === undefined) continue;
        for (const entry of await scanConversationEntries(room.conversationId)) {
          const data = entry.data as { workId?: unknown } | undefined;
          if (typeof data?.workId === "string" && data.workId.length > 0 && selectedWorks.has(data.workId)) {
            markRelated(roomId, String(entry.id));
          }
        }
      }
      for (const taskId of selectedTasks) {
        const key = `tool:${taskId}`;
        for (const receipt of [session.mailReceipts.get(key), session.messageReceipts.get(key)]) {
          if (receipt === undefined) continue;
          const record = valueOf<MailSendReceiptRecord | MessageSendReceiptRecord>(receipt);
          if (record.roomId.length === 0) continue;
          if (record.roomId === requestedRoomId || relatedRooms.has(record.roomId)) {
            markRelated(record.roomId, record.entryId);
          }
        }
      }

      // Follow mail reply chains inside related rooms to their roots.
      for (const roomId of relatedRooms) {
        const room = roomValues.get(roomId);
        if (room === undefined) continue;
        const entries = await scanConversationEntries(room.conversationId);
        const byId = new Map<number, EntryRecord>(entries.map((entry) => [entry.id, entry]));
        const pending = [...(relatedEntryIds.get(roomId) ?? [])];
        const visited = new Set<number>();
        while (pending.length > 0) {
          const entryId = pending.pop()!;
          if (visited.has(entryId)) continue;
          visited.add(entryId);
          const entry = byId.get(entryId);
          if (entry === undefined) {
            missing.push({ kind: "entry", id: `${roomId}|${entryId}`, reason: "not-found" });
            continue;
          }
          markRelated(roomId, String(entryId));
          const mail = (entry.data as { mail?: { inReplyTo?: unknown } } | undefined)?.mail;
          if (typeof mail?.inReplyTo === "string" && mail.inReplyTo.length > 0) {
            const parent = Number(mail.inReplyTo);
            if (Number.isFinite(parent)) pending.push(parent);
          }
        }
      }

      // ---- room conversations and their entries.
      const exportedConversations = new Map<number, ExportedConversation>();
      const exportedEntries = new Map<number, EntryRecord>();
      for (const room of [requestedRoomRecord, ...[...relatedRooms].map((id) => roomValues.get(id))]) {
        if (room === undefined) continue;
        const coverage = room.id === requestedRoomId ? "full" : "related";
        const entries =
          coverage === "full"
            ? fullRoomEntries.get(room.id) ?? []
            : (await scanConversationEntries(room.conversationId)).filter((entry) =>
                relatedEntryIds.get(room.id)?.has(entry.id),
              );
        for (const entry of entries) exportedEntries.set(entry.id, entry);
        exportedConversations.set(room.conversationId, {
          id: room.conversationId,
          ...(conversationById.get(room.conversationId)?.parent === undefined
            ? {}
            : { parent: conversationById.get(room.conversationId)!.parent }),
          ...(conversationById.get(room.conversationId)?.owner === undefined
            ? {}
            : { owner: conversationById.get(room.conversationId)!.owner }),
          role: "room",
          coverage,
          entryIds: entries.map((entry) => entry.id),
          maxEntryId: entries.length === 0 ? null : Math.max(...entries.map((entry) => entry.id)),
        });
      }

      // ---- execution conversations: complete raw transcripts.
      for (const id of selectedConversations) {
        const entries = await scanConversationEntries(id);
        for (const entry of entries) exportedEntries.set(entry.id, entry);
        const record = conversationById.get(id as ConversationId);
        exportedConversations.set(id, {
          id,
          ...(record?.parent === undefined ? {} : { parent: record.parent }),
          ...(record?.owner === undefined ? {} : { owner: record.owner }),
          role: "execution",
          coverage: "full",
          entryIds: entries.map((entry) => entry.id),
          maxEntryId: entries.length === 0 ? null : Math.max(...entries.map((entry) => entry.id)),
        });
      }

      // ---- entries can attribute further tasks, whose conversations and
      // entries then join the export too.
      let entryRounds = 0;
      let added = true;
      while (added) {
        if (++entryRounds > MAX_CLOSURE_ROUNDS) throw new Error("Session export entry closure did not reach a fixed point");
        added = false;
        for (const entry of exportedEntries.values()) {
          if (entry.byTaskId === undefined || selectedTasks.has(entry.byTaskId)) continue;
          const task = taskById.get(entry.byTaskId as number);
          if (task === undefined) continue;
          selectedTasks.add(task.id);
          const conversationId = task.conversationId;
          if (!selectedConversations.has(conversationId)) {
            selectedConversations.add(conversationId);
            added = true;
          }
        }
        for (const id of selectedConversations) {
          if (exportedConversations.has(id)) continue;
          const entries = await scanConversationEntries(id);
          for (const entry of entries) exportedEntries.set(entry.id, entry);
          const record = conversationById.get(id as ConversationId);
          exportedConversations.set(id, {
            id,
            ...(record?.parent === undefined ? {} : { parent: record.parent }),
            ...(record?.owner === undefined ? {} : { owner: record.owner }),
            role: "execution",
            coverage: "full",
            entryIds: entries.map((entry) => entry.id),
            maxEntryId: entries.length === 0 ? null : Math.max(...entries.map((entry) => entry.id)),
          });
        }
      }

      // ---- submissions of the selected conversations.
      const submissions: SubmissionRecord[] = [];
      for (const id of selectedConversations) {
        submissions.push(
          ...(await scanToExhaustion<SubmissionRecord>((cursor) =>
            runtime.storage.scanSubmissions({ conversationId: id as ConversationId }, SCAN_LIMIT, cursor, runtime.ctx),
          )),
        );
      }

      // ---- referenced works must exist; a queued work's zero conversation is
      // recorded, not invented.
      for (const id of selectedWorks) {
        const work = workValues.get(id);
        if (work === undefined) continue;
        if (work.conversationId === 0) {
          missing.push({ kind: "conversation", id: `work:${work.id}`, reason: "not-started" });
        } else if (!conversationById.has(work.conversationId)) {
          missing.push({ kind: "conversation", id: String(work.conversationId), reason: "not-found" });
        }
        if (work.employeeId.length > 0 && !session.employees.has(work.employeeId)) {
          missing.push({ kind: "employee", id: work.employeeId, reason: "not-found" });
        }
      }

      // ---- documents: the selected session documents, every conversation and
      // task document of the selected execution scope, and nothing else.
      const documents: StoredDocument[] = [];
      const seenDocuments = new Set<number>();
      const addDocument = (doc: StoredDocument): void => {
        if (seenDocuments.has(doc.record.id)) return;
        seenDocuments.add(doc.record.id);
        documents.push(doc);
      };
      if (session.app !== undefined) addDocument(session.app);
      const selectedRooms = new Set<string>();
      if (requestedRoomRecord !== undefined) selectedRooms.add(requestedRoomRecord.id);
      for (const id of relatedRooms) selectedRooms.add(id);
      for (const id of selectedRooms) {
        const room = session.rooms.get(id);
        if (room !== undefined) addDocument(room);
      }
      for (const id of selectedWorks) {
        const work = session.works.get(id);
        if (work !== undefined) addDocument(work);
      }
      for (const doc of session.approvals.values()) {
        const approval = valueOf<ApprovalRecord>(doc);
        if (selectedWorks.has(approval.workId) || selectedRoots.has(approval.rootWorkId)) addDocument(doc);
        else if (approval.employeeId.length > 0 && !session.employees.has(approval.employeeId)) {
          missing.push({ kind: "employee", id: approval.employeeId, reason: "not-found" });
        }
      }
      for (const rootId of selectedRoots) {
        const collab = session.collaborations.get(rootId);
        if (collab !== undefined) addDocument(collab);
      }
      for (const [key, doc] of session.mailFlags) {
        const flag = valueOf<MailFlagRecord>(doc);
        const separator = key.indexOf("|");
        const roomId = separator === -1 ? "" : key.slice(0, separator);
        const entryId = separator === -1 ? "" : key.slice(separator + 1);
        if (!selectedRooms.has(roomId)) continue;
        const numeric = Number(entryId);
        if (Number.isFinite(numeric) && exportedEntries.has(numeric)) addDocument(doc);
      }
      for (const [key, doc] of [...session.mailReceipts, ...session.messageReceipts, ...session.mutationReceipts]) {
        const record = valueOf<MailSendReceiptRecord | MessageSendReceiptRecord | WorkContextMutationReceiptRecord>(doc);
        const roomId = record.roomId;
        const entryId = "entryId" in record ? record.entryId : "";
        const taskId = Number(key.slice("tool:".length));
        const byTask = Number.isFinite(taskId) && selectedTasks.has(taskId);
        const byEntry =
          selectedRooms.has(roomId) && entryId.length > 0 && exportedEntries.has(Number(entryId));
        if (byTask || byEntry) addDocument(doc);
      }
      const employeeIds = new Set<string>();
      for (const id of selectedWorks) {
        const work = workValues.get(id);
        if (work !== undefined && work.employeeId.length > 0) employeeIds.add(work.employeeId);
      }
      for (const id of selectedRooms) {
        const room = roomValues.get(id);
        if (room === undefined) continue;
        for (const memberId of room.memberIds) employeeIds.add(memberId);
        for (const participantId of room.dmParticipantIds) {
          if (participantId !== "user") employeeIds.add(participantId);
        }
        if (room.employeeId.length > 0) employeeIds.add(room.employeeId);
      }
      for (const doc of session.approvals.values()) {
        const approval = valueOf<ApprovalRecord>(doc);
        if (selectedWorks.has(approval.workId) || selectedRoots.has(approval.rootWorkId)) employeeIds.add(approval.employeeId);
      }
      for (const employeeId of employeeIds) {
        const doc = session.employees.get(employeeId);
        if (doc === undefined) missing.push({ kind: "employee", id: employeeId, reason: "not-found" });
        else addDocument(doc);
      }
      const workContextIds = new Set<string>();
      for (const id of selectedWorks) {
        const work = workValues.get(id);
        if (work !== undefined && work.workContextId.length > 0) workContextIds.add(work.workContextId);
      }
      for (const id of selectedRooms) {
        const room = roomValues.get(id);
        if (room !== undefined && room.workContextId.length > 0) workContextIds.add(room.workContextId);
      }
      for (const contextId of workContextIds) {
        const doc = session.workContexts.get(contextId);
        if (doc === undefined) missing.push({ kind: "work-context", id: contextId, reason: "not-found" });
        else addDocument(doc);
      }
      for (const doc of session.skills.values()) addDocument(doc);
      for (const doc of session.mcps.values()) addDocument(redactMcpDocument(doc));
      // Every conversation and task document of the selected execution scope
      // travels with the export; unrelated scopes never do.
      for (const conversationId of selectedConversations) {
        for (const doc of await scanDocuments(runtime, undefined, {
          kind: "conversation",
          conversationId: conversationId as ConversationId,
        })) {
          addDocument(doc);
        }
      }
      for (const taskId of selectedTasks) {
        for (const doc of await scanDocuments(runtime, undefined, { kind: "task", taskId: taskId as TaskId })) {
          addDocument(doc);
        }
      }

      const snapshot: SessionSnapshot = {
        format: "emit.session-debug",
        schemaVersion: 1,
        capturedAt: Date.now(),
        scope,
        conversations: [...exportedConversations.values()].sort((left, right) => left.id - right.id),
        entries: [...exportedEntries.values()].sort((left, right) => left.id - right.id),
        tasks: tasks
          .filter((task) => selectedTasks.has(task.id))
          .sort((left, right) => left.id - right.id),
        submissions: [...new Map(submissions.map((record) => [record.id, record])).values()].sort(
          (left, right) => left.id - right.id,
        ),
        documents: documents.sort((left, right) => left.record.id - right.record.id),
        artifacts: [],
        missing,
        redaction: { marker: REDACTION_MARKER, applied: true },
      };

      const artifactRequests = collectArtifactRequests(snapshot.entries);
      return { snapshot, artifactRequests };
    }, runtime.ctx);
  }

  /** Materialize every session document this process can scan. */
  async #readSessionDocuments(): Promise<SessionDocuments> {
    const runtime = this.#runtime;
    const byKind = async (kind: string): Promise<StoredDocument[]> =>
      scanDocuments(runtime, kind, { kind: "session" });
    const [apps, rooms, works, approvals, employees, workContexts, collaborations, mailFlags, mailReceipts, messageReceipts, mutationReceipts, skills, mcps] =
      await Promise.all([
        byKind(AppDoc.definition.kind),
        byKind(RoomDoc.definition.kind),
        byKind(WorkDoc.definition.kind),
        byKind(ApprovalDoc.definition.kind),
        byKind(EmployeeDoc.definition.kind),
        byKind(WorkContextDoc.definition.kind),
        byKind(CollaborationDoc.definition.kind),
        byKind(MailFlagDoc.definition.kind),
        byKind(MailSendReceiptDoc.definition.kind),
        byKind(MessageSendReceiptDoc.definition.kind),
        byKind(WorkContextMutationReceiptDoc.definition.kind),
        byKind(SkillDoc.definition.kind),
        byKind(McpDoc.definition.kind),
      ]);
    const keyed = (documents: StoredDocument[]): Map<string, StoredDocument> => {
      const map = new Map<string, StoredDocument>();
      for (const doc of documents) {
        const key = doc.record.key ?? (doc.value as { id?: unknown }).id;
        if (typeof key === "string" && key.length > 0) map.set(key, doc);
      }
      return map;
    };
    return {
      app: apps[0],
      rooms: keyed(rooms),
      works: keyed(works),
      approvals: keyed(approvals),
      employees: keyed(employees),
      workContexts: keyed(workContexts),
      collaborations: keyed(collaborations),
      mailFlags: keyed(mailFlags),
      mailReceipts: keyed(mailReceipts),
      messageReceipts: keyed(messageReceipts),
      mutationReceipts: keyed(mutationReceipts),
      skills: keyed(skills),
      mcps: keyed(mcps),
    };
  }

  /** Read every available spill file after the durable barrier. */
  async #readArtifacts(requests: ArtifactRequest[]): Promise<ExportedArtifact[]> {
    const root = await realpath(tmpdir());
    const artifacts: ExportedArtifact[] = [];
    for (const request of requests) {
      artifacts.push(await readArtifact(request, root));
    }
    return artifacts;
  }

  /** Lazily create the private, process-owned export directory. */
  async #ensureDirectory(): Promise<string> {
    if (this.#directory !== undefined) return this.#directory;
    const directory = await mkdtemp(join(tmpdir(), "emit-session-exports-"));
    this.#directory = directory;
    return directory;
  }

  /** Stream one snapshot to its private file and register the receipt. */
  async #persist(snapshot: SessionSnapshot): Promise<SessionExportReceiptDTO> {
    const directory = await this.#ensureDirectory();
    const id = randomUUID();
    const filename = `emit-session-${id}.json`;
    const finalPath = join(directory, filename);
    const temporaryPath = join(directory, `.emit-session-${id}.json.tmp`);
    try {
      await writeSnapshotFile(temporaryPath, snapshot);
      await rename(temporaryPath, finalPath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw new SessionExportError(
        500,
        apiMessages.sessionExportFailed(error instanceof Error ? error.message : String(error)),
      );
    }
    const info = await stat(finalPath);
    this.#registry.set(id, { path: finalPath, filename });
    return {
      id,
      filename,
      path: finalPath,
      bytes: info.size,
      capturedAt: snapshot.capturedAt,
      downloadUrl: `/api/session-exports/${id}`,
    };
  }
}

/**
 * Stream a snapshot as one JSON document with per-record backpressure.
 *
 * Each record is redacted and serialized on its own, so no second whole-export
 * JSON string is ever allocated and no field is silently capped.
 */
async function writeSnapshotFile(path: string, snapshot: SessionSnapshot): Promise<void> {
  const stream = createWriteStream(path, { flags: "wx", mode: 0o600 });
  // The stream's own error stays observed for its whole lifetime, so a failure
  // between two writes can never surface as an unhandled `error` event.
  const failure = new Promise<never>((_resolve, reject) => {
    stream.once("error", reject);
  });
  try {
    const write = (chunk: string): Promise<void> => Promise.race([writeChunk(stream, chunk), failure]);
    await write(`{"format":"emit.session-debug","schemaVersion":1,"capturedAt":${snapshot.capturedAt}`);
    await write(`,"scope":${JSON.stringify(snapshot.scope)}`);
    await writeRecords(write, "conversations", snapshot.conversations);
    await writeRecords(write, "entries", snapshot.entries);
    await writeRecords(write, "tasks", snapshot.tasks);
    await writeRecords(write, "submissions", snapshot.submissions);
    await writeRecords(write, "documents", snapshot.documents);
    await writeRecords(write, "artifacts", snapshot.artifacts);
    await writeRecords(write, "missing", snapshot.missing);
    await write(`,"redaction":${JSON.stringify(snapshot.redaction)}}`);
    await Promise.race([
      new Promise<void>((resolve, reject) => {
        stream.end((error?: Error | null) => (error == null ? resolve() : reject(error)));
      }),
      failure,
    ]);
  } catch (error) {
    stream.destroy();
    throw error;
  }
}

async function writeRecords(
  write: (chunk: string) => Promise<void>,
  key: string,
  records: readonly unknown[],
): Promise<void> {
  await write(`,"${key}":[`);
  for (const [index, record] of records.entries()) {
    if (index > 0) await write(",");
    await write(JSON.stringify(redactJsonValue(record) ?? null));
  }
  await write("]");
}

function writeChunk(stream: WriteStream, chunk: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      stream.off("error", onError);
      reject(error);
    };
    stream.once("error", onError);
    if (stream.write(chunk)) {
      stream.off("error", onError);
      resolve();
      return;
    }
    stream.once("drain", () => {
      stream.off("error", onError);
      resolve();
    });
  });
}

/** Shell spill paths from captured tool results; never scraped from free text. */
function collectArtifactRequests(entries: readonly EntryRecord[]): ArtifactRequest[] {
  const requests: ArtifactRequest[] = [];
  const successPrefix = renderToolResult("shell-exit-spill", { spillPath: "" });
  const failurePrefix = renderToolResult("shell-failed-spill", { spillPath: "" });
  const legacyPrefixes = ["完整输出已写入 ", "完整输出: "];
  for (const entry of entries) {
    for (const message of entry.model ?? []) {
      if (message.role !== "toolResult" || message.toolName !== "run_shell") continue;
      const details = (message as { details?: { fullOutputPath?: unknown } }).details;
      if (typeof details?.fullOutputPath === "string" && details.fullOutputPath.length > 0) {
        requests.push({ entryId: entry.id, toolCallId: message.toolCallId, path: details.fullOutputPath });
        continue;
      }
      const diagnostics = (entry.data as { diagnostics?: unknown } | undefined)?.diagnostics;
      if (!Array.isArray(diagnostics)) continue;
      for (const diagnostic of diagnostics) {
        if (typeof diagnostic !== "object" || diagnostic === null) continue;
        const record = diagnostic as { code?: unknown; message?: unknown };
        if (record.code !== "full_output" || typeof record.message !== "string") continue;
        const path = spillPathFromDiagnostic(record.message, [successPrefix, failurePrefix, ...legacyPrefixes]);
        if (path === undefined) {
          requests.push({
            entryId: entry.id,
            toolCallId: message.toolCallId,
            path: record.message,
            unparsed: true,
          });
          continue;
        }
        requests.push({ entryId: entry.id, toolCallId: message.toolCallId, path });
      }
    }
  }
  return requests;
}

/** The path after one exact rendered prefix; anything else is not a path. */
function spillPathFromDiagnostic(message: string, prefixes: readonly string[]): string | undefined {
  for (const prefix of prefixes) {
    if (prefix.length > 0 && message.startsWith(prefix)) {
      const path = message.slice(prefix.length).trim();
      return path.length > 0 ? path : undefined;
    }
  }
  return undefined;
}

/** Read one spilled shell output, only from the execution environment's own temp layout. */
async function readArtifact(request: ArtifactRequest, tempRoot: string): Promise<ExportedArtifact> {
  const base = { entryId: request.entryId, toolCallId: request.toolCallId, path: request.path, readAt: Date.now() };
  const unsafe = (reason: string): ExportedArtifact => ({ ...base, status: "unsafe", reason });
  if (request.unparsed === true) {
    return { ...base, status: "unparsed", reason: "the recorded full-output diagnostic carries no parseable path" };
  }
  if (!isAbsolute(request.path)) return unsafe("the path is not absolute");
  const parent = dirname(request.path);
  if (!/^tmp-.{6}$/.test(basename(parent))) return unsafe("the parent directory is not an execution-environment temp directory");
  let parentReal: string;
  try {
    parentReal = await realpath(parent);
  } catch {
    return { ...base, status: "missing", reason: "the spill directory no longer exists" };
  }
  if (parentReal !== parent || dirname(parentReal) !== tempRoot) {
    return unsafe("the spill directory is not a direct child of the OS temporary directory");
  }
  const parentStat = await lstat(parent).catch(() => undefined);
  if (parentStat === undefined || !parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    return unsafe("the spill directory is not a regular directory");
  }
  if (!/^pi-output-[0-9a-fA-F-]{36}\.log$/.test(basename(request.path))) {
    return unsafe("the filename does not follow the execution environment's spill convention");
  }
  const linkStat = await lstat(request.path).catch(() => undefined);
  if (linkStat === undefined) return { ...base, status: "missing", reason: "the spill file no longer exists" };
  if (!linkStat.isFile() || linkStat.isSymbolicLink()) return unsafe("the spill path is not a regular file");

  let handle;
  try {
    handle = await open(request.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ...base, status: "missing", reason: "the spill file no longer exists" };
    if (code === "ELOOP") return unsafe("the spill path is a symbolic link");
    return { ...base, status: "read-error", reason: error instanceof Error ? error.message : String(error) };
  }
  try {
    const openedStat = await handle.stat();
    if (!openedStat.isFile() || openedStat.dev !== linkStat.dev || openedStat.ino !== linkStat.ino) {
      return unsafe("the opened file is not the validated regular file");
    }
    const buffer = await handle.readFile();
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      return {
        ...base,
        status: "included",
        encoding: "utf8",
        bytes: buffer.byteLength,
        content: redactApprovalText(text),
      };
    } catch {
      return {
        ...base,
        status: "included",
        encoding: "base64",
        sensitive: true,
        bytes: buffer.byteLength,
        content: buffer.toString("base64"),
      };
    }
  } catch (error) {
    return { ...base, status: "read-error", reason: error instanceof Error ? error.message : String(error) };
  } finally {
    await handle.close().catch(() => undefined);
  }
}
