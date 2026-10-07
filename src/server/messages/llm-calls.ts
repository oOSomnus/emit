import { appText } from "../app-text.ts";

export const llmCallMessages = {
  invalidCursor: appText({
    en: "The LLM call cursor is invalid",
    "zh-CN": "LLM 调用游标无效",
  }),
  notFound: appText({
    en: "LLM call not found",
    "zh-CN": "LLM 调用不存在",
  }),
  corruptRecord: appText({
    en: "The LLM call record is incomplete",
    "zh-CN": "LLM 调用记录不完整",
  }),
  captureFailure: appText({
    en: "LLM call history could not be fully recorded.",
    "zh-CN": "LLM 调用历史未能完整保存。",
  }),
};
