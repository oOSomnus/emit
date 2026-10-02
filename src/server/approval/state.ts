/**
 * The approval lifecycle.
 *
 * One approval case is created per gated tool call, keyed deterministically by
 * the tool task, the employee, the normalized arguments, the working directory,
 * and the configuration versions in force. That key is what makes the whole
 * path durable:
 *
 *  - the gate runs before the harness records the tool intent, so a process
 *    that dies while a human is deciding has recorded no side effect at all;
 *  - a restarted call recomputes the same key and finds the same case, so a
 *    decision is never asked for twice;
 *  - a grant is bound to the arguments, directory, and configuration versions
 *    it was issued for, so it cannot be reused for a different call.
 *
 * The gate waits for a human by polling the committed document rather than by
 * holding an in-process promise, because that is the only state a new process
 * can see.
 */

import { createHash } from "node:crypto";
import type { ApprovalDTO, ApprovalEvidenceDTO } from "../../shared/contracts.ts";
import { AppDoc, ApprovalDoc, ConversationContextDoc, EmployeeDoc, RoomDoc, WorkDoc } from "../documents.ts";
import {
  type ApprovalRecord,
  type AppRecord,
  type ConversationContextRecord,
  type EmployeeRecord,
  type RoomRecord,
  type WorkRecord,
} from "../documents.ts";
import { ROOM_PAGE_SIZE, listRoomMessages } from "../rooms.ts";
import type { EmitRuntime } from "../runtime.ts";

/** The harness brands task ids; this app carries them as plain strings. */
type HarnessTaskId = Parameters<EmitRuntime["harness"]["getTask"]>[0];
import type { ApprovalCase, ApprovalEvaluatorConfig, ApprovalUserIntent, EvaluationOutcome } from "./contracts.ts";
import {
  CLASSIFIER_CRITERIA_VERSION,
  LLM_CRITERIA_VERSION,
  createClassifierEvaluator,
  createLlmEvaluator,
  redactApprovalText,
  redactArguments,
} from "./evaluators.ts";
import { parseJsonObject } from "../llm.ts";

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
  /** Canonical normalized arguments; hashed, never sent raw to a model. */
  arguments: unknown;
  cwd: string;
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
    String(configVersion),
    String(policyVersion),
  ].join("\u0000");
  return `ap_${createHash("sha256").update(material).digest("hex").slice(0, 32)}`;
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
    risk: record.risk,
    status: record.status,
    execution: {
      state: record.executionState,
      detail: record.executionDetail.length > 0 ? record.executionDetail : undefined,
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
    timeline: record.timeline.map((entry) => ({ at: entry.at, actor: entry.actor, text: entry.text })),
  };
}

function toEvidenceDTO(record: ApprovalRecord): ApprovalEvidenceDTO | undefined {
  const evidence = record.evidence;
  if (evidence === null) return undefined;
  if (evidence.kind === "policy") return { kind: "policy", rationale: evidence.rationale };
  if (evidence.kind === "llm") {
    return {
      kind: "llm",
      ...(evidence.criteriaVersion !== undefined ? { criteriaVersion: evidence.criteriaVersion } : {}),
      rationale: evidence.rationale,
      risk: evidence.risk,
      recommendation: evidence.recommendation,
      ...(typeof evidence.readOnly === "boolean" ? { readOnly: evidence.readOnly } : {}),
      ...(evidence.userAuthorization !== undefined ? { userAuthorization: evidence.userAuthorization } : {}),
    };
  }
  const answer: Extract<ApprovalEvidenceDTO, { kind: "classifier" }> = {
    kind: "classifier",
    criteriaVersion: evidence.criteriaVersion,
    questions: parseStoredQuestions(evidence.questions),
    answers: [],
  };
  if (evidence.probability !== null && Number.isFinite(evidence.probability)) {
    answer.answers.push({
      key: "decision",
      choice: evidence.choice,
      probabilities: { [evidence.choice]: evidence.probability },
    });
  } else {
    answer.answers.push({ key: "decision", choice: evidence.choice });
  }
  if (
    evidence.readOnlyProbability !== null &&
    evidence.readOnlyProbability !== undefined &&
    Number.isFinite(evidence.readOnlyProbability)
  ) {
    answer.readOnlyProbability = evidence.readOnlyProbability;
    answer.answers.push({ key: "read_only", probability: evidence.readOnlyProbability });
  }
  if (evidence.authorizedProbability !== null && Number.isFinite(evidence.authorizedProbability)) {
    answer.authorizedProbability = evidence.authorizedProbability;
    answer.answers.push({ key: "authorized", probability: evidence.authorizedProbability });
  }
  return answer;
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
  /** Tool task that asked; the approval key is derived from it. */
  toolTaskId: string;
  /** Execution conversation the tool call belongs to. */
  conversationId: number;
  toolName: string;
  toolKind: "file-write" | "shell" | "mcp" | "other";
  /** Raw validated arguments, hashed but never sent to a model. */
  arguments: unknown;
  signal: AbortSignal | undefined;
};

