/**
 * The work ledger.
 *
 * One row per request that reached an employee, with its status, depth in a
 * delegation chain, tokens, and the reason it ended. Stopping here withdraws
 * the queued input, aborts the run, and cancels the approvals that belonged to
 * it, so nothing is left waiting on a decision that no longer matters.
 */

import { useState, type ReactNode } from "react";
import { api } from "../api.ts";
import { errorDisplay } from "../../shared/i18n.ts";
import { useI18n } from "../i18n.tsx";
import { useApp } from "../state.tsx";
import { Chip, IconButton, WorkStatus, timeAgo } from "./ui.tsx";
import { WorkExecution } from "./WorkExecution.tsx";
import type { WorkStatusDTO } from "../../shared/contracts.ts";

/** Work that is still owed to somebody: it can be stopped and it is shown as live. */
export const ACTIVE_WORK_STATUSES: readonly WorkStatusDTO[] = ["queued", "running", "waiting-approval", "waiting-mail"];

export function WorkView(): ReactNode {
  const { state, setError } = useApp();
  const { messages, text, locale } = useI18n();
  const [executionWorkId, setExecutionWorkId] = useState<string | undefined>(undefined);

  const stop = (workId: string) => {
    void api
      .stopWork(workId)
      .catch((error: unknown) => setError(errorDisplay(error)));
  };

  return (
    <div className="pane">
      <header className="pane-header">
        <div>
          <h2>{messages.app.view.work}</h2>
          <p className="topic">
            {messages.work.topic(
              state.work.length,
              state.work.filter((work) => ACTIVE_WORK_STATUSES.includes(work.status)).length,
            )}
          </p>
        </div>
      </header>
      <div className="scroll">
        {state.work.length === 0 ? (
          <div className="empty">
            <h2>{messages.work.emptyTitle}</h2>
            <p>{messages.work.emptyBody}</p>
          </div>
        ) : (
          <div className="work-table-wrap">
            <table className="work-table">
              <thead>
                <tr>
                  <th>{messages.work.columns.status}</th>
                  <th>{messages.work.columns.employee}</th>
                  <th>{messages.work.columns.source}</th>
                  <th>{messages.work.columns.kind}</th>
                  <th>{messages.work.columns.depth}</th>
                  <th>{messages.work.columns.tokens}</th>
                  <th>{messages.work.columns.started}</th>
                  <th>{messages.work.columns.detail}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {state.work.map((work) => (
                  <tr key={work.id}>
                    <td>
                      <WorkStatus status={work.status} />
                    </td>
                    <td>{work.employeeName}</td>
                    <td>{work.roomName.length > 0 ? work.roomName : work.parentWorkId !== undefined ? messages.work.delegatedFrom(work.parentWorkId) : "—"}</td>
                    <td>{messages.work.kind[work.kind]}</td>
                    <td>{work.depth}</td>
                    <td>{work.usage !== undefined ? `${work.usage.input}/${work.usage.output}` : "—"}</td>
                    <td>{timeAgo(work.startedAt, locale)}</td>
                    <td className="reason">
                      {work.error !== undefined ? text(work.errorLocalized ?? work.error) : work.progressText !== undefined ? work.progressText.slice(0, 120) : ""}
                    </td>
                    <td>
                      <button type="button" className="link" onClick={() => setExecutionWorkId(work.id)}>
                        {messages.work.viewExecution}
                      </button>
                      {ACTIVE_WORK_STATUSES.includes(work.status) ? (
                        <IconButton icon="close" label={messages.work.stop} onClick={() => stop(work.id)} />
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="hint">
          <Chip tone="muted">{messages.work.hintLabel}</Chip> {messages.work.hint}
        </p>
      </div>
      {executionWorkId !== undefined ? (
        <WorkExecution workId={executionWorkId} onClose={() => setExecutionWorkId(undefined)} />
      ) : null}
    </div>
  );
}
