/**
 * Model catalog messages: chat/approval selection diagnostics, connection
 * checks, and the one-shot completion wrappers. Model names, provider ids, and
 * native provider errors are embedded unchanged; only the sentence around them
 * is app-authored, so effort lists are joined per language.
 */

import type { AppText } from "../app-text.ts";
import { appText } from "../app-text.ts";

export const modelMessages = {
  chatSelectionRequired: (): AppText =>
    appText({ en: "Select an execution model", "zh-CN": "请选择执行模型" }),

  chatModelUnresolved: (providerId: string, modelId: string): AppText =>
    appText({
      en: `Chat model not available: ${providerId}/${modelId}`,
      "zh-CN": `找不到可用的对话模型 ${providerId}/${modelId}`,
    }),

  /** `supported` is the effort list; joined with the list separator of each language. */
  effortUnsupported: (modelName: string, effort: string, supported: readonly string[]): AppText =>
    appText({
      en: `Model ${modelName} does not support effort "${effort}". Available: ${supported.join(", ")}`,
      "zh-CN": `模型 ${modelName} 不支持 effort「${effort}」，可选：${supported.join("、")}`,
    }),

  classifierModelUnresolved: (providerId: string, modelId: string): AppText =>
    appText({
      en: `Classifier model not available: ${providerId}/${modelId}`,
      "zh-CN": `找不到分类模型 ${providerId}/${modelId}`,
    }),

  classifierModelMissing: (providerId: string, modelId: string): AppText =>
    appText({
      en: `Classifier model not found: ${providerId}/${modelId}`,
      "zh-CN": `未找到分类模型 ${providerId}/${modelId}`,
    }),

  chatModelMissing: (providerId: string, modelId: string): AppText =>
    appText({
      en: `Chat model not found: ${providerId}/${modelId}`,
      "zh-CN": `未找到对话模型 ${providerId}/${modelId}`,
    }),

  chatModelNotConfigured: (providerId: string, modelId: string): AppText =>
    appText({
      en: `No chat model is configured: ${providerId}/${modelId}`,
      "zh-CN": `未配置对话模型 ${providerId}/${modelId}`,
    }),

  /** App-authored fallback when the probe carries no native error message. */
  requestEnded: (stopReason: string): AppText =>
    appText({
      en: `The request ended with "${stopReason}"`,
      "zh-CN": `请求结束于 ${stopReason}`,
    }),

  /**
   * A response that did not reach a complete final answer. `length` is named as
   * the output limit; any other end is described by its stop reason. The token
   * counts make a reasoning model's spent budget diagnosable.
   */
  requestIncomplete: (stopReason: string, maxTokens: number, outputTokens: number): AppText =>
    appText({
      en: `${stopReason === "length" ? "The model response reached its output limit" : "The model response did not finish completely"} (stop reason ${stopReason}; output limit ${maxTokens} tokens; output ${outputTokens} tokens); no complete final answer was obtained`,
      "zh-CN": `${stopReason === "length" ? "模型响应达到输出上限" : "模型响应未完整结束"}（结束原因 ${stopReason}；输出上限 ${maxTokens} token；实际输出 ${outputTokens} token），未取得完整最终回答`,
    }),

  /** A clean stop with no final text: thinking never substitutes for an answer. */
  requestEmptyOutput: (stopReason: string, effort: string, outputTokens: number): AppText =>
    appText({
      en: `The model returned no final text (stop reason ${stopReason}; reasoning effort ${effort}; output ${outputTokens} tokens)`,
      "zh-CN": `模型未返回最终正文（结束原因 ${stopReason}；推理强度 ${effort}；实际输出 ${outputTokens} token）`,
    }),

  classifierRequestEnded: (stopReason: string): AppText =>
    appText({
      en: `The classification request ended with "${stopReason}"`,
      "zh-CN": `分类请求结束于 ${stopReason}`,
    }),

  /** `answerType`/`stopReason` come from the probe result and pass through. */
  classifierResponded: (modelName: string, answerType: string): AppText =>
    appText({
      en: `${modelName} responded (${answerType})`,
      "zh-CN": `${modelName} 已应答（${answerType}）`,
    }),

  chatResponded: (modelName: string, stopReason: string): AppText =>
    appText({
      en: `${modelName} responded (${stopReason})`,
      "zh-CN": `${modelName} 已应答（${stopReason}）`,
    }),
};