export type GateDecision = { allow: true; record: ApprovalRecord } | { allow: false; message: string };

/**
 * The complete gate: create or find the case, run the configured evaluator when
 * it has not been answered yet, and wait for a human when the evaluator
 * declines to decide.
 */
export async function gateToolCall(input: GateInput): Promise<GateDecision> {
  const { runtime } = input;
  const app = await runtime.readSession(AppDoc);
  const binding = await runtime.readConversationDoc(ConversationContextDoc, input.conversationId);
  if (binding === undefined || binding.workId.length === 0) {
    return { allow: false, message: "该会话没有绑定工作上下文，已阻止工具调用" };
  }
  const employee = await runtime.readFamily(EmployeeDoc, binding.employeeId, { id: binding.employeeId });
  if (employee === undefined) return { allow: false, message: "找不到员工记录，已阻止工具调用" };
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
    cwd: employee.cwd,
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
    doc.argumentsPreview = redactArguments(request.arguments as Record<string, unknown>);
    doc.cwd = request.cwd;
    doc.risk = request.toolKind;
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
    doc.evidence = { kind: "policy", rationale: "等待自动判断" };
    doc.timeline = [{ at: now, actor: "system", text: `提交审批：${request.toolName}` }];
  });

  runtime.emit({ type: "approval", approval: toApprovalDTO(created) });

  if (created.status === "approved") return { allow: true, record: created };
  if (created.status !== "evaluating" && created.status !== "pending-human") {
    return { allow: false, message: blockedMessage(created) };
  }

  const context: GateContext = {
    runtime,
    employee,
    app,
    request,
    binding,
    room,
    work,
    signal: input.signal,
  };

  let record = created;
  if (record.status === "evaluating") {
    record = await evaluateAndPersist(context, record);
    runtime.emit({ type: "approval", approval: toApprovalDTO(record) });
    if (record.status === "approved") return { allow: true, record };
    if (record.status !== "pending-human") return { allow: false, message: blockedMessage(record) };
  }

  // An approval that already exists as pending-human is one this exact call is
  // supposed to keep waiting on, not one it may treat as a refusal. That is
  // what makes a crash during the wait survivable: the recovered tool call
  // re-enters here, finds its own pending approval, and waits again.
  await setWorkStatus(runtime, binding.workId, "waiting-approval");
  runtime.emit({ type: "notice", text: `审批 ${record.id} 等待你的裁决（${request.toolName}）` });

  const finalStatus = await waitForHuman(runtime, id, binding.workId, input.toolTaskId as unknown as HarnessTaskId);
  const latest = (await runtime.readFamily(ApprovalDoc, id, { id })) ?? record;
  if (finalStatus === "approved") {
    await setWorkStatus(runtime, binding.workId, "running");
    return { allow: true, record: latest };
  }
  await setWorkStatus(runtime, binding.workId, "running", true);
  if (finalStatus === "cancelled") {
    return { allow: false, message: `工具调用已取消：${request.toolName} 没有执行（工作已停止或调用被中止）` };
  }
  return { allow: false, message: blockedMessage(latest) };
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
  binding: { workId: string; rootWorkId: string; roomId: string; depth: number };
  room: RoomRecord | undefined;
  work: WorkRecord | undefined;
  signal: AbortSignal | undefined;
};

function blockedMessage(record: ApprovalRecord): string {
  switch (record.status) {
    case "rejected":
      return `工具调用被拒绝（审批 ${record.id}）${record.comment.length > 0 ? `：${record.comment}` : ""}`;
    case "cancelled":
      return `工具调用已取消：所属工作已停止（审批 ${record.id}）`;
    case "invalidated":
      return `之前的批准已失效，请重新请求（审批 ${record.id}）`;
    case "pending-human":
      return `等待人工审批（审批 ${record.id}），在“审批”页面批准或拒绝后该调用才会执行`;
    default:
      return `工具调用未获批准（审批 ${record.id}）`;
  }
}

