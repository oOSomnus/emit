/**
 * The approval lifecycle.
 *
 * One approval case is created per gated tool call, keyed deterministically by
 * the tool task, employee, complete arguments, canonical session directory
 * scope and targets, and configuration versions in force. That key is what makes
 * the whole path durable:
 *
 *  - the gate runs before the harness records the tool intent, so a process
 *    that dies while a human is deciding has recorded no side effect at all;
 *  - a restarted call recomputes the same key and finds the same case, so a
 *    decision is never asked for twice;
 *  - a grant is bound to the arguments, directory scope, target paths, and
 *    configuration versions it was issued for, so it cannot be reused for a
 *    different call.
 *
 * The gate waits for a human only for a high-risk verdict, polling the committed
 * document rather than holding an in-process promise, because that is the only
 * state a new process can see.
 */

import { createHash } from "node:crypto";
import type { ConversationId, EntryId, TaskId as HarnessTaskId } from "@earendil-works/pi-durable";
import type { LocalizedText } from "../../shared/i18n.ts";
import type { ApprovalDTO, ApprovalEvidenceDTO } from "../../shared/contracts.ts";
import {
  AppDoc,
  ApprovalDoc,
  ConversationContextDoc,
  EmployeeDoc,
  RoomDoc,
  WorkContextDoc,
  WorkDoc,
} from "../documents.ts";
import type {
  ApprovalEvidenceRecord,
  ApprovalRecord,
  ApprovalTimelineRecord,
  AppRecord,
  ConversationContextRecord,
  EmployeeRecord,
  RoomRecord,
  WorkContextRecord,
  WorkDirectoryScopeRecord,
  WorkRecord,
} from "../documents.ts";
import { readRoomMessageWindow } from "../rooms.ts";
import type { MessageDTO } from "../../shared/contracts.ts";
import type { EmitRuntime } from "../runtime.ts";
import type {
  ApprovalCase,
  ApprovalContextEntry,
  ApprovalEvaluatorConfig,
  ApprovalUserIntent,
  EvaluationOutcome,
} from "./contracts.ts";
import {
  argumentsPreview,
  createClassifierEvaluator,
  createLlmEvaluator,
  describeClassifierEvidence,
  redactApprovalText,
  redactArguments,
} from "./evaluators.ts";
import { parseJsonObject } from "../llm.ts";
import { fromError, rawText, type AppText } from "../app-text.ts";
import { appMessages } from "../messages.ts";
import { renderApprovalContext } from "../prompts/index.ts";
import { resolveToolDirectoryScope } from "../work-directories.ts";

/** How a tool call is classified for the gate. */
export type ToolRisk =
  | { risk: "safe" }
  | { risk: "gated"; kind: "file-write" | "shell" | "mcp" | "other" };

export type ApprovalRequest = {
  toolTaskId: string;
  employeeId: string;
  employeeName: string;
  toolName: string;
  toolKind: "file-write" | "shell" | "mcp" | "other";
  /** Raw validated arguments are hashed; only their redacted JSON reaches review. */
  arguments: unknown;
  cwd: string;
  directoryWorkContextId: string;
  directoryRoomId: string;
  directoryVersion: number;
  directoryPaths: string[];
  targetPaths: string[];
};

/** Stable JSON with sorted object keys, so equal arguments hash equally. */
export function canonicalJson(value: unknown): string {
  const seen = new WeakSet<object>();
  const encode = (input: unknown): unknown => {
    if (input === null || typeof input !== "object") return input === undefined ? null : input;
    if (seen.has(input)) return "[circular]";
    seen.add(input);
    if (Array.isArray(input)) return input.map(encode);
    const entries = Object.entries(input as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([key, entry]) => [key, encode(entry)]));
  };
  return JSON.stringify(encode(value));
}

