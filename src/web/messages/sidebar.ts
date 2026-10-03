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
  noEmployees: "（还没有员工）",
};