function boundedContextText(value: string): { text: string; truncated: boolean } {
  const redacted = redactApprovalText(value);
  return {
    text: redacted.slice(0, 2_000),
    truncated: redacted.length > 2_000,
  };
}

async function approvalContext(input: GateContext): Promise<{
  userIntent: ApprovalUserIntent;
  recentContext: ApprovalCase["recentContext"];
}> {
  const messages =
    input.room !== undefined ? await listRoomMessages(input.runtime, input.room, ROOM_PAGE_SIZE) : [];
  const sourceMessage =
    input.work?.sourceEntryId.length
      ? messages.find((message) => message.id === input.work?.sourceEntryId)
      : undefined;
  const directUserMessage = sourceMessage?.author.type === "user" ? sourceMessage : undefined;
  const derivedText = input.work?.intent ?? "";
  const userIntentText = directUserMessage?.body ?? derivedText;
  const intentSource = directUserMessage !== undefined
    ? "room-message"
    : input.work?.kind === "delegation"
      ? "delegation"
      : input.work !== undefined
        ? "work-intent"
        : "unknown";
  const boundedIntent = boundedContextText(userIntentText);
  const userIntent: ApprovalUserIntent = {
    ...boundedIntent,
    source: intentSource,
    authorization: directUserMessage !== undefined ? "user" : "unknown",
    ...(directUserMessage !== undefined
      ? {
          at: directUserMessage.createdAt,
          author: {
            id: directUserMessage.author.id,
            name: directUserMessage.author.name,
            type: directUserMessage.author.type,
          },
        }
      : sourceMessage !== undefined
        ? {
            at: sourceMessage.createdAt,
            author: {
              id: sourceMessage.author.id,
              name: sourceMessage.author.name,
              type: sourceMessage.author.type,
            },
          }
        : {}),
  };

  const sourceIndex = sourceMessage === undefined ? -1 : messages.indexOf(sourceMessage);
  const messagesBeforeSource = sourceIndex >= 0 ? messages.slice(0, sourceIndex + 1) : messages;
  const hasDerivedContext = directUserMessage === undefined && derivedText.length > 0;
  const recentMessages = messagesBeforeSource.slice(-(hasDerivedContext ? 11 : 12));
  const recentContext: ApprovalCase["recentContext"] = recentMessages.map((message) => ({
    source: "room-message",
    at: message.createdAt,
    author: {
      id: message.author.id,
      name: message.author.name,
      type: message.author.type,
    },
    ...boundedContextText(message.body),
  }));
  if (hasDerivedContext) {
    recentContext.push({
      source: input.work?.kind === "delegation" ? "delegation" : "work-intent",
      ...boundedContextText(derivedText),
      ...(sourceMessage !== undefined
        ? {
            at: sourceMessage.createdAt,
            author: {
              id: sourceMessage.author.id,
              name: sourceMessage.author.name,
              type: sourceMessage.author.type,
            },
          }
        : {}),
    });
  }
  return { userIntent, recentContext };
}

/** Run the configured evaluator and persist the resulting status. */
async function evaluateAndPersist(input: GateContext, record: ApprovalRecord): Promise<ApprovalRecord> {
  const { runtime, employee, app, request, binding } = input;
  const config = toEvaluatorConfig(app);
  const contextEvidence = await approvalContext(input);
  const approvalCase: ApprovalCase = {
    schemaVersion: 2,
    id: record.id,
    toolTaskId: request.toolTaskId,
    employee: { id: employee.id, name: employee.name, role: employee.role },
    tool: { name: request.toolName, kind: request.toolKind },
    argumentsPreview: record.argumentsPreview,
    cwd: request.cwd,
    allowedTools: [...employee.allowedTools],
    userIntent: contextEvidence.userIntent,
    recentContext: contextEvidence.recentContext,
    origin: {
      kind: binding.roomId.length > 0 ? "room" : "delegation",
      description:
        binding.roomId.length > 0
          ? `来自聊天室「${input.room?.name ?? binding.roomId}」的工作 ${binding.workId}`
          : `来自上层工作 ${input.work?.parentWorkId ?? ""} 的交办`,
    },
    configVersion: employee.configVersion,
    policyVersion: app.policyVersion,
  };

  const evaluator =
    config.kind === "llm" ? createLlmEvaluator(runtime.catalog) : createClassifierEvaluator(runtime.catalog);
  const outcome = await evaluator
    .evaluate(approvalCase, config, {
      evaluationId: record.id,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    })
    .catch((error: unknown): EvaluationOutcome => ({
      status: "unavailable",
      reason: "provider",
      message: error instanceof Error ? error.message : String(error),
    }));

  return persistOutcome(input, record, config, outcome);
}

