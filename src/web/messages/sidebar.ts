/**
 * The left rail: room sections, the mailbox entry, and the inline creator.
 *
 * The footer navigation names the application views, so it reads from
 * `app.view`; the language picker beside the theme picker also lives here.
 */

export const englishSidebar = {
  channels: "Channels",
  newChannel: "New channel",
  directs: "Direct messages",
  newDirect: "Start a direct message",
  mailbox: "Mailbox",
  creatorChannel: "New channel",
  creatorDirect: "Start a direct message",
  channelPlaceholder: "Channel name",
  initialMembers: "Initial members (optional)",
  initialMembersHint: "Everyone can read channel messages; only explicitly addressed members reply. Members can be invited later.",
  noWorkSelected: "Create or select a work before opening a conversation.",
  noEmployees: "(No employees yet)",
};

export type SidebarMessages = typeof englishSidebar;

export const chineseSidebar: SidebarMessages = {
  channels: "频道",
  newChannel: "新建频道",
  directs: "私信",
  newDirect: "开始私信",
  mailbox: "邮箱",
  creatorChannel: "新频道",
  creatorDirect: "开始私信",
  channelPlaceholder: "频道名称",
  initialMembers: "初始成员（可选）",
  initialMembersHint: "全员可见，只有被点名的员工会回复。成员之后也可以邀请加入。",
  noWorkSelected: "请先创建或选择一个工作，再新建会话。",
  noEmployees: "（还没有员工）",
};
