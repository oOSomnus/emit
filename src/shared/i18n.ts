/**
 * Language preference and localized display text, shared by the server and the
 * browser.
 *
 * The product ships exactly two interface languages, registered in `LOCALES`.
 * A browser follows its own language until the user picks one, and every
 * application message that can reach the interface travels as a `LocalizedText`
 * pair next to its original string. User content, model answers, and
 * third-party output are never translated: they only ever exist as their
 * original string.
 *
 * `CANONICAL_LOCALE` names the language of the persisted `text` of application
 * messages: logs, records, and model-facing strings are canonical English, and
 * the pair carries the interface translations.
 */

/** Every registered interface locale, in picker order. */
export const LOCALES = ["en", "zh-CN"] as const;

export type Locale = (typeof LOCALES)[number];

/** `system` follows the browser; a locale pins the interface language. */
export type LanguagePreference = "system" | Locale;

/** The language an application message's persisted `text` is written in. */
export const CANONICAL_LOCALE: Locale = "en";

/** Follow the browser until the user chooses otherwise. */
export const DEFAULT_LANGUAGE_PREFERENCE: LanguagePreference = "system";

/** One application message in every registered interface language. */
export type LocalizedText = { [K in Locale]: string };

/** Per-locale browser matching and the label key used by the language picker. */
export type LocaleConfig = { browserPrefix: string; languageLabelKey: "en" | "zh" };

export const LOCALE_CONFIG: Record<Locale, LocaleConfig> = {
  en: { browserPrefix: "en", languageLabelKey: "en" },
  "zh-CN": { browserPrefix: "zh", languageLabelKey: "zh" },
};

/**
 * Text ready to display: an original string (user or third-party text), or a
 * pair that can follow the current locale.
 */
export type DisplayText = string | LocalizedText;

/** Narrow wire data to a usable translation pair. */
export function isLocalizedText(value: unknown): value is LocalizedText {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return LOCALES.every((locale) => typeof candidate[locale] === "string");
}

/** Narrow stored or wire data to a usable language preference. */
export function isLanguagePreference(value: unknown): value is LanguagePreference {
  if (value === "system") return true;
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/**
 * Resolve a preference against the browser's language list.
 *
 * Only the first non-empty browser preference is considered. Each registered
 * locale matches its configured browser prefix (`en`, or `zh` with regional
 * variants such as `zh-TW`); everything else — including an empty list — falls
 * back to the canonical locale.
 */
export function resolveLocale(preference: LanguagePreference, browserLanguages: readonly string[]): Locale {
  if (preference !== "system") return preference;
  const first = browserLanguages.find((language) => language.length > 0);
  if (first === undefined) return CANONICAL_LOCALE;
  const normalized = first.toLowerCase();
  for (const locale of LOCALES) {
    const prefix = LOCALE_CONFIG[locale].browserPrefix;
    if (normalized === prefix || normalized.startsWith(`${prefix}-`)) return locale;
  }
  return CANONICAL_LOCALE;
}

/** Render display text in one locale; an original string passes through. */
export function formatText(value: DisplayText, locale: Locale): string {
  if (typeof value === "string") return value;
  const text = value[locale];
  return typeof text === "string" && text.length > 0 ? text : value[CANONICAL_LOCALE];
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