export function hashArguments(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** The identity of one approval: deterministic for one specific call. */
export function approvalId(request: ApprovalRequest, configVersion: number, policyVersion: number): string {
  const material = [
    request.toolTaskId,
    request.employeeId,
    request.toolName,
    hashArguments(request.arguments),
    request.cwd,
    request.directoryWorkContextId,
    request.directoryRoomId,
    String(request.directoryVersion),
    canonicalJson(request.directoryPaths),
    canonicalJson(request.targetPaths),
    String(configVersion),
    String(policyVersion),
  ].join("\u0000");
  return `ap_${createHash("sha256").update(material).digest("hex").slice(0, 32)}`;
}

/** Policy evidence pair included only when the sentence is application-authored. */
function policyEvidence(message: AppText): ApprovalEvidenceRecord {
  return message.localized === undefined
    ? { kind: "policy", rationale: message.text }
    : { kind: "policy", rationale: message.text, rationaleLocalized: message.localized };
}

/** One persisted timeline row; raw actor/text stay byte-identical, pairs ride along. */
function timelineEntry(at: number, actor: AppText, text: AppText): ApprovalTimelineRecord {
  return {
    at,
    actor: actor.text,
    ...(actor.localized !== undefined ? { actorLocalized: actor.localized } : {}),
    text: text.text,
    ...(text.localized !== undefined ? { textLocalized: text.localized } : {}),
  };
}

export function toApprovalDTO(record: ApprovalRecord): ApprovalDTO {
  return {
    id: record.id,
    workId: record.workId.length > 0 ? record.workId : undefined,
    employeeId: record.employeeId,
    employeeName: record.employeeName,
    toolName: record.toolName,
    argumentsPreview: record.argumentsPreview,
    cwd: record.cwd,
    directoryWorkContextId: record.directoryWorkContextId,
    directoryRoomId: record.directoryRoomId,
    directoryVersion: record.directoryVersion,
    directoryPaths: [...record.directoryPaths],
    targetPaths: [...record.targetPaths],
    risk: record.risk,
    status: record.status,
    execution: {
      state: record.executionState,
      detail: record.executionDetail.length > 0 ? record.executionDetail : undefined,
      ...(record.executionDetail.length > 0 && record.executionDetailLocalized !== undefined
        ? { detailLocalized: record.executionDetailLocalized }
        : {}),
    },
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    decidedAt: record.decidedAt > 0 ? record.decidedAt : undefined,
    decidedBy: record.decidedBy.length > 0 ? record.decidedBy : undefined,
    comment: record.comment.length > 0 ? record.comment : undefined,
    autoDecision:
      record.autoDecisionSource === ""
        ? undefined
        : {
            source: record.autoDecisionSource as "llm" | "classifier" | "policy" | "human",
            reason: record.autoDecisionReason,
            ...(record.autoDecisionReasonLocalized !== undefined
              ? { reasonLocalized: record.autoDecisionReasonLocalized }
              : {}),
          },
    evidence: toEvidenceDTO(record),
    origin:
      record.originKind === "room"
        ? {
            kind: "room",
            roomId: record.originRoomId,
            roomName: record.originRoomName,
            entryId: record.originEntryId,
          }
        : { kind: "delegation", parentWorkId: record.originParentWorkId },
    timeline: record.timeline.map((entry) => ({
      at: entry.at,
      actor: entry.actor,
      text: entry.text,
      ...(entry.actorLocalized !== undefined ? { actorLocalized: entry.actorLocalized } : {}),
      ...(entry.textLocalized !== undefined ? { textLocalized: entry.textLocalized } : {}),
    })),
  };
}

function toEvidenceDTO(record: ApprovalRecord): ApprovalEvidenceDTO | undefined {
  const evidence = record.evidence;
  if (evidence === null) return undefined;
  if (evidence.kind === "policy") {
    return {
      kind: "policy",
      rationale: evidence.rationale,
      ...(evidence.rationaleLocalized !== undefined ? { rationaleLocalized: evidence.rationaleLocalized } : {}),
    };
  }
  if (evidence.kind === "llm") return { ...evidence };
  return {
    kind: "classifier",
    criteriaVersion: evidence.criteriaVersion,
    questions: parseStoredQuestions(evidence.questions),
    answers: [
      {
        key: "outcome",
        choice: evidence.outcome,
        probability: evidence.outcomeProbability ?? undefined,
        probabilities: { ...evidence.outcomeProbabilities },
      },
      {
        key: "risk",
        choice: evidence.risk,
        probability: evidence.riskProbability ?? undefined,
        probabilities: { ...evidence.riskProbabilities },
      },
      {
        key: "read_only",
        ...(evidence.readOnly !== null ? { choice: String(evidence.readOnly) } : {}),
        ...(evidence.readOnlyProbability !== null ? { probability: evidence.readOnlyProbability } : {}),
      },
      {
        key: "authorized",
        ...(evidence.authorized !== null ? { choice: String(evidence.authorized) } : {}),
        ...(evidence.authorizedProbability !== null ? { probability: evidence.authorizedProbability } : {}),
      },
    ],
    outcome: evidence.outcome,
    risk: evidence.risk,
    outcomeProbability: evidence.outcomeProbability,
    outcomeProbabilities: { ...evidence.outcomeProbabilities },
    riskProbability: evidence.riskProbability,
    riskProbabilities: { ...evidence.riskProbabilities },
    readOnly: evidence.readOnly,
    readOnlyProbability: evidence.readOnlyProbability,
    authorized: evidence.authorized,
    authorizedProbability: evidence.authorizedProbability,
  };
}

/** Re-parse the criteria snapshot stored at evaluation time, for display only. */
function parseStoredQuestions(rendered: string): Extract<ApprovalEvidenceDTO, { kind: "classifier" }>["questions"] {
  const parsed = parseJsonObject(rendered);
  if (typeof parsed !== "object" || parsed === null) return [];
  const questions: Extract<ApprovalEvidenceDTO, { kind: "classifier" }>["questions"] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "object" || value === null) continue;
    const entry = value as Record<string, unknown>;
    const type = typeof entry.type === "string" ? entry.type : "";
    const instructions = typeof entry.instructions === "string" ? entry.instructions : "";
    const criteria: { label: string; description: string }[] = [];
    const raw = entry.criteria;
    if (Array.isArray(raw)) {
      raw.forEach((description, index) => {
        if (typeof description === "string") criteria.push({ label: String(index), description });
      });
    } else if (typeof raw === "object" && raw !== null) {
      for (const [label, description] of Object.entries(raw)) {
        if (typeof description === "string") criteria.push({ label, description });
      }
    }
    questions.push({ key, type, instructions, criteria });
  }
  return questions;
}

export async function listApprovals(runtime: EmitRuntime): Promise<ApprovalRecord[]> {
  const members = await runtime.listFamily(ApprovalDoc, (id) => ({ id }));
  return members.map((member) => member.value).sort((a, b) => b.createdAt - a.createdAt);
}

export async function findApproval(runtime: EmitRuntime, id: string): Promise<ApprovalRecord | undefined> {
  const members = await runtime.listFamily(ApprovalDoc, (key) => ({ id: key }));
  return members.find((member) => member.key === id)?.value;
}

export type GateInput = {
  runtime: EmitRuntime;
  /** Execution tool registry description, labelled untrusted for review. */
  toolDescription: string;
  toolTaskId: string;
  conversationId: number;
  toolName: string;
  toolKind: "file-write" | "shell" | "mcp" | "other";
  arguments: unknown;
  signal: AbortSignal | undefined;
};
export type GateDecision = { allow: true; record: ApprovalRecord } | { allow: false; message: string };

/**
 * The complete gate: create or find the case, run the configured evaluator when
 * it has not been answered yet, and wait for a human only for a high-risk verdict.
 */
