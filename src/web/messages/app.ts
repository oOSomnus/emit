/** The application shell: navigation titles, boot and connection states. */

export const englishApp = {
  boot: "Loading local data…",
  view: {
    chat: "Chat",
    mail: "Mail",
    approvals: "Approvals",
    work: "Work",
    employees: "Employees",
    settings: "Settings",
  },
  navOpen: "Open navigation",
  navClose: "Close navigation",
  reconnect: "Disconnected from the local service. Reconnecting…",
  dismiss: "Dismiss",
  emptySubject: "(No subject)",
  newMail: (subject: string) => `New mail received: ${subject}`,
};

export type AppMessages = typeof englishApp;

export const chineseApp: AppMessages = {
  boot: "正在读取本地数据…",
  view: {
    chat: "会话",
    mail: "邮件",
    approvals: "审批",
    work: "工作",
    employees: "员工",
    settings: "设置",
  },
  navOpen: "打开导航",
  navClose: "关闭导航",
  reconnect: "与本地服务的连接已断开，正在重连…",
  dismiss: "关闭",
  emptySubject: "（无主题）",
  newMail: (subject) => `收到新邮件：${subject}`,
};
