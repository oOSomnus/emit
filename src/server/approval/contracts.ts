/**
 * The approval judgment seam.
 *
 * A chat-model reviewer and a native probability classifier evaluate the same
 * complete action and context. Every consumer receives one exact outcome/risk
 * verdict and the same provenance-aware audit structure.
 *
 * Reviewers classify an action; they never bypass tool permissions, directory
 * authorization, or the hard execution checks.
 */

import type { LocalizedText } from "../../shared/i18n.ts";
import type { ModelRefDTO } from "../../shared/contracts.ts";
import type { WorkDirectoryScopeRecord } from "../documents.ts";

/** Token and cost accounting of one evaluation call, when the provider reports it. */
export type ModelUsage = { input: number; output: number; cost: number };

/** One bounded, provenance-labelled item shown to the reviewer. */
export type ApprovalContextSource = "room-message" | "work-intent" | "delegation" | "execution-context";

export type ApprovalContextEntry = {
  source: ApprovalContextSource;
  at?: number;
  entryId?: string;
  role?: "user" | "assistant" | "toolResult" | "meta";
  toolCallId?: string;
  toolName?: string;
  author?: { id: string; name: string; type: "user" | "employee" | "system" };
  text: string;
  truncated: boolean;
};

export type ApprovalUserIntent = {
  text: string;
  source: ApprovalContextSource | "unknown";
  truncated: boolean;
  /** Only a verified, real user-authored source can be treated as authorization. */
  authorization: "user" | "unknown";
  at?: number;
  author?: { id: string; name: string; type: "user" | "employee" | "system" };
};

export type RiskLevel = "low" | "medium" | "high" | "critical" | "unknown";
export type ReviewOutcome = "allow" | "deny";
export type UserAuthorizationLevel = "high" | "medium" | "low" | "unknown";

/** Everything one reviewer may consider, with provenance retained. */
export type ApprovalCase = {
  schemaVersion: 3;
  id: string;
  toolTaskId: string;
  employee: { id: string; name: string; role: string };
  tool: {
    name: string;
    kind: "file-write" | "shell" | "mcp" | "other";
    description: string;
  };
  /** Complete redacted JSON passed to the tool; never a display-truncated preview. */
  arguments: string;
  /** Truncated only for the approval-page display. */
  argumentsPreview: string;
  cwd: string;
  directories: WorkDirectoryScopeRecord;
  targetPaths: string[];
  allowedTools: string[];
  userIntent: ApprovalUserIntent;
  recentContext: ApprovalContextEntry[];
  executionContext: ApprovalContextEntry[];
  contextBudget: { omittedEntries: number; truncatedEntries: number };
  origin: { kind: "room" | "delegation"; description: string };
  configVersion: number;
  policyVersion: number;
};

export type EvaluationContext = {
  evaluationId: string;
  /** Selected model context window, used to bound the serialized review input. */
  contextWindow: number;
  signal?: AbortSignal;
};

export type EvaluationEvidence =
  | {
      kind: "llm";
      criteriaVersion: number;
      rationale: string;
      risk: RiskLevel;
      outcome: ReviewOutcome;
      readOnly: boolean;
      userAuthorization: UserAuthorizationLevel;
    }
  | {
      kind: "classifier";
      criteriaVersion: number;
      questions: string;
      outcome: ReviewOutcome;
      risk: RiskLevel;
      outcomeProbability: number;
      outcomeProbabilities: Record<string, number>;
      riskProbability: number;
      riskProbabilities: Record<string, number>;
      readOnly: boolean | null;
      readOnlyProbability: number | null;
      authorized: boolean | null;
      authorizedProbability: number | null;
    };

export type EvaluationOutcome =
  | {
      status: "evaluated";
      outcome: ReviewOutcome;
      risk: RiskLevel;
      evidence: EvaluationEvidence;
      model: ModelRefDTO;
      usage?: ModelUsage;
    }
  | {
      status: "unavailable";
      reason: "configuration" | "provider" | "invalid-output";
      message: string;
      /** Present when the message is application-authored rather than a provider's raw text. */
      messageLocalized?: LocalizedText;
      /**
       * True only for messages that are complete sentences on their own (tool
       * arguments over the review budget, an approval context over the budget,
       * a missing execution context); the persisted reason is then stored
       * verbatim instead of wrapped in a generic unavailable sentence.
       */
      verbatim?: true;
    };

export interface ApprovalEvaluator {
  evaluate(
    input: ApprovalCase,
    config: ApprovalEvaluatorConfig,
    context: EvaluationContext,
  ): Promise<EvaluationOutcome>;
}

export type ApprovalEvaluatorConfig =
  | { kind: "llm"; model: ModelRefDTO; effort: string; criteriaVersion: number }
  | { kind: "classifier"; model: ModelRefDTO; criteriaVersion: number };