export async function gateToolCall(input: GateInput): Promise<GateDecision> {
  const { runtime } = input;
  const app = await runtime.readSession(AppDoc);
  const binding = await runtime.readConversationDoc(ConversationContextDoc, input.conversationId);
  if (binding === undefined || binding.workId.length === 0) {
    return { allow: false, message: "This conversation is not bound to a work context; the tool call was blocked" };
  }
  const scopeResult = await resolveToolDirectoryScope(
    runtime,
    input.conversationId,
    input.toolName,
    input.arguments,
    runtime.ctx,
  );
  if (!scopeResult.ok) return { allow: false, message: scopeResult.message };
  const { scope } = scopeResult;
  const employee = await runtime.readFamily(EmployeeDoc, binding.employeeId, { id: binding.employeeId });
  if (employee === undefined) return { allow: false, message: "The employee record was not found; the tool call was blocked" };
  const work = await runtime.readFamily(WorkDoc, binding.workId, { id: binding.workId });
  const room =
    binding.roomId.length > 0 ? await runtime.readFamily(RoomDoc, binding.roomId, { id: binding.roomId }) : undefined;

  const request: ApprovalRequest = {
    toolTaskId: input.toolTaskId,
    employeeId: employee.id,
    employeeName: employee.name,
    toolName: input.toolName,
    toolKind: input.toolKind,
    arguments: input.arguments,
    cwd: scopeResult.cwd,
    directoryWorkContextId: scope.workContextId,
    directoryRoomId: scope.roomId,
    directoryVersion: scope.version,
    directoryPaths: [...scope.paths],
    targetPaths: [...scopeResult.targetPaths],
  };
  const id = approvalId(request, employee.configVersion, app.policyVersion);

  const created = await runtime.updateFamily(ApprovalDoc, id, { id }, (doc) => {
    if (doc.createdAt !== 0) return;
    const now = Date.now();
    doc.id = id;
    doc.toolTaskId = request.toolTaskId;
    doc.workId = binding.workId;
    doc.rootWorkId = binding.rootWorkId;
    doc.employeeId = employee.id;
    doc.employeeName = employee.name;
    doc.toolName = request.toolName;
    doc.argsHash = hashArguments(request.arguments);
    doc.argumentsPreview = argumentsPreview(request.arguments);
    doc.cwd = request.cwd;
    doc.directoryWorkContextId = request.directoryWorkContextId;
    doc.directoryRoomId = request.directoryRoomId;
    doc.directoryVersion = request.directoryVersion;
    doc.directoryPaths = [...request.directoryPaths];
    doc.targetPaths = [...request.targetPaths];
    doc.risk = "unknown";
    doc.status = "evaluating";
    doc.createdAt = now;
    doc.updatedAt = now;
    doc.originKind = binding.roomId.length > 0 ? "room" : "delegation";
    doc.originRoomId = binding.roomId;
    doc.originRoomName = room?.name ?? "";
    doc.originEntryId = work?.sourceEntryId ?? "";
    doc.originParentWorkId = work?.parentWorkId ?? "";
    doc.configVersion = employee.configVersion;
    doc.policyVersion = app.policyVersion;
    doc.evidence = policyEvidence(appMessages.approval.policyWaiting);
    doc.timeline = [timelineEntry(now, appMessages.approval.actorSystem, appMessages.approval.submitted(request.toolName))];
  });

  runtime.emit({ type: "approval", approval: toApprovalDTO(created) });

  if (created.status === "approved") return { allow: true, record: created };
  if (created.status !== "evaluating" && created.status !== "pending-human") {
    return { allow: false, message: blockedMessage(created).text };
  }

  const context: GateContext = {
    runtime,
    employee,
    app,
    request,
    toolDescription: input.toolDescription,
    conversationId: input.conversationId,
    binding,
    room,
    work,
    directoryScope: scope,
    signal: input.signal,
  };

  let record = created;
  if (record.status === "evaluating") {
    record = await evaluateAndPersist(context, record);
    runtime.emit({ type: "approval", approval: toApprovalDTO(record) });
    if (record.status === "approved") return { allow: true, record };
    if (record.status !== "pending-human") return { allow: false, message: blockedMessage(record).text };
  }

  await setWorkStatus(runtime, binding.workId, "waiting-approval");
  const notice = appMessages.approval.pendingDecision(record.id, request.toolName);
  runtime.emit({
    type: "notice",
    text: notice.text,
    // The catalog always pairs this sentence; the raw fallback never fires.
    textLocalized: notice.localized ?? { en: notice.text, "zh-CN": notice.text },
  });

  const finalStatus = await waitForHuman(
    runtime,
    id,
    binding.workId,
    input.toolTaskId as unknown as HarnessTaskId,
    request,
  );
  const latest = (await runtime.readFamily(ApprovalDoc, id, { id })) ?? record;
  if (finalStatus === "approved") {
    await setWorkStatus(runtime, binding.workId, "running");
    return { allow: true, record: latest };
  }
  await setWorkStatus(runtime, binding.workId, "running", true);
  if (finalStatus === "cancelled") {
    return {
      allow: false,
      message: appMessages.approval.blockedCancelledRun(request.toolName).text,
    };
  }
  return { allow: false, message: blockedMessage(latest).text };
}

/**
 * Reflect the approval wait in the work item.
 *
 * The work list is what the user reads to see what is happening, so a call
 * blocked on a decision has to be visible there; only a work item that is
 * actually running is re-labelled, so a stopped or finished one is left alone.
 */
async function setWorkStatus(
  runtime: EmitRuntime,
  workId: string,
  status: "waiting-approval" | "running",
  onlyIfWaiting = false,
): Promise<void> {
  if (workId.length === 0) return;
  const current = await runtime.readFamily(WorkDoc, workId, { id: workId });
  if (current === undefined) return;
  const allowed = onlyIfWaiting ? current.status === "waiting-approval" : current.status === "running";
  if (!allowed) return;
  await runtime.updateFamily(WorkDoc, workId, { id: workId }, (doc) => {
    if (doc.status === status) return;
    doc.status = status;
  });
  runtime.emit({ type: "approvals" });
}

/** Everything one evaluation needs, resolved once per gated call. */
type GateContext = {
  runtime: EmitRuntime;
  employee: EmployeeRecord;
  app: AppRecord;
  request: ApprovalRequest;
  toolDescription: string;
  conversationId: number;
  binding: { workId: string; rootWorkId: string; roomId: string; depth: number };
  room: RoomRecord | undefined;
  work: WorkRecord | undefined;
  directoryScope: WorkDirectoryScopeRecord;
  signal: AbortSignal | undefined;
};

type ApprovalContextEvidence = {
  userIntent: ApprovalUserIntent;
  recentContext: ApprovalContextEntry[];
  executionContext: ApprovalContextEntry[];
  contextBudget: { omittedEntries: number; truncatedEntries: number };
};

type ApprovalContextResult =
  | { ok: true; evidence: ApprovalContextEvidence; originRoom: RoomRecord | undefined }
  | {
      ok: false;
      message: string;
      /** Present when the failure sentence is application-authored. */
      messageLocalized?: LocalizedText;
      /** Missing-context sentences are complete sentences stored verbatim. */
      verbatim?: true;
    };

/**
 * The blocked outcome of one approval, as it is reported to the model and to
 * the browser. Nested reasons (the user's comment, the automatic decision
 * reason) keep their raw value in Chinese and their display pair in English
 * when one exists.
 */
function blockedMessage(record: ApprovalRecord): AppText {
  switch (record.status) {
    case "rejected": {
      const useComment = record.comment.length > 0;
      return appMessages.approval.blockedRejected(
        record.id,
        useComment ? record.comment : record.autoDecisionReason,
        useComment ? undefined : record.autoDecisionReasonLocalized,
      );
    }
    case "blocked":
      return appMessages.approval.blockedAutomatic(
        record.id,
        record.autoDecisionReason,
        record.autoDecisionReasonLocalized,
      );
    case "cancelled":
      return appMessages.approval.blockedCancelled(record.id);
    case "invalidated":
      return appMessages.approval.blockedInvalidated(record.id);
    case "pending-human":
      return appMessages.approval.blockedPendingHuman(record.id);
    default:
      return appMessages.approval.blockedDefault(record.id);
  }
}

type OmittedContext = { count: number };

function textFromParts(parts: readonly { type: string; text?: string }[], omitted: OmittedContext): string {
  const text: string[] = [];
  for (const part of parts) {
    if (part.type === "text" && typeof part.text === "string") text.push(part.text);
    else if (part.type === "image" || part.type === "thinking") omitted.count += 1;
  }
  return text.join("\n");
}

