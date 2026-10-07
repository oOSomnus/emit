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
import { mergeExecutionSteps } from "../execution-steps.ts";
import { errorDisplay, type DisplayText } from "../../shared/i18n.ts";
import { useI18n } from "../i18n.tsx";
import { useSessionExport } from "../session-export.ts";
import { useApp } from "../state.tsx";
import { Chip, IconButton, WorkStatus, timeAgo } from "./ui.tsx";
import { MarkdownBody } from "./MarkdownBody.tsx";
import { ACTIVE_WORK_STATUSES } from "./WorkView.tsx";
import { LlmCallTimeline } from "./LlmCallTimeline.tsx";
import type { ApprovalDTO, WorkExecutionDTO, WorkExecutionStepDTO } from "../../shared/contracts.ts";

const REFRESH_INTERVAL_MS = 120;

function StepBody({ step }: { step: WorkExecutionStepDTO }): ReactNode {
  const { messages } = useI18n();
  if (step.kind === "tool-call") {
    return (
      <>
        <div className="line">
          <code>{step.toolName ?? messages.execution.toolFallback}</code>
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
          {step.isError === true ? <Chip tone="error">{messages.execution.stepFailed}</Chip> : null}
        </div>
      ) : null}
      {step.text !== undefined && step.text.length > 0 ? <pre className="step-payload">{step.text}</pre> : null}
    </>
  );
}

function approvalTone(approval: ApprovalDTO): string {
  if (approval.status === "approved") return "ok";
  if (approval.status === "pending-human" || approval.status === "evaluating") return "warn";
  if (approval.status === "rejected" || approval.status === "blocked") return "error";
  return "muted";
}

