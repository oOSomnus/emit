/**
 * The chat surface: message history and channel addressing controls.
 *
 * Tool names, outputs, and message bodies are user or model content and are
 * never listed in a dictionary.
 */

export const englishChat = {
  emptyTitle: "No conversations yet",
  emptyBody: "Create a channel on the left, or create your first digital employee on the Employees page.",
  working: (name: string) => `${name} is working`,
  startedHint: "Work has started; its output appears here in real time.",
  stop: "Stop",
  toolStatus: {
    pending: "Pending",
    running: "Running",
    done: "Done",
  },
  channelPlaceholder: "Message the channel; type @ to mention a member…",
  directPlaceholder: "Message this employee…",
  messageLabel: "Message",
  mentionTrigger: "Mention a member",
  mentionEveryone: "Everyone",
  noMatchingMembers: "No matching channel members",
  addressingScopeHint: "Visible to everyone; only addressed employees will reply.",
  addressedReplies: (names: string) => `Visible to everyone; replies: ${names}`,
  noOneAddressed: "No one is addressed.",
  saveMembers: "Save members",
  savingMembers: "Saving members…",
  latestMembersVersion: (version: number) => `Latest membership version: v${version}.`,
  send: "Send",
};

export type ChatMessages = typeof englishChat;

export const chineseChat: ChatMessages = {
  emptyTitle: "还没有会话",
  emptyBody: "在左侧创建一个频道，或在“员工”页创建你的第一位数字员工。",
  working: (name) => `${name} 正在工作`,
  startedHint: "已开始处理，输出会实时出现在这里。",
  stop: "停止",
  toolStatus: {
    pending: "待执行",
    running: "执行中",
    done: "已完成",
  },
  channelPlaceholder: "给群里发消息，输入 @ 提及成员…",
  directPlaceholder: "发消息给这位员工…",
  messageLabel: "消息内容",
  mentionTrigger: "提及成员",
  mentionEveryone: "全体成员",
  noMatchingMembers: "没有匹配的群成员",
  addressingScopeHint: "全员可见，只有被点名的员工会回复",
  addressedReplies: (names) => `全员可见；回复：${names}`,
  noOneAddressed: "无人被点名",
  saveMembers: "保存成员",
  savingMembers: "正在保存成员…",
  latestMembersVersion: (version) => `最新成员版本：v${version}。`,
  send: "发送",
};