async function approvalContext(input: GateContext): Promise<ApprovalContextResult> {
  const conversation = await input.runtime.harness
    .conversation(input.conversationId as ConversationId, input.runtime.ctx)
    .catch(() => undefined);
  if (conversation === undefined) {
    const blocked = appMessages.approval.missingContext;
    return { ok: false, message: blocked.text, messageLocalized: blocked.localized, verbatim: true };
  }
  const active = await conversation.context(input.runtime.ctx).catch(() => undefined);
  if (active === undefined || active.entries.length === 0) {
    const blocked = appMessages.approval.noContextAvailable;
    return { ok: false, message: blocked.text, messageLocalized: blocked.localized, verbatim: true };
  }

  const omitted: OmittedContext = { count: 0 };
  const executionContext: ApprovalContextEntry[] = [];
  const firstActive = Math.max(0, active.entries.length - 40);
  for (let index = 0; index < firstActive; index += 1) {
    const contribution = active.contributions[index] ?? [];
    if (contribution.length === 0) {
      omitted.count += 1;
      continue;
    }
    for (const message of contribution) {
      if (message.role === "system") {
        omitted.count += Math.max(
          1,
          Object.keys(message.sections ?? {}).length +
            (message.toolsAdded?.length ?? 0) +
            (message.toolsRemoved?.length ?? 0),
        );
      } else {
        omitted.count += 1;
      }
    }
  }
  for (let index = firstActive; index < active.entries.length; index += 1) {
    const entry = active.entries[index]!;
    const contribution = active.contributions[index] ?? [];
    if (contribution.length === 0 && entry.kind !== "pi.compaction" && entry.kind !== "pi.reset") {
      omitted.count += 1;
      continue;
    }
    if (entry.kind === "pi.compaction" || entry.kind === "pi.reset") {
      const fragments: string[] = [];
      for (const message of contribution) {
        if (message.role === "system") {
          omitted.count += Math.max(
            1,
            Object.keys(message.sections ?? {}).length +
              (message.toolsAdded?.length ?? 0) +
              (message.toolsRemoved?.length ?? 0),
          );
          continue;
        }
        if (message.role === "user") {
          fragments.push(
            typeof message.content === "string"
              ? message.content
              : textFromParts(message.content, omitted),
          );
        } else if (message.role === "assistant") {
          const text: string[] = [];
          for (const part of message.content) {
            if (part.type === "text") text.push(part.text);
            else if (part.type === "thinking") omitted.count += 1;
          }
          fragments.push(...text);
        } else {
          fragments.push(textFromParts(message.content, omitted));
        }
      }
      const marker =
        entry.kind === "pi.compaction"
          ? renderApprovalContext("compaction-marker")
          : renderApprovalContext("reset-marker");
      const summary = fragments.map(redactApprovalText).filter((text) => text.length > 0).join("\n");
      executionContext.push({
        source: "execution-context",
        role: "meta",
        entryId: String(entry.id),
        text: summary.length > 0 ? `${marker}：\n${summary}` : marker,
        truncated: false,
      });
      continue;
    }

    for (const message of contribution) {
      if (message.role === "system") {
        omitted.count += Math.max(
          1,
          Object.keys(message.sections ?? {}).length +
            (message.toolsAdded?.length ?? 0) +
            (message.toolsRemoved?.length ?? 0),
        );
        continue;
      }
      if (message.role === "user") {
        if (typeof message.content === "string") {
          if (message.content.length > 0) {
            executionContext.push({
              source: "execution-context",
              role: "user",
              at: message.timestamp,
              entryId: String(entry.id),
              text: redactApprovalText(message.content),
              truncated: false,
            });
          }
        } else {
          const text = textFromParts(message.content, omitted);
          if (text.length > 0) {
            executionContext.push({
              source: "execution-context",
              role: "user",
              at: message.timestamp,
              entryId: String(entry.id),
              text: redactApprovalText(text),
              truncated: false,
            });
          }
        }
      } else if (message.role === "assistant") {
        for (const part of message.content) {
          if (part.type === "text") {
            executionContext.push({
              source: "execution-context",
              role: "assistant",
              at: message.timestamp,
              entryId: String(entry.id),
              text: redactApprovalText(part.text),
              truncated: false,
            });
          } else if (part.type === "thinking") {
            omitted.count += 1;
          } else if (part.type === "toolCall") {
            executionContext.push({
              source: "execution-context",
              role: "assistant",
              at: message.timestamp,
              entryId: String(entry.id),
              toolCallId: part.id,
              toolName: part.name,
              text: renderApprovalContext("tool-call", {
                name: part.name,
                id: part.id,
                arguments: redactArguments(part.arguments),
              }),
              truncated: false,
            });
          }
        }
      } else {
        const text = textFromParts(message.content, omitted);
        executionContext.push({
          source: "execution-context",
          role: "toolResult",
          at: message.timestamp,
          entryId: String(entry.id),
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          text: renderApprovalContext("tool-result", {
            toolName: message.toolName,
            errorMark: message.isError ? renderApprovalContext("error-mark") : "",
            text: redactApprovalText(text),
          }),
          truncated: false,
        });
      }
    }
  }

  let current: WorkRecord | undefined = input.work;
  const lineage: WorkRecord[] = [];
  const seen = new Set<string>();
  let verifiedUserMessage: MessageDTO | undefined;
  let triggerMessage: MessageDTO | undefined;
  let originRoom: RoomRecord | undefined;
  const maximumWorks = input.app.collaboration.maxDepth + 1;
  while (current !== undefined && lineage.length < maximumWorks) {
    if (seen.has(current.id)) {
      omitted.count += 1;
      break;
    }
    seen.add(current.id);
    lineage.push(current);
    if (current.roomId.length > 0 && current.sourceEntryId.length > 0) {
      const room =
        input.room?.id === current.roomId
          ? input.room
          : await input.runtime.readFamily(RoomDoc, current.roomId, { id: current.roomId });
      if (room !== undefined) {
        const window = await readRoomMessageWindow(input.runtime, room, current.sourceEntryId);
        if (triggerMessage === undefined && window.trigger !== undefined) {
          triggerMessage = window.trigger;
          originRoom = room;
        }
        if (verifiedUserMessage === undefined && window.trigger?.author.type === "user") {
          verifiedUserMessage = window.trigger;
        }

      }
    }
    if (current.parentWorkId.length === 0) break;
    if (lineage.length >= maximumWorks) {
      omitted.count += 1;
      break;
    }
    const parent = await input.runtime.readFamily(WorkDoc, current.parentWorkId, { id: current.parentWorkId });
    if (parent === undefined) {
      omitted.count += 1;
      break;
    }
    current = parent;
  }


  const derivedIntent = input.work?.intent ?? "";
  const userText = verifiedUserMessage?.body ?? derivedIntent;
  const userIntent: ApprovalUserIntent = {
    text: redactApprovalText(userText),
    source:
      verifiedUserMessage !== undefined
        ? "room-message"
        : input.work?.kind === "delegation"
          ? "delegation"
          : input.work === undefined
            ? "unknown"
            : "work-intent",
    truncated: false,
    authorization: verifiedUserMessage !== undefined ? "user" : "unknown",
    ...(verifiedUserMessage !== undefined
      ? {
          at: verifiedUserMessage.createdAt,
          author: {
            id: verifiedUserMessage.author.id,
            name: verifiedUserMessage.author.name,
            type: verifiedUserMessage.author.type,
          },
        }
      : triggerMessage !== undefined
        ? {
            at: triggerMessage.createdAt,
            author: {
              id: triggerMessage.author.id,
              name: triggerMessage.author.name,
              type: triggerMessage.author.type,
            },
          }
        : {}),
  };

  let recentContext: ApprovalContextEntry[] = [];
  if (triggerMessage !== undefined && originRoom !== undefined) {
    const window = await readRoomMessageWindow(input.runtime, originRoom, triggerMessage.id);
    omitted.count += window.omittedBeforeTrigger;
    recentContext = window.messages.map((message) => ({
      source: "room-message",
      at: message.createdAt,
      entryId: message.id,
      author: {
        id: message.author.id,
        name: message.author.name,
        type: message.author.type,
      },
      text: redactApprovalText(message.body),
      truncated: false,
    }));
  }
  for (const work of [...lineage].reverse()) {
    if (work.kind !== "delegation" || work.intent.length === 0) continue;
    recentContext.push({
      source: "delegation",
      author: { id: work.employeeId, name: work.employeeId, type: "employee" },
      text: redactApprovalText(work.intent),
      truncated: false,
    });
  }

  return {
    ok: true,
    evidence: {
      userIntent,
      recentContext,
      executionContext,
      contextBudget: { omittedEntries: omitted.count, truncatedEntries: 0 },
    },
    originRoom,
  };
}

