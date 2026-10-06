/**
 * Mail delivery messages: send validations, dispatch failures, and
 * reply-resume errors.
 *
 * Chinese strings are byte-identical to the ones this module replaces; raw
 * reasons passed in (native errors, provider strings) are embedded unchanged
 * in both languages.
 */

import { appText, type AppText } from "../app-text.ts";

export const mailMessages = {
  /** Reply resume. */
  resumeDirectoryChanged: (): AppText =>
    appText({
      en: "The session working directories have changed; the reply cannot resume from the original task",
      "zh-CN": "会话工作目录已变更，回信无法续接原任务",
    }),

  /** Send validations, raised as `RoomDirectoryError` or `AppError`.
   * `会话不存在：${id}`, `inReplyTo 必须引用…`, `这封邮件已经发送`, and
   * `写入的消息类型不正确` live in appMessages.rooms / appMessages.api. */
  newSessionInReplyTo: (): AppText =>
    appText({
      en: "A new mail conversation cannot reference an old conversation's inReplyTo",
      "zh-CN": "新邮件会话不能引用旧会话的 inReplyTo",
    }),
  draftNeedsExistingRoom: (): AppText =>
    appText({
      en: "A new mail conversation cannot retire a draft",
      "zh-CN": "新邮件会话不能退役草稿",
    }),
  draftGone: (): AppText =>
    appText({
      en: "The draft no longer exists or has already changed; refresh and try again",
      "zh-CN": "草稿不存在或已失效，请刷新后重试",
    }),
  callerWorkMissing: (id: string): AppText =>
    appText({ en: `Current work not found: ${id}`, "zh-CN": `找不到当前工作 ${id}` }),
  callerWorkFinished: (): AppText =>
    appText({
      en: "The current work has already finished; it can no longer send mail",
      "zh-CN": "当前工作已结束，不能再发送邮件",
    }),
  awaitReplyEmployeeOnly: (): AppText =>
    appText({ en: "Only mail between employees can wait for a reply", "zh-CN": "只有员工之间的邮件才能等待回信" }),

  /** Reply-resume refusals, raised inside `emit.mail-resume`. */
  parentWorkMissing: (): AppText =>
    appText({ en: "The original task no longer exists; the reply cannot resume it", "zh-CN": "原任务不存在，无法续接回信" }),
  parentConversationMissing: (): AppText =>
    appText({ en: "The original task has no execution conversation", "zh-CN": "原任务执行会话不存在" }),
  resumeRoomMissing: (): AppText =>
    appText({ en: "The mail conversation no longer exists", "zh-CN": "邮件会话不存在" }),
  resumeSourceMissing: (): AppText =>
    appText({ en: "The reply's source text cannot be found; the task cannot resume", "zh-CN": "找不到回信原文，无法续接" }),
  resumeStopped: (): AppText =>
    appText({ en: "Resuming from the reply was stopped", "zh-CN": "回信续接已被停止" }),

  /** Internal invariants on the send and replay path. */
  sentMailInvariant: (): AppText =>
    appText({ en: "sendQueuedMail only accepts sent mail", "zh-CN": "sendQueuedMail 只接受已发送的邮件" }),
  replayRecordMissing: (): AppText =>
    appText({
      en: "The sent-mail record cannot be found; the send result cannot be replayed",
      "zh-CN": "找不到已发送的邮件记录，无法重放发送结果",
    }),
};

export type MailMessages = typeof mailMessages;
