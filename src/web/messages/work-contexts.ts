/**
 * The work surface: the work list and editor, shared notes, channel membership,
 * and the addressing controls of a group message.
 *
 * English is the authority; Chinese must satisfy it. Every dynamic sentence is
 * a function, never a concatenation of translated fragments.
 */

export const englishWorkContexts = {
  // Navigation and list.
  navLabel: "Work",
  runsLabel: "Runs",
  selectWork: "Current work",
  createWork: "New work",
  noWorks: "No work yet",
  workPickerLabel: "Select work",
  switchWorkHint: "A conversation stays fixed to the work it was created under; switching work only filters what you create next.",
  helpTitle: "About work",
  title: "Work",
  subtitle:
    "Notes and resources can be shared across conversations in one work; histories from other conversations are never " +
    "loaded automatically.",
  emptyTitle: "No work yet",
  emptyBody: "Create your first work: name it, point it at directories, and open a channel inside it.",
  createTitle: "New work",
  editorTitle: (name: string) => `Work settings · ${name}`,
  nameLabel: "Name",
  namePlaceholder: "e.g. Storefront redesign",
  goalLabel: "Goal",
  goalPlaceholder: "What this work is trying to achieve",
  instructionsLabel: "Work instructions",
  instructionsPlaceholder: "Standing instructions every conversation of this work should follow",
  save: "Save work",
  saving: "Saving…",
  conflict:
    "The work was changed by another operation. Your draft is kept; reload to replace it with the server's " +
    "current version.",
  reload: "Reload",
  workGone: "The work no longer exists.",
  viewWork: "View work",
  currentWorkLabel: "Work",
  updated: (label: string) => `Updated ${label}`,

  // Directories.
  directoriesTitle: "Directories",
  directoriesHint:
    "Paths must be directories that already exist on the server. Every conversation of this work shares them: " +
    "sharing directories means sharing files, not an isolation sandbox.",
  directoriesEmpty: "This work has no directories; its employees can chat, research, and keep notes, but cannot touch local files or run shell commands.",

  // Resources.
  resourcesTitle: "Resources",
  resourcesHint:
    "References only: a file must already exist inside the directories above, and a URL is listed but never " +
    "fetched.",
  resourceName: "Resource name",
  resourceNamePlaceholder: "Reference name",
  resourceLocation: "Absolute file path or http(s) URL",
  resourceFile: "File",
  resourceUrl: "URL",
  addResource: "Add resource",
  removeResource: (label: string) => `Remove resource ${label}`,
  resourceKindLabel: "Reference kind",

  // Notes.
  notesTitle: "Shared notes",
  notesHint:
    "Notes are the only memory shared across this work's conversations. Employees read them when asked; they are " +
    "never pushed into every prompt.",
  notesEmpty: "No notes yet",
  notePick: "Select a note to read or edit it",
  notePickerLabel: "Select note",
  noteTitle: "Note title",
  noteBody: "Note body",
  newNote: "New note",
  saveNote: "Save note",
  deleteNote: "Delete note",
  noteSavedNotice: "Note saved to this work's shared notes.",
  noteDeleted: "Note deleted",
  noteAuthorYou: "You",
  noteSource: (room: string, entryId: string) => `Saved from ${room} · message ${entryId}`,
  noteSharedWarning: "Anyone working in this work can read saved notes, including notes saved from private conversations.",

  // Chat: members and addressing.
  membersCount: (count: number) => `${count} member${count === 1 ? "" : "s"}`,
  manageMembers: "Manage members",
  membersTitle: "Channel members",
  membersJoined: "In this channel",
  membersAvailable: "Available to invite",
  membersEmpty: "This channel has no members yet. Invite an employee before addressing anyone.",
  membersNoneAvailable: "Every enabled employee is already a member.",
  invite: "Invite",
  remove: "Remove",
  membersConflict: "Membership changed elsewhere. Your draft is kept; reload and try again.",
  membersSaved: "Members updated",
  membersLimit: (max: number) => `Invite at most ${max} employees at a time`,
  close: "Close",
  reloadMembers: "Reload members",

  addressSuggestions: "Members",
  skippedDisabled: (names: string) => `Disabled members were skipped: ${names}`,
  mentionNotMember: (token: string) => `${token} is not a member of this channel.`,
  mentionDisabled: (token: string) => `${token} is disabled and cannot be addressed.`,
  mentionEmptyAll: "Address everyone needs at least one enabled member.",
  sendFailed: "The message could not be sent; your draft is kept.",
  saveToNote: "Save to work note",
  saveToNoteAction: "Save note",
  saveToNoteHint:
    "This note becomes readable by everyone working in this work, including content from this conversation. Save " +
    "it?",
  noteTitleFromMessage: (room: string) => `Note from ${room}`,
  readNoteFailed: "The note could not be read; it may have been deleted.",
};

