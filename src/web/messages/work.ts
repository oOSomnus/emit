/**
 * Work statuses and the work ledger.
 *
 * The status dictionary covers every `WorkStatusDTO` value, so a new status
 * cannot ship without its labels.
 */

export const englishWork = {
  emptyTitle: "No work yet",
  emptyBody:
    "After you message an employee, send mail, or assign a task, every run is listed here.",
  topic(count: number, active: number): string {
    return `${count} records · ${active} running`;
  },
  columns: {
    status: "Status",
    employee: "Employee",
    source: "Source",
    kind: "Type",
    depth: "Depth",
    tokens: "Tokens",
    started: "Started",
    detail: "Details",
  },
  kind: {
    message: "Message",
    mail: "Mail",
    delegation: "Delegation",
  },
  delegatedFrom(parentWorkId: string): string {
    return `Delegated from ${parentWorkId}`;
  },
  viewExecution: "View execution",
  stop: "Stop",
  hintLabel: "Tip",
  hint:
    "When the process is restarted after a forced shutdown, work that could not be recovered automatically is marked failed here, with an explanation left in the original conversation.",
  status: {
    queued: "Queued",
    running: "Running",
    succeeded: "Completed",
    failed: "Failed",
    stopped: "Stopped",
    "waiting-approval": "Waiting for approval",
    "waiting-mail": "Waiting for reply",
  },
};

export type WorkMessages = typeof englishWork;

export const chineseWork: WorkMessages = {
  emptyTitle: "还没有工作记录",
  emptyBody: "给员工发消息、发邮件或交办任务后，这里会列出每一次执行。",
  topic(count, active) {
    return `${count} 条记录 · 进行中 ${active}`;
  },
  columns: {
    status: "状态",
    employee: "员工",
    source: "来源",
    kind: "类型",
    depth: "层级",
    tokens: "token",
    started: "开始",
    detail: "说明",
  },
  kind: {
    message: "消息",
    mail: "邮件",
    delegation: "交办",
  },
  delegatedFrom(parentWorkId) {
    return `交办自 ${parentWorkId}`;
  },
  viewExecution: "查看执行",
  stop: "停止",
  hintLabel: "提示",
  hint:
    "进程被强制关闭后重启时，未能自动恢复的工作会在这里标记为失败，并在原会话里留下说明。",
  status: {
    queued: "排队中",
    running: "进行中",
    succeeded: "已完成",
    failed: "失败",
    stopped: "已停止",
    "waiting-approval": "等待审批",
    "waiting-mail": "等待回信",
  },
};
