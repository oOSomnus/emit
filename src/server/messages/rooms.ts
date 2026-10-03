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
  directoryNotAbsolutePath: (path: string): AppText =>
    pair({
      en: `The working directory must be an absolute path on the server: ${path || "(empty)"}`,
      "zh-CN": `工作目录必须是服务器本地绝对路径：${path || "(空)"}`,
    }),
  directoryNotADirectory: (path: string): AppText =>
    pair({
      en: `The working directory is not a directory: ${path}`,
      "zh-CN": `工作目录不是目录：${path}`,
    }),
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
  expectedVersionNotAnInteger: pair({
    en: "expectedVersion must be an integer",
    "zh-CN": "expectedVersion 必须是整数",
  }),
  roomNotFoundWithId: (roomId: string): AppText =>
    pair({ en: `Conversation not found: ${roomId}`, "zh-CN": `会话不存在：${roomId}` }),
  directoriesMissingRecreate: pair({
    en: "This conversation is missing its directory configuration, please recreate the conversation",
    "zh-CN": "该会话缺少目录配置，请重新创建会话",
  }),
  directoriesChangedReload: pair({
    en: "The session working directories were changed by another operation, please reload",
    "zh-CN": "会话工作目录已被其他更改，请重新载入",
  }),
};
