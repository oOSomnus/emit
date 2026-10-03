/**
 * Words shared across surfaces.
 *
 * Both dictionaries are typed by the English one, so a missing or misspelled
 * key is a compile error. Dynamic sentences are functions: a translation never
 * concatenates already-translated fragments.
 */

export const englishCommon = {
  close: "Close",
  cancel: "Cancel",
  create: "Create",
  save: "Save",
  saving: "Saving…",
  saved: "Saved",
  delete: "Delete",
  remove: "Remove",
  edit: "Edit",
  back: "Back",
  refresh: "Refresh",
  loading: "Loading…",
  retry: "Retry",
  none: "None",
  notRecorded: "Not recorded",
  yes: "Yes",
  no: "No",
  allow: "Allow",
  deny: "Deny",
  requestFailed: (status: number) => `Request failed (${status})`,
  secondsAgo: (seconds: number) => `${seconds} ${seconds === 1 ? "second" : "seconds"} ago`,
  minutesAgo: (minutes: number) => `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`,
  hoursAgo: (hours: number) => `${hours} ${hours === 1 ? "hour" : "hours"} ago`,
};

export type CommonMessages = typeof englishCommon;

export const chineseCommon: CommonMessages = {
  close: "关闭",
  cancel: "取消",
  create: "创建",
  save: "保存",
  saving: "保存中…",
  saved: "已保存",
  delete: "删除",
  remove: "移除",
  edit: "编辑",
  back: "返回",
  refresh: "刷新",
  loading: "载入中…",
  retry: "重试",
  none: "无",
  notRecorded: "未记录",
  yes: "是",
  no: "否",
  allow: "允许",
  deny: "拒绝",
  requestFailed: (status) => `请求失败（${status}）`,
  secondsAgo: (seconds) => `${seconds} 秒前`,
  minutesAgo: (minutes) => `${minutes} 分钟前`,
  hoursAgo: (hours) => `${hours} 小时前`,
};