/** Run the configured reviewer and persist a result only for a current work-context directory scope. */
async function evaluateAndPersist(input: GateContext, record: ApprovalRecord): Promise<ApprovalRecord> {
  const { runtime, employee, app, request, binding } = input;
  const config = toEvaluatorConfig(app);
  const contextResult = await approvalContext(input).catch((error: unknown): ApprovalContextResult => {
    const wrapped = fromError(error);
    return {
      ok: false,
      message: wrapped.text,
      ...(wrapped.localized !== undefined ? { messageLocalized: wrapped.localized } : {}),
    };
  });
  if (!contextResult.ok) {
    return persistOutcome(input, record, {
      status: "unavailable",
      reason: "invalid-output",
      message: contextResult.message,
      ...(contextResult.messageLocalized !== undefined
        ? { messageLocalized: contextResult.messageLocalized }
        : {}),
      ...(contextResult.verbatim === true ? { verbatim: true } : {}),
    });
  }
  const selectedModel =
    config.kind === "llm"
      ? runtime.catalog.chatModel(config.model)
      : runtime.catalog.classifierModel(config.model);
  if (selectedModel === undefined) {
    return persistOutcome(input, record, {
      status: "unavailable",
      reason: "configuration",
      message: appMessages.approval.reviewUnavailable.text,
      messageLocalized: appMessages.approval.reviewUnavailable.localized,
    });
  }
  const approvalCase: ApprovalCase = {
    schemaVersion: 3,
    id: record.id,
    toolTaskId: request.toolTaskId,
    employee: { id: employee.id, name: employee.name, role: employee.role },
    tool: { name: request.toolName, kind: request.toolKind, description: input.toolDescription },
    arguments: redactArguments(request.arguments),
    argumentsPreview: record.argumentsPreview,
    cwd: request.cwd,
    directories: input.directoryScope,
    targetPaths: [...request.targetPaths],
    allowedTools: [...employee.allowedTools],
    userIntent: contextResult.evidence.userIntent,
    recentContext: contextResult.evidence.recentContext,
    executionContext: contextResult.evidence.executionContext,
    contextBudget: contextResult.evidence.contextBudget,
    origin: {
      kind: binding.roomId.length > 0 ? "room" : "delegation",
      description:
        contextResult.originRoom !== undefined
          ? renderApprovalContext("origin-room", {
              roomName: contextResult.originRoom.name,
              workId: binding.workId,
            })
          : renderApprovalContext("origin-delegation", { parentWorkId: input.work?.parentWorkId ?? "" }),
    },
    configVersion: employee.configVersion,
    policyVersion: app.policyVersion,
  };

  const evaluator =
    config.kind === "llm" ? createLlmEvaluator(runtime.catalog) : createClassifierEvaluator(runtime.catalog);
  const outcome = await evaluator
    .evaluate(approvalCase, config, {
      evaluationId: record.id,
      contextWindow: selectedModel.contextWindow,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    })
    .catch((error: unknown): EvaluationOutcome => {
      const wrapped = fromError(error);
      return {
        status: "unavailable",
        reason: "provider",
        message: wrapped.text,
        ...(wrapped.localized !== undefined ? { messageLocalized: wrapped.localized } : {}),
      };
    });

  return persistOutcome(input, record, outcome);
}

export type ApprovalVerdict =
  | { action: "approve" }
  | { action: "human" }
  | { action: "reject"; reason: AppText }
  | { action: "block"; reason: AppText };

/** The one policy seam shared by LLM and classifier decisions. */
export function approvalVerdict(outcome: EvaluationOutcome): ApprovalVerdict {
  if (outcome.status === "unavailable") {
    return {
      action: "block",
      reason: appMessages.approval.unavailableVerdict(outcome.message, outcome.messageLocalized),
    };
  }
  if (outcome.outcome === "deny") {
    return { action: "reject", reason: appMessages.approval.denyReason };
  }
  if (outcome.risk === "critical") {
    return { action: "reject", reason: appMessages.approval.criticalReason };
  }
  if (outcome.risk === "high") return { action: "human" };
  if (outcome.risk === "low" || outcome.risk === "medium") return { action: "approve" };
  return { action: "block", reason: appMessages.approval.unknownReason };
}

function workContextDirectoryMatchesSnapshot(
  workContext: WorkContextRecord | undefined,
  directoryWorkContextId: string,
  directoryVersion: number,
  directoryPaths: readonly string[],
): boolean {
  return (
    workContext !== undefined &&
    workContext.id === directoryWorkContextId &&
    workContext.directories !== undefined &&
    workContext.directories.version === directoryVersion &&
    workContext.directories.paths.length === directoryPaths.length &&
    workContext.directories.paths.every((path, index) => path === directoryPaths[index])
  );
}

/**
 * A work-context draft that was never written looks identical to its `initial`
 * shape; creation always stamps `createdAt`, so a zero there means "absent".
 */
function liveWorkContext(record: WorkContextRecord | undefined): WorkContextRecord | undefined {
  return record === undefined || record.createdAt === 0 ? undefined : record;
}

function invalidateApproval(doc: ApprovalRecord, currentVersion: number): void {
  const now = Date.now();
  const reason = appMessages.approval.directoryInvalidated(currentVersion);
  doc.status = "invalidated";
  doc.autoDecisionSource = "policy";
  doc.autoDecisionReason = reason.text;
  doc.autoDecisionReasonLocalized = reason.localized;
  doc.evidence = policyEvidence(reason);
  doc.decidedAt = now;
  doc.decidedBy = "policy";
  doc.updatedAt = now;
  doc.timeline.push(timelineEntry(now, appMessages.approval.actorSystem, reason));
}

