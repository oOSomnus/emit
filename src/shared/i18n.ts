/**
 * Language preference and localized display text, shared by the server and the
 * browser.
 *
 * The product ships exactly two interface languages. A browser follows its own
 * language until the user picks one, and every application message that can
 * reach the interface travels as a `LocalizedText` pair next to its original
 * string. User content, model answers, and third-party output are never
 * translated: they only ever exist as their original string.
 */

export type Locale = "en" | "zh-CN";

/** `system` follows the browser; a locale pins the interface language. */
export type LanguagePreference = "system" | Locale;

/** One application message in both interface languages. */
export type LocalizedText = { en: string; "zh-CN": string };

/**
 * Text ready to display: an original string (user or third-party text), or a
 * pair that can follow the current locale.
 */
export type DisplayText = string | LocalizedText;

/** Narrow wire data to a usable translation pair. */
export function isLocalizedText(value: unknown): value is LocalizedText {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { en?: unknown; "zh-CN"?: unknown };
  return typeof candidate.en === "string" && typeof candidate["zh-CN"] === "string";
}

/**
 * Resolve a preference against the browser's language list.
 *
 * Only the first non-empty browser preference is considered: a Simplified
 * Chinese preference maps to `zh-CN` (Traditional variants included), and
 * everything else — including an empty list — maps to `en`.
 */
export function resolveLocale(preference: LanguagePreference, browserLanguages: readonly string[]): Locale {
  if (preference !== "system") return preference;
  const first = browserLanguages.find((language) => language.length > 0);
  if (first === undefined) return "en";
  return first.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

/** Render display text in one locale; an original string passes through. */
export function formatText(value: DisplayText, locale: Locale): string {
  if (typeof value === "string") return value;
  const text = value[locale];
  return typeof text === "string" && text.length > 0 ? text : value.en;
}

/**
 * The display text of an unknown error.
 *
 * An application error carries a translation pair; anything else — a native
 * error, a string, an object — keeps its original text.
 */
export function errorDisplay(error: unknown): DisplayText {
  if (error instanceof Error) {
    const localized = (error as Error & { messageLocalized?: unknown }).messageLocalized;
    return isLocalizedText(localized) ? localized : error.message;
  }
  return String(error);
}
