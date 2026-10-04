/**
 * Work lifecycle messages: creation and start validations, run failures,
 * stops, reconciliation, and the work-related notices.
 *
 * Chinese strings are byte-identical to the ones this module replaces; raw
 * reasons passed in (native errors, serialized task failures) are embedded
 * unchanged in both languages.
 */

import type { LocalizedText } from "../../shared/i18n.ts";
import { appText, type AppText } from "../app-text.ts";

/**
 * An SSE notice event: `text` stays the original string the event has always
 * carried, and `textLocalized` is the pair the contract requires.
 */
export function noticeOf(value: AppText): { type: "notice"; text: string; textLocalized: LocalizedText } {
  return {
    type: "notice",
    text: value.text,
    textLocalized: value.localized ?? { en: value.text, "zh-CN": value.text },
  };
}

export const workMessages = {
  /** Creation and start validations. */
  employeeNotFound: (id: string): AppText =>
    appText({ en: `Employee not found: ${id}`, "zh-CN": `找不到员工 ${id}` }),
  employeeDisabled: (name: string): AppText =>
    appText({ en: `Employee ${name} is disabled`, "zh-CN": `员工 ${name} 已停用` }),
  modelUnavailable: (name: string, problem: AppText): AppText =>
    appText({
      en: `Employee ${name}'s model is unavailable: ${problem.localized?.en ?? problem.text}`,
      "zh-CN": `员工 ${name} 的模型不可用：${problem.text}`,
    }),
  depthOverLimit: (max: number): AppText =>
    appText({ en: `Delegation depth exceeds the limit (${max} levels)`, "zh-CN": `交办层数超过上限（${max} 层）` }),
  workWriteFailed: (id: string): AppText =>
    appText({ en: `Failed to write the work record ${id}`, "zh-CN": `工作记录写入失败 ${id}` }),
  finished: (status: string): AppText =>
    appText({
      en: `Work already finished (${status}); execution will not start`,
      "zh-CN": `工作已结束（${status}），不再启动执行`,
    }),
  workNotFound: (id: string): AppText => appText({ en: `Work not found: ${id}`, "zh-CN": `找不到工作 ${id}` }),
  directoryChanged: (): AppText =>
    appText({
      en: "The session working directories have changed; stop this work and send the task again",
      "zh-CN": "会话工作目录已变更，请停止并重新发送任务",
    }),
  conversationMissing: (id: number): AppText =>
    appText({ en: `Execution conversation not found: ${id}`, "zh-CN": `执行会话不存在 ${id}` }),
  mailSourceMissing: (): AppText =>
    appText({
      en: "The original mail message cannot be found; the reply task cannot be generated",
      "zh-CN": "找不到本次邮件原文，无法生成回复任务",
    }),

  /** Run settlement and reconciliation failures. */
  runNoAnswer: (): AppText =>
    appText({
      en: "This run produced no answer (the model or a tool failed; see the run's execution record for details)",
      "zh-CN": "本次运行没有产生回答（模型或工具出错，详情见该次运行记录）",
    }),
  dispatchLost: (): AppText =>
    appText({
      en: "The dispatch task is missing; this work never started",
      "zh-CN": "执行派发任务丢失，该工作未能开始",
    }),
  startInterrupted: (): AppText =>
    appText({
      en: "Startup was interrupted; the execution conversation was never created",
      "zh-CN": "启动过程中断，未能创建执行会话",
    }),
  processInterrupted: (): AppText =>
    appText({
      en: "The process was interrupted; this run could not be resumed",
      "zh-CN": "进程中断，该次运行未能恢复",
    }),
  awaitChildMissing: (): AppText =>
    appText({ en: "The awaited reply's work record is missing", "zh-CN": "等待的回信工作记录丢失" }),
  awaitResumeTaskMissing: (childId: string): AppText =>
    appText({ en: `The reply resume task is missing (${childId})`, "zh-CN": `回信任务缺失（${childId}）` }),
  awaitResumeTaskRecordMissing: (childId: string): AppText =>
    appText({ en: `The reply resume task record is missing (${childId})`, "zh-CN": `回信任务记录丢失（${childId}）` }),
  awaitReplyNotSubmitted: (childId: string): AppText =>
    appText({ en: `The reply never reached the original task (${childId})`, "zh-CN": `回信没有进入原任务（${childId}）` }),
  awaitUnreachable: (broken: AppText): AppText =>
    appText({
      en: `The awaited reply cannot resume from the original task: ${broken.localized?.en ?? broken.text}`,
      "zh-CN": `等待的回信无法续接原任务：${broken.text}`,
    }),

  /** Stops. */
  stoppedByUser: (): AppText => appText({ en: "Stopped by the user", "zh-CN": "已被用户停止" }),
  stopNotice: (name: string): AppText =>
    appText({
      en: `Stopped ${name.length > 0 ? name : "the employee"}'s work.`,
      "zh-CN": `已停止 ${name.length > 0 ? name : "员工"} 的工作。`,
    }),

  /** Room notices and SSE notices. */
  failNotice: (name: string, reason: AppText): AppText =>
    appText({
      en: `${name.length > 0 ? name : "The employee"}'s work did not complete: ${reason.localized?.en ?? reason.text}. Please send it again.`,
      "zh-CN": `${name.length > 0 ? name : "员工"} 的这次工作未能完成：${reason.text}。请重新发送。`,
    }),
  turnLimit: (max: number): AppText =>
    appText({
      en: `Collaboration reached the model turn limit (${max} turns); the work has been stopped.`,
      "zh-CN": `协作已达到模型轮次上限（${max} 轮），本次工作已停止。`,
    }),

  /** Directory scope resolved for a new work. */
  delegationSourceMissing: (): AppText =>
    appText({ en: "The delegation has no valid source conversation", "zh-CN": "交办任务没有有效来源会话" }),
  sourceRoomMissing: (): AppText =>
    appText({ en: "The source conversation does not exist", "zh-CN": "来源会话不存在" }),

  /** Collaboration routing. */
  wakeLimit: (max: number): AppText =>
    appText({
      en: `Collaboration has reached the cross-employee wake limit (${max} wakes)`,
      "zh-CN": `本次协作已达到跨员工唤醒上限（${max} 次）`,
    }),
  dispatchStopped: (): AppText =>
    appText({ en: "The dispatch was stopped", "zh-CN": "任务投递已被停止" }),
  removedFromConversation: (name: string): AppText =>
    appText({
      en: `${name.length > 0 ? name : "The employee"} was removed from the conversation, so this run stopped and its result was not published.`,
      "zh-CN": `${name.length > 0 ? name : "该员工"} 已被移出会话，本次运行已停止，结果不再发布。`,
    }),

  /** Execution-record paging (work-execution.ts); `游标格式不正确` lives in appMessages.api. */
  cursorUnparsable: (): AppText => appText({ en: "The cursor could not be parsed", "zh-CN": "游标无法解析" }),
};

export type WorkMessages = typeof workMessages;