async function persistOutcome(
  input: GateContext,
  record: ApprovalRecord,
  config: ApprovalEvaluatorConfig,
  outcome: EvaluationOutcome,
): Promise<ApprovalRecord> {
  const { runtime } = input;
  return runtime.updateFamily(ApprovalDoc, record.id, { id: record.id }, (doc) => {
    if (doc.status !== "evaluating") return;
    const now = Date.now();

    if (outcome.status === "unavailable") {
      doc.status = "pending-human";
      doc.autoDecisionSource = "policy";
      doc.autoDecisionReason = `自动判断不可用：${outcome.message}`;
      doc.evidence = { kind: "policy", rationale: `自动判断不可用（${outcome.reason}）：${outcome.message}` };
      doc.timeline.push({ at: now, actor: "system", text: `自动判断不可用，转人工：${outcome.message}` });
    } else if (outcome.evidence.kind === "llm") {
      doc.evidence = {
        kind: "llm",
        criteriaVersion: outcome.evidence.criteriaVersion,
        rationale: outcome.evidence.rationale,
        risk: outcome.evidence.risk,
        recommendation: outcome.evidence.recommendation,
        readOnly: outcome.evidence.readOnly,
        userAuthorization: outcome.evidence.userAuthorization,
      };
      const autoApprove = llmAutoApproves(outcome.evidence);
      doc.risk = outcome.risk;
      doc.autoDecisionSource = "llm";
      doc.autoDecisionReason =
        `LLM 建议 ${outcome.recommendation}（风险 ${outcome.risk}；只读 ${outcome.evidence.readOnly ? "是" : "否"}；用户授权 ${outcome.evidence.userAuthorization}）`;
      if (autoApprove) {
        doc.status = "approved";
        doc.decidedAt = now;
        doc.decidedBy = `llm:${outcome.model.providerId}/${outcome.model.modelId}`;
        doc.timeline.push({ at: now, actor: "自动判断", text: `自动批准：${outcome.evidence.rationale}` });
      } else {
        doc.status = "pending-human";
        doc.timeline.push({
          at: now,
          actor: "自动判断",
          text: `转人工（${outcome.recommendation}，风险 ${outcome.risk}）：${outcome.evidence.rationale}`,
        });
      }
    } else {
      doc.evidence = {
        kind: "classifier",
        criteriaVersion: CLASSIFIER_CRITERIA_VERSION,
        choice: outcome.evidence.choice,
        questions: outcome.evidence.questions,
        probability: outcome.evidence.probability,
        authorizedProbability: outcome.evidence.authorizedProbability ?? null,
        readOnlyProbability: outcome.evidence.readOnlyProbability ?? null,
      };
      const autoApprove =
        config.kind === "classifier" &&
        outcome.recommendation === "approve" &&
        classifierAutoApproves(outcome.evidence, config);
      const detail = describeClassifierEvidence(outcome.evidence);
      doc.autoDecisionSource = "classifier";
      doc.autoDecisionReason = detail;
      if (autoApprove) {
        doc.status = "approved";
        doc.decidedAt = now;
        doc.decidedBy = `classifier:${outcome.model.providerId}/${outcome.model.modelId}`;
        doc.timeline.push({ at: now, actor: "自动判断", text: `自动批准：${detail}` });
      } else {
        doc.status = "pending-human";
        doc.timeline.push({ at: now, actor: "自动判断", text: `转人工：${detail}` });
      }
    }
    doc.updatedAt = now;
  });
}

/**
 * Whether the evaluator's own answer approves the call.
 *
 * Kept as pure functions because these are the thresholds that decide whether a
 * risky call runs unattended; a wrong comparison here is invisible in normal
 * use, so it is tested directly rather than only through a run.
 */
