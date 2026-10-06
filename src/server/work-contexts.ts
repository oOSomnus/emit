/**
 * Work contexts: the first-class object a conversation is fixed to.
 *
 * A work context owns the goal, instructions, authorized directories,
 * references, and the notes employees explicitly share inside it. Rooms,
 * runs, and approvals never own directories themselves: a run snapshots the
 * work's directory version, and every later check compares against the work
 * document, so two conversations of the same work share one authorization and
 * conversations of different works never leak into each other.
 *
 * Validation happens before the transaction (filesystem work), and the
 * transaction re-checks the version it was given, so a concurrent save is a
 * 409 rather than a lost update.
 */

import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, sep } from "node:path";
import type { ConversationId, EntryId, Tx } from "@earendil-works/pi-durable";
import {
  ConversationContextDoc,
  EmployeeDoc,
  RoomDoc,
  RoomMessageEntry,
  WorkContextDoc,
  WorkDoc,
  type DirectoryConfigRecord,
  type EmployeeRecord,
  type RoomRecord,
  type WorkContextRecord,
  type WorkNoteRecord,
  type WorkRecord,
  type WorkResourceRecord,
} from "./documents.ts";
import type { EmitRuntime } from "./runtime.ts";
import { AppError, type AppText } from "./app-text.ts";
import { appMessages } from "./messages.ts";
import type {
  WorkContextDTO,
  WorkContextDraftDTO,
  WorkContextPatchDTO,
  WorkNoteDTO,
  WorkNoteResponseDTO,
  WorkNoteSummaryDTO,
  WorkResourceDTO,
  WorkResourceDraftDTO,
} from "../shared/contracts.ts";

/** Input limits, enforced as 400s rather than silent truncation. */
export const WORK_CONTEXT_LIMITS = {
  name: 120,
  goal: 2_000,
  instructions: 4_000,
  resources: 40,
  resourceName: 120,
  resourceLocation: 2_048,
  notes: 100,
  noteTitle: 120,
  noteBody: 16_000,
} as const;

/** The uniform failure of the work-context surface. */
export class WorkContextError extends AppError {
  constructor(
    readonly status: 400 | 404 | 409,
    message: AppText,
  ) {
    super(message);
  }
}

function invalid(message: AppText): WorkContextError {
  return new WorkContextError(400, message);
}

// --------------------------------------------------------------- directories

async function canonicalDirectoryPath(path: string): Promise<string> {
  const trimmed = path.trim();
  if (trimmed.length === 0 || !isAbsolute(trimmed)) {
    throw invalid(appMessages.workContexts.directoryNotAbsolutePath(trimmed));
  }
  try {
    const canonical = await realpath(trimmed);
    const info = await stat(canonical);
    if (!info.isDirectory()) throw invalid(appMessages.workContexts.directoryNotADirectory(trimmed));
    return canonical;
  } catch (error) {
    if (error instanceof WorkContextError) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw invalid(appMessages.workContexts.directoryUnreadable(trimmed, reason));
  }
}

/**
 * Validate and canonicalize one directory draft.
 *
 * Absolute paths only, each root realpath'd, duplicates dropped in order, a
 * non-empty group must choose a default inside it, and an empty group has an
 * empty default. The version starts at 1 and is bumped by the caller.
 */