export function WorkExecution({ workId, onClose }: { workId: string; onClose: () => void }): ReactNode {
  const { state, dispatch, setError } = useApp();
  const { messages, text, locale } = useI18n();
  const exportSession = useSessionExport();
  const [execution, setExecution] = useState<WorkExecutionDTO | undefined>(undefined);
  const [steps, setSteps] = useState<WorkExecutionStepDTO[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setLocalError] = useState<DisplayText>("");
  const [executionView, setExecutionView] = useState<"steps" | "llmCalls">("steps");
  const requestSeq = useRef(0);
  const refreshTimer = useRef<number | undefined>(undefined);
  const historyRequested = useRef(false);
  const work = state.work.find((item) => item.id === workId);

  const load = useCallback(
    async (nextCursor?: string) => {
      const seq = ++requestSeq.current;
      try {
        const payload = await api.workExecution(workId, nextCursor);
        if (seq !== requestSeq.current) return;
        setExecution(payload);
        if (historyRequested.current) {
          setSteps((current) => mergeExecutionSteps(current, payload.steps, "newer"));
        } else {
          setSteps(payload.steps);
          setCursor(payload.nextCursor);
        }
        setLocalError("");
      } catch (cause) {
        if (seq !== requestSeq.current) return;
        setLocalError(errorDisplay(cause));
      }
    },
    [workId],
  );

  useEffect(() => {
    setExecution(undefined);
    setSteps([]);
    setCursor(undefined);
    historyRequested.current = false;
    void load();
  }, [load]);

  // Live changes only say "look again"; the modal reads the truth itself, and
  // the refresh is coalesced so a streaming run cannot spam the server. Tool
  // status is part of the fingerprint: a finished tool must refresh the
  // durable record even when the streamed text did not grow.
  const workRevision = `${state.work.length}|${work?.status ?? ""}|${work?.progressText?.length ?? 0}|${JSON.stringify(work?.tools?.map((tool) => [tool.callId, tool.status]) ?? [])}|${state.approvals.length}`;
  useEffect(() => {
    clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => void load(), REFRESH_INTERVAL_MS);
    return () => {
      clearTimeout(refreshTimer.current);
    };
  }, [workRevision, load]);

  const loadOlder = async (): Promise<void> => {
    if (cursor === undefined || loadingOlder) return;
    historyRequested.current = true;
    setLoadingOlder(true);
    try {
      const payload = await api.workExecution(workId, cursor);
      setSteps((current) => mergeExecutionSteps(current, payload.steps, "older"));
      setCursor(payload.nextCursor);
    } catch (cause) {
      setLocalError(errorDisplay(cause));
    } finally {
      setLoadingOlder(false);
    }
  };

  const stop = async (): Promise<void> => {
    try {
      await api.stopWork(workId);
      await load();
    } catch (cause) {
      setError(errorDisplay(cause));
    }
  };

  const shown = execution?.work ?? work;

  // The live half of the record: the newest state of this work, rendered from
  // the event stream while the run is still owed to somebody. The durable
  // steps below remain the record; this block is a snapshot of the stream.
  const liveWork = work ?? execution?.work;
  const lastAssistant = useMemo(() => {
    for (let index = steps.length - 1; index >= 0; index -= 1) {
      const step = steps[index]!;
      if (step.kind === "assistant") return step;
    }
    return undefined;
  }, [steps]);
  // A complete, untruncated assistant step already carries this text: showing
  // it twice in one modal would read as two different answers.
  const liveText =
    liveWork !== undefined &&
    liveWork.progressText !== undefined &&
    liveWork.progressText.length > 0 &&
    !(lastAssistant?.text === liveWork.progressText && lastAssistant.truncated !== true)
      ? liveWork.progressText
      : undefined;
  const liveTools = liveWork?.tools?.filter((tool) => tool.status !== "done") ?? [];
  const showLive =
    liveWork !== undefined &&
    ACTIVE_WORK_STATUSES.includes(liveWork.status) &&
    (liveText !== undefined || liveTools.length > 0);

  return (
    <div className="work-execution-backdrop">
      <section className={`work-execution${executionView === "llmCalls" ? " work-execution-llm" : ""}`} role="dialog" aria-modal="true" aria-labelledby="work-execution-title">
      <div className="work-execution-head">
        <h2 id="work-execution-title">{messages.execution.title}</h2>
        {shown !== undefined ? <WorkStatus status={shown.status} /> : null}
        {shown !== undefined ? <span className="hint">{shown.employeeName}</span> : null}
        {shown?.kind === "mail" && shown.roomName.length > 0 ? <span className="hint">{shown.roomName}</span> : null}
        <span className="spacer" />
        {shown !== undefined && ACTIVE_WORK_STATUSES.includes(shown.status) ? (
          <button type="button" onClick={() => void stop()}>
            {messages.work.stop}
          </button>
        ) : null}
        <IconButton
          icon="download"
          label={messages.common.exportSession}
          onClick={() => void exportSession({ workId })}
        />
        <IconButton icon="close" label={messages.common.close} onClick={onClose} />
      </div>

      <div className="work-execution-body">
        {shown !== undefined ? (
          <div className="work-execution-meta">
            <span>{messages.execution.meta.work(shown.id)}</span>
            <span>{messages.execution.meta.started(timeAgo(shown.startedAt, locale))}</span>
            {shown.finishedAt !== undefined ? <span>{messages.execution.meta.ended(timeAgo(shown.finishedAt, locale))}</span> : null}
            {shown.usage !== undefined ? <span>{messages.execution.meta.tokens(shown.usage.input, shown.usage.output)}</span> : null}
            {shown.awaitedMailWorkIds.length > 0 ? (
              <span>{messages.execution.meta.awaitingReplies(shown.awaitedMailWorkIds.length)}</span>
            ) : null}
          </div>
        ) : null}
        {shown?.error !== undefined && shown.error.length > 0 ? (
          <p className="error-text">
            <Chip tone="error">{messages.execution.workError}</Chip> {text(shown.errorLocalized ?? shown.error)}
          </p>
        ) : null}

        <div className="execution-view-tabs" role="group" aria-label={messages.llmCalls.viewOptions}>
          <button type="button" aria-pressed={executionView === "steps"} onClick={() => setExecutionView("steps")}>
            {messages.execution.stepsTab}
          </button>
          <button type="button" aria-pressed={executionView === "llmCalls"} onClick={() => setExecutionView("llmCalls")}>
            {messages.llmCalls.tab}
          </button>
        </div>

        {executionView === "steps" && error !== "" ? (
          <p className="error-text">
            <Chip tone="error">{messages.execution.loadFailed}</Chip> {text(error)}
            <button type="button" className="link" onClick={() => void load()}>
              {messages.execution.reload}
            </button>
          </p>
        ) : null}

        {executionView === "steps" && execution !== undefined && cursor !== undefined ? (
          <button type="button" className="link" disabled={loadingOlder} onClick={() => void loadOlder()}>
            {loadingOlder ? messages.common.loading : messages.execution.loadOlder}
          </button>
        ) : null}

        {executionView === "steps" && showLive ? (
          <section className="execution-live" aria-label={messages.execution.live}>
            <h3>{messages.execution.live}</h3>
            {liveTools.length > 0 ? (
              <ul className="execution-live-tools">
                {liveTools.map((tool) => (
                  <li key={tool.callId}>
                    <Chip tone={tool.status === "running" ? "info" : "muted"}>
                      {messages.execution.toolStatus[tool.status]}
                    </Chip>
                    <code>{tool.name}</code>
                  </li>
                ))}
              </ul>
            ) : null}
            {liveText !== undefined ? <MarkdownBody body={liveText} className="stream" /> : null}
          </section>
        ) : null}

        {executionView === "llmCalls" ? (
          <LlmCallTimeline workId={workId} />
        ) : execution === undefined && error === "" ? (
          <p className="hint">{messages.execution.loadingRecord}</p>
        ) : steps.length === 0 ? (
          <p className="hint">
            {shown !== undefined && shown.status === "queued" ? messages.execution.notStarted : messages.execution.noSteps}
          </p>
        ) : (
          <ol className="work-steps">
            {steps.map((step) => (
              <li key={step.id} className={`work-step kind-${step.kind}`}>
                <div className="line">
                  <Chip tone={step.kind === "tool-result" && step.isError === true ? "error" : "muted"}>
                    {messages.execution.step[step.kind]}
                  </Chip>
                  {step.taskStatus !== undefined ? <span className="hint">{messages.execution.task(step.taskStatus)}</span> : null}
                  {step.truncated === true ? <span className="hint">{messages.execution.truncated}</span> : null}
                </div>
                <StepBody step={step} />
                {step.taskError !== undefined ? (
                  <p className="error-text">
                    <Chip tone="error">{messages.execution.taskError}</Chip> {step.taskError}
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
        )}

        {executionView === "steps" && execution !== undefined && execution.approvals.length > 0 ? (
          <div className="work-approvals">
            <h3>{messages.execution.approvalsTitle}</h3>
            <ul>
              {execution.approvals.map((approval) => (
                <li key={approval.id}>
                  <Chip tone={approvalTone(approval)}>{messages.execution.approval[approval.status]}</Chip>
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
                    {messages.execution.openApprovals}
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
