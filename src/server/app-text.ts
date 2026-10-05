/**
 * Application message values, shared by every server module.
 *
 * This is a leaf module on purpose: the message catalogs in `./messages/*` and
 * the modules that consume them both import from here, so the catalog assembly
 * in `./messages.ts` never sits in an import cycle.
 *
 * Every message is an `AppText`: `text` is the canonical English string that
 * model context, persisted records, and existing callers use, and `localized`
 * is the pair the browser renders. Messages composed with a raw reason (a
 * native error, a provider string) embed that reason unchanged in every
 * language.
 */

import { CANONICAL_LOCALE, formatText, isLocalizedText, type Locale, type LocalizedText } from "../shared/i18n.ts";

export type AppText = { text: string; localized?: LocalizedText };

/** Build an application message from its translation pair; `text` stays canonical English. */
export function appText(value: LocalizedText): AppText {
  return { text: value[CANONICAL_LOCALE], localized: value };
}

/** The display pair of an application message; text without a pair is raw in both languages. */
export function pairOf(value: AppText): LocalizedText {
  return value.localized ?? { en: value.text, "zh-CN": value.text };
}

/** Render an application message in one locale; text without a pair is raw. */
export function appTextIn(value: AppText, locale: Locale): string {
  return value.localized === undefined ? value.text : formatText(value.localized, locale);
}

/** Original text with no translation pair. */
export function rawText(text: string): AppText {
  return { text };
}

/** Wrap an unknown error, keeping an application error's translation pair. */
export function fromError(error: unknown): AppText {
  if (error instanceof Error) {
    const localized = (error as Error & { messageLocalized?: unknown }).messageLocalized;
    return isLocalizedText(localized)
      ? { text: localized[CANONICAL_LOCALE], localized }
      : { text: error.message };
  }
  return { text: String(error) };
}

/** An application error whose message carries its display pair. */
export class AppError extends Error {
  readonly messageLocalized?: LocalizedText;

  constructor(value: AppText) {
    super(value.text);
    this.name = "AppError";
    this.messageLocalized = value.localized;
  }
}
