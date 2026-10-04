/**
 * Room and directory messages: the transcript DTO helpers and the
 * working-directory validation errors.
 *
 * Directory reasons embed caller-provided paths verbatim in both languages;
 * the raw native reason of a failed `realpath`/`stat` is inserted unchanged.
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

export const roomMessages = {
  /** Author labels derived from identity at DTO time, never from stored names alone. */
  systemAuthorName: { en: "System", "zh-CN": "系统" } satisfies LocalizedText,
  userFallbackAuthorName: { en: "You", "zh-CN": "你" } satisfies LocalizedText,

  messageUnexpectedType: pair({
    en: "The appended message has an unexpected type",
    "zh-CN": "写入的消息类型不正确",
  }),
  expectedVersionNotAnInteger: pair({
    en: "expectedVersion must be an integer",
    "zh-CN": "expectedVersion 必须是整数",
  }),
  roomNotFoundWithId: (roomId: string): AppText =>
    pair({ en: `Conversation not found: ${roomId}`, "zh-CN": `会话不存在：${roomId}` }),
  workContextMissing: (id: string): AppText =>
    pair({
      en: `The work this conversation would belong to does not exist: ${id || "(empty)"}`,
      "zh-CN": `该会话所属的工作不存在：${id || "(空)"}`,
    }),
  memberNotFound: (id: string): AppText =>
    pair({ en: `Employee not found: ${id}`, "zh-CN": `找不到员工 ${id}` }),
  memberDisabled: (name: string): AppText =>
    pair({ en: `Employee ${name} is disabled and cannot be a member`, "zh-CN": `员工 ${name} 已停用，不能加入` }),
  membersNotAnArray: pair({ en: "memberIds must be an array", "zh-CN": "memberIds 必须是数组" }),
  membersChannelOnly: pair({
    en: "Members can be managed only in a channel",
    "zh-CN": "只有频道可以管理成员",
  }),
  membersChangedReload: (latest: number): AppText =>
    pair({
      en: `Membership changed elsewhere; the latest membership version is ${latest}. Reload before saving.`,
      "zh-CN": `成员已在别处被修改，最新成员版本是 ${latest}，请重新载入后再保存`,
    }),
  dmParticipantsInvalid: pair({
    en: "A direct message needs exactly two distinct participants",
    "zh-CN": "私信必须恰好有两位不同的参与者",
  }),
  membersInvited: (actor: string, names: readonly string[]): AppText =>
    pair({
      en: `${actor} added ${names.join(", ")} to the channel`,
      "zh-CN": `${actor} 邀请了 ${names.join("、")} 加入频道`,
    }),
  membersRemoved: (actor: string, names: readonly string[]): AppText =>
    pair({
      en: `${actor} removed ${names.join(", ")} from the channel`,
      "zh-CN": `${actor} 将 ${names.join("、")} 移出了频道`,
    }),

  /** Message routing refusals (`sendQueuedMessage`, `send_message`). */
  mailNotByMessageSend: pair({
    en: "Mail must be sent through the mail send path, not the message path",
    "zh-CN": "邮件不能通过消息发送路径发送，请使用邮件发送",
  }),
  dmNoAddressing: pair({
    en: "A direct message does not take recipients or @all",
    "zh-CN": "私信不能指定收件人或 @全体",
  }),
  notParticipant: (name: string): AppText =>
    pair({
      en: `${name.length > 0 ? name : "This employee"} is not a participant of this conversation`,
      "zh-CN": `${name.length > 0 ? name : "该员工"}不是本会话的参与者`,
    }),
  sendSelfNotAllowed: pair({
    en: "A plain channel message cannot wake the sender; address others explicitly",
    "zh-CN": "普通群消息不能唤醒发送者本人，请点名其他员工",
  }),
  ancestorRecipient: (name: string): AppText =>
    pair({
      en: `Cannot wake ${name}: they are an ancestor of this task and it would form a loop`,
      "zh-CN": `不能唤醒本任务的上级 ${name}，这会形成循环`,
    }),
};
