/**
 * Work enqueueing: the one place a queued run and its wake accounting are born.
 *
 * Every route that starts an employee — a channel message, a direct message, a
 * mail, a delegation — enqueues through here, so "the request was accepted",
 * "the employee will run", and "a cross-employee wake was paid for" are the
 * same commit. Callers resolve and validate recipients first and pass exactly
 * what they validated; this module opens no commit, emits no event, resolves
 * no recipient, and never talks to a model.
 */

import { randomUUID } from "node:crypto";
import type { ConversationId, Tx } from "@earendil-works/pi-durable";
import { CollaborationDoc, WorkDoc, type WorkDirectoryScopeRecord, type WorkRecord } from "./documents.ts";
import type { EmitRuntime } from "./runtime.ts";
import type { WorkDispatchTask } from "./work-dispatch.ts";
import { AppError } from "./app-text.ts";
import { appMessages } from "./messages.ts";

export type WorkKind = WorkRecord["kind"];

export type EnqueueWorksInput = {
  employeeIds: readonly string[];
  roomId: string;
  workContextId: string;
  intent: string;
  kind: WorkKind;
  sourceEntryId: string;
  parentWorkId: string;
  rootWorkId: string;
  depth: number;
  /** Conversation that owns the dispatch tasks; the room's, or the caller's for a delegation. */
  dispatchConversationId: number;
  directoryScope: WorkDirectoryScopeRecord;
  now: number;
  /** Commit a cross-employee wake per created work against this root, or refuse the whole batch. */
  wakeBudget?: { rootWorkId: string; max: number };
};

/** The wake budget refusal, sized so each caller can render its own message. */
export class WakeBudgetExceededError extends AppError {
  constructor(readonly limit: number) {
    super(appMessages.work.wakeLimit(limit));
  }
}

/**
 * Create one queued work and its durable dispatch task per employee in the
 * caller's transaction, spending the wake budget first.
 *
 * A refusal throws before any work or task is written, and any failure after
 * that rolls the whole batch — budget, works, tasks, and whatever the caller
 * wrote — back together. The returned ids are in employeeIds order.
 */
export async function enqueueWorksIn(tx: Tx, dispatch: WorkDispatchTask, input: EnqueueWorksInput): Promise<string[]> {
  if (input.wakeBudget !== undefined && input.wakeBudget.rootWorkId.length > 0) {
    const { rootWorkId, max } = input.wakeBudget;
    const collaboration = await tx.doc(CollaborationDoc, rootWorkId, { rootWorkId });
    collaboration.rootWorkId = rootWorkId;
    const used = collaboration.crossEmployeeWakes + input.employeeIds.length;
    if (used > max) throw new WakeBudgetExceededError(max);
    collaboration.crossEmployeeWakes = used;
  }
  const workIds: string[] = [];
  for (const employeeId of input.employeeIds) {
    const workId = `wk_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const doc = await tx.doc(WorkDoc, workId, { id: workId });
    doc.id = workId;
    doc.employeeId = employeeId;
    doc.roomId = input.roomId;
    doc.workContextId = input.workContextId;
    doc.kind = input.kind;
    doc.status = "queued";
    doc.sourceEntryId = input.sourceEntryId;
    doc.parentWorkId = input.parentWorkId;
    doc.rootWorkId = input.rootWorkId.length > 0 ? input.rootWorkId : workId;
    doc.depth = input.depth;
    doc.startedAt = input.now;
    doc.intent = input.intent;
    doc.directoryScope = { ...input.directoryScope, paths: [...input.directoryScope.paths] };
    const taskId = await tx.createTask(
      dispatch,
      { workId },
      {
        ownership: { kind: "conversation" },
        conversationId: input.dispatchConversationId as ConversationId,
        background: true,
      },
    );
    doc.dispatchTaskId = String(taskId);
    workIds.push(workId);
  }
  return workIds;
}

export function isTerminal(status: WorkRecord["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "stopped";
}

export async function findWork(runtime: EmitRuntime, id: string): Promise<WorkRecord | undefined> {
  return runtime.readFamily(WorkDoc, id, { id });
}