/** Persist only if the work context's exact directory authorization is still current. */
async function persistOutcome(
  input: GateContext,
  record: ApprovalRecord,
  outcome: EvaluationOutcome,
): Promise<ApprovalRecord> {
  const updated = await input.runtime.harness.commit(async (tx) => {
    const doc = await tx.doc(ApprovalDoc, record.id, { id: record.id });
    if (doc.status !== "evaluating") return snapshotApproval(doc);
    let workContext: WorkContextRecord | undefined;
    if (doc.directoryWorkContextId.length > 0) {
      workContext = liveWorkContext(
        await tx.doc(WorkContextDoc, doc.directoryWorkContextId, { id: doc.directoryWorkContextId }),
      );
    }
    if (
      !workContextDirectoryMatchesSnapshot(workContext, doc.directoryWorkContextId, doc.directoryVersion, doc.directoryPaths)
    ) {
      invalidateApproval(doc, workContext?.directories?.version ?? 0);
      return snapshotApproval(doc);
    }

    const now = Date.now();
    if (outcome.status === "unavailable") {
      doc.risk = "unknown";
      doc.status = "blocked";
      doc.autoDecisionSource = "policy";
      // A verbatim reason is a complete application sentence (budget or
      // missing-context) stored as-is; everything else gets the generic
      // unavailable wrapper with the raw reason embedded unchanged.
      const reason =
        outcome.verbatim === true && outcome.messageLocalized !== undefined
          ? { text: outcome.message, localized: outcome.messageLocalized }
          : outcome.verbatim === true
            ? rawText(outcome.message)
            : appMessages.approval.reviewUnavailableWithReason(
                outcome.reason,
                outcome.message,
                outcome.messageLocalized,
              );
      doc.autoDecisionReason = reason.text;
      doc.autoDecisionReasonLocalized = reason.localized;
      doc.evidence = policyEvidence(
        appMessages.approval.unavailableEvidence(outcome.reason, outcome.message, outcome.messageLocalized),
      );
      doc.decidedAt = now;
      doc.decidedBy = "policy";
      doc.timeline.push(timelineEntry(now, appMessages.approval.actorAuto, appMessages.approval.blockedTimeline(reason)));
      doc.updatedAt = now;
      return snapshotApproval(doc);
    }

    doc.risk = outcome.risk;
    doc.autoDecisionSource = outcome.evidence.kind;
    let reason: AppText;
    if (outcome.evidence.kind === "llm") {
      doc.evidence = {
        kind: "llm",
        criteriaVersion: outcome.evidence.criteriaVersion,
        rationale: outcome.evidence.rationale,
        risk: outcome.evidence.risk,
        outcome: outcome.evidence.outcome,
        readOnly: outcome.evidence.readOnly,
        userAuthorization: outcome.evidence.userAuthorization,
      };
      reason = appMessages.approval.llmSummary(
        outcome.outcome,
        outcome.risk,
        outcome.evidence.readOnly,
        outcome.evidence.userAuthorization,
        outcome.evidence.rationale,
      );
    } else {
      doc.evidence = {
        kind: "classifier",
        criteriaVersion: outcome.evidence.criteriaVersion,
        questions: outcome.evidence.questions,
        outcome: outcome.evidence.outcome,
        risk: outcome.evidence.risk,
        outcomeProbability: outcome.evidence.outcomeProbability,
        outcomeProbabilities: { ...outcome.evidence.outcomeProbabilities },
        riskProbability: outcome.evidence.riskProbability,
        riskProbabilities: { ...outcome.evidence.riskProbabilities },
        readOnly: outcome.evidence.readOnly,
        readOnlyProbability: outcome.evidence.readOnlyProbability,
        authorized: outcome.evidence.authorized,
        authorizedProbability: outcome.evidence.authorizedProbability,
      };
      reason = describeClassifierEvidence(outcome.evidence);
    }
    doc.autoDecisionReason = reason.text;
    doc.autoDecisionReasonLocalized = reason.localized;

    const verdict = approvalVerdict(outcome);
    if (verdict.action === "approve") {
      doc.status = "approved";
      doc.decidedAt = now;
      doc.decidedBy = `${outcome.evidence.kind}:${outcome.model.providerId}/${outcome.model.modelId}`;
      doc.timeline.push(
        timelineEntry(now, appMessages.approval.actorAuto, appMessages.approval.autoApproved(reason)),
      );
    } else if (verdict.action === "human") {
      doc.status = "pending-human";
      doc.timeline.push(
        timelineEntry(now, appMessages.approval.actorAuto, appMessages.approval.humanHandoff(reason)),
      );
    } else if (verdict.action === "reject") {
      doc.status = "rejected";
      doc.decidedAt = now;
      doc.decidedBy = `${outcome.evidence.kind}:${outcome.model.providerId}/${outcome.model.modelId}`;
      const combined = appMessages.approval.combinedReason(verdict.reason, reason);
      doc.autoDecisionReason = combined.text;
      doc.autoDecisionReasonLocalized = combined.localized;
      doc.timeline.push(
        timelineEntry(now, appMessages.approval.actorAuto, appMessages.approval.autoRejected(combined)),
      );
    } else {
      doc.status = "blocked";
      doc.decidedAt = now;
      doc.decidedBy = "policy";
      const combined = appMessages.approval.combinedReason(verdict.reason, reason);
      doc.autoDecisionReason = combined.text;
      doc.autoDecisionReasonLocalized = combined.localized;
      doc.timeline.push(
        timelineEntry(now, appMessages.approval.actorAuto, appMessages.approval.blockedTimeline(combined)),
      );
    }
    doc.updatedAt = now;
    return snapshotApproval(doc);
  }, input.runtime.ctx);
  input.runtime.emit({ type: "approval", approval: toApprovalDTO(updated) });
  return updated;
}

/** Draft overlays are settled after commit; never expose one to callers. */
function snapshotApproval(record: ApprovalRecord): ApprovalRecord {
  return JSON.parse(JSON.stringify(record)) as ApprovalRecord;
}

export function toEvaluatorConfig(app: AppRecord): ApprovalEvaluatorConfig {
  const model = { providerId: app.approval.providerId, modelId: app.approval.modelId };
  if (app.approval.kind === "classifier") {
    return { kind: "classifier", model, criteriaVersion: app.approval.criteriaVersion };
  }
  return {
    kind: "llm",
    model,
    effort: app.approval.effort,
    criteriaVersion: app.approval.criteriaVersion,
  };
}

type ApprovalDirectoryBinding = Pick<
  ApprovalRequest,
  "directoryWorkContextId" | "directoryVersion" | "directoryPaths"
>;

