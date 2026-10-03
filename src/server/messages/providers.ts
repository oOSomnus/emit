/**
 * Custom provider validation messages and the built-in Azure login prompts.
 *
 * Validation reasons embed user-submitted fragments (ids, URLs) unchanged in
 * both languages. Prompt fields that read identically in both languages carry
 * no translation pair.
 */

import type { AppText } from "../app-text.ts";
import { appText } from "../app-text.ts";
import type { LocalizedText } from "../../shared/i18n.ts";

/** Display stand-in for a submitted value the user left empty. */
const EMPTY_EN = "(empty)";
const EMPTY_ZH = "(空)";

export const providerMessages = {
  validate: {
    mustBeArray: (): AppText =>
      appText({ en: "providers must be an array", "zh-CN": "providers 必须是数组" }),

    entryNotObject: (where: string): AppText =>
      appText({ en: `${where} is not an object`, "zh-CN": `${where} 不是对象` }),

    idInvalid: (where: string, id: string): AppText =>
      appText({
        en: `${where}.id is invalid: ${id.length > 0 ? id : EMPTY_EN}`,
        "zh-CN": `${where}.id 无效：${id.length > 0 ? id : EMPTY_ZH}`,
      }),

    idConflictsBuiltin: (where: string, id: string): AppText =>
      appText({
        en: `${where}.id conflicts with a built-in provider: ${id}`,
        "zh-CN": `${where}.id 与内置 Provider 冲突：${id}`,
      }),

    idDuplicate: (id: string): AppText =>
      appText({
        en: `Duplicate custom provider id: ${id}`,
        "zh-CN": `自定义 Provider id 重复：${id}`,
      }),

    baseUrlNotUrl: (where: string, baseUrl: string): AppText =>
      appText({
        en: `${where}.baseUrl is not a valid URL: ${baseUrl.length > 0 ? baseUrl : EMPTY_EN}`,
        "zh-CN": `${where}.baseUrl 不是合法 URL：${baseUrl.length > 0 ? baseUrl : EMPTY_ZH}`,
      }),

    baseUrlNotHttp: (where: string, baseUrl: string): AppText =>
      appText({
        en: `${where}.baseUrl must be an http(s) URL: ${baseUrl}`,
        "zh-CN": `${where}.baseUrl 必须是 http(s) 地址：${baseUrl}`,
      }),

    baseUrlNoCredentials: (where: string): AppText =>
      appText({
        en: `${where}.baseUrl must not contain a username or password`,
        "zh-CN": `${where}.baseUrl 不能包含用户名或密码`,
      }),

    apiUnsupported: (where: string, apis: readonly string[]): AppText =>
      appText({
        en: `${where}.api must be one of ${apis.join(" / ")}`,
        "zh-CN": `${where}.api 必须是 ${apis.join(" / ")} 之一`,
      }),

    apiKeyEnvInvalid: (where: string): AppText =>
      appText({
        en: `${where}.apiKeyEnv must be an uppercase environment variable name or an empty string`,
        "zh-CN": `${where}.apiKeyEnv 必须是大写环境变量名或空字符串`,
      }),

    modelsAtLeastOne: (where: string): AppText =>
      appText({
        en: `${where}.models needs at least one model`,
        "zh-CN": `${where}.models 至少需要一个模型`,
      }),

    modelNotObject: (where: string): AppText =>
      appText({ en: `${where} is not an object`, "zh-CN": `${where} 不是对象` }),

    modelIdEmpty: (where: string): AppText =>
      appText({
        en: `${where}.id must not be empty`,
        "zh-CN": `${where}.id 不能为空`,
      }),

    modelIdNoPipe: (where: string): AppText =>
      appText({
        en: `${where}.id must not contain "|"`,
        "zh-CN": `${where}.id 不能包含「|」`,
      }),

    modelIdDuplicate: (where: string, modelId: string): AppText =>
      appText({
        en: `Duplicate model id in ${where}.models: ${modelId}`,
        "zh-CN": `${where}.models 中模型 id 重复：${modelId}`,
      }),

    contextWindowPositive: (where: string): AppText =>
      appText({
        en: `${where}.contextWindow must be a positive integer`,
        "zh-CN": `${where}.contextWindow 必须是正整数`,
      }),

    maxTokensPositive: (where: string): AppText =>
      appText({
        en: `${where}.maxTokens must be a positive integer`,
        "zh-CN": `${where}.maxTokens 必须是正整数`,
      }),

    reasoningBoolean: (where: string): AppText =>
      appText({
        en: `${where}.reasoning must be a boolean`,
        "zh-CN": `${where}.reasoning 必须是布尔值`,
      }),

    inputTextOrImage: (where: string): AppText =>
      appText({
        en: `${where}.input accepts only text or image, and must not be empty`,
        "zh-CN": `${where}.input 只能包含 text 或 image，且不能为空`,
      }),
  },

  azure: {
    endpointModePrompt: (): AppText =>
      appText({ en: "Azure OpenAI endpoint mode", "zh-CN": "Azure OpenAI 端点方式" }),

    /** `label` keeps the submitted-string wording; the descriptions differ per language. */
    baseUrlOption: (): {
      id: string;
      label: string;
      description: string;
      descriptionLocalized: LocalizedText;
    } => ({
      id: "base-url",
      label: "Base URL",
      description: "例如 https://my-resource.openai.azure.com/openai/v1",
      descriptionLocalized: {
        en: "for example https://my-resource.openai.azure.com/openai/v1",
        "zh-CN": "例如 https://my-resource.openai.azure.com/openai/v1",
      },
    }),

    resourceNameOption: (): {
      id: string;
      label: string;
      description: string;
      descriptionLocalized: LocalizedText;
    } => ({
      id: "resource-name",
      label: "Resource name",
      description: "例如 my-resource",
      descriptionLocalized: { en: "for example my-resource", "zh-CN": "例如 my-resource" },
    }),

    baseUrlRetry: (): AppText =>
      appText({
        en: "The Base URL must be an absolute address starting with http:// or https://. Please try again.",
        "zh-CN": "Base URL 必须是以 http:// 或 https:// 开头的绝对地址，请重试。",
      }),

    resourceNameRetry: (): AppText =>
      appText({
        en: "The resource name must not be empty. Please try again.",
        "zh-CN": "resource name 不能为空，请重试。",
      }),

    unknownEndpointMode: (mode: string): AppText =>
      appText({
        en: `Unknown Azure endpoint mode: ${mode}`,
        "zh-CN": `未知的 Azure 端点方式：${mode}`,
      }),

    apiVersionPrompt: (): AppText =>
      appText({
        en: "API version (leave blank for v1)",
        "zh-CN": "API version（留空使用 v1）",
      }),

    deploymentMapPrompt: (): AppText =>
      appText({
        en: "Deployment map, format model-id=deployment-name,model-id=deployment-name (leave blank to use the model id)",
        "zh-CN": "部署映射，格式 model-id=deployment-name,model-id=deployment-name（留空使用模型 id）",
      }),

    deploymentMapRetry: (): AppText =>
      appText({
        en: "Each deployment map entry must be model-id=deployment-name. Please try again.",
        "zh-CN": "部署映射每一项都必须是 model-id=deployment-name，请重试。",
      }),
  },
};
