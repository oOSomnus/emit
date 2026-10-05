/**
 * Approval evaluation and decision messages.
 *
 * Chinese strings are byte-identical to the application text these entries
 * replaced. Reasons supplied by the model, the classifier, the provider, or the
 * user (`detail` parameters) are embedded raw in both languages; only the
 * application-authored wrapper around them is translated.
 *
 * The one deliberate exception is `actorSystem`: the persisted timeline actor
 * stays the literal `"system"` it has always been, so its `text` is that raw
 * value while the pair carries the display labels.
 */

import type { RiskLevel, ReviewOutcome, UserAuthorizationLevel } from "../approval/contracts.ts";
import type { LocalizedText } from "../../shared/i18n.ts";
import { appText, type AppText } from "../app-text.ts";

export const approvalMessages = {
  // ------------------------------------------------------------- actor labels
  /** Raw actor `"system"`; the pair supplies the display labels. */
  actorSystem: {
    text: "system",
    localized: { en: "System", "zh-CN": "系统" },
  } satisfies AppText,
  actorAuto: appText({ en: "Automatic", "zh-CN": "自动判断" }),
  actorYou: appText({ en: "You", "zh-CN": "你" }),

  // ------------------------------------------------------- persisted gate text
  /** Policy evidence recorded while the evaluator has not answered yet. */
  policyWaiting: appText({ en: "Waiting for automatic review", "zh-CN": "等待自动判断" }),
  submitted: (toolName: string): AppText =>
    appText({ en: `Approval submitted: ${toolName}`, "zh-CN": `提交审批：${toolName}` }),
  /** Required-pair notice: an approval is waiting for a human decision. */
  pendingDecision: (id: string, toolName: string): AppText =>
    appText({
      en: `Approval ${id} is waiting for your decision (${toolName})`,
      "zh-CN": `审批 ${id} 等待你的裁决（${toolName}）`,
    }),

  // -------------------------------------------------------------- blocked cases
  blockedRejected: (id: string, detail: string, detailLocalized?: LocalizedText): AppText =>
    appText({
      en: `The tool call was automatically rejected (approval ${id})${detail.length > 0 ? `: ${detailLocalized?.en ?? detail}` : ""}`,
      "zh-CN": `工具调用被自动拒绝（审批 ${id}）${detail.length > 0 ? `：${detail}` : ""}`,
    }),
  blockedAutomatic: (id: string, detail: string, detailLocalized?: LocalizedText): AppText =>
    appText({
      en: `Automatic review blocked the tool call (approval ${id})${detail.length > 0 ? `: ${detailLocalized?.en ?? detail}` : ""}`,
      "zh-CN": `自动审查阻止了工具调用（审批 ${id}）${detail.length > 0 ? `：${detail}` : ""}`,
    }),
  blockedCancelled: (id: string): AppText =>
    appText({
      en: `The tool call was cancelled: the work it belongs to has stopped (approval ${id})`,
      "zh-CN": `工具调用已取消：所属工作已停止（审批 ${id}）`,
    }),
  /** Model-facing cancellation when the wait ended with the work stopped or aborted. */
  blockedCancelledRun: (toolName: string): AppText =>
    appText({
      en: `The tool call was cancelled: ${toolName} did not run (the work stopped or the call was aborted)`,
      "zh-CN": `工具调用已取消：${toolName} 没有执行（工作已停止或调用被中止）`,
    }),
  blockedInvalidated: (id: string): AppText =>
    appText({
      en: `The session working directories changed, so the old approval is invalid; stop the work and send the task again (approval ${id})`,
      "zh-CN": `会话工作目录已变更，旧审批失效；请停止并重新发送任务（审批 ${id}）`,
    }),
  blockedPendingHuman: (id: string): AppText =>
    appText({
      en: `Waiting for human approval (approval ${id}); the call runs only after you approve or reject it on the Approvals page`,
      "zh-CN": `等待人工审批（审批 ${id}），在“审批”页面批准或拒绝后该调用才会执行`,
    }),
  blockedDefault: (id: string): AppText =>
    appText({
      en: `The tool call was not approved (approval ${id})`,
      "zh-CN": `工具调用未获批准（审批 ${id}）`,
    }),

  // ------------------------------------------------- evaluator availability
  /** Missing or unusable approval judge model, without a nested reason. */
  reviewUnavailable: appText({
    en: "Automatic review is unavailable; configure an approval judge model in Settings",
    "zh-CN": "自动审查不可用，请在设置中配置审批判断模型",
  }),
  /**
   * Missing or unusable approval judge model, with the raw nested reason.
   * The reason class decides the sentence: a broken configuration, a failed
   * model request, or an unusable model response. Only the configuration case
   * points at Settings; the others state that this call was blocked.
   */
  reviewUnavailableWithReason: (
    reason: "configuration" | "provider" | "invalid-output",
    detail: string,
    detailLocalized?: LocalizedText,
  ): AppText =>
    reason === "configuration"
      ? appText({
          en: `Automatic review is unavailable; configure an approval judge model in Settings: ${detailLocalized?.en ?? detail}`,
          "zh-CN": `自动审查不可用，请在设置中配置审批判断模型：${detail}`,
        })
      : reason === "provider"
        ? appText({
            en: `Automatic review is unavailable (model request failed); this call was blocked: ${detailLocalized?.en ?? detail}`,
            "zh-CN": `自动审查不可用（模型请求失败），本次调用已阻止：${detail}`,
          })
        : appText({
            en: `Automatic review is unavailable (invalid model response); this call was blocked: ${detailLocalized?.en ?? detail}`,
            "zh-CN": `自动审查不可用（模型响应无效），本次调用已阻止：${detail}`,
          }),
  /** Policy evidence for a blocked evaluation; `reason` is the outcome reason enum. */
  unavailableEvidence: (reason: string, detail: string, detailLocalized?: LocalizedText): AppText =>
    appText({
      en: `Automatic review unavailable (${reason}): ${detailLocalized?.en ?? detail}`,
      "zh-CN": `自动审查不可用（${reason}）：${detail}`,
    }),
  /** Verdict wrapper for an unavailable evaluation; the reason is embedded raw. */
  unavailableVerdict: (detail: string, detailLocalized?: LocalizedText): AppText =>
    appText({
      en: `Automatic review is unavailable: ${detailLocalized?.en ?? detail}`,
      "zh-CN": `自动审查不可用：${detail}`,
    }),
  /** Timeline sentence for a blocked evaluation; `reason` is a composed AppText. */
  blockedTimeline: (reason: AppText): AppText =>
    appText({
      en: `Automatic review blocked: ${reason.localized?.en ?? reason.text}`,
      "zh-CN": `自动审查受阻：${reason.text}`,
    }),

  // ------------------------------------------------------- automatic verdicts
  denyReason: appText({
    en: "Automatic review decided that this action should not run",
    "zh-CN": "自动审查明确判定该动作不应执行",
  }),
  criticalReason: appText({
    en: "Automatic review classified this action as critical risk and rejected it",
    "zh-CN": "自动审查判定该动作属于严重风险，已自动拒绝",
  }),
  unknownReason: appText({
    en: "Automatic review could not determine the risk level and blocked execution",
    "zh-CN": "自动审查无法确定具体风险等级，已阻止执行",
  }),
  /** `prefix reason；rest reason` with each part localized independently. */
  combinedReason: (prefix: AppText, rest: AppText): AppText =>
    appText({
      en: `${prefix.localized?.en ?? prefix.text}; ${rest.localized?.en ?? rest.text}`,
      "zh-CN": `${prefix.text}；${rest.text}`,
    }),
  autoApproved: (reason: AppText): AppText =>
    appText({
      en: `Automatically approved: ${reason.localized?.en ?? reason.text}`,
      "zh-CN": `自动批准：${reason.text}`,
    }),
  humanHandoff: (reason: AppText): AppText =>
    appText({
      en: `High risk escalated for human review: ${reason.localized?.en ?? reason.text}`,
      "zh-CN": `高风险转人工：${reason.text}`,
    }),
  autoRejected: (reason: AppText): AppText =>
    appText({
      en: `Automatically rejected: ${reason.localized?.en ?? reason.text}`,
      "zh-CN": `自动拒绝：${reason.text}`,
    }),

  // --------------------------------------------------------- evaluator results
  llmSummary: (
    outcome: ReviewOutcome,
    risk: RiskLevel,
    readOnly: boolean,
    userAuthorization: UserAuthorizationLevel,
    rationale: string,
  ): AppText =>
    appText({
      en: `LLM verdict ${outcome} (risk ${risk}; read-only ${readOnly ? "yes" : "no"}; user authorization ${userAuthorization}): ${rationale}`,
      "zh-CN": `LLM 判定 ${outcome}（风险 ${risk}；只读 ${readOnly ? "是" : "否"}；用户授权 ${userAuthorization}）：${rationale}`,
    }),
  classifierSummary: (
    outcome: ReviewOutcome,
    risk: RiskLevel,
    riskProbability: number,
    outcomeProbability: number,
    readOnlyProbability: number | null,
    authorizedProbability: number | null,
  ): AppText =>
    appText({
      en: `Classifier verdict ${outcome} (risk ${risk}, risk probability ${riskProbability.toFixed(4)}; pass probability ${outcomeProbability.toFixed(4)}; read-only probability ${readOnlyProbability === null ? "not recorded" : readOnlyProbability.toFixed(4)}; authorized probability ${authorizedProbability === null ? "not recorded" : authorizedProbability.toFixed(4)})`,
      "zh-CN": `分类器判定 ${outcome}（风险 ${risk}，风险概率 ${riskProbability.toFixed(4)}；通过概率 ${outcomeProbability.toFixed(4)}；只读概率 ${readOnlyProbability === null ? "未记录" : readOnlyProbability.toFixed(4)}；授权概率 ${authorizedProbability === null ? "未记录" : authorizedProbability.toFixed(4)}）`,
    }),

  // --------------------------------------------------------- evaluator setup
  fitConfiguration: appText({
    en: "The approval judge model's context window is too small for automatic review",
    "zh-CN": "审批模型上下文窗口不足以执行自动审查",
  }),
  /** Budget failures are stored verbatim: they are complete sentences on their own. */
  fitBudgetArguments: appText({
    en: "The tool arguments exceed the automatic review input budget; split the call",
    "zh-CN": "工具参数超出自动审查输入预算，请拆分调用",
  }),
  fitBudgetContext: appText({
    en: "The approval context exceeds the automatic review input budget; execution is blocked",
    "zh-CN": "审批上下文超出自动审查输入预算，已阻止执行",
  }),
  evaluatorNotLlm: appText({
    en: "The evaluator configuration is not an LLM",
    "zh-CN": "评估器配置不是 LLM",
  }),
  evaluatorNotClassifier: appText({
    en: "The evaluator configuration is not a classifier",
    "zh-CN": "评估器配置不是 classifier",
  }),
  classifierModelMissing: (providerId: string, modelId: string): AppText =>
    appText({
      en: `Classifier model ${providerId}/${modelId} not found`,
      "zh-CN": `未找到分类模型 ${providerId}/${modelId}`,
    }),

  // ------------------------------------------------------- classifier output
  classifierStopReason: (stopReason: string): AppText =>
    appText({
      en: `The classification request ended with ${stopReason}`,
      "zh-CN": `分类请求结束于 ${stopReason}`,
    }),
  classifierNoAnswers: appText({
    en: "The classifier returned no outcome/risk answers",
    "zh-CN": "分类器没有返回 outcome/risk answers",
  }),
  classifierBadChoice: appText({
    en: "The classifier is missing a valid outcome/risk choice or probability distribution",
    "zh-CN": "分类器缺少合法的 outcome/risk choice 或概率分布",
  }),
  classifierBadEvidence: appText({
    en: "The read-only or authorized evidence returned by the classifier is invalid",
    "zh-CN": "分类器返回的只读或授权证据格式无效",
  }),

  // ------------------------------------------------------------- llm output
  /** The model's raw output is embedded unchanged in both languages. */
  llmUnparseable: (output: string): AppText =>
    appText({
      en: `Cannot parse the model output: ${output}`,
      "zh-CN": `无法解析模型输出: ${output}`,
    }),
  llmBadProtocol: (output: string): AppText =>
    appText({
      en: `The model output does not follow the outcome/risk/rationale/readOnly/userAuthorization protocol: ${output}`,
      "zh-CN": `模型输出不符合 outcome/risk/rationale/readOnly/userAuthorization 协议: ${output}`,
    }),

  // ----------------------------------------------- approval context failures
  /** Complete sentences stored verbatim; the tool call cannot proceed. */
  missingContext: appText({
    en: "The current execution context is missing; the tool call has been blocked",
    "zh-CN": "缺少当前执行上下文，已阻止工具调用",
  }),
  noContextAvailable: appText({
    en: "The current execution session has no available context; the tool call has been blocked",
    "zh-CN": "当前执行会话没有可用上下文，已阻止工具调用",
  }),

  // --------------------------------------------------------- execution record
  executionStarted: (toolName: string): AppText =>
    appText({ en: `${toolName} started`, "zh-CN": `${toolName} 开始执行` }),
  executionSucceeded: (toolName: string): AppText =>
    appText({ en: `${toolName} completed`, "zh-CN": `${toolName} 已完成` }),
  executionFailed: (toolName: string): AppText =>
    appText({ en: `${toolName} returned an error`, "zh-CN": `${toolName} 返回错误` }),

  // ------------------------------------------------------------ human decision
  notFound: appText({ en: "Approval not found", "zh-CN": "审批不存在" }),
  notFoundWithId: (id: string): AppText =>
    appText({ en: `Approval not found: ${id}`, "zh-CN": `审批不存在: ${id}` }),
  decisionInvalid: appText({
    en: "The decision must be approved or rejected",
    "zh-CN": "裁决必须是 approved 或 rejected",
  }),
  alreadyInStatus: (status: string): AppText =>
    appText({
      en: `The approval is already in ${status} state`,
      "zh-CN": `审批已处于 ${status} 状态`,
    }),
  alreadyDecided: (status: string): AppText =>
    appText({
      en: `The approval has already been decided: ${status}`,
      "zh-CN": `审批已被处理：${status}`,
    }),
  humanApproved: appText({ en: "Approved by you", "zh-CN": "由你批准" }),
  humanRejected: appText({ en: "Rejected by you", "zh-CN": "由你拒绝" }),
  humanTimelineApproved: appText({ en: "Execution approved", "zh-CN": "批准执行" }),
  humanTimelineRejected: appText({ en: "Execution rejected", "zh-CN": "拒绝执行" }),
  /** `批准：${comment}` / `拒绝：${comment}`; the comment is user content, kept raw. */
  decidedWithComment: (decision: "approved" | "rejected", comment: string): AppText =>
    decision === "approved"
      ? appText({
          en: `Approved${comment.length > 0 ? `: ${comment}` : ""}`,
          "zh-CN": `批准${comment.length > 0 ? `：${comment}` : ""}`,
        })
      : appText({
          en: `Rejected${comment.length > 0 ? `: ${comment}` : ""}`,
          "zh-CN": `拒绝${comment.length > 0 ? `：${comment}` : ""}`,
        }),

  // ------------------------------------------------------------- invalidation
  directoryInvalidated: (currentVersion: number): AppText =>
    appText({
      en: `The session working directories changed (current version v${currentVersion}), so the old approval is invalid; stop the work and send the task again`,
      "zh-CN": `会话工作目录已变更（当前版本 v${currentVersion}），旧审批失效；请停止并重新发送任务`,
    }),
  policyUpdated: (policyVersion: number): AppText =>
    appText({
      en: `The approval policy was updated (v${policyVersion}); old grants are invalid`,
      "zh-CN": `审批策略已更新（v${policyVersion}），旧批准失效`,
    }),
  workStopped: appText({
    en: "The work has stopped; the approval was cancelled",
    "zh-CN": "所属工作已停止，审批取消",
  }),
};
