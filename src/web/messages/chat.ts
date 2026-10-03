/**
 * The chat surface: empty state, live-work chips, and the composer.
 *
 * Live work statuses reuse `work.status`; only this surface's own wording
 * (tool activity, composer, and the directory editor entry point) lives here.
 * Tool names, outputs, and message bodies are user or model content and are
 * never listed in a dictionary.
 */

export const englishChat = {
  emptyTitle: "No conversations yet",
  emptyBody: "Create a channel on the left, or create your first digital employee on the Employees page.",
  directoriesButton: (count: number) => `Working directories (${count})`,
  working: (name: string) => `${name} is working`,
  startedHint: "Work has started; its output appears here in real time.",
  stop: "Stop",
  toolStatus: {
    pending: "Pending",
    running: "Running",
    done: "Done",
  },
  assignEmployee: "Assign employee",
  recordOnly: "(Record only; no employee assigned)",
  channelPlaceholder: "Type a message and pick an employee to follow up…",
  directPlaceholder: "Message this employee…",
  messageLabel: "Message",
  send: "Send",
};

export type ChatMessages = typeof englishChat;

export const chineseChat: ChatMessages = {
  emptyTitle: "还没有会话",
  emptyBody: "在左侧创建一个频道，或在“员工”页创建你的第一位数字员工。",
  directoriesButton: (count) => `工作目录（${count}）`,
  working: (name) => `${name} 正在工作`,
  startedHint: "已开始处理，输出会实时出现在这里。",
  stop: "停止",
  toolStatus: {
    pending: "待执行",
    running: "执行中",
    done: "已完成",
  },
  assignEmployee: "指派员工",
  recordOnly: "（只记录，不指派员工）",
  channelPlaceholder: "写点什么，选中一位员工让他跟进…",
  directPlaceholder: "发消息给这位员工…",
  messageLabel: "消息内容",
  send: "发送",
};
