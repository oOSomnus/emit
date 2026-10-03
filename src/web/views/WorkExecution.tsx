/**
 * One work's durable execution record, in a modal.
 *
 * The record is read from the server: it is what actually happened, so it
 * survives a restart, shows a failed tool with its real reason, and never
 * invents steps for a work that has not started. Live events only trigger a
 * refresh of the newest page, coalesced so a busy run cannot flood the modal.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../api.ts";
import { useApp } from "../state.tsx";
import { Chip, IconButton, WorkStatus, timeAgo } from "./ui.tsx";
import { ACTIVE_WORK_STATUSES } from "./WorkView.tsx";
import type { ApprovalDTO, WorkExecutionDTO, WorkExecutionStepDTO } from "../../shared/contracts.ts";

const REFRESH_INTERVAL_MS = 120;

const STEP_LABELS: Record<WorkExecutionStepDTO["kind"], string> = {
  input: "输入",
  assistant: "回答",
  "tool-call": "调用工具",
  "tool-result": "工具结果",
};

function StepBody({ step }: { step: WorkExecutionStepDTO }): ReactNode {
  if (step.kind === "tool-call") {
    return (
      <>
        <div className="line">
          <code>{step.toolName ?? "工具"}</code>
          {step.toolCallId !== undefined ? <span className="hint">{step.toolCallId}</span> : null}
        </div>
        {step.arguments !== undefined && step.arguments.length > 0 ? (
          <pre className="step-payload">{step.arguments}</pre>
        ) : null}
      </>
    );
  }
  return (
    <>
      {step.kind === "tool-result" && step.toolName !== undefined ? (
        <div className="line">
          <code>{step.toolName}</code>
          {step.isError === true ? <Chip tone="danger">失败</Chip> : null}
        </div>
      ) : null}
      {step.text !== undefined && step.text.length > 0 ? <pre className="step-payload">{step.text}</pre> : null}
    </>
  );
}

function approvalTone(approval: ApprovalDTO): string {
  if (approval.status === "approved") return "ok";
  if (approval.status === "pending-human" || approval.status === "evaluating") return "warn";
  if (approval.status === "rejected" || approval.status === "blocked") return "danger";
  return "muted";
}

const APPROVAL_LABELS: Record<ApprovalDTO["status"], string> = {
  evaluating: "判定中",
  "pending-human": "等待人工",
  approved: "已批准",
  rejected: "已拒绝",
  blocked: "已阻止",
  cancelled: "已取消",
  invalidated: "已失效",
};

export function WorkExecution({ workId, onClose }: { workId: string; onClose: () => void }): ReactNode {
  const { state, dispatch, setError } = useApp();
  const [execution, setExecution] = useState<WorkExecutionDTO | undefined>(undefined);
  const [olderSteps, setOlderSteps] = useState<WorkExecutionStepDTO[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setLocalError] = useState("");
  const requestSeq = useRef(0);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const work = state.work.find((item) => item.id === workId);

  const load = useCallback(
    async (nextCursor?: string) => {
      const seq = ++requestSeq.current;
      try {
        const payload = await api.workExecution(workId, nextCursor);
        if (seq !== requestSeq.current) return;
        setExecution(payload);
        setLocalError("");
      } catch (cause) {
        if (seq !== requestSeq.current) return;
        setLocalError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [workId],
  );

  useEffect(() => {
    setExecution(undefined);
    setOlderSteps([]);
    setCursor(undefined);
    void load();
  }, [load]);

  // Live changes only say "look again"; the modal reads the truth itself, and
  // the refresh is coalesced so a streaming run cannot spam the server.
  const workRevision = `${state.work.length}|${work?.status ?? ""}|${work?.progressText?.length ?? 0}|${state.approvals.length}`;
  useEffect(() => {
    if (refreshTimer.current !== undefined) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => void load(), REFRESH_INTERVAL_MS);
    return () => {
      if (refreshTimer.current !== undefined) clearTimeout(refreshTimer.current);
    };
  }, [workRevision, load]);

  const loadOlder = async (): Promise<void> => {
    if (cursor === undefined || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const payload = await api.workExecution(workId, cursor);
      setOlderSteps((current) => {
        const seen = new Set(current.map((step) => step.id));
        return [...payload.steps.filter((step) => !seen.has(step.id)), ...current];
      });
      setCursor(payload.nextCursor);
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoadingOlder(false);
    }
  };

  const steps = useMemo(() => {
    const newest = execution?.steps ?? [];
    const seen = new Set(olderSteps.map((step) => step.id));
    return [...olderSteps, ...newest.filter((step) => !seen.has(step.id))];
  }, [execution, olderSteps]);

  const stop = async (): Promise<void> => {
    try {
      await api.stopWork(workId);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const shown = execution?.work ?? work;

  return (
    <div className="work-execution-backdrop">
      <section className="work-execution" role="dialog" aria-modal="true" aria-labelledby="work-execution-title">
      <div className="work-execution-head">
        <h2 id="work-execution-title">执行详情</h2>
        {shown !== undefined ? <WorkStatus status={shown.status} /> : null}
        {shown !== undefined ? <span className="hint">{shown.employeeName}</span> : null}
        {shown?.kind === "mail" && shown.roomName.length > 0 ? <span className="hint">{shown.roomName}</span> : null}
        <span className="spacer" />
        {shown !== undefined && ACTIVE_WORK_STATUSES.includes(shown.status) ? (
          <button type="button" onClick={() => void stop()}>
            停止
          </button>
        ) : null}
        <IconButton icon="close" label="关闭" onClick={onClose} />
      </div>

      <div className="work-execution-body">
        {shown !== undefined ? (
          <div className="work-execution-meta">
            <span>工作 {shown.id}</span>
            <span>开始 {timeAgo(shown.startedAt)}</span>
            {shown.finishedAt !== undefined ? <span>结束 {timeAgo(shown.finishedAt)}</span> : null}
            {shown.usage !== undefined ? <span>token {shown.usage.input}/{shown.usage.output}</span> : null}
            {shown.awaitedMailWorkIds.length > 0 ? (
              <span>等待 {shown.awaitedMailWorkIds.length} 封回信</span>
            ) : null}
          </div>
        ) : null}
        {shown?.error !== undefined && shown.error.length > 0 ? (
          <p className="error">
            <Chip tone="danger">错误</Chip> {shown.error}
          </p>
        ) : null}

        {error.length > 0 ? (
          <p className="error">
            <Chip tone="danger">读取失败</Chip> {error}
            <button type="button" className="link" onClick={() => void load()}>
              重新载入
            </button>
          </p>
        ) : null}

        {execution !== undefined && cursor !== undefined ? (
          <button type="button" className="link" disabled={loadingOlder} onClick={() => void loadOlder()}>
            {loadingOlder ? "载入中…" : "加载更早的步骤"}
          </button>
        ) : null}

        {execution === undefined && error.length === 0 ? (
          <p className="hint">正在读取执行记录…</p>
        ) : steps.length === 0 ? (
          <p className="hint">
            {shown !== undefined && shown.status === "queued" ? "尚未开始执行。" : "这次运行没有留下可见步骤。"}
          </p>
        ) : (
          <ol className="work-steps">
            {steps.map((step) => (
              <li key={step.id} className={`work-step kind-${step.kind}`}>
                <div className="line">
                  <Chip tone={step.kind === "tool-result" && step.isError === true ? "danger" : "muted"}>
                    {STEP_LABELS[step.kind]}
                  </Chip>
                  {step.taskStatus !== undefined ? <span className="hint">任务 {step.taskStatus}</span> : null}
                  {step.truncated === true ? <span className="hint">已截断</span> : null}
                </div>
                <StepBody step={step} />
                {step.taskError !== undefined ? (
                  <p className="error">
                    <Chip tone="danger">任务错误</Chip> {step.taskError}
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
        )}

        {execution !== undefined && execution.approvals.length > 0 ? (
          <div className="work-approvals">
            <h3>关联审批</h3>
            <ul>
              {execution.approvals.map((approval) => (
                <li key={approval.id}>
                  <Chip tone={approvalTone(approval)}>{APPROVAL_LABELS[approval.status]}</Chip>
                  <code>{approval.toolName}</code>
                  <span className="hint">{approval.risk}</span>
                  <button
                    type="button"
                    className="link"
                    onClick={() => {
                      dispatch({ type: "view", view: "approvals" });
                      onClose();
                    }}
                  >
                    去审批页
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
      </section>
    </div>
  );
}
