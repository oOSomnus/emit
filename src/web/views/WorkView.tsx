/**
 * The work ledger.
 *
 * One row per request that reached an employee, with its status, depth in a
 * delegation chain, tokens, and the reason it ended. Stopping here withdraws
 * the queued input, aborts the run, and cancels the approvals that belonged to
 * it, so nothing is left waiting on a decision that no longer matters.
 */

import { type ReactNode } from "react";
import { api } from "../api.ts";
import { useApp } from "../state.tsx";
import { Chip, IconButton, WorkStatus, timeAgo } from "./ui.tsx";

export function WorkView(): ReactNode {
  const { state, setError } = useApp();

  const stop = (workId: string) => {
    void api
      .stopWork(workId)
      .catch((error: unknown) => setError(error instanceof Error ? error.message : String(error)));
  };

  return (
    <div className="pane">
      <header className="pane-header">
        <div>
          <h2>工作</h2>
          <p className="topic">
            {state.work.length} 条记录 · 进行中 {state.work.filter((work) => work.status === "running").length}
          </p>
        </div>
      </header>
      <div className="scroll">
        {state.work.length === 0 ? (
          <div className="empty">
            <h2>还没有工作记录</h2>
            <p>给员工发消息、发邮件或交办任务后，这里会列出每一次执行。</p>
          </div>
        ) : (
          <div className="work-table-wrap">
            <table className="work-table">
              <thead>
                <tr>
                  <th>状态</th>
                  <th>员工</th>
                  <th>来源</th>
                  <th>类型</th>
                  <th>层级</th>
                  <th>token</th>
                  <th>开始</th>
                  <th>说明</th>
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
                    <td>{work.roomName.length > 0 ? work.roomName : work.parentWorkId !== undefined ? `交办自 ${work.parentWorkId}` : "—"}</td>
                    <td>{work.kind === "message" ? "消息" : work.kind === "mail" ? "邮件" : "交办"}</td>
                    <td>{work.depth}</td>
                    <td>{work.usage !== undefined ? `${work.usage.input}/${work.usage.output}` : "—"}</td>
                    <td>{timeAgo(work.startedAt)}</td>
                    <td className="reason">
                      {work.error !== undefined ? work.error : work.progressText !== undefined ? work.progressText.slice(0, 120) : ""}
                    </td>
                    <td>
                      {work.status === "running" || work.status === "queued" || work.status === "waiting-approval" ? (
                        <IconButton icon="stop" label="停止" onClick={() => stop(work.id)} />
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="hint">
          <Chip tone="muted">提示</Chip> 进程被强制关闭后重启时，未能自动恢复的工作会在这里标记为失败，并在原会话里留下说明。
        </p>
      </div>
    </div>
  );
}
