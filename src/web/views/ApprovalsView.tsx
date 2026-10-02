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
import type { ApprovalDTO, ApprovalStatusDTO } from "../../shared/contracts.ts";

const STATUS_LABELS: Record<ApprovalStatusDTO, string> = {
  evaluating: "自动判断中",
  "pending-human": "等待你的裁决",
  approved: "已批准",
  rejected: "已拒绝",
  cancelled: "已取消",
  invalidated: "已失效",
};

const STATUS_TONES: Record<ApprovalStatusDTO, string> = {
  evaluating: "info",
  "pending-human": "warn",
  approved: "ok",
  rejected: "error",
  cancelled: "muted",
  invalidated: "muted",
};

export function ApprovalsView(): ReactNode {
  const { state, dispatch, setError } = useApp();
  const [comments, setComments] = useState<Record<string, string>>({});

  const decide = async (approval: ApprovalDTO, decision: "approved" | "rejected") => {
    try {
      const updated = await api.decideApproval(approval.id, decision, comments[approval.id] ?? "");
      dispatch({ type: "approval", approval: updated });
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };

  const pending = state.approvals.filter((approval) => approval.status === "pending-human");
  const settled = state.approvals.filter((approval) => approval.status !== "pending-human");

  const renderCard = (approval: ApprovalDTO) => (
    <article key={approval.id} className={`approval ${approval.status}`}>
      <header className="approval-head">
        <Chip tone={STATUS_TONES[approval.status]}>{STATUS_LABELS[approval.status]}</Chip>
        <strong>{approval.employeeName}</strong>
        <code>{approval.toolName}</code>
        <span className="time">{timeAgo(approval.createdAt)}</span>
        {approval.decidedBy !== undefined ? <Chip tone="muted">{approval.decidedBy}</Chip> : null}
      </header>

      <div className="approval-body">
        {approval.autoDecision !== undefined ? (
          <p className="hint">
            {approval.autoDecision.source} · {approval.autoDecision.reason}
          </p>
        ) : null}
        <pre className="args">{approval.argumentsPreview}</pre>
        {approval.cwd.length > 0 ? <p className="hint">工作目录：{approval.cwd}</p> : null}
        {approval.origin.kind === "room" ? (
          <p className="hint">
            来自会话「{approval.origin.roomName}」
            {approval.workId !== undefined ? ` · 工作 ${approval.workId}` : ""}
          </p>
        ) : (
          <p className="hint">来自交办 · 上层工作 {approval.origin.parentWorkId}</p>
        )}

        {approval.evidence !== undefined ? (
          <details>
            <summary>自动判断依据</summary>
            {approval.evidence.kind === "policy" ? (
              <div className="evidence-grid">
                <p>{approval.evidence.rationale}</p>
                <p>只读：未记录</p>
                <p>用户授权：未记录</p>
              </div>
            ) : null}
            {approval.evidence.kind === "llm" ? (
              <div className="evidence-grid">
                <p>标准版本：{approval.evidence.criteriaVersion ?? "未记录"}</p>
                <p>
                  风险 {approval.evidence.risk} · 建议 {approval.evidence.recommendation} · {approval.evidence.rationale}
                </p>
                <p>只读：{approval.evidence.readOnly === undefined ? "未记录" : approval.evidence.readOnly ? "是" : "否"}</p>
                <p>用户授权：{approval.evidence.userAuthorization ?? "未记录"}</p>
              </div>
            ) : null}
            {approval.evidence.kind === "classifier" ? (
              <div>
                <p>标准版本 v{approval.evidence.criteriaVersion}</p>
                <div className="evidence-grid">
                  <p>
                    只读概率：
                    {approval.evidence.readOnlyProbability === undefined
                      ? "未记录"
                      : approval.evidence.readOnlyProbability.toFixed(3)}
                  </p>
                  <p>
                    用户授权概率：
                    {approval.evidence.authorizedProbability === undefined
                      ? "未记录"
                      : approval.evidence.authorizedProbability.toFixed(3)}
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
                      {answer.choice !== undefined ? <> · 选择 {answer.choice}</> : null}
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
          <summary>时间线（{approval.timeline.length}）</summary>
          <ol>
            {approval.timeline.map((entry) => (
              <li key={`${entry.at}-${entry.text}`}>
                <span className="time">{new Date(entry.at).toLocaleTimeString("zh-CN")}</span> {entry.actor} · {entry.text}
              </li>
            ))}
          </ol>
        </details>

        {approval.execution.detail !== undefined ? <p className="hint">执行：{approval.execution.detail}</p> : null}

        {approval.status === "pending-human" ? (
          <div className="approval-actions row">
            <input
              placeholder="备注（会写入记录）"
              value={comments[approval.id] ?? ""}
              onChange={(event) => setComments((current) => ({ ...current, [approval.id]: event.target.value }))}
            />
            <button type="button" onClick={() => void decide(approval, "approved")}>
              批准
            </button>
            <button type="button" onClick={() => void decide(approval, "rejected")}>
              拒绝
            </button>
          </div>
        ) : null}
      </div>
    </article>
  );

  return (
    <div className="pane">
      <header className="pane-header">
        <div>
          <h2>审批</h2>
          <p className="topic">{pending.length} 项等待你裁决 · 策略版本 v{state.app?.policyVersion ?? 0}</p>
        </div>
      </header>
      <div className="scroll">
        {pending.length === 0 ? <p className="hint">没有等待裁决的调用。</p> : pending.map(renderCard)}
        {settled.length > 0 ? (
          <details className="history">
            <summary>历史（{settled.length}，显示最近 {Math.min(settled.length, 50)} 条）</summary>
            {settled.slice(0, 50).map(renderCard)}
          </details>
        ) : null}
      </div>
    </div>
  );
}
