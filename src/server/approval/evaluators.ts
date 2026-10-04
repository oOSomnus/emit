/**
 * Structured approval reviewers. A verdict is based on one complete action
 * and a bounded, provenance-labelled view of its actual execution transcript.
 */

import type { JsonObject } from "@earendil-works/pi-durable";
import type { ClassifierAnswer } from "@earendil-works/pi-ai";
import type { ModelCatalog } from "../models.ts";
import { completeText, parseJsonObject } from "../llm.ts";
import {
  classifierEvidenceTrust,
  classifierQuestions,
  renderApprovalSystem,
  renderApprovalUser,
} from "../prompts/index.ts";
import { isLocalizedText, type LocalizedText } from "../../shared/i18n.ts";
import { rawText, type AppText } from "../app-text.ts";
import { appMessages } from "../messages.ts";
import { modelMessages } from "../messages/models.ts";
import type {
  ApprovalCase,
  ApprovalContextEntry,
  ApprovalEvaluator,
  ApprovalEvaluatorConfig,
  EvaluationContext,
  EvaluationOutcome,
  RiskLevel,
  ReviewOutcome,
  UserAuthorizationLevel,
} from "./contracts.ts";

/** Bump when reviewer criteria change so audits retain the applicable policy. */
export const CLASSIFIER_CRITERIA_VERSION = 3;
export const LLM_CRITERIA_VERSION = 3;

const RISK_LEVELS = ["low", "medium", "high", "critical", "unknown"] as const;
const OUTCOMES = ["allow", "deny"] as const;
const USER_AUTHORIZATIONS = ["high", "medium", "low", "unknown"] as const;
const MAX_REVIEW_BYTES = 64_000;
const RESERVED_CONTEXT_TOKENS = 4_096;
/** Fixed output budget for one verdict: enough for reasoning plus the JSON. */
const MAX_REVIEW_OUTPUT_TOKENS = 4_096;
const MAX_HISTORY_ENTRY_BYTES = 8_000;

function isRiskLevel(value: unknown): value is RiskLevel {
  return typeof value === "string" && (RISK_LEVELS as readonly string[]).includes(value);
}

function isReviewOutcome(value: unknown): value is ReviewOutcome {
  return typeof value === "string" && (OUTCOMES as readonly string[]).includes(value);
}

function isUserAuthorization(value: unknown): value is UserAuthorizationLevel {
  return typeof value === "string" && (USER_AUTHORIZATIONS as readonly string[]).includes(value);
}

function probabilityOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

function isProbabilityMap(value: unknown): value is Record<string, number> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length > 0 && entries.every(([, probability]) => probabilityOrNull(probability) !== null);
}

/** An unavailable evaluation from a catalog message; `verbatim` marks self-contained sentences. */
function unavailable(
  reason: "configuration" | "provider" | "invalid-output",
  message: AppText,
  verbatim?: true,
): EvaluationOutcome {
  return {
    status: "unavailable",
    reason,
    message: message.text,
    ...(message.localized !== undefined ? { messageLocalized: message.localized } : {}),
    ...(verbatim === true ? { verbatim: true } : {}),
  };
}

/** A failed fit from a catalog message. */
function fitFailure(reason: "configuration" | "budget", message: AppText, verbatim?: true): FitResult {
  return {
    ok: false,
    reason,
    message: message.text,
    ...(message.localized !== undefined ? { messageLocalized: message.localized } : {}),
    ...(verbatim === true ? { verbatim: true } : {}),
  };
}