async function directoryScopeMatchesCurrentWorkContext(
  runtime: EmitRuntime,
  request: ApprovalDirectoryBinding,
): Promise<{ matches: boolean; currentVersion: number }> {
  if (request.directoryWorkContextId.length === 0) return { matches: false, currentVersion: 0 };
  const workContext = liveWorkContext(
    await runtime.readFamily(WorkContextDoc, request.directoryWorkContextId, { id: request.directoryWorkContextId }),
  );
  return {
    matches: workContextDirectoryMatchesSnapshot(
      workContext,
      request.directoryWorkContextId,
      request.directoryVersion,
      request.directoryPaths,
    ),
    currentVersion: workContext?.directories?.version ?? 0,
  };
}

async function invalidateApprovalForDirectoryChange(
  runtime: EmitRuntime,
  id: string,
): Promise<ApprovalRecord> {
  const updated = await runtime.harness.commit(async (tx) => {
    const approval = await tx.doc(ApprovalDoc, id, { id });
    if (
      !["evaluating", "pending-human", "approved"].includes(approval.status) ||
      approval.executionState !== "not-started"
    ) {
      return snapshotApproval(approval);
    }
    const workContext =
      approval.directoryWorkContextId.length > 0
        ? liveWorkContext(
            await tx.doc(WorkContextDoc, approval.directoryWorkContextId, { id: approval.directoryWorkContextId }),
          )
        : undefined;
    if (
      workContextDirectoryMatchesSnapshot(
        workContext,
        approval.directoryWorkContextId,
        approval.directoryVersion,
        approval.directoryPaths,
      )
    ) {
      return snapshotApproval(approval);
    }
    invalidateApproval(approval, workContext?.directories?.version ?? 0);
    return snapshotApproval(approval);
  }, runtime.ctx);
  if (updated.status === "invalidated") runtime.emit({ type: "approval", approval: toApprovalDTO(updated) });
  return updated;
}

/**
 * Wait for the human's answer by polling the committed document.
 *
 * The invocation's abort signal is deliberately not the cancellation source.
 * A recovered invocation can arrive with an already-aborted signal, and the
 * whole point of the gate is that a decision made after a restart still
 * applies; stopping a run is expressed durably instead, by cancelling the
 * work's approvals, or by marking the task aborted, both of which this loop
 * observes as a terminal status.
 */
async function waitForHuman(
  runtime: EmitRuntime,
  id: string,
  workId: string,
  toolTaskId: HarnessTaskId,
  request: ApprovalRequest,
): Promise<string> {
  for (;;) {
    // A stop is a durable mark on the task itself. Waiting for the approval
    // document alone would deadlock the very call that has to finish before an
    // aborted conversation can go idle.
    const task = await runtime.harness.getTask(toolTaskId, runtime.ctx).catch(() => undefined);
    if (task?.abortRequested === true) return "cancelled";
    const snapshot = await runtime.readFamily(ApprovalDoc, id, { id });
    const status = snapshot?.status ?? "pending-human";
    if (status !== "pending-human" && status !== "evaluating") return status;
    const directory = await directoryScopeMatchesCurrentWorkContext(runtime, request);
    if (!directory.matches) {
      const invalidated = await invalidateApprovalForDirectoryChange(runtime, id);
      return invalidated.status;
    }
    // A work that ended without cancelling its approvals must not trap the call
    // waiting for a decision nobody will make.
    const work = await runtime.readFamily(WorkDoc, workId, { id: workId });
    if (work === undefined) return "cancelled";
    if (work.status !== "running" && work.status !== "waiting-approval" && work.status !== "queued") {
      return "cancelled";
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 700);
    await promise;
  }
}

export type DecisionResult = { ok: true; record: ApprovalRecord } | { ok: false; message: AppText };

export async function decideApproval(
  runtime: EmitRuntime,
  id: string,
  decision: "approved" | "rejected",
  comment: string,
): Promise<DecisionResult> {
  const existing = await findApproval(runtime, id);
  if (existing === undefined) return { ok: false, message: appMessages.approval.notFoundWithId(id) };
  if (existing.status === "pending-human") {
    const directory = await directoryScopeMatchesCurrentWorkContext(runtime, existing);
    if (!directory.matches) {
      const invalidated = await invalidateApprovalForDirectoryChange(runtime, id);
      return { ok: false, message: blockedMessage(invalidated) };
    }
  }
  const updated = await runtime.updateFamily(ApprovalDoc, id, { id }, (doc) => {
    if (doc.status !== "pending-human") return;
    const now = Date.now();
    doc.status = decision;
    doc.decidedAt = now;
    doc.decidedBy = "user";
    doc.comment = comment;
    doc.updatedAt = now;
    doc.timeline.push(
      timelineEntry(now, appMessages.approval.actorYou, appMessages.approval.decidedWithComment(decision, comment)),
    );
  });
  const record = updated.status === existing.status ? existing : updated;
  runtime.emit({ type: "approval", approval: toApprovalDTO(record) });
  if (record.status !== decision) {
    return { ok: false, message: appMessages.approval.alreadyDecided(record.status) };
  }
  return { ok: true, record };
}

/** Record the terminal execution state after a grant has been claimed. */
export async function recordExecution(
  runtime: EmitRuntime,
  id: string,
  state: "succeeded" | "failed" | "interrupted",
  detail: AppText,
): Promise<void> {
  const updated = await runtime.updateFamily(ApprovalDoc, id, { id }, (doc) => {
    doc.executionState = state;
    // The raw detail keeps its current length budget; each display language
    // gets the same budget so no language shows a longer record than today.
    doc.executionDetail = detail.text.slice(0, 2_000);
    doc.executionDetailLocalized =
      detail.localized === undefined
        ? undefined
        : {
            en: detail.localized.en.slice(0, 2_000),
            "zh-CN": detail.localized["zh-CN"].slice(0, 2_000),
          };
    doc.updatedAt = Date.now();
  });
  runtime.emit({ type: "approval", approval: toApprovalDTO(updated) });
}

/**
 * Atomically validate and claim one grant immediately before execution. The
 * running state is committed with the current work-context directory check, so a
 * concurrent directory change either invalidates this grant first or sees an
 * already-started tool that is allowed to finish.
 */
