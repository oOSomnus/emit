/**
 * Provider login messages: session validation errors, terminal notes, and the
 * internal abort sentinels. Native provider reasons embedded in the refresh
 * notes stay unchanged in both languages.
 */

import type { AppText } from "../app-text.ts";
import { appText } from "../app-text.ts";
import type { AuthType } from "@earendil-works/pi-ai";

export const authMessages = {
  serverClosing: (): AppText =>
    appText({ en: "The service is shutting down", "zh-CN": "服务正在关闭" }),

  providerMissing: (providerId: string): AppText =>
    appText({
      en: `Provider not found: ${providerId}`,
      "zh-CN": `Provider 不存在：${providerId}`,
    }),

  loginUnsupported: (providerName: string, type: AuthType): AppText =>
    appText({
      en: `${providerName} does not support ${type === "oauth" ? "OAuth" : "API key"} login`,
      "zh-CN": `${providerName} 不支持 ${type === "oauth" ? "OAuth" : "API Key"} 登录`,
    }),

  sessionActive: (): AppText =>
    appText({
      en: "Another login is already in progress. Finish or cancel it first",
      "zh-CN": "已有一个进行中的认证会话，请先完成或取消它",
    }),

  sessionMissing: (): AppText =>
    appText({
      en: "The login session does not exist or has expired",
      "zh-CN": "认证会话不存在或已过期",
    }),

  promptStale: (): AppText =>
    appText({
      en: "This prompt is no longer valid. Refresh the session state",
      "zh-CN": "该提示已失效，请刷新会话状态",
    }),

  answerNotString: (): AppText =>
    appText({ en: "The answer must be a string", "zh-CN": "回答必须是字符串" }),

  optionInvalid: (): AppText =>
    appText({ en: "Invalid option", "zh-CN": "选项无效" }),

  secretEmpty: (): AppText =>
    appText({ en: "The key must not be empty", "zh-CN": "密钥不能为空" }),

  /** `reasons` are native provider/refresh failures; embedded unchanged. */
  refreshFailed: (reasons: readonly string[]): AppText =>
    appText({
      en: `Authentication was saved, but the model catalog refresh failed: ${reasons.join("; ")}`,
      "zh-CN": `认证已保存，但模型目录刷新失败：${reasons.join("；")}`,
    }),

  cancelled: (): AppText =>
    appText({ en: "Cancelled", "zh-CN": "已取消" }),

  sessionEnded: (): AppText =>
    appText({ en: "The login session has ended", "zh-CN": "认证会话已结束" }),

  promptCancelledByNativeFlow: (): AppText =>
    appText({
      en: "This prompt was cancelled by the native login flow",
      "zh-CN": "该提示已被原生流程取消",
    }),

  flowEnded: (): AppText =>
    appText({ en: "The login flow has ended", "zh-CN": "认证流程已结束" }),
};
