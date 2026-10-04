/**
 * The approval queue.
 *
 * Every gated call appears here with what the automatic judge decided and why,
 * the arguments it saw, and the whole timeline. A human decision writes the
 * same document the waiting tool is polling, so approving here unblocks that
 * exact call — and only that call.
 */

import { useState, type ReactNode } from "react";
import { api } from "../api.ts";
import { useApp } from "../state.tsx";
import { Chip, timeAgo } from "./ui.tsx";
import { useI18n } from "../i18n.tsx";
import { errorDisplay } from "../../shared/i18n.ts";
import type { ApprovalDTO, ApprovalStatusDTO, RiskLevel } from "../../shared/contracts.ts";

const STATUS_TONES: Record<ApprovalStatusDTO, string> = {
  evaluating: "info",
  "pending-human": "warn",
  approved: "ok",
  rejected: "error",
  blocked: "error",
  cancelled: "muted",
  invalidated: "muted",
};

const RISK_LEVELS: readonly RiskLevel[] = ["low", "medium", "high", "critical", "unknown"];

/** Outcome class keys come from the classifier's vocabulary: enum keys get labels, the rest stay raw. */
function outcomeClassLabel(labels: { allow: string; deny: string }, key: string): string {
  if (key === "allow") return labels.allow;
  if (key === "deny") return labels.deny;
  return key;
}

/** Risk class keys likewise. */
function riskClassLabel(labels: Record<RiskLevel, string>, key: string): string {
  const level = RISK_LEVELS.find((candidate) => candidate === key);
  return level !== undefined ? labels[level] : key;
}

