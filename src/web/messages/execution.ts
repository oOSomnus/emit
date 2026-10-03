/** The durable execution record modal. */

export const englishExecution = {
  title: "Execution details",
  meta: {
    work(workId: string): string {
      return `Work ${workId}`;
    },
    started(time: string): string {
      return `Started ${time}`;
    },
    ended(time: string): string {
      return `Ended ${time}`;
    },
    tokens(input: number, output: number): string {
      return `Tokens ${input}/${output}`;
    },
    awaitingReplies(count: number): string {
      return `Waiting for ${count} ${count === 1 ? "reply" : "replies"}`;
    },
  },
  step: {
    input: "Input",
    assistant: "Answer",
    "tool-call": "Tool call",
    "tool-result": "Tool result",
  },
  task(status: string): string {
    return `Task ${status}`;
  },
  truncated: "Truncated",
  taskError: "Task error",
  toolFallback: "Tool",
  stepFailed: "Failed",
  workError: "Error",
  loadFailed: "Failed to load",
  reload: "Reload",
  loadOlder: "Load earlier steps",
  loadingRecord: "Loading the execution record…",
  notStarted: "Not started yet.",
  noSteps: "This run left no visible steps.",
  approvalsTitle: "Related approvals",
  approval: {
    evaluating: "Evaluating",
    "pending-human": "Waiting for human",
    approved: "Approved",
    rejected: "Rejected",
    blocked: "Blocked",
    cancelled: "Cancelled",
    invalidated: "Invalidated",
  },
  openApprovals: "Go to approvals",
};

export type ExecutionMessages = typeof englishExecution;

export const chineseExecution: ExecutionMessages = {
  title: "执行详情",
  meta: {
    work(workId) {
      return `工作 ${workId}`;
    },
    started(time) {
      return `开始 ${time}`;
    },
    ended(time) {
      return `结束 ${time}`;
    },
    tokens(input, output) {
      return `token ${input}/${output}`;
    },
    awaitingReplies(count) {
      return `等待 ${count} 封回信`;
    },
  },
  step: {
    input: "输入",
    assistant: "回答",
    "tool-call": "调用工具",
    "tool-result": "工具结果",
  },
  task(status) {
    return `任务 ${status}`;
  },
  truncated: "已截断",
  taskError: "任务错误",
  toolFallback: "工具",
  stepFailed: "失败",
  workError: "错误",
  loadFailed: "读取失败",
  reload: "重新载入",
  loadOlder: "加载更早的步骤",
  loadingRecord: "正在读取执行记录…",
  notStarted: "尚未开始执行。",
  noSteps: "这次运行没有留下可见步骤。",
  approvalsTitle: "关联审批",
  approval: {
    evaluating: "判定中",
    "pending-human": "等待人工",
    approved: "已批准",
    rejected: "已拒绝",
    blocked: "已阻止",
    cancelled: "已取消",
    invalidated: "已失效",
  },
  openApprovals: "去审批页",
};
