/**
 * Room working-directory editing: the shared path fields and the per-room
 * editor dialog.
 */

export const englishDirectories = {
  // The per-room editor dialog.
  title: "Session working directories",
  scopeChannel: "Shared by the employees in this channel.",
  scopeDm: "Shared only in this direct conversation.",
  scopeMail: "Shared within the same mail conversation; replies and branches share it.",
  notSandbox: "This is not an operating-system sandbox.",
  closeEditor: "Close directory settings",
  saveDirectories: "Save directories",
  savingDirectories: "Saving directories…",
  roomGone: "The conversation no longer exists, so the directory configuration cannot be reloaded.",
  conflictText:
    "The directory configuration was changed by another operation. Your draft is kept; after reloading it is " +
    "replaced with the server's current configuration.",
  reload: "Reload",
  unsavedGroup: "Unsaved directory changes",
  unsavedHint: "You have unsaved changes",
  discard: "Discard",
  keepEditing: "Keep editing",

  // The shared path fields.
  pathInput: (number: number) => `Working directory path ${number}`,
  pathPlaceholder: "Absolute path on the server",
  defaultDirectoryTitle: "Default execution directory",
  setDefault: (label: string) => `Set ${label} as the default execution directory`,
  defaultDirectory: (number: number) => `Working directory ${number}`,
  defaultMark: "Default",
  removeDirectory: (number: number) => `Remove working directory ${number}`,
  addDirectory: "Add directory",
  pathsHint:
    "Paths must be directories that already exist on the server and are accessible. The default directory is " +
    "used for executions without a specified working path.",
};

export type DirectoriesMessages = typeof englishDirectories;

export const chineseDirectories: DirectoriesMessages = {
  title: "本会话授权的工作目录",
  scopeChannel: "本频道员工共享。",
  scopeDm: "仅当前私信对话。",
  scopeMail: "同一邮件会话内共享，回复链与分支共用。",
  notSandbox: "这不是操作系统沙箱。",
  closeEditor: "关闭目录设置",
  saveDirectories: "保存目录",
  savingDirectories: "正在保存…",
  roomGone: "会话不存在，无法重新载入目录配置",
  conflictText: "目录配置已被其他操作更新。你的草稿仍保留；重新载入后会以服务器当前配置替换它。",
  reload: "重新载入",
  unsavedGroup: "未保存的目录修改",
  unsavedHint: "有未保存的修改",
  discard: "丢弃修改",
  keepEditing: "继续编辑",

  pathInput: (number) => `工作目录路径 ${number}`,
  pathPlaceholder: "服务器本地绝对路径",
  defaultDirectoryTitle: "默认执行目录",
  setDefault: (label) => `将 ${label} 设为默认执行目录`,
  defaultDirectory: (number) => `工作目录 ${number}`,
  defaultMark: "默认",
  removeDirectory: (number) => `移除工作目录 ${number}`,
  addDirectory: "添加目录",
  pathsHint: "路径必须是服务器上已存在、可访问的目录。默认目录用于未指定工作路径的执行。",
};