/** Remove obvious inline credentials before request text or arguments reach a reviewer or the page. */
export function redactApprovalText(value: string): string {
  return value
    .replace(
      /((?:["']?)(?:api[_-]?key|access[_-]?key|private[_-]?key|token|password|passphrase|passwd|secret|credential|authorization|cookie)(?:["']?\s*[:=]\s*))("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|Bearer\s+[^\s,;}\]]+|[^\s,;}\]]+)/gi,
      "$1[已隐去]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [已隐去]")
    .replace(/\b(?:sk|ghp|github_pat|xox[baprs])-[A-Za-z0-9_-]{8,}\b/gi, "[已隐去]");
}

/** Full redacted JSON for review. This deliberately does not truncate any action argument. */
export function redactArguments(value: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (input: unknown): unknown => {
    if (typeof input === "string") return redactApprovalText(input);
    if (typeof input !== "object" || input === null) return input;
    if (seen.has(input)) return "[循环]";
    seen.add(input);
    if (Array.isArray(input)) return input.map(walk);
    const output: Record<string, unknown> = Object.create(null);
    for (const [key, entry] of Object.entries(input)) {
      output[key] = /(secret|token|password|passphrase|passwd|private[_-]?key|credential|access[_-]?key|api[_-]?key|authorization|cookie)/i.test(key)
        ? "[已隐去]"
        : walk(entry);
    }
    return output;
  };
  return JSON.stringify(walk(value) ?? null);
}

/** Human-only preview; it never substitutes for the full action sent to review. */
export function argumentsPreview(value: unknown): string {
  const full = redactArguments(value);
  return full.length <= 8_000 ? full : `${full.slice(0, 4_000)}\n[…中间内容已省略…]\n${full.slice(-4_000)}`;
}

function takeUtf8Prefix(value: string, maxBytes: number): string {
  let bytes = 0;
  let result = "";
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (bytes + charBytes > maxBytes) break;
    result += char;
    bytes += charBytes;
  }
  return result;
}

function takeUtf8Suffix(value: string, maxBytes: number): string {
  let bytes = 0;
  let result = "";
  for (let end = value.length; end > 0; ) {
    let start = end - 1;
    const lastCodeUnit = value.charCodeAt(start);
    if (lastCodeUnit >= 0xdc00 && lastCodeUnit <= 0xdfff && start > 0) {
      const previousCodeUnit = value.charCodeAt(start - 1);
      if (previousCodeUnit >= 0xd800 && previousCodeUnit <= 0xdbff) start -= 1;
    }
    const char = value.slice(start, end);
    const charBytes = Buffer.byteLength(char, "utf8");
    if (bytes + charBytes > maxBytes) break;
    result = char + result;
    bytes += charBytes;
    end = start;
  }
  return result;
}

/** Every historical item is individually bounded while retaining both ends. */
function boundHistoryEntry(entry: ApprovalContextEntry): ApprovalContextEntry {
  if (Buffer.byteLength(entry.text, "utf8") <= MAX_HISTORY_ENTRY_BYTES) return entry;
  const prefix = takeUtf8Prefix(entry.text, 3_800);
  const suffix = takeUtf8Suffix(entry.text, 3_800);
  const omitted = Buffer.byteLength(entry.text, "utf8") - Buffer.byteLength(prefix + suffix, "utf8");
  return {
    ...entry,
    text: `${prefix}\n[…省略 ${omitted} UTF-8 字节…]\n${suffix}`,
    truncated: true,
  };
}

type HistoryGroup = { order: number; entries: ApprovalContextEntry[] };

/** Keep each tool call paired with its result while allowing other history to be budgeted independently. */
function groupExecutionContext(entries: readonly ApprovalContextEntry[]): HistoryGroup[] {
  const groups: HistoryGroup[] = [];
  const pendingCalls = new Set<string>();
  let start = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (entry.role === "assistant" && entry.toolCallId !== undefined) {
      pendingCalls.add(entry.toolCallId);
    } else if (entry.role === "toolResult" && entry.toolCallId !== undefined) {
      pendingCalls.delete(entry.toolCallId);
    }
    if (pendingCalls.size === 0) {
      groups.push({ order: start, entries: entries.slice(start, index + 1) });
      start = index + 1;
    }
  }
  if (start < entries.length) groups.push({ order: start, entries: entries.slice(start) });
  return groups;
}

type FitResult =
  | { ok: true; input: ApprovalCase }
  | {
      ok: false;
      reason: "configuration" | "budget";
      message: string;
      /** Present when the message is application-authored. */
      messageLocalized?: LocalizedText;
      /** Budget messages are complete sentences stored verbatim. */
      verbatim?: true;
    };

/**
 * Reserve the required context first, then allocate remaining bytes to the
 * newest execution groups and newest room/delegation entries. The serializer
 * measures the exact dynamic input for the evaluator that calls this helper.
 */
function fitApprovalCase(
  input: ApprovalCase,
  contextWindow: number,
  serializedInput: (candidate: ApprovalCase) => string,
): FitResult {
  if (!Number.isFinite(contextWindow) || contextWindow <= RESERVED_CONTEXT_TOKENS) {
    return fitFailure("configuration", appMessages.approval.fitConfiguration);
  }
  const byteLimit = Math.min(MAX_REVIEW_BYTES, Math.floor(contextWindow - RESERVED_CONTEXT_TOKENS));
  if (byteLimit <= 0) {
    return fitFailure("configuration", appMessages.approval.fitConfiguration);
  }

  const execution = input.executionContext.map(boundHistoryEntry);
  const recent = input.recentContext.map(boundHistoryEntry);
  const executionGroups = groupExecutionContext(execution);
  const recentGroups = recent.map((entry, index) => ({ order: index, entries: [entry] }));
  const allHistoryCount = execution.length + recent.length;
  const selectedExecution = new Set<number>();
  const selectedRecent = new Set<number>();

  const serialize = (): { candidate: ApprovalCase; byteLength: number } => {
    const executionEntries = executionGroups
      .filter((group, index) => selectedExecution.has(index))
      .sort((left, right) => left.order - right.order)
      .flatMap((group) => group.entries);
    const recentEntries = recentGroups
      .filter((_, index) => selectedRecent.has(index))
      .sort((left, right) => left.order - right.order)
      .flatMap((group) => group.entries);
    const includedHistoryCount = executionEntries.length + recentEntries.length;
    const candidate: ApprovalCase = {
      ...input,
      executionContext: executionEntries,
      recentContext: recentEntries,
      contextBudget: {
        omittedEntries: input.contextBudget.omittedEntries + allHistoryCount - includedHistoryCount,
        truncatedEntries:
          input.contextBudget.truncatedEntries +
          [...executionEntries, ...recentEntries].filter((entry) => entry.truncated).length,
      },
    };
    return { candidate, byteLength: Buffer.byteLength(serializedInput(candidate), "utf8") };
  };

  const empty = serialize();
  if (empty.byteLength > byteLimit) {
    const noArguments = Buffer.byteLength(serializedInput({ ...empty.candidate, arguments: "" }), "utf8");
    return noArguments <= byteLimit
      ? fitFailure("budget", appMessages.approval.fitBudgetArguments, true)
      : fitFailure("budget", appMessages.approval.fitBudgetContext, true);
  }

  for (let index = executionGroups.length - 1; index >= 0; index -= 1) {
    selectedExecution.add(index);
    if (serialize().byteLength > byteLimit) {
      selectedExecution.delete(index);
      break;
    }
  }
  for (let index = recentGroups.length - 1; index >= 0; index -= 1) {
    selectedRecent.add(index);
    if (serialize().byteLength > byteLimit) {
      selectedRecent.delete(index);
      break;
    }
  }

  const fitted = serialize();
  if (fitted.byteLength > byteLimit) {
    return fitFailure("budget", appMessages.approval.fitBudgetContext, true);
  }
  return { ok: true, input: fitted.candidate };
}


/** The approval case fields, serialized once so the fit lambda and the call agree. */
function approvalCaseJson(input: ApprovalCase): string {
  return JSON.stringify({
    id: input.id,
    toolTaskId: input.toolTaskId,
    employee: input.employee,
    userIntent: input.userIntent,
    origin: input.origin,
    recentContext: input.recentContext,
    executionContext: input.executionContext,
    contextBudget: input.contextBudget,
    directories: input.directories,
    targetPaths: input.targetPaths,
    cwd: input.cwd,
    allowedTools: input.allowedTools,
    tool: input.tool,
    arguments: input.arguments,
    configVersion: input.configVersion,
    policyVersion: input.policyVersion,
    schemaVersion: input.schemaVersion,
  });
}

function classifierState(input: ApprovalCase): JsonObject {
  const state = {
    id: input.id,
    tool_task_id: input.toolTaskId,
    schema_version: input.schemaVersion,
    employee: input.employee,
    verified_user_intent: input.userIntent,
    recent_room_context: input.recentContext,
    active_execution_context: input.executionContext,
    context_budget: input.contextBudget,
    directories: input.directories,
    target_paths: input.targetPaths,
    cwd: input.cwd,
    allowed_tools: input.allowedTools,
    tool: input.tool,
    arguments: input.arguments,
    origin: input.origin,
    config_version: input.configVersion,
    policy_version: input.policyVersion,
    evidence_trust: classifierEvidenceTrust,
  };
  return JSON.parse(JSON.stringify(state)) as JsonObject;
}


type ChoiceAnswer = Extract<ClassifierAnswer, { type: "choice" }>;

type ValidChoiceAnswer = { answer: ChoiceAnswer; probability: number };


function validatedChoiceAnswer(
  answer: unknown,
  allowedChoices: readonly string[],
): ValidChoiceAnswer | undefined {
  if (typeof answer !== "object" || answer === null || Array.isArray(answer)) return undefined;
  const candidate = answer as Record<string, unknown>;
  if (candidate.type !== "choice" || typeof candidate.choice !== "string") return undefined;
  if (!allowedChoices.includes(candidate.choice) || !isProbabilityMap(candidate.probabilities)) return undefined;
  const probability = probabilityOrNull(candidate.probabilities[candidate.choice]);
  if (probability === null) return undefined;
  return { answer: candidate as unknown as ChoiceAnswer, probability };
}

type BoolEvidence = {
  valid: boolean;
  value: boolean | null;
  probability: number | null;
};

function boolEvidence(answer: unknown): BoolEvidence {
  if (answer === undefined) return { valid: true, value: null, probability: null };
  if (typeof answer !== "object" || answer === null || Array.isArray(answer)) {
    return { valid: false, value: null, probability: null };
  }
  const candidate = answer as Record<string, unknown>;
  if (candidate.type !== "bool") return { valid: false, value: null, probability: null };
  if (candidate.probability === undefined) return { valid: true, value: null, probability: null };
  const probability = probabilityOrNull(candidate.probability);
  if (probability === null) return { valid: false, value: null, probability: null };
  return { valid: true, value: probability >= 0.5, probability };
}

export function createLlmEvaluator(catalog: ModelCatalog): ApprovalEvaluator {
  return {
    async evaluate(
      input: ApprovalCase,
      config: ApprovalEvaluatorConfig,
      context: EvaluationContext,
    ): Promise<EvaluationOutcome> {
      if (config.kind !== "llm") {
        return unavailable("configuration", appMessages.approval.evaluatorNotLlm);
      }
      const fitted = fitApprovalCase(input, context.contextWindow, (candidate) =>
        `${renderApprovalSystem()}\n${renderApprovalUser(approvalCaseJson(candidate))}`,
      );
      if (!fitted.ok) {
        return {
          status: "unavailable",
          reason: fitted.reason === "configuration" ? "configuration" : "invalid-output",
          message: fitted.message,
          ...(fitted.messageLocalized !== undefined ? { messageLocalized: fitted.messageLocalized } : {}),
          ...(fitted.verbatim === true ? { verbatim: true } : {}),
        };
      }
      // The model is resolved here so its own output limit can bound the fixed
      // review budget; a model that no longer exists is a configuration issue,
      // not a provider failure.
      const model = catalog.chatModel(config.model);
      if (model === undefined) {
        return unavailable(
          "configuration",
          modelMessages.chatModelNotConfigured(config.model.providerId, config.model.modelId),
        );
      }
      const outcome = await completeText(
        catalog,
        { providerId: config.model.providerId, modelId: config.model.modelId, effort: config.effort },
        {
          system: renderApprovalSystem(),
          prompt: renderApprovalUser(approvalCaseJson(fitted.input)),
          maxTokens: Math.min(MAX_REVIEW_OUTPUT_TOKENS, model.maxTokens),
          sessionId: `emit:approval:${context.evaluationId}`,
          ...(context.signal !== undefined ? { signal: context.signal } : {}),
        },
      );
      if (!outcome.ok) {
        // The failure reason comes from llm.ts: configuration, a provider
        // request failure, or an unusable response. The provider's own failure
        // text is never translated; an app-authored wrapper from llm.ts may
        // still carry a display pair, forwarded as-is.
        const localized = isLocalizedText(outcome.messageLocalized) ? outcome.messageLocalized : undefined;
        return unavailable(outcome.reason, { text: outcome.message, localized });
      }
      const parsed = parseJsonObject(outcome.text);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return unavailable("invalid-output", appMessages.approval.llmUnparseable(redactApprovalText(outcome.text).slice(0, 200)));
      }
      const parsedRecord = parsed as Record<string, unknown>;
      const expectedKeys = ["outcome", "risk", "rationale", "readOnly", "userAuthorization"];
      const exactKeys =
        Object.keys(parsedRecord).length === expectedKeys.length &&
        expectedKeys.every((key) => Object.hasOwn(parsedRecord, key));
      if (
        !exactKeys ||
        !isReviewOutcome(parsedRecord.outcome) ||
        !isRiskLevel(parsedRecord.risk) ||
        typeof parsedRecord.rationale !== "string" ||
        parsedRecord.rationale.length > 240 ||
        typeof parsedRecord.readOnly !== "boolean" ||
        !isUserAuthorization(parsedRecord.userAuthorization)
      ) {
        return unavailable("invalid-output", appMessages.approval.llmBadProtocol(redactApprovalText(outcome.text).slice(0, 200)));
      }
      return {
        status: "evaluated",
        outcome: parsedRecord.outcome,
        risk: parsedRecord.risk,
        evidence: {
          kind: "llm",
          criteriaVersion: LLM_CRITERIA_VERSION,
          rationale: parsedRecord.rationale,
          risk: parsedRecord.risk,
          outcome: parsedRecord.outcome,
          readOnly: parsedRecord.readOnly,
          userAuthorization: parsedRecord.userAuthorization,
        },
        model: config.model,
        usage: outcome.usage,
      };
    },
  };
}

