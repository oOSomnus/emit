/**
 * Workspace and employee validation messages.
 *
 * These reach the browser as 400 responses. Model diagnoses are composed per
 * language: the catalog problem keeps its raw text, and English uses its pair
 * when one exists.
 *
 * This module keeps no runtime import of `../messages.ts`: catalog modules are
 * also imported directly, and a back-edge would make the loaded order decide
 * whether evaluation fails on an uninitialized binding.
 */

import type { LocalizedText } from "../../shared/i18n.ts";
import type { AppText } from "../app-text.ts";

/** Build an application message: `text` stays the original Chinese string. */
function pair(value: LocalizedText): AppText {
  return { text: value["zh-CN"], localized: value };
}

/** Which chat selection a validation failure is about. */
export type ExecutionModelScope = "default" | "employee";

const executionModelLabels: Record<ExecutionModelScope, LocalizedText> = {
  default: { en: "Default execution model", "zh-CN": "默认执行模型" },
  employee: { en: "Employee execution model", "zh-CN": "员工执行模型" },
};

export const workspaceMessages = {
  /** The approval judge is required at setup and whenever settings change. */
  approvalJudgeRequired: pair({
    en: "Choose an available approval judge model",
    "zh-CN": "请选择一个可用的审批判断模型",
  }),
  approvalJudgeEmpty: pair({
    en: "The approval judge model cannot be empty",
    "zh-CN": "审批判断模型不能为空",
  }),
  employeeLocalPartInvalid: pair({
    en: "The email local part is invalid",
    "zh-CN": "邮箱本地部分无效",
  }),
  employeeNotFound: (id: string): AppText =>
    pair({ en: `Employee not found: ${id}`, "zh-CN": `员工不存在: ${id}` }),
  executionModelUnavailable: (scope: ExecutionModelScope, problem: AppText): AppText => {
    const label = executionModelLabels[scope];
    return pair({
      en: `${label.en} is unavailable: ${problem.localized?.en ?? problem.text}`,
      "zh-CN": `${label["zh-CN"]}不可用：${problem.text}`,
    });
  },
  approvalJudgeUnavailable: (problem: AppText): AppText =>
    pair({
      en: `The approval judge model is unavailable: ${problem.localized?.en ?? problem.text}`,
      "zh-CN": `审批判断模型不可用：${problem.text}`,
    }),
};
