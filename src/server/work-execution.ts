/**
 * A work's durable execution record, read for the browser.
 *
 * The live progress stream is an optimisation: this is the truth. Steps come
 * from the committed conversation entries, so they survive a restart and show
 * the tool calls, results, and errors of a run that already ended. Nothing here
 * returns system prompts, private thinking, or raw image payloads, and task
 * states come from the real task records rather than from inference.
 */

import type { ConversationId, Cursor, EntryRecord, JsonObject, TaskId } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";
import type { EmitRuntime } from "./runtime.ts";
import { AppError } from "./app-text.ts";
import { appMessages } from "./messages.ts";
import { EmployeeDoc } from "./documents.ts";
import { findWork } from "./work-queue.ts";
import { findRoom } from "./rooms.ts";
import { toWorkDTO } from "./dto.ts";
import { listApprovals, toApprovalDTO } from "./approval/state.ts";
import { redactApprovalText, redactArguments } from "./approval/evaluators.ts";
import type { WorkExecutionDTO, WorkExecutionStepDTO } from "../shared/contracts.ts";

/** Entries per page: enough to cover a normal run, small enough for a modal. */
const EXECUTION_PAGE = 100;
/** One step's text is bounded in bytes, not code units. */
const STEP_LIMIT_BYTES = 8_000;

/** A bad cursor is the caller's mistake, and the route reports it as one. */
export class WorkExecutionCursorError extends AppError {}

function clampBytes(value: string): { text: string; truncated?: boolean } {
  const redacted = redactApprovalText(value);
  if (Buffer.byteLength(redacted, "utf8") <= STEP_LIMIT_BYTES) return { text: redacted };
  let low = 0;
  let high = redacted.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(redacted.slice(0, middle), "utf8") <= STEP_LIMIT_BYTES) low = middle;
    else high = middle - 1;
  }
  return { text: redacted.slice(0, low), truncated: true };
}

function parseCursor(raw: string | undefined): Cursor | undefined {
  if (raw === undefined || raw.length === 0) return undefined;
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(raw) as JsonValue;
  } catch {
    throw new WorkExecutionCursorError(appMessages.work.cursorUnparsable());
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new WorkExecutionCursorError(appMessages.api.malformedCursor);
  }
  return parsed as JsonObject;
}

/** Visible text of one message, whether its content is a string or parts. */
function messageText(content: string | readonly { type: string; text?: string }[]): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
    .filter((text) => text.length > 0)
    .join("\n");
}

/** Every visible step one entry contributed, in the order the model saw it. */
function stepsOfEntry(entry: EntryRecord): WorkExecutionStepDTO[] {
  const messages = entry.model ?? [];
  const steps: WorkExecutionStepDTO[] = [];
  const entryId = String(entry.id);
  for (const [messageIndex, message] of messages.entries()) {
    if (message.role === "user") {
      const text = messageText(message.content);
      if (text.length > 0) {
        steps.push({ id: `${entryId}:${messageIndex}`, entryId, kind: "input", ...clampBytes(text) });
      }
      continue;
    }
    if (message.role === "assistant") {
      const text = messageText(message.content);
      if (text.length > 0) {
        steps.push({ id: `${entryId}:${messageIndex}`, entryId, kind: "assistant", ...clampBytes(text) });
      }
      for (const [partIndex, part] of message.content.entries()) {
        if (part.type !== "toolCall") continue;
        const args = clampBytes(redactArguments(part.arguments));
        steps.push({
          id: `${entryId}:${messageIndex}:${partIndex}`,
          entryId,
          kind: "tool-call",
          toolCallId: part.id,
          toolName: part.name,
          arguments: args.text,
          ...(args.truncated !== undefined ? { truncated: true } : {}),
        });
      }
      continue;
    }
    if (message.role === "toolResult") {
      const text = messageText(message.content);
      const bounded = clampBytes(text);
      steps.push({
        id: `${entryId}:${messageIndex}`,
        entryId,
        kind: "tool-result",
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        text: bounded.text,
        isError: message.isError === true,
        ...(bounded.truncated !== undefined ? { truncated: true } : {}),
      });
    }
  }
  return steps;
}

/**
 * One page of a work's execution record, oldest step first.
 *
 * A work whose conversation does not exist yet (queued, or never started) has
 * no steps but is still returned: "not started" is an answer, not a 404.
 */
export async function readWorkExecution(
  runtime: EmitRuntime,
  workId: string,
  cursor?: string,
): Promise<WorkExecutionDTO | undefined> {
  const work = await findWork(runtime, workId);
  if (work === undefined) return undefined;
  const employee = await runtime.readFamily(EmployeeDoc, work.employeeId, { id: work.employeeId });
  const room = work.roomId.length > 0 ? await findRoom(runtime, work.roomId) : undefined;
  const approvals = (await listApprovals(runtime)).filter((approval) => approval.workId === work.id).map(toApprovalDTO);
  const dto = toWorkDTO(work, employee?.name ?? "", room?.name ?? "");
  if (work.conversationId === 0) return { work: dto, steps: [], approvals };

  const conversation = await runtime.harness.conversation(work.conversationId as ConversationId, runtime.ctx);
  if (conversation === undefined) return { work: dto, steps: [], approvals };

  const page = await conversation.entries({}, EXECUTION_PAGE, parseCursor(cursor), runtime.ctx);
  // The harness pages newest first; a reader wants the page oldest first.
  const ordered = [...page.items].reverse();
  const steps: WorkExecutionStepDTO[] = [];
  const taskIds = new Set<string>();
  for (const entry of ordered) {
    const entrySteps = stepsOfEntry(entry);
    if (entry.byTaskId !== undefined) {
      taskIds.add(String(entry.byTaskId));
      for (const step of entrySteps) step.taskId = String(entry.byTaskId);
    }
    steps.push(...entrySteps);
  }

  // Task state is read from the durable task record: a step is only shown as
  // failed when the task that wrote it really failed.
  const taskStates = new Map<string, { status: string; error?: string }>();
  for (const taskId of taskIds) {
    const record = await runtime.harness.getTask(Number(taskId) as TaskId, runtime.ctx);
    if (record === undefined) continue;
    const outcome = record.state.status === "terminal" ? record.state.outcome : undefined;
    taskStates.set(taskId, {
      status: record.state.status,
      ...(outcome?.status === "failed" ? { error: clampBytes(outcome.error.message).text } : {}),
    });
  }
  for (const step of steps) {
    if (step.taskId === undefined) continue;
    const state = taskStates.get(step.taskId);
    if (state === undefined) continue;
    step.taskStatus = state.status;
    if (state.error !== undefined) step.taskError = state.error;
  }

  return {
    work: dto,
    steps,
    ...(page.next !== undefined ? { nextCursor: JSON.stringify(page.next) } : {}),
    approvals,
  };
}