export function createClassifierEvaluator(catalog: ModelCatalog): ApprovalEvaluator {
  return {
    async evaluate(
      input: ApprovalCase,
      config: ApprovalEvaluatorConfig,
      context: EvaluationContext,
    ): Promise<EvaluationOutcome> {
      if (config.kind !== "classifier") {
        return unavailable("configuration", appMessages.approval.evaluatorNotClassifier);
      }
      const model = catalog.classifierModel(config.model);
      if (model === undefined) {
        return unavailable(
          "configuration",
          appMessages.approval.classifierModelMissing(config.model.providerId, config.model.modelId),
        );
      }
      const questions = classifierQuestions();
      const fitted = fitApprovalCase(input, context.contextWindow, (candidate) =>
        JSON.stringify({ state: classifierState(candidate), questions }),
      );
      if (!fitted.ok) {
        return {
          status: "unavailable",
          reason: fitted.reason === "configuration" ? "configuration" : "invalid-output",
          message: fitted.message,
          ...(fitted.messageLocalized !== undefined ? { messageLocalized: fitted.messageLocalized } : {}),
          ...(fitted.verbatim === true ? { verbatim: true } : {}),
        };
      }
      const result = await catalog.models.classify(
        model,
        { state: classifierState(fitted.input), questions },
        context.signal !== undefined ? { signal: context.signal } : {},
      );
      if (result.stopReason !== "stop") {
        return result.errorMessage === undefined
          ? unavailable("provider", appMessages.approval.classifierStopReason(result.stopReason))
          : unavailable("provider", rawText(result.errorMessage));
      }
      const answers: unknown = result.answers;
      if (typeof answers !== "object" || answers === null || Array.isArray(answers)) {
        return unavailable("invalid-output", appMessages.approval.classifierNoAnswers);
      }
      const answerMap = answers as Record<string, unknown>;
      const outcomeAnswer = validatedChoiceAnswer(answerMap.outcome, OUTCOMES);
      const riskAnswer = validatedChoiceAnswer(answerMap.risk, RISK_LEVELS);
      if (outcomeAnswer === undefined || riskAnswer === undefined) {
        return unavailable("invalid-output", appMessages.approval.classifierBadChoice);
      }
      const outcomeProbabilities = { ...outcomeAnswer.answer.probabilities };
      const riskProbabilities = { ...riskAnswer.answer.probabilities };
      const reviewOutcome = outcomeAnswer.answer.choice as ReviewOutcome;
      const risk = riskAnswer.answer.choice as RiskLevel;
      const readOnly = boolEvidence(answerMap.read_only);
      const authorized = boolEvidence(answerMap.authorized);
      if (!readOnly.valid || !authorized.valid) {
        return unavailable("invalid-output", appMessages.approval.classifierBadEvidence);
      }
      return {
        status: "evaluated",
        outcome: reviewOutcome,
        risk,
        evidence: {
          kind: "classifier",
          criteriaVersion: CLASSIFIER_CRITERIA_VERSION,
          questions: JSON.stringify(questions, null, 2),
          outcome: reviewOutcome,
          risk,
          outcomeProbability: outcomeAnswer.probability,
          outcomeProbabilities,
          riskProbability: riskAnswer.probability,
          riskProbabilities,
          readOnly: readOnly.value,
          readOnlyProbability: readOnly.probability,
          authorized: authorized.value,
          authorizedProbability: authorized.probability,
        },
        model: config.model,
        ...(result.usage !== undefined
          ? {
              usage: {
                input: result.usage.input,
                output: result.usage.output,
                cost: result.usage.cost.total,
              },
            }
          : {}),
      };
    },
  };
}

export function describeClassifierEvidence(evidence: {
  outcome: ReviewOutcome;
  risk: RiskLevel;
  outcomeProbability: number;
  riskProbability: number;
  readOnlyProbability: number | null;
  authorizedProbability: number | null;
}): AppText {
  return appMessages.approval.classifierSummary(
    evidence.outcome,
    evidence.risk,
    evidence.riskProbability,
    evidence.outcomeProbability,
    evidence.readOnlyProbability,
    evidence.authorizedProbability,
  );
}