export function ApprovalsView(): ReactNode {
  const { state, dispatch, setError } = useApp();
  const { messages, locale, text } = useI18n();
  const [comments, setComments] = useState<Record<string, string>>({});
  const [workContextFilter, setWorkContextFilter] = useState("");

  const decide = async (approval: ApprovalDTO, decision: "approved" | "rejected") => {
    try {
      const updated = await api.decideApproval(approval.id, decision, comments[approval.id] ?? "");
      dispatch({ type: "approval", approval: updated });
    } catch (error) {
      setError(errorDisplay(error));
    }
  };

  const filteredApprovals =
    workContextFilter.length === 0
      ? state.approvals
      : state.approvals.filter((approval) => approval.directoryWorkContextId === workContextFilter);
  const pending = filteredApprovals.filter((approval) => approval.status === "pending-human");
  const settled = filteredApprovals.filter((approval) => approval.status !== "pending-human");

  const renderCard = (approval: ApprovalDTO) => (
    <article key={approval.id} className={`approval ${approval.status}`}>
      <header className="approval-head">
        <Chip tone={STATUS_TONES[approval.status]}>{messages.approvals.status[approval.status]}</Chip>
        <strong>{approval.employeeName}</strong>
        <code>{approval.toolName}</code>
        <span className="time">{timeAgo(approval.createdAt, locale)}</span>
        {approval.decidedBy !== undefined ? <Chip tone="muted">{approval.decidedBy}</Chip> : null}
      </header>

      <div className="approval-body">
        {approval.autoDecision !== undefined ? (
          <p className="hint">
            {messages.approvals.decisionSource[approval.autoDecision.source]} ·{" "}
            {text(approval.autoDecision.reasonLocalized ?? approval.autoDecision.reason)}
          </p>
        ) : null}
        <pre className="args">{approval.argumentsPreview}</pre>
        <p className="hint">{messages.approvals.riskJudged(messages.approvals.risk[approval.risk])}</p>
        <p className="hint">
          {messages.approvals.workingDirectory(
            approval.cwd.length > 0 ? approval.cwd : messages.common.notRecorded,
          )}
        </p>
        <p className="hint">
          {messages.approvals.directoryWorkContext(
            state.workContexts.find((workContext) => workContext.id === approval.directoryWorkContextId)?.name ??
              (approval.directoryWorkContextId || messages.approvals.notBoundToWork),
            approval.directoryVersion,
          )}
        </p>
        {approval.directoryPaths.length > 0 ? (
          <div>
            <p className="hint">{messages.approvals.authorizedPathsHeading}</p>
            <ul className="plain">{approval.directoryPaths.map((path) => <li key={path}><code>{path}</code></li>)}</ul>
          </div>
        ) : (
          <p className="hint">{messages.approvals.noAuthorizedPaths}</p>
        )}
        {approval.targetPaths.length > 0 ? (
          <div>
            <p className="hint">{messages.approvals.targetPathsHeading}</p>
            <ul className="plain">{approval.targetPaths.map((path) => <li key={path}><code>{path}</code></li>)}</ul>
          </div>
        ) : null}
        {approval.evidence !== undefined ? (
          <details>
            <summary>{messages.approvals.evidenceSummary}</summary>
            {approval.evidence.kind === "policy" ? (
              <div className="evidence-grid">
                <p>{text(approval.evidence.rationaleLocalized ?? approval.evidence.rationale)}</p>
                <p>{messages.approvals.readOnlyNotRecorded}</p>
                <p>{messages.approvals.authorizationNotRecorded}</p>
              </div>
            ) : null}
            {approval.evidence.kind === "llm" ? (
              <div className="evidence-grid">
                <p>{messages.approvals.criteriaVersion(approval.evidence.criteriaVersion)}</p>
                <p>{messages.approvals.outcomeLine(messages.approvals.outcome[approval.evidence.outcome])}</p>
                <p>{messages.approvals.riskLine(messages.approvals.risk[approval.evidence.risk])}</p>
                <p>{messages.approvals.rationaleLine(approval.evidence.rationale)}</p>
                <p>
                  {messages.approvals.readOnlyLine(
                    approval.evidence.readOnly ? messages.common.yes : messages.common.no,
                  )}
                </p>
                <p>
                  {messages.approvals.authorizationLine(
                    messages.approvals.authorization[approval.evidence.userAuthorization],
                  )}
                </p>
              </div>
            ) : null}
            {approval.evidence.kind === "classifier" ? (
              <div>
                <p>{messages.approvals.criteriaVersionShort(approval.evidence.criteriaVersion)}</p>
                <div className="evidence-grid">
                  <p>{messages.approvals.outcomeLine(messages.approvals.outcome[approval.evidence.outcome])}</p>
                  <p>{messages.approvals.riskLine(messages.approvals.risk[approval.evidence.risk])}</p>
                  <p>
                    {messages.approvals.outcomeProbability(
                      typeof approval.evidence.outcomeProbability === "number"
                        ? approval.evidence.outcomeProbability.toFixed(3)
                        : messages.common.notRecorded,
                    )}
                  </p>
                  <p>
                    {messages.approvals.outcomeClassProbabilities(
                      Object.entries(approval.evidence.outcomeProbabilities)
                        .map(([key, probability]) => ` ${outcomeClassLabel(messages.approvals.outcome, key)}=${probability.toFixed(3)}`)
                        .join(""),
                    )}
                  </p>
                  <p>
                    {messages.approvals.riskProbability(
                      typeof approval.evidence.riskProbability === "number"
                        ? approval.evidence.riskProbability.toFixed(3)
                        : messages.common.notRecorded,
                    )}
                  </p>
                  <p>
                    {messages.approvals.riskClassProbabilities(
                      Object.entries(approval.evidence.riskProbabilities)
                        .map(([key, probability]) => ` ${riskClassLabel(messages.approvals.risk, key)}=${probability.toFixed(3)}`)
                        .join(""),
                    )}
                  </p>
                  <p>
                    {messages.approvals.readOnlyWithProbability(
                      approval.evidence.readOnly === null
                        ? messages.common.notRecorded
                        : approval.evidence.readOnly
                          ? messages.common.yes
                          : messages.common.no,
                      typeof approval.evidence.readOnlyProbability === "number"
                        ? approval.evidence.readOnlyProbability.toFixed(3)
                        : messages.common.notRecorded,
                    )}
                  </p>
                  <p>
                    {messages.approvals.authorizedWithProbability(
                      approval.evidence.authorized === null
                        ? messages.common.notRecorded
                        : approval.evidence.authorized
                          ? messages.common.yes
                          : messages.common.no,
                      typeof approval.evidence.authorizedProbability === "number"
                        ? approval.evidence.authorizedProbability.toFixed(3)
                        : messages.common.notRecorded,
                    )}
                  </p>
                </div>
                <ul>
                  {approval.evidence.questions.map((question) => (
                    <li key={question.key}>
                      <code>{question.key}</code>
                      <p>{question.instructions}</p>
                      <ul>
                        {question.criteria.map((criterion) => (
                          <li key={criterion.label}>{criterion.description}</li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
                <ul>
                  {approval.evidence.answers.map((answer) => (
                    <li key={answer.key}>
                      <code>{answer.key}</code>
                      {answer.choice !== undefined ? messages.approvals.answerChoice(answer.choice) : null}
                      {answer.probabilities !== undefined
                        ? Object.entries(answer.probabilities).map(([choice, probability]) => (
                            <span key={choice}>
                              {" "}
                              {choice}={probability.toFixed(3)}
                            </span>
                          ))
                        : null}
                      {answer.probability !== undefined ? <> · {answer.probability.toFixed(3)}</> : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </details>
        ) : null}

        <details className="timeline">
          <summary>{messages.approvals.timelineSummary(approval.timeline.length)}</summary>
          <ol>
            {approval.timeline.map((entry) => (
              <li key={`${entry.at}-${entry.text}`}>
                <span className="time">{new Date(entry.at).toLocaleTimeString(locale)}</span>{" "}
                {text(entry.actorLocalized ?? entry.actor)} · {text(entry.textLocalized ?? entry.text)}
              </li>
            ))}
          </ol>
        </details>

        {approval.execution.detail !== undefined ? (
          <p className="hint">
            {messages.approvals.executionLine(text(approval.execution.detailLocalized ?? approval.execution.detail))}
          </p>
        ) : null}

        {approval.status === "pending-human" ? (
          <footer className="approval-actions row">
            <input
              aria-label={messages.approvals.commentPlaceholder}
              placeholder={messages.approvals.commentPlaceholder}
              value={comments[approval.id] ?? ""}
              onChange={(event) => setComments((current) => ({ ...current, [approval.id]: event.target.value }))}
            />
            <button type="button" className="primary" onClick={() => void decide(approval, "approved")}>
              {messages.approvals.approve}
            </button>
            <button type="button" className="danger" onClick={() => void decide(approval, "rejected")}>
              {messages.approvals.reject}
            </button>
          </footer>
        ) : null}
      </div>
    </article>
  );

  return (
    <div className="pane">
      <header className="pane-header">
        <div>
          <h2>{messages.approvals.title}</h2>
          <p className="topic">
            {messages.approvals.pendingCount(pending.length)} ·{" "}
            {messages.approvals.policyVersion(state.app?.policyVersion ?? 0)}
          </p>
        </div>
        <div className="pane-header-actions">
          <select
            value={workContextFilter}
            aria-label={messages.approvals.workFilter}
            onChange={(event) => setWorkContextFilter(event.target.value)}
          >
            <option value="">{messages.approvals.allWorkContexts}</option>
            {state.workContexts.map((workContext) => (
              <option key={workContext.id} value={workContext.id}>{workContext.name}</option>
            ))}
          </select>
        </div>
      </header>
      <div className="scroll">
        {pending.length === 0 ? <p className="hint">{messages.approvals.emptyQueue}</p> : pending.map(renderCard)}
        {settled.length > 0 ? (
          <details className="history">
            <summary>{messages.approvals.historySummary(settled.length, Math.min(settled.length, 50))}</summary>
            {settled.slice(0, 50).map(renderCard)}
          </details>
        ) : null}
      </div>
    </div>
  );
}
