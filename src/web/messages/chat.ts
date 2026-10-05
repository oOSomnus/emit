/**
 * The chat surface: message history and channel addressing controls.
 *
 * Tool names, outputs, and message bodies are user or model content and are
 * never listed in a dictionary.
 */

export const englishChat = {
  emptyTitle: "No conversations yet",
  emptyBody: "Create a channel on the left, or create your first digital employee on the Employees page.",
  typingOne: (name: string) => `${name} is typing…`,
  typingMany: (names: string) => `${names} are typing…`,
  channelPlaceholder: "Message the channel; type @ to pick a member…",
  directPlaceholder: "Message this employee…",
  messageLabel: "Message",
  sessionWorkLabel: "Conversation work",
  mentionTrigger: "Select reply recipients",
  replyPicker: "Reply to",
  mentionEveryone: "Everyone",
  noMatchingMembers: "No matching channel members",
  addressedReplies: (names: string) => `Replies: ${names}`,
  noOneAddressed: "Posts the message without starting an employee.",
  removeRecipient: (name: string) => `Remove ${name} from recipients`,
  saveMembers: "Save members",
  savingMembers: "Saving members…",
  latestMembersVersion: (version: number) => `Latest membership version: v${version}.`,
  send: "Send",
  post: "Post",
};

export type ChatMessages = typeof englishChat;

export const chineseChat: ChatMessages = {
  emptyTitle: "还没有会话",
  emptyBody: "在左侧创建一个频道，或在“员工”页创建你的第一位数字员工。",
  typingOne: (name) => `${name} 正在输入消息…`,
  typingMany: (names) => `${names} 正在输入消息…`,
  channelPlaceholder: "给群里发消息，输入 @ 选择成员…",
  directPlaceholder: "发消息给这位员工…",
  messageLabel: "消息内容",
  sessionWorkLabel: "会话所属工作",
  mentionTrigger: "选择回复者",
  replyPicker: "回复者",
  mentionEveryone: "全体成员",
  noMatchingMembers: "没有匹配的群成员",
  addressedReplies: (names) => `回复者：${names}`,
  noOneAddressed: "仅发布消息，不启动员工。",
  removeRecipient: (name) => `从收件人中移除 ${name}`,
  saveMembers: "保存成员",
  savingMembers: "正在保存成员…",
  latestMembersVersion: (version) => `最新成员版本：v${version}。`,
  send: "发送",
  post: "发布",
};