export async function canonicalizeDirectories(draft: unknown): Promise<DirectoryConfigRecord> {
  if (typeof draft !== "object" || draft === null || Array.isArray(draft)) {
    throw invalid(appMessages.workContexts.directoriesNotAnObject);
  }
  const value = draft as Record<string, unknown>;
  if (!Array.isArray(value.paths)) throw invalid(appMessages.workContexts.directoryPathsNotAnArray);
  if (typeof value.defaultPath !== "string") {
    throw invalid(appMessages.workContexts.defaultDirectoryNotAString);
  }

  const paths: string[] = [];
  const seen = new Set<string>();
  for (const item of value.paths) {
    if (typeof item !== "string") throw invalid(appMessages.workContexts.directoryPathNotAString);
    const path = await canonicalDirectoryPath(item);
    if (seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }

  const defaultInput = value.defaultPath.trim();
  if (paths.length === 0) {
    if (defaultInput.length > 0) {
      throw invalid(appMessages.workContexts.defaultDirectoryNotAuthorized(defaultInput));
    }
    return { paths, defaultPath: "", version: 1 };
  }
  if (defaultInput.length === 0) throw invalid(appMessages.workContexts.chooseDefaultDirectory);
  const defaultPath = await canonicalDirectoryPath(defaultInput);
  if (!seen.has(defaultPath)) {
    throw invalid(appMessages.workContexts.defaultDirectoryNotAuthorized(defaultPath));
  }
  return { paths, defaultPath, version: 1 };
}

function directoriesEqual(a: DirectoryConfigRecord, b: DirectoryConfigRecord): boolean {
  return (
    a.defaultPath === b.defaultPath &&
    a.paths.length === b.paths.length &&
    a.paths.every((path, index) => path === b.paths[index])
  );
}

function insideDirectories(canonical: string, directories: DirectoryConfigRecord): boolean {
  return directories.paths.some(
    (root) => canonical === root || canonical.startsWith(root.endsWith(sep) ? root : `${root}${sep}`),
  );
}

// ---------------------------------------------------------------- resources

async function prepareResources(
  current: WorkResourceRecord[],
  draft: unknown,
  directories: DirectoryConfigRecord,
): Promise<WorkResourceRecord[]> {
  if (!Array.isArray(draft)) throw invalid(appMessages.workContexts.resourcesNotAnArray);
  if (draft.length > WORK_CONTEXT_LIMITS.resources) {
    throw invalid(appMessages.workContexts.resourceLimit(WORK_CONTEXT_LIMITS.resources));
  }
  const existing = new Map(current.map((resource) => [resource.id, resource]));
  const resources: WorkResourceRecord[] = [];
  const seenIds = new Set<string>();
  for (const item of draft) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw invalid(appMessages.workContexts.resourceNotAnObject);
    }
    const value = item as WorkResourceDraftDTO;
    if (value.kind !== "file" && value.kind !== "url") {
      throw invalid(appMessages.workContexts.resourceKindInvalid);
    }
    if (typeof value.name !== "string" || value.name.trim().length === 0) {
      throw invalid(appMessages.workContexts.resourceNameRequired);
    }
    if (value.name.length > WORK_CONTEXT_LIMITS.resourceName) {
      throw invalid(appMessages.workContexts.resourceNameTooLong(WORK_CONTEXT_LIMITS.resourceName));
    }
    if (typeof value.location !== "string" || value.location.trim().length === 0) {
      throw invalid(appMessages.workContexts.resourceLocationRequired);
    }
    if (value.location.length > WORK_CONTEXT_LIMITS.resourceLocation) {
      throw invalid(appMessages.workContexts.resourceLocationTooLong(WORK_CONTEXT_LIMITS.resourceLocation));
    }
    let id = value.id;
    if (id !== undefined) {
      if (typeof id !== "string" || id.length === 0) throw invalid(appMessages.workContexts.resourceIdUnknown(String(id)));
      if (seenIds.has(id)) throw invalid(appMessages.workContexts.resourceIdDuplicate(id));
      if (!existing.has(id)) throw invalid(appMessages.workContexts.resourceIdUnknown(id));
    } else {
      id = `res_${randomUUID()}`;
    }
    seenIds.add(id);
    const name = value.name.trim();
    const location = value.location.trim();
    if (value.kind === "url") {
      let parsed: URL;
      try {
        parsed = new URL(location);
      } catch {
        throw invalid(appMessages.workContexts.resourceUrlInvalid(location));
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw invalid(appMessages.workContexts.resourceUrlInvalid(location));
      }
      resources.push({ id, kind: "url", name, location: parsed.href });
      continue;
    }
    const canonical = await canonicalFileResource(location);
    if (!insideDirectories(canonical, directories)) {
      throw invalid(appMessages.workContexts.resourceFileOutsideDirectories(location));
    }
    resources.push({ id, kind: "file", name, location: canonical });
  }
  return resources;
}

/** Canonicalize a file resource: it must exist and be a regular file. */
async function canonicalFileResource(location: string): Promise<string> {
  if (!isAbsolute(location)) throw invalid(appMessages.workContexts.resourceFileOutsideDirectories(location));
  try {
    const canonical = await realpath(location);
    const info = await stat(canonical);
    if (!info.isFile()) throw invalid(appMessages.workContexts.resourceFileNotAFile(location));
    return canonical;
  } catch (error) {
    if (error instanceof WorkContextError) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw invalid(appMessages.workContexts.resourceFileMissing(location, reason));
  }
}

