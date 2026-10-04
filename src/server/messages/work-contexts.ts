/**
 * Work-context messages: creation and patch validation, resource and note
 * failures, and the tool-side authorization errors.
 *
 * Every reason embeds the caller-provided id/path/number verbatim in both
 * languages; a raw native reason (a failed `realpath`/`stat`) is inserted
 * unchanged.
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

export const workContextMessages = {
  notFound: (id: string): AppText =>
    pair({ en: `Work not found: ${id}`, "zh-CN": `工作不存在：${id}` }),
  nameRequired: pair({ en: "The work name is required", "zh-CN": "工作名称不能为空" }),
  nameTooLong: (max: number): AppText =>
    pair({ en: `The work name exceeds ${max} characters`, "zh-CN": `工作名称超过 ${max} 字符` }),
  goalTooLong: (max: number): AppText =>
    pair({ en: `The work goal exceeds ${max} characters`, "zh-CN": `工作目标超过 ${max} 字符` }),
  instructionsTooLong: (max: number): AppText =>
    pair({
      en: `The work instructions exceed ${max} characters`,
      "zh-CN": `工作说明超过 ${max} 字符`,
    }),
  expectedVersionNotAnInteger: pair({
    en: "expectedVersion must be an integer",
    "zh-CN": "expectedVersion 必须是整数",
  }),
  versionConflict: (latest: number): AppText =>
    pair({
      en: `The work changed elsewhere; the latest version is ${latest}. Reload before saving.`,
      "zh-CN": `该工作已在别处被修改，最新版本是 ${latest}，请重新载入后再保存`,
    }),
  patchNotAnObject: pair({ en: "The work patch must be an object", "zh-CN": "工作更新内容必须是对象" }),

  // Directory configuration (reuses the room-directory rules and wording).
  directoryNotAbsolutePath: (path: string): AppText =>
    pair({
      en: `The working directory must be an absolute path on the server: ${path || "(empty)"}`,
      "zh-CN": `工作目录必须是服务器本地绝对路径：${path || "(空)"}`,
    }),
  directoryNotADirectory: (path: string): AppText =>
    pair({ en: `The working directory is not a directory: ${path}`, "zh-CN": `工作目录不是目录：${path}` }),
  directoryUnreadable: (path: string, reason: string): AppText =>
    pair({
      en: `The working directory ${path} does not exist or cannot be accessed: ${reason}`,
      "zh-CN": `工作目录不存在或无法访问 ${path}：${reason}`,
    }),
  directoriesNotAnObject: pair({
    en: "The working directory configuration must be an object",
    "zh-CN": "工作目录配置必须是对象",
  }),
  directoryPathsNotAnArray: pair({
    en: "Working directory paths must be an array",
    "zh-CN": "工作目录 paths 必须是数组",
  }),
  defaultDirectoryNotAString: pair({
    en: "The default working directory must be a string",
    "zh-CN": "默认工作目录必须是字符串",
  }),
  directoryPathNotAString: pair({
    en: "Each working directory path must be a string",
    "zh-CN": "工作目录路径必须是字符串",
  }),
  defaultDirectoryNotAuthorized: (path: string): AppText =>
    pair({
      en: `The default working directory is not in the authorized directory list: ${path}`,
      "zh-CN": `默认工作目录不在授权目录列表中：${path}`,
    }),
  chooseDefaultDirectory: pair({
    en: "Choose the default working directory from the authorized directory list",
    "zh-CN": "请从授权目录列表中选择默认工作目录",
  }),
  directoriesMissingRecreate: pair({
    en: "This work is missing its directory configuration, please recreate it",
    "zh-CN": "该工作缺少目录配置，请重新创建工作",
  }),

  // Resources.
  resourcesNotAnArray: pair({ en: "Resources must be an array", "zh-CN": "资料列表必须是数组" }),
  resourceLimit: (max: number): AppText =>
    pair({ en: `A work carries at most ${max} resources`, "zh-CN": `每个工作最多 ${max} 项资料` }),
  resourceNotAnObject: pair({ en: "Each resource must be an object", "zh-CN": "每项资料必须是对象" }),
  resourceKindInvalid: pair({
    en: 'A resource kind must be "file" or "url"',
    "zh-CN": "资料类型必须是 file 或 url",
  }),
  resourceNameRequired: pair({ en: "A resource name is required", "zh-CN": "资料名称不能为空" }),
  resourceNameTooLong: (max: number): AppText =>
    pair({ en: `A resource name exceeds ${max} characters`, "zh-CN": `资料名称超过 ${max} 字符` }),
  resourceLocationRequired: pair({ en: "A resource location is required", "zh-CN": "资料位置不能为空" }),
  resourceLocationTooLong: (max: number): AppText =>
    pair({ en: `A resource location exceeds ${max} characters`, "zh-CN": `资料位置超过 ${max} 字符` }),
  resourceIdUnknown: (id: string): AppText =>
    pair({
      en: `The resource ${id} does not belong to this work`,
      "zh-CN": `资料 ${id} 不属于该工作`,
    }),
  resourceIdDuplicate: (id: string): AppText =>
    pair({ en: `Duplicate resource id ${id}`, "zh-CN": `资料 id 重复：${id}` }),
  resourceFileNotAFile: (location: string): AppText =>
    pair({
      en: `The resource file is not a regular file: ${location}`,
      "zh-CN": `资料文件不是普通文件：${location}`,
    }),
  resourceFileMissing: (location: string, reason: string): AppText =>
    pair({
      en: `The resource file ${location} does not exist or cannot be accessed: ${reason}`,
      "zh-CN": `资料文件不存在或无法访问 ${location}：${reason}`,
    }),
  resourceFileOutsideDirectories: (location: string): AppText =>
    pair({
      en: `A file resource must live inside this work's authorized directories: ${location}`,
      "zh-CN": `文件资料必须位于该工作授权的目录内：${location}`,
    }),
  resourceUrlInvalid: (location: string): AppText =>
    pair({
      en: `A URL resource must be an http or https URL: ${location}`,
      "zh-CN": `链接资料必须是 http 或 https 链接：${location}`,
    }),

  // Notes.
  noteLimit: (max: number): AppText =>
    pair({ en: `A work carries at most ${max} notes`, "zh-CN": `每个工作最多 ${max} 条笔记` }),
  noteTitleRequired: pair({ en: "A note title is required", "zh-CN": "笔记标题不能为空" }),
  noteTitleTooLong: (max: number): AppText =>
    pair({ en: `A note title exceeds ${max} characters`, "zh-CN": `笔记标题超过 ${max} 字符` }),
  noteBodyRequired: pair({ en: "A note body is required", "zh-CN": "笔记正文不能为空" }),
  noteBodyTooLong: (max: number): AppText =>
    pair({ en: `A note body exceeds ${max} characters`, "zh-CN": `笔记正文超过 ${max} 字符` }),
  noteNotFound: (noteId: string): AppText =>
    pair({ en: `Note not found: ${noteId}`, "zh-CN": `笔记不存在：${noteId}` }),
  noteSourceInvalid: pair({
    en: "The note source must be a real message of this work's conversations",
    "zh-CN": "笔记来源必须是该工作会话中的真实消息",
  }),

  // Conversation binding and tool authorization.
  conversationNotBound: pair({
    en: "This conversation is not bound to a work, so the action was blocked",
    "zh-CN": "该会话未绑定工作，已阻止操作",
  }),
  workFinished: pair({ en: "This work has already ended", "zh-CN": "该工作已经结束" }),
  employeeNotFound: (id: string): AppText =>
    pair({ en: `Employee not found: ${id}`, "zh-CN": `找不到员工 ${id}` }),
  employeeDisabled: (name: string): AppText =>
    pair({ en: `Employee ${name} is disabled`, "zh-CN": `员工 ${name} 已停用` }),
  channelMemberOnly: (name: string): AppText =>
    pair({
      en: `${name} is not a member of this channel`,
      "zh-CN": `${name} 不是该频道成员`,
    }),
  dmParticipantOnly: pair({
    en: "This direct message belongs to two other participants",
    "zh-CN": "该私信属于另外两位参与者",
  }),
  mailRecipientOnly: (name: string): AppText =>
    pair({
      en: `${name} was not a To recipient of this mail`,
      "zh-CN": `${name} 不是该邮件的收件人`,
    }),
  inviteChannelOnly: pair({
    en: "invite_to_channel works only in a channel",
    "zh-CN": "invite_to_channel 只能在频道中使用",
  }),
  inviteTargetNotEnabled: (name: string): AppText =>
    pair({
      en: `${name} is disabled and cannot be invited`,
      "zh-CN": `${name} 已停用，不能被邀请`,
    }),
  inviteLimit: (max: number): AppText =>
    pair({ en: `Invite at most ${max} employees at once`, "zh-CN": `一次最多邀请 ${max} 位员工` }),
};

export type WorkContextMessages = typeof workContextMessages;
