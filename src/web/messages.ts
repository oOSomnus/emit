/**
 * The interface dictionary.
 *
 * `englishMessages` is the authority: its inferred type is `UiMessages`, and
 * `chineseMessages` must satisfy it, so the two languages cannot drift apart —
 * a missing key, or one with a different parameter signature, fails the
 * compile. Each group lives in its own module; dynamic sentences are functions,
 * never concatenations of translated fragments.
 *
 * `uiText` captures one sentence as a pair at the moment it is produced, which
 * is what lets a message already on screen redraw when the user switches
 * languages.
 */

import { type Locale, type LocalizedText, LOCALES } from "../shared/i18n.ts";
import { englishApp, chineseApp } from "./messages/app.ts";
import { englishApprovals, chineseApprovals } from "./messages/approvals.ts";
import { englishChat, chineseChat } from "./messages/chat.ts";
import { englishCommon, chineseCommon } from "./messages/common.ts";
import { englishDirectories, chineseDirectories } from "./messages/directories.ts";
import { englishEmployees, chineseEmployees } from "./messages/employees.ts";
import { englishExecution, chineseExecution } from "./messages/execution.ts";
import { englishLanguage, chineseLanguage } from "./messages/language.ts";
import { englishLlmCalls, chineseLlmCalls } from "./messages/llm-calls.ts";
import { englishMail, chineseMail } from "./messages/mail.ts";
import { englishModel, chineseModel } from "./messages/model.ts";
import { englishOnboarding, chineseOnboarding } from "./messages/onboarding.ts";
import { englishProviders, chineseProviders } from "./messages/providers.ts";
import { englishSettings, chineseSettings } from "./messages/settings.ts";
import { englishSidebar, chineseSidebar } from "./messages/sidebar.ts";
import { englishTheme, chineseTheme } from "./messages/theme.ts";
import { englishWork, chineseWork } from "./messages/work.ts";
import { englishWorkContexts, chineseWorkContexts } from "./messages/work-contexts.ts";

export const englishMessages = {
  common: englishCommon,
  app: englishApp,
  theme: englishTheme,
  language: englishLanguage,
  onboarding: englishOnboarding,
  sidebar: englishSidebar,
  chat: englishChat,
  mail: englishMail,
  work: englishWork,
  workContexts: englishWorkContexts,
  llmCalls: englishLlmCalls,
  execution: englishExecution,
  approvals: englishApprovals,
  employees: englishEmployees,
  settings: englishSettings,
  providers: englishProviders,
  directories: englishDirectories,
  model: englishModel,
};

export type UiMessages = typeof englishMessages;

export const chineseMessages: UiMessages = {
  common: chineseCommon,
  app: chineseApp,
  theme: chineseTheme,
  language: chineseLanguage,
  onboarding: chineseOnboarding,
  sidebar: chineseSidebar,
  chat: chineseChat,
  mail: chineseMail,
  work: chineseWork,
  llmCalls: chineseLlmCalls,
  workContexts: chineseWorkContexts,
  execution: chineseExecution,
  approvals: chineseApprovals,
  employees: chineseEmployees,
  settings: chineseSettings,
  providers: chineseProviders,
  directories: chineseDirectories,
  model: chineseModel,
};

/** The catalog for each registered locale; English is the shape authority. */
export const uiMessagesByLocale: Record<Locale, UiMessages> = {
  en: englishMessages,
  "zh-CN": chineseMessages,
};

/** The catalog for one locale. */
export function messagesFor(locale: Locale): UiMessages {
  return uiMessagesByLocale[locale];
}

/** Build a message pair from a selector run against every registered catalog. */
export function uiText(select: (messages: UiMessages) => string): LocalizedText {
  const text = {} as LocalizedText;
  for (const locale of LOCALES) text[locale] = select(messagesFor(locale));
  return text;
}