export type WorkContextsMessages = typeof englishWorkContexts;

export const chineseWorkContexts: WorkContextsMessages = {
  navLabel: "工作",
  runsLabel: "执行记录",
  selectWork: "当前工作",
  createWork: "新建工作",
  noWorks: "还没有工作",
  workPickerLabel: "选择工作",
  switchWorkHint: "会话固定属于创建时的工作；切换工作只影响接下来创建的内容。",
  helpTitle: "工作说明",
  title: "工作",
  subtitle: "同一工作的笔记与资料可跨会话共享；其他会话全文不会自动加载。",
  emptyTitle: "还没有工作",
  emptyBody: "创建第一个工作：起个名字、指向目录，然后在里面开一个频道。",
  createTitle: "新建工作",
  editorTitle: (name) => `工作设置 · ${name}`,
  nameLabel: "名称",
  namePlaceholder: "例如：门店改版",
  goalLabel: "目标",
  goalPlaceholder: "这个工作想达成什么",
  instructionsLabel: "工作说明",
  instructionsPlaceholder: "该工作的每个会话都要遵守的长期说明",
  save: "保存工作",
  saving: "正在保存…",
  conflict: "该工作已被其他操作修改。你的草稿仍保留；重新载入后会以服务器当前版本替换它。",
  reload: "重新载入",
  workGone: "工作不存在。",
  viewWork: "查看工作",
  currentWorkLabel: "工作",
  updated: (label) => `已更新${label}`,

  directoriesTitle: "目录",
  directoriesHint:
    "路径必须是服务器上已存在的目录。该工作的所有会话共享它们：共享目录意味着共享文件，不是隔离沙箱。",
  directoriesEmpty: "该工作没有目录：员工可以聊天、调研、记笔记，但不能读写本地文件或运行 Shell。",

  resourcesTitle: "资料",
  resourcesHint: "这里只保存引用：文件必须已存在于上方目录内，链接只列出、不会被抓取。",
  resourceName: "资料名称",
  resourceNamePlaceholder: "例如：设计简报",
  resourceLocation: "绝对文件路径或 http(s) 链接",
  resourceFile: "文件",
  resourceUrl: "链接",
  addResource: "添加资料",
  removeResource: (label) => `移除资料 ${label}`,
  resourceKindLabel: "资料类型",

  notesTitle: "共享笔记",
  notesHint: "笔记是该工作各会话之间唯一共享的记忆。员工在需要时读取，不会自动塞进每轮提示。",
  notesEmpty: "还没有笔记",
  notePick: "选择一条笔记来阅读或编辑",
  notePickerLabel: "选择笔记",
  noteTitle: "笔记标题",
  noteBody: "笔记正文",
  newNote: "新建笔记",
  saveNote: "保存笔记",
  deleteNote: "删除笔记",
  noteSavedNotice: "笔记已保存到该工作的共享笔记。",
  noteDeleted: "笔记已删除",
  noteAuthorYou: "你",
  noteSource: (room, entryId) => `来自 ${room} · 消息 ${entryId}`,
  noteSharedWarning: "该工作的所有员工都能读到已保存的笔记，包括从私聊中保存的内容。",

  membersCount: (count) => `${count} 位成员`,
  manageMembers: "管理成员",
  membersTitle: "频道成员",
  membersJoined: "已加入",
  membersAvailable: "可邀请",
  membersEmpty: "该频道还没有成员。先邀请员工，才能点名。",
  membersNoneAvailable: "所有启用的员工都已在群内。",
  invite: "邀请",
  remove: "移除",
  membersConflict: "成员已在别处被修改。草稿仍保留；重新载入后再试。",
  membersSaved: "成员已更新",
  membersLimit: (max) => `一次最多邀请 ${max} 位员工`,
  close: "关闭",
  reloadMembers: "重新载入成员",

  addressSuggestions: "成员",
  skippedDisabled: (names) => `已跳过停用成员：${names}`,
  mentionNotMember: (token) => `${token} 不是该频道成员。`,
  mentionDisabled: (token) => `${token} 已停用，不能被点名。`,
  mentionEmptyAll: "点名全体需要至少一位启用成员。",
  sendFailed: "消息发送失败，草稿已保留。",
  saveToNote: "保存到工作笔记",
  saveToNoteAction: "保存笔记",
  saveToNoteHint: "保存后该工作的所有员工都能读到这条笔记，包括本会话内容。确定保存？",
  noteTitleFromMessage: (room) => `来自${room}的笔记`,
  readNoteFailed: "笔记读取失败，可能已被删除。",
};