function resourcesEqual(a: WorkResourceRecord[], b: WorkResourceRecord[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (resource, index) =>
        resource.id === b[index]!.id &&
        resource.kind === b[index]!.kind &&
        resource.name === b[index]!.name &&
        resource.location === b[index]!.location,
    )
  );
}

// ------------------------------------------------------------ read and DTOs

export function toWorkResourceDTO(record: WorkResourceRecord): WorkResourceDTO {
  return { id: record.id, kind: record.kind, name: record.name, location: record.location };
}

export function toWorkNoteDTO(record: WorkNoteRecord): WorkNoteDTO {
  return {
    id: record.id,
    title: record.title,
    body: record.body,
    authorId: record.authorId,
    sourceRoomId: record.sourceRoomId,
    sourceEntryId: record.sourceEntryId,
    sourceWorkId: record.sourceWorkId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function toWorkNoteSummary(record: WorkNoteRecord): WorkNoteSummaryDTO {
  const summary = toWorkNoteDTO(record);
  Reflect.deleteProperty(summary, "body");
  return summary;
}

export function toWorkContextDTO(record: WorkContextRecord): WorkContextDTO {
  return {
    id: record.id,
    name: record.name,
    goal: record.goal,
    instructions: record.instructions,
    directories: {
      paths: [...record.directories.paths],
      defaultPath: record.directories.defaultPath,
      version: record.directories.version,
    },
    resources: record.resources.map(toWorkResourceDTO),
    notes: record.notes.map(toWorkNoteSummary),
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export async function findWorkContext(runtime: EmitRuntime, id: string): Promise<WorkContextRecord | undefined> {
  return runtime.readFamily(WorkContextDoc, id, { id });
}

export async function listWorkContexts(runtime: EmitRuntime): Promise<WorkContextRecord[]> {
  const members = await runtime.listFamily(WorkContextDoc, (id) => ({ id }));
  return members.map((member) => member.value).sort((a, b) => b.updatedAt - a.updatedAt);
}

function plainWorkContext(record: WorkContextRecord): WorkContextRecord {
  return {
    ...record,
    directories: {
      paths: [...record.directories.paths],
      defaultPath: record.directories.defaultPath,
      version: record.directories.version,
    },
    resources: record.resources.map((resource) => ({ ...resource })),
    notes: record.notes.map((note) => ({ ...note })),
  };
}

// ------------------------------------------------------------- create/update

export async function createWorkContext(
  runtime: EmitRuntime,
  draft: WorkContextDraftDTO,
): Promise<WorkContextRecord> {
  if (typeof draft !== "object" || draft === null) throw invalid(appMessages.workContexts.patchNotAnObject);
  if (typeof draft.name !== "string" || draft.name.trim().length === 0) {
    throw invalid(appMessages.workContexts.nameRequired);
  }
  if (draft.name.length > WORK_CONTEXT_LIMITS.name) {
    throw invalid(appMessages.workContexts.nameTooLong(WORK_CONTEXT_LIMITS.name));
  }
  const goal = typeof draft.goal === "string" ? draft.goal : "";
  if (goal.length > WORK_CONTEXT_LIMITS.goal) {
    throw invalid(appMessages.workContexts.goalTooLong(WORK_CONTEXT_LIMITS.goal));
  }
  const instructions = typeof draft.instructions === "string" ? draft.instructions : "";
  if (instructions.length > WORK_CONTEXT_LIMITS.instructions) {
    throw invalid(appMessages.workContexts.instructionsTooLong(WORK_CONTEXT_LIMITS.instructions));
  }
  const directories =
    draft.directories === undefined
      ? { paths: [], defaultPath: "", version: 1 }
      : await canonicalizeDirectories(draft.directories);
  const resources =
    draft.resources === undefined ? [] : await prepareResources([], draft.resources, directories);

  const id = `ctx_${randomUUID()}`;
  const now = Date.now();
  const record: WorkContextRecord = {
    id,
    name: draft.name.trim(),
    goal,
    instructions,
    directories,
    resources,
    notes: [],
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  const saved = await runtime.updateFamily(WorkContextDoc, id, { id }, (doc) => {
    Object.assign(doc, plainWorkContext(record));
  });
  runtime.emit({ type: "work-context", workContext: toWorkContextDTO(saved) });
  return saved;
}

/** The validated result of one patch, ready to apply inside the transaction. */
type PreparedPatch = {
  name?: string;
  goal?: string;
  instructions?: string;
  directories?: DirectoryConfigRecord;
  resources?: WorkResourceRecord[];
};

async function preparePatch(current: WorkContextRecord, patch: WorkContextPatchDTO): Promise<PreparedPatch> {
  if (typeof patch !== "object" || patch === null) throw invalid(appMessages.workContexts.patchNotAnObject);
  const prepared: PreparedPatch = {};
  if (patch.name !== undefined) {
    if (typeof patch.name !== "string" || patch.name.trim().length === 0) {
      throw invalid(appMessages.workContexts.nameRequired);
    }
    if (patch.name.length > WORK_CONTEXT_LIMITS.name) {
      throw invalid(appMessages.workContexts.nameTooLong(WORK_CONTEXT_LIMITS.name));
    }
    prepared.name = patch.name.trim();
  }
  if (patch.goal !== undefined) {
    if (typeof patch.goal !== "string") throw invalid(appMessages.workContexts.patchNotAnObject);
    if (patch.goal.length > WORK_CONTEXT_LIMITS.goal) {
      throw invalid(appMessages.workContexts.goalTooLong(WORK_CONTEXT_LIMITS.goal));
    }
    prepared.goal = patch.goal;
  }
  if (patch.instructions !== undefined) {
    if (typeof patch.instructions !== "string") throw invalid(appMessages.workContexts.patchNotAnObject);
    if (patch.instructions.length > WORK_CONTEXT_LIMITS.instructions) {
      throw invalid(appMessages.workContexts.instructionsTooLong(WORK_CONTEXT_LIMITS.instructions));
    }
    prepared.instructions = patch.instructions;
  }
  const directories =
    patch.directories === undefined
      ? current.directories
      : await canonicalizeDirectories(patch.directories);
  if (patch.directories !== undefined) prepared.directories = directories;
  if (patch.resources !== undefined) {
    prepared.resources = await prepareResources(current.resources, patch.resources, directories);
  } else if (!directoriesEqual(directories, current.directories)) {
    // A directory change must re-verify the retained file references in the
    // same save, so a removed root cannot leave a dangling authorization.
    prepared.resources = await prepareResources(current.resources, current.resources, directories);
  }
  return prepared;
}

export async function updateWorkContext(
  runtime: EmitRuntime,
  id: string,
  patch: WorkContextPatchDTO,
): Promise<WorkContextRecord> {
  if (typeof patch !== "object" || patch === null || !Number.isInteger(patch.expectedVersion)) {
    throw invalid(appMessages.workContexts.expectedVersionNotAnInteger);
  }
  const current = await findWorkContext(runtime, id);
  if (current === undefined) throw new WorkContextError(404, appMessages.workContexts.notFound(id));
  if (current.version !== patch.expectedVersion) {
    throw new WorkContextError(409, appMessages.workContexts.versionConflict(current.version));
  }
  const prepared = await preparePatch(current, patch);
  const expected = patch.expectedVersion;
  const updated = await runtime.updateFamily(WorkContextDoc, id, { id }, (doc) => {
    if (doc.version !== expected) {
      throw new WorkContextError(409, appMessages.workContexts.versionConflict(doc.version));
    }
    let changed = false;
    if (prepared.name !== undefined && doc.name !== prepared.name) {
      doc.name = prepared.name;
      changed = true;
    }
    if (prepared.goal !== undefined && doc.goal !== prepared.goal) {
      doc.goal = prepared.goal;
      changed = true;
    }
    if (prepared.instructions !== undefined && doc.instructions !== prepared.instructions) {
      doc.instructions = prepared.instructions;
      changed = true;
    }
    if (prepared.directories !== undefined && !directoriesEqual(doc.directories, prepared.directories)) {
      doc.directories = {
        paths: [...prepared.directories.paths],
        defaultPath: prepared.directories.defaultPath,
        version: doc.directories.version + 1,
      };
      changed = true;
    }
    if (prepared.resources !== undefined && !resourcesEqual(doc.resources, prepared.resources)) {
      doc.resources = prepared.resources.map((resource) => ({ ...resource }));
      changed = true;
    }
    if (changed) {
      doc.version += 1;
      doc.updatedAt = Date.now();
    }
  });
  runtime.emit({ type: "work-context", workContext: toWorkContextDTO(updated) });
  return updated;
}

// -------------------------------------------------------------------- notes

function validateNoteText(title: unknown, body: unknown): { title: string; body: string } {
  if (typeof title !== "string" || title.trim().length === 0) {
    throw invalid(appMessages.workContexts.noteTitleRequired);
  }
  if (title.length > WORK_CONTEXT_LIMITS.noteTitle) {
    throw invalid(appMessages.workContexts.noteTitleTooLong(WORK_CONTEXT_LIMITS.noteTitle));
  }
  if (typeof body !== "string" || body.trim().length === 0) {
    throw invalid(appMessages.workContexts.noteBodyRequired);
  }
  if (body.length > WORK_CONTEXT_LIMITS.noteBody) {
    throw invalid(appMessages.workContexts.noteBodyTooLong(WORK_CONTEXT_LIMITS.noteBody));
  }
  return { title: title.trim(), body };
}

export function findWorkNote(record: WorkContextRecord, noteId: string): WorkNoteRecord | undefined {
  return record.notes.find((note) => note.id === noteId);
}

/** One note create, with the real source the caller already verified. */
export type WorkNoteSource = {
  authorId: string;
  sourceRoomId: string;
  sourceEntryId: string;
  sourceWorkId: string;
};

/** Note mutation input; validation happens before or inside the transaction. */
export type WorkNoteMutationInput = {
  title: unknown;
  body: unknown;
  expectedVersion: number;
} & WorkNoteSource;

/**
 * Create one note inside an open transaction.
 *
 * The work context must exist, its version must equal `expectedVersion`, and
 * the caller has already established that the source is a real message of this
 * work. The record version is bumped here so the receipt written beside it in
 * the same commit names the version it belongs to.
 */
export async function createWorkNoteIn(
  tx: Tx,
  workContextId: string,
  input: WorkNoteMutationInput,
): Promise<{ note: WorkNoteRecord; version: number }> {
  const { title, body } = validateNoteText(input.title, input.body);
  const doc = await tx.doc(WorkContextDoc, workContextId, { id: workContextId });
  if (doc.createdAt === 0) throw new WorkContextError(404, appMessages.workContexts.notFound(workContextId));
  if (doc.notes.length >= WORK_CONTEXT_LIMITS.notes) {
    throw invalid(appMessages.workContexts.noteLimit(WORK_CONTEXT_LIMITS.notes));
  }
  if (!Number.isInteger(input.expectedVersion) || doc.version !== input.expectedVersion) {
    throw new WorkContextError(409, appMessages.workContexts.versionConflict(doc.version));
  }
  const now = Date.now();
  const note: WorkNoteRecord = {
    id: `note_${randomUUID()}`,
    title,
    body,
    authorId: input.authorId,
    sourceRoomId: input.sourceRoomId,
    sourceEntryId: input.sourceEntryId,
    sourceWorkId: input.sourceWorkId,
    createdAt: now,
    updatedAt: now,
  };
  doc.notes = [...doc.notes, { ...note }];
  doc.version += 1;
  doc.updatedAt = now;
  return { note, version: doc.version };
}

/** Update one note inside an open transaction; the id and creation time stay. */
export async function updateWorkNoteIn(
  tx: Tx,
  workContextId: string,
  noteId: string,
  input: WorkNoteMutationInput,
): Promise<{ note: WorkNoteRecord; version: number }> {
  const { title, body } = validateNoteText(input.title, input.body);
  const doc = await tx.doc(WorkContextDoc, workContextId, { id: workContextId });
  if (doc.createdAt === 0) throw new WorkContextError(404, appMessages.workContexts.notFound(workContextId));
  const existing = doc.notes.find((note) => note.id === noteId);
  if (existing === undefined) throw new WorkContextError(404, appMessages.workContexts.noteNotFound(noteId));
  if (!Number.isInteger(input.expectedVersion) || doc.version !== input.expectedVersion) {
    throw new WorkContextError(409, appMessages.workContexts.versionConflict(doc.version));
  }
  existing.title = title;
  existing.body = body;
  existing.authorId = input.authorId;
  existing.sourceRoomId = input.sourceRoomId;
  existing.sourceEntryId = input.sourceEntryId;
  existing.sourceWorkId = input.sourceWorkId;
  existing.updatedAt = Date.now();
  doc.version += 1;
  doc.updatedAt = Date.now();
  return { note: JSON.parse(JSON.stringify(existing)) as WorkNoteRecord, version: doc.version };
}

export async function createWorkNote(
  runtime: EmitRuntime,
  workContextId: string,
  input: WorkNoteMutationInput,
): Promise<WorkNoteResponseDTO> {
  const result = await runtime.harness.commit(
    (tx) => createWorkNoteIn(tx, workContextId, input),
    runtime.ctx,
  );
  const updated = await findWorkContext(runtime, workContextId);
  if (updated === undefined) throw new WorkContextError(404, appMessages.workContexts.notFound(workContextId));
  runtime.emit({ type: "work-context", workContext: toWorkContextDTO(updated) });
  return { note: toWorkNoteDTO(result.note), workContext: toWorkContextDTO(updated) };
}

export async function updateWorkNote(
  runtime: EmitRuntime,
  workContextId: string,
  noteId: string,
  input: WorkNoteMutationInput,
): Promise<WorkNoteResponseDTO> {
  const result = await runtime.harness.commit(
    (tx) => updateWorkNoteIn(tx, workContextId, noteId, input),
    runtime.ctx,
  );
  const updated = await findWorkContext(runtime, workContextId);
  if (updated === undefined) throw new WorkContextError(404, appMessages.workContexts.notFound(workContextId));
  runtime.emit({ type: "work-context", workContext: toWorkContextDTO(updated) });
  return { note: toWorkNoteDTO(result.note), workContext: toWorkContextDTO(updated) };
}

export async function deleteWorkNote(
  runtime: EmitRuntime,
  workContextId: string,
  noteId: string,
  expectedVersion: number,
): Promise<WorkContextRecord> {
  const current = await findWorkContext(runtime, workContextId);
  if (current === undefined) throw new WorkContextError(404, appMessages.workContexts.notFound(workContextId));
  if (findWorkNote(current, noteId) === undefined) {
    throw new WorkContextError(404, appMessages.workContexts.noteNotFound(noteId));
  }
  if (!Number.isInteger(expectedVersion) || current.version !== expectedVersion) {
    throw new WorkContextError(409, appMessages.workContexts.versionConflict(current.version));
  }
  const updated = await runtime.updateFamily(WorkContextDoc, workContextId, { id: workContextId }, (doc) => {
    if (doc.version !== expectedVersion) {
      throw new WorkContextError(409, appMessages.workContexts.versionConflict(doc.version));
    }
    doc.notes = doc.notes.filter((entry) => entry.id !== noteId);
    doc.version += 1;
    doc.updatedAt = Date.now();
  });
  runtime.emit({ type: "work-context", workContext: toWorkContextDTO(updated) });
  return updated;
}

/**
 * Resolve a user-provided note source against the real transcript.
 *
 * The source must be a message of a conversation fixed to this very work
 * context; the work id recorded is the work that produced the message, so the
 * note keeps a verifiable provenance.
 */
export async function resolveUserNoteSource(
  runtime: EmitRuntime,
  workContextId: string,
  source: { roomId: string; entryId: string } | undefined,
): Promise<WorkNoteSource> {
  const authorId = "user";
  if (source === undefined) {
    return { authorId, sourceRoomId: "", sourceEntryId: "", sourceWorkId: "" };
  }
  if (typeof source.roomId !== "string" || typeof source.entryId !== "string" || source.roomId.length === 0) {
    throw invalid(appMessages.workContexts.noteSourceInvalid);
  }
  const room = await runtime.readFamily(RoomDoc, source.roomId, { id: source.roomId });
  if (room === undefined || room.workContextId !== workContextId) {
    throw invalid(appMessages.workContexts.noteSourceInvalid);
  }
  const entry = await readRoomEntry(runtime, room, source.entryId);
  if (entry === undefined || !RoomMessageEntry.is(entry)) {
    throw invalid(appMessages.workContexts.noteSourceInvalid);
  }
  return {
    authorId,
    sourceRoomId: room.id,
    sourceEntryId: source.entryId,
    sourceWorkId: entry.data.workId,
  };
}

/** One transcript entry by decimal id, still committed and readable. */
async function readRoomEntry(runtime: EmitRuntime, room: RoomRecord, entryId: string) {
  if (entryId.length === 0 || !Number.isSafeInteger(Number(entryId)) || Number(entryId) <= 0) return undefined;
  const conversation = await runtime.harness.conversation(room.conversationId as ConversationId, runtime.ctx);
  if (conversation === undefined) return undefined;
  const page = await conversation.entries(
    { minEntryId: Number(entryId) as EntryId, maxEntryId: Number(entryId) as EntryId },
    1,
    undefined,
    runtime.ctx,
  );
  return page.items[0];
}

// -------------------------------------------------- tool-side authorization

export type ActiveWorkContext = {
  work: WorkRecord;
  workContext: WorkContextRecord;
  room: RoomRecord | undefined;
  employee: EmployeeRecord;
};

function isTerminalStatus(status: WorkRecord["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "stopped";
}

/**
 * The work context a tool call is allowed to act on.
 *
 * The binding is derived from the calling conversation — never from tool
 * arguments — and the employee must still be authorized in the room the work
 * belongs to: a channel member, a DM participant, a real To recipient of the
 * mail it came from, or the assignee of a delegation.
 */
export async function resolveActiveWorkContextForTool(
  runtime: EmitRuntime,
  conversationId: number,
): Promise<ActiveWorkContext> {
  const binding = await runtime.readConversationDoc(ConversationContextDoc, conversationId);
  if (binding === undefined || binding.workId.length === 0) {
    throw invalid(appMessages.workContexts.conversationNotBound);
  }
  const work = await runtime.readFamily(WorkDoc, binding.workId, { id: binding.workId });
  if (work === undefined) {
    throw new WorkContextError(404, appMessages.work.workNotFound(binding.workId));
  }
  if (isTerminalStatus(work.status)) throw invalid(appMessages.workContexts.workFinished);
  const employee = await runtime.readFamily(EmployeeDoc, work.employeeId, { id: work.employeeId });
  if (employee === undefined) {
    throw new WorkContextError(404, appMessages.workContexts.employeeNotFound(work.employeeId));
  }
  if (!employee.enabled) throw invalid(appMessages.workContexts.employeeDisabled(employee.name));
  const workContext = await findWorkContext(runtime, work.workContextId);
  if (workContext === undefined) {
    throw new WorkContextError(404, appMessages.workContexts.notFound(work.workContextId));
  }
  if (work.roomId.length === 0) {
    // A delegation is authorized by its own work record; there is no room.
    return { work, workContext, room: undefined, employee };
  }
  const room = await runtime.readFamily(RoomDoc, work.roomId, { id: work.roomId });
  if (room === undefined) throw invalid(appMessages.workContexts.conversationNotBound);
  if (room.kind === "channel") {
    if (!room.memberIds.includes(employee.id)) {
      throw invalid(appMessages.workContexts.channelMemberOnly(employee.name));
    }
  } else if (room.kind === "dm") {
    if (!room.dmParticipantIds.includes(employee.id)) {
      throw invalid(appMessages.workContexts.dmParticipantOnly);
    }
  } else {
    const entry = work.sourceEntryId.length > 0 ? await readRoomEntry(runtime, room, work.sourceEntryId) : undefined;
    const recipients = entry !== undefined && RoomMessageEntry.is(entry) ? entry.data.mail?.recipients ?? [] : [];
    if (!recipients.includes(employee.id)) {
      throw invalid(appMessages.workContexts.mailRecipientOnly(employee.name));
    }
  }
  return { work, workContext, room, employee };
}

/**
 * The immutable directory snapshot a new run of this work context inherits.
 *
 * The room id is the conversation the run starts from; the check is always
 * against the work context's directory version, never the room.
 */
export function workContextDirectorySnapshot(
  workContext: WorkContextRecord,
  roomId: string,
): {
  roomId: string;
  workContextId: string;
  version: number;
  paths: string[];
  defaultPath: string;
} {
  return {
    roomId,
    workContextId: workContext.id,
    version: workContext.directories.version,
    paths: [...workContext.directories.paths],
    defaultPath: workContext.directories.defaultPath,
  };
}

/** Read one work-context family member inside an open transaction. */
export async function readWorkContextIn(tx: Tx, id: string): Promise<WorkContextRecord> {
  const doc = await tx.doc(WorkContextDoc, id, { id });
  return JSON.parse(JSON.stringify(doc)) as WorkContextRecord;
}
