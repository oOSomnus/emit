/**
 * API route messages: validation, not-found, and status replies the routes
 * themselves produce. Manual-approval decision wording lives in the approval
 * catalog (`../approval/state.ts` writes the same strings), so the record and
 * the HTTP layer never drift apart.
 */

import { appText, type AppText } from "../app-text.ts";

export const apiMessages = {
  missingWorkspaceName: appText({
    en: "Workspace name or your name is missing",
    "zh-CN": "缺少工作区名称或你的名字",
  }),
  missingModelRef: appText({ en: "Model reference is missing", "zh-CN": "缺少模型标识" }),
  employeeNotFound: appText({ en: "Employee not found", "zh-CN": "员工不存在" }),
  invalidRoomKind: appText({ en: "Invalid conversation type", "zh-CN": "会话类型无效" }),
  missingRoomName: appText({ en: "The name is missing", "zh-CN": "缺少名称" }),
  roomNotFound: appText({ en: "Conversation not found", "zh-CN": "会话不存在" }),
  emptyMessageBody: appText({ en: "The message body is empty", "zh-CN": "消息内容为空" }),
  inReplyToNotSentMail: appText({
    en: "inReplyTo must reference a sent mail in the same conversation",
    "zh-CN": "inReplyTo 必须引用当前会话内的已发送邮件",
  }),
  missingDraftId: appText({ en: "The draft id is missing", "zh-CN": "缺少草稿 id" }),
  draftNotFound: appText({ en: "Draft not found", "zh-CN": "草稿不存在" }),
  mailAlreadySent: appText({ en: "This mail has already been sent", "zh-CN": "这封邮件已经发送" }),
  missingMailEntryId: appText({ en: "The mail entry id is missing", "zh-CN": "缺少邮件 id" }),
  malformedCursor: appText({ en: "The cursor is malformed", "zh-CN": "游标格式不正确" }),
  workNotFound: appText({ en: "Work not found", "zh-CN": "工作不存在" }),
  missingSkillDirectory: appText({ en: "The directory path is missing", "zh-CN": "缺少目录路径" }),
  missingProviders: appText({ en: "The providers list is missing", "zh-CN": "缺少 providers" }),
  providerNotFound: appText({ en: "Provider not found", "zh-CN": "Provider 不存在" }),
  catalogRefreshed: appText({ en: "Model catalog refreshed", "zh-CN": "模型目录已刷新" }),
  missingAuthInput: appText({
    en: "providerId is missing or the auth type is invalid",
    "zh-CN": "缺少 providerId 或认证方式无效",
  }),
  missingAuthResponse: appText({ en: "promptId or the answer is missing", "zh-CN": "缺少 promptId 或回答" }),
  apiRouteNotFound: appText({ en: "API route not found", "zh-CN": "接口不存在" }),
  unknownRecipient: (id: string): AppText =>
    appText({ en: `Recipient not found: ${id}`, "zh-CN": `找不到收件人 ${id}` }),
};