export async function verifyGrant(
  runtime: EmitRuntime,
  employee: Readonly<EmployeeRecord>,
  app: Readonly<AppRecord>,
  request: ApprovalRequest,
): Promise<GrantDecision> {
  const id = approvalId(request, employee.configVersion, app.policyVersion);
  if ((await findApproval(runtime, id)) === undefined) {
    return { allow: false, message: "No approval record was found for this call; execution was blocked" };
  }
  const liveContext = liveWorkContext(
    await runtime.readFamily(WorkContextDoc, request.directoryWorkContextId, { id: request.directoryWorkContextId }),
  );
  if (liveContext === undefined) {
    const invalidated = await invalidateApprovalForDirectoryChange(runtime, id);
    return { allow: false, message: blockedMessage(invalidated).text };
  }
  const claim = await runtime.harness.commit(async (tx) => {
    const record = await tx.doc(ApprovalDoc, id, { id });
    if (record.createdAt === 0) {
      return { decision: { allow: false, message: "No approval record was found for this call; execution was blocked" } as GrantDecision };
    }
    if (
      record.argsHash !== hashArguments(request.arguments) ||
      record.cwd !== request.cwd ||
      record.directoryWorkContextId !== request.directoryWorkContextId ||
      record.directoryRoomId !== request.directoryRoomId ||
      record.directoryVersion !== request.directoryVersion ||
      record.directoryPaths.length !== request.directoryPaths.length ||
      record.directoryPaths.some((path, index) => path !== request.directoryPaths[index]) ||
      record.targetPaths.length !== request.targetPaths.length ||
      record.targetPaths.some((path, index) => path !== request.targetPaths[index])
    ) {
      return {
        decision: {
          allow: false,
          message: "The approval record does not match the current arguments or session directories; execution was blocked",
        } as GrantDecision,
      };
    }
    if (record.status !== "approved") {
      return { decision: { allow: false, message: blockedMessage(record).text } as GrantDecision };
    }
    if (record.executionState !== "not-started") {
      return {
        decision: {
          allow: false,
          message: `This call's approval was already used (state ${record.executionState}); start a new request to retry`,
        } as GrantDecision,
      };
    }

    const workContext = liveWorkContext(
      await tx.doc(WorkContextDoc, request.directoryWorkContextId, { id: request.directoryWorkContextId }),
    );
    if (
      !workContextDirectoryMatchesSnapshot(
        workContext,
        request.directoryWorkContextId,
        request.directoryVersion,
        request.directoryPaths,
      )
    ) {
      invalidateApproval(record, workContext?.directories?.version ?? 0);
      return {
        decision: { allow: false, message: blockedMessage(record).text } as GrantDecision,
        updated: snapshotApproval(record),
      };
    }

    record.executionState = "running";
    const started = appMessages.approval.executionStarted(request.toolName);
    record.executionDetail = started.text;
    record.executionDetailLocalized = started.localized;
    record.updatedAt = Date.now();
    const snapshot = snapshotApproval(record);
    return {
      decision: { allow: true, record: snapshot } as GrantDecision,
      updated: snapshot,
    };
  }, runtime.ctx);
  if (claim.updated !== undefined) {
    runtime.emit({ type: "approval", approval: toApprovalDTO(claim.updated) });
  }
  return claim.decision;
}

export type GrantDecision = { allow: true; record: ApprovalRecord } | { allow: false; message: string };

/** Cancel every undecided approval of a stopped work item. */
export async function cancelApprovalsForWork(runtime: EmitRuntime, workId: string): Promise<number> {
  const candidates = (await listApprovals(runtime)).filter(
    (record) => record.workId === workId && (record.status === "pending-human" || record.status === "evaluating"),
  );
  for (const record of candidates) {
    const updated = await runtime.updateFamily(ApprovalDoc, record.id, { id: record.id }, (doc) => {
      if (doc.status !== "pending-human" && doc.status !== "evaluating") return;
      const now = Date.now();
      doc.status = "cancelled";
      doc.updatedAt = now;
      doc.timeline.push(timelineEntry(now, appMessages.approval.actorSystem, appMessages.approval.workStopped));
    });
    runtime.emit({ type: "approval", approval: toApprovalDTO(updated) });
  }
  return candidates.length;
}

/**
 * Retire unconsumed approvals whose policy or work-directory snapshot is
 * stale. This also repairs the brief gap between a work-context save and its
 * route-level grant-invalidation call after a process restart.
 */
export async function invalidateStaleGrants(runtime: EmitRuntime, policyVersion: number): Promise<number> {
  const eligible = (await listApprovals(runtime)).filter(
    (record) =>
      ["approved", "pending-human", "evaluating"].includes(record.status) &&
      record.executionState === "not-started",
  );
  let invalidated = 0;
  for (const record of eligible) {
    const workContext =
      record.directoryWorkContextId.length > 0
        ? liveWorkContext(
            await runtime.readFamily(WorkContextDoc, record.directoryWorkContextId, {
              id: record.directoryWorkContextId,
            }),
          )
        : undefined;
    const directoryIsCurrent = workContextDirectoryMatchesSnapshot(
      workContext,
      record.directoryWorkContextId,
      record.directoryVersion,
      record.directoryPaths,
    );
    const stalePolicy = record.policyVersion < policyVersion;
    if (directoryIsCurrent && !stalePolicy) continue;
    const updated = await runtime.updateFamily(ApprovalDoc, record.id, { id: record.id }, (doc) => {
      if (
        !["approved", "pending-human", "evaluating"].includes(doc.status) ||
        doc.executionState !== "not-started"
      ) {
        return;
      }
      if (!directoryIsCurrent) {
        invalidateApproval(doc, workContext?.directories?.version ?? 0);
      } else {
        const now = Date.now();
        const reason = appMessages.approval.policyUpdated(policyVersion);
        doc.status = "invalidated";
        doc.autoDecisionSource = "policy";
        doc.autoDecisionReason = reason.text;
        doc.autoDecisionReasonLocalized = reason.localized;
        doc.evidence = policyEvidence(reason);
        doc.decidedAt = now;
        doc.decidedBy = "policy";
        doc.updatedAt = now;
        doc.timeline.push(timelineEntry(now, appMessages.approval.actorSystem, reason));
      }
    });
    if (updated.status === "invalidated") {
      invalidated += 1;
      runtime.emit({ type: "approval", approval: toApprovalDTO(updated) });
    }
  }
  return invalidated;
}

/** Invalidate every unconsumed approval tied to an older version of one work context. */
export async function invalidateWorkContextDirectoryGrants(
  runtime: EmitRuntime,
  workContextId: string,
  currentVersion: number,
): Promise<number> {
  const candidates = (await listApprovals(runtime)).filter(
    (record) =>
      record.directoryWorkContextId === workContextId &&
      record.directoryVersion < currentVersion &&
      ["approved", "pending-human", "evaluating"].includes(record.status) &&
      record.executionState === "not-started",
  );
  let invalidated = 0;
  for (const record of candidates) {
    const updated = await runtime.updateFamily(ApprovalDoc, record.id, { id: record.id }, (doc) => {
      if (
        doc.directoryWorkContextId !== workContextId ||
        doc.directoryVersion >= currentVersion ||
        !["approved", "pending-human", "evaluating"].includes(doc.status) ||
        doc.executionState !== "not-started"
      ) {
        return;
      }
      invalidateApproval(doc, currentVersion);
    });
    if (updated.status === "invalidated") {
      invalidated += 1;
      runtime.emit({ type: "approval", approval: toApprovalDTO(updated) });
    }
  }
  return invalidated;
}

/** Read the work binding a tool or hook needs from its own conversation. */
export async function readBinding(
  runtime: EmitRuntime,
  conversationId: number,
): Promise<ConversationContextRecord | undefined> {
  const record = await runtime.readConversationDoc(ConversationContextDoc, conversationId);
  if (record === undefined || record.workId.length === 0) return undefined;
  return record;
}