export function llmAutoApproves(evidence: {
  recommendation: string;
  risk: string;
  readOnly: boolean;
  userAuthorization: "high" | "medium" | "low" | "unknown";
}): boolean {
  if (evidence.recommendation !== "approve") return false;
  if (evidence.readOnly && evidence.risk === "low") return true;
  return evidence.risk !== "high";
}

export function classifierAutoApproves(
  evidence: {
    choice: string;
    probability: number | null;
    readOnlyProbability?: number | null;
    authorizedProbability?: number | null;
  },
  config: { minApproveProbability: number; minAuthorizedProbability: number; requireAuthorized: boolean },
): boolean {
  if (
    evidence.choice !== "approve" ||
    typeof evidence.probability !== "number" ||
    !Number.isFinite(evidence.probability) ||
    evidence.probability < 0 ||
    evidence.probability > 1 ||
    typeof config.minApproveProbability !== "number" ||
    !Number.isFinite(config.minApproveProbability) ||
    config.minApproveProbability < 0 ||
    config.minApproveProbability > 1 ||
    typeof evidence.readOnlyProbability !== "number" ||
    !Number.isFinite(evidence.readOnlyProbability) ||
    evidence.readOnlyProbability < 0 ||
    evidence.readOnlyProbability > 1
  ) {
    return false;
  }
  if (evidence.probability < config.minApproveProbability) return false;
  if (evidence.readOnlyProbability >= config.minApproveProbability) return true;
  if (!config.requireAuthorized) return true;
  return (
    typeof evidence.authorizedProbability === "number" &&
    Number.isFinite(evidence.authorizedProbability) &&
    evidence.authorizedProbability >= 0 &&
    evidence.authorizedProbability <= 1 &&
    Number.isFinite(config.minAuthorizedProbability) &&
    config.minAuthorizedProbability >= 0 &&
    config.minAuthorizedProbability <= 1 &&
    evidence.authorizedProbability >= config.minAuthorizedProbability
  );
}

/** The reason line shown next to a classifier decision. */
export function describeClassifierEvidence(evidence: {
  choice: string;
  probability: number | null;
  readOnlyProbability?: number | null;
  authorizedProbability?: number | null;
}): string {
  const probability =
    typeof evidence.probability === "number" && Number.isFinite(evidence.probability)
      ? evidence.probability.toFixed(4)
      : "未记录";
  const readonlyProbability =
    typeof evidence.readOnlyProbability === "number" && Number.isFinite(evidence.readOnlyProbability)
      ? evidence.readOnlyProbability.toFixed(4)
      : "未记录";
  const authorizedProbability =
    typeof evidence.authorizedProbability === "number" && Number.isFinite(evidence.authorizedProbability)
      ? evidence.authorizedProbability.toFixed(4)
      : "未记录";
  return `分类器选择 ${evidence.choice}（概率 ${probability}，只读概率 ${readonlyProbability}，授权概率 ${authorizedProbability}）`;
}

