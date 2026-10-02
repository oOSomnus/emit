/**
 * The approval judgment seam.
 *
 * Emit gates risky tool calls behind one structured question: may this exact
 * call run? Two real implementations answer it — a chat model returning a
 * recommendation, and a structured classifier (Jev and friends) returning
 * probabilities over versioned criteria. Everything downstream of this seam
 * sees the same `EvaluationOutcome`, so a new judgment technology is added by
 * implementing one interface, not by editing communications, the approval
 * page, or tool execution.
 *
 * An evaluator only ever recommends. It never grants permission, and it never
 * overrides an employee's hard tool or directory limits.
 */

import type { ModelRefDTO } from "../../shared/contracts.ts";

/** Token and cost accounting of one evaluation call, when the provider reports it. */
export type ModelUsage = { input: number; output: number; cost: number };

/** Everything the judgment is allowed to see. */
export type ApprovalContextSource = "room-message" | "work-intent" | "delegation";

export type ApprovalContextEntry = {
  source: ApprovalContextSource;
  at?: number;
  author?: { id: string; name: string; type: "user" | "employee" | "system" };
  text: string;
  truncated: boolean;
};

export type ApprovalUserIntent = {
  text: string;
  source: ApprovalContextSource | "unknown";
  truncated: boolean;
  /** Only `user` is a verified human request; all derived intent is unknown. */
  authorization: "user" | "unknown";
  at?: number;
  author?: { id: string; name: string; type: "user" | "employee" | "system" };
};

/** Everything the judgment is allowed to see. */
export type ApprovalCase = {
  schemaVersion: 2;
  /** Stable identity of this evaluation; the same call always maps to it. */
  id: string;
  toolTaskId: string;
  employee: { id: string; name: string; role: string };
  tool: {
    name: string;
    /** Coarse category used by criteria text, never for the decision itself. */
    kind: "file-write" | "shell" | "mcp" | "other";
  };
  /** Canonical, redacted arguments; the model sees this text, not raw values. */
  argumentsPreview: string;
  cwd: string;
  /** Tools the employee is allowed to call at all. */
  allowedTools: string[];
  /** Request text with its actual author/source, never inferred from employee output. */
  userIntent: ApprovalUserIntent;
  /** At most twelve redacted, provenance-labelled messages or derived intents. */
  recentContext: ApprovalContextEntry[];
  /** Where this work came from, for a human reader. */
  origin: { kind: "room" | "delegation"; description: string };
  configVersion: number;
  policyVersion: number;
};

export type UserAuthorizationLevel = "high" | "medium" | "low" | "unknown";

export type EvaluationContext = {
  /** Correlation id for logs and audit; identical for every retry of one evaluation. */
  evaluationId: string;
  signal?: AbortSignal;
};

export type EvaluationEvidence =
  | {
      kind: "llm";
      criteriaVersion: number;
      rationale: string;
      risk: "low" | "medium" | "high" | "unknown";
      recommendation: "approve" | "review" | "deny";
      readOnly: boolean;
      userAuthorization: UserAuthorizationLevel;
    }
  | {
      kind: "classifier";
      criteriaVersion: number;
      /** The choice the classifier selected. */
      choice: string;
      /** Rendered questions and criteria, kept for the audit trail. */
      questions: string;
      probability: number | null;
      authorizedProbability?: number | null;
      readOnlyProbability?: number | null;
    };

export type EvaluationOutcome =
  | {
      status: "evaluated";
      recommendation: "approve" | "review" | "deny";
      risk: "low" | "medium" | "high" | "unknown";
      evidence: EvaluationEvidence;
      model: ModelRefDTO;
      usage?: ModelUsage;
    }
  | { status: "unavailable"; reason: "configuration" | "provider" | "invalid-output"; message: string };

export interface ApprovalEvaluator {
  evaluate(
    input: ApprovalCase,
    config: ApprovalEvaluatorConfig,
    context: EvaluationContext,
  ): Promise<EvaluationOutcome>;
}

/** Configuration of the active evaluator, as stored in the workspace config. */
export type ApprovalEvaluatorConfig =
  | { kind: "llm"; model: ModelRefDTO; effort: string; criteriaVersion: number }
  | {
      kind: "classifier";
      model: ModelRefDTO;
      criteriaVersion: number;
      minApproveProbability: number;
      minAuthorizedProbability: number;
      requireAuthorized: boolean;
    };
