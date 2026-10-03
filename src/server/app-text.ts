/**
 * Application message values, shared by every server module.
 *
 * This is a leaf module on purpose: the message catalogs in `./messages/*` and
 * the modules that consume them both import from here, so the catalog assembly
 * in `./messages.ts` never sits in an import cycle.
 *
 * Every message is an `AppText`: `text` keeps the original string that model
 * context, persisted records, and existing callers have always used, and
 * `localized` is the pair the browser renders. Messages composed with a raw
 * reason (a native error, a provider string) embed that reason unchanged in
 * both languages.
 */

import { isLocalizedText, type LocalizedText } from "../shared/i18n.ts";

export type AppText = { text: string; localized?: LocalizedText };

/** Build an application message from its translation pair; `text` stays Chinese. */
export function appText(value: LocalizedText): AppText {
  return { text: value["zh-CN"], localized: value };
}

/** Original text with no translation pair. */
export function rawText(text: string): AppText {
  return { text };
}

/** Wrap an unknown error, keeping an application error's translation pair. */
export function fromError(error: unknown): AppText {
  if (error instanceof Error) {
    const localized = (error as Error & { messageLocalized?: unknown }).messageLocalized;
    return isLocalizedText(localized) ? { text: error.message, localized } : { text: error.message };
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