export function toEvaluatorConfig(app: AppRecord): ApprovalEvaluatorConfig {
  if (app.approval.kind === "classifier") {
    return {
      kind: "classifier",
      model: { providerId: app.approval.providerId, modelId: app.approval.modelId },
      criteriaVersion: CLASSIFIER_CRITERIA_VERSION,
      minApproveProbability: app.approval.minApproveProbability,
      minAuthorizedProbability: app.approval.minAuthorizedProbability,
      requireAuthorized: app.approval.requireAuthorized,
    };
  }
  return {
    kind: "llm",
    model: { providerId: app.approval.providerId, modelId: app.approval.modelId },
    effort: app.approval.effort,
    criteriaVersion: LLM_CRITERIA_VERSION,
  };
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
async function waitForHuman(runtime: EmitRuntime, id: string, workId: string, toolTaskId: HarnessTaskId): Promise<string> {
  for (;;) {
    // A stop is a durable mark on the task itself. Waiting for the approval
    // document alone would deadlock the very call that has to finish before an
    // aborted conversation can go idle.
    const task = await runtime.harness.getTask(toolTaskId, runtime.ctx).catch(() => undefined);
    if (task?.abortRequested === true) return "cancelled";
    const snapshot = await runtime.readFamily(ApprovalDoc, id, { id });
    const status = snapshot?.status ?? "pending-human";
    if (status !== "pending-human" && status !== "evaluating") return status;
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

export type DecisionResult = { ok: true; record: ApprovalRecord } | { ok: false; message: string };

export async function decideApproval(
  runtime: EmitRuntime,
  id: string,
  decision: "approved" | "rejected",
  comment: string,
): Promise<DecisionResult> {
  const existing = await findApproval(runtime, id);
  if (existing === undefined) return { ok: false, message: `审批不存在: ${id}` };
  const updated = await runtime.updateFamily(ApprovalDoc, id, { id }, (doc) => {
    if (doc.status !== "pending-human") return;
    const now = Date.now();
    doc.status = decision;
    doc.decidedAt = now;
    doc.decidedBy = "user";
    doc.comment = comment;
    doc.updatedAt = now;
    doc.timeline.push({
      at: now,
      actor: "你",
      text: decision === "approved" ? `批准${comment.length > 0 ? `：${comment}` : ""}` : `拒绝${comment.length > 0 ? `：${comment}` : ""}`,
    });
  });
  const record = updated.status === existing.status ? existing : updated;
  runtime.emit({ type: "approval", approval: toApprovalDTO(record) });
  if (record.status !== decision) {
    return { ok: false, message: `审批已被处理：${record.status}` };
  }
  return { ok: true, record };
}

/** Record that the gated tool started, is done, or was interrupted. */
export async function recordExecution(
  runtime: EmitRuntime,
  id: string,
  state: ApprovalRecord["executionState"],
  detail: string,
): Promise<void> {
  const updated = await runtime.updateFamily(ApprovalDoc, id, { id }, (doc) => {
    doc.executionState = state;
    doc.executionDetail = detail.slice(0, 2_000);
    doc.updatedAt = Date.now();
  });
  runtime.emit({ type: "approval", approval: toApprovalDTO(updated) });
}

/**
 * The execute-time check, which is the one that survives recovery: the harness
 * does not re-run `beforeTool` when it resumes a recorded tool intent, so the
 * tool itself must verify that the grant it holds is still the grant that was
 * issued for these exact arguments and these configuration versions.
 */
export async function verifyGrant(
  runtime: EmitRuntime,
  employee: Readonly<EmployeeRecord>,
  app: Readonly<AppRecord>,
  request: ApprovalRequest,
): Promise<GrantDecision> {
  const id = approvalId(request, employee.configVersion, app.policyVersion);
  const record = await findApproval(runtime, id);
  if (record === undefined) {
    return { allow: false, message: "没有找到本次调用的批准记录，已阻止执行" };
  }
  if (record.argsHash !== hashArguments(request.arguments)) {
    return { allow: false, message: "批准记录与当前参数不一致，已阻止执行" };
  }
  if (record.status !== "approved") {
    return { allow: false, message: blockedMessage(record) };
  }
  if (record.executionState !== "not-started") {
    return {
      allow: false,
      message: `本次调用的批准已被使用（状态 ${record.executionState}）；如确需重试，请重新发起请求`,
    };
  }
  return { allow: true, record };
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
      doc.timeline.push({ at: now, actor: "system", text: "所属工作已停止，审批取消" });
    });
    runtime.emit({ type: "approval", approval: toApprovalDTO(updated) });
  }
  return candidates.length;
}

/**
 * Invalidate grants that were issued under an older policy and never consumed.
 * The key already includes the policy version, so such a grant can never be
 * found again; marking it keeps the approval page honest.
 */
export async function invalidateStaleGrants(runtime: EmitRuntime, policyVersion: number): Promise<number> {
  const stale = (await listApprovals(runtime)).filter(
    (record) => record.status === "approved" && record.executionState === "not-started" && record.policyVersion < policyVersion,
  );
  for (const record of stale) {
    const updated = await runtime.updateFamily(ApprovalDoc, record.id, { id: record.id }, (doc) => {
      if (doc.status !== "approved" || doc.executionState !== "not-started") return;
      const now = Date.now();
      doc.status = "invalidated";
      doc.updatedAt = now;
      doc.timeline.push({ at: now, actor: "system", text: `审批策略已更新（v${policyVersion}），旧批准失效` });
    });
    runtime.emit({ type: "approval", approval: toApprovalDTO(updated) });
  }
  return stale.length;
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
