/**
 * API route messages: validation, not-found, and status replies the routes
 * themselves produce. Manual-approval decision wording lives in the approval
 * catalog (`../approval/state.ts` writes the same strings), so the record and
 * the HTTP layer never drift apart.
 */

import type { LocalizedText } from "../../shared/i18n.ts";
import type { AppText } from "../app-text.ts";

/**
 * Build an application message: `text` stays the original Chinese string the
 * callers and persisted records have always used.
 *
 * This module keeps no runtime import of `../messages.ts`: catalog modules are
 * also imported directly, and a back-edge would make the loaded order decide
 * whether evaluation fails on an uninitialized binding.
 */
function pair(value: LocalizedText): AppText {
  return { text: value["zh-CN"], localized: value };
}

export const apiMessages = {
  missingWorkspaceName: pair({
    en: "Workspace name or your name is missing",
    "zh-CN": "缺少工作区名称或你的名字",
  }),
  missingModelRef: pair({ en: "Model reference is missing", "zh-CN": "缺少模型标识" }),
  employeeNotFound: pair({ en: "Employee not found", "zh-CN": "员工不存在" }),
  invalidRoomKind: pair({ en: "Invalid conversation type", "zh-CN": "会话类型无效" }),
  missingRoomName: pair({ en: "The name is missing", "zh-CN": "缺少名称" }),
  roomNotFound: pair({ en: "Conversation not found", "zh-CN": "会话不存在" }),
  emptyMessageBody: pair({ en: "The message body is empty", "zh-CN": "消息内容为空" }),
  inReplyToNotSentMail: pair({
    en: "inReplyTo must reference a sent mail in the same conversation",
    "zh-CN": "inReplyTo 必须引用当前会话内的已发送邮件",
  }),
  missingDraftId: pair({ en: "The draft id is missing", "zh-CN": "缺少草稿 id" }),
  draftNotFound: pair({ en: "Draft not found", "zh-CN": "草稿不存在" }),
  mailAlreadySent: pair({ en: "This mail has already been sent", "zh-CN": "这封邮件已经发送" }),
  missingMailEntryId: pair({ en: "The mail entry id is missing", "zh-CN": "缺少邮件 id" }),
  malformedCursor: pair({ en: "The cursor is malformed", "zh-CN": "游标格式不正确" }),
  workNotFound: pair({ en: "Work not found", "zh-CN": "工作不存在" }),
  missingSkillDirectory: pair({ en: "The directory path is missing", "zh-CN": "缺少目录路径" }),
  missingProviders: pair({ en: "The providers list is missing", "zh-CN": "缺少 providers" }),
  providerNotFound: pair({ en: "Provider not found", "zh-CN": "Provider 不存在" }),
  catalogRefreshed: pair({ en: "Model catalog refreshed", "zh-CN": "模型目录已刷新" }),
  missingAuthInput: pair({
    en: "providerId is missing or the auth type is invalid",
    "zh-CN": "缺少 providerId 或认证方式无效",
  }),
  missingAuthResponse: pair({ en: "promptId or the answer is missing", "zh-CN": "缺少 promptId 或回答" }),
  apiRouteNotFound: pair({ en: "API route not found", "zh-CN": "接口不存在" }),
  unknownRecipient: (id: string): AppText =>
    pair({ en: `Recipient not found: ${id}`, "zh-CN": `找不到收件人 ${id}` }),
};
