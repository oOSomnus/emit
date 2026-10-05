/**
 * Interface language.
 *
 * The preference is a browser choice (`system` follows the browser,
 * `en`/`zh-CN` pin it), stored in localStorage. Reading and writing storage can
 * fail (private mode, disabled storage), so a failure only costs persistence —
 * the in-memory preference keeps working. Unlike the theme, the choice also
 * drives `<html lang>` and the document title before the first paint.
 *
 * Switching the language never reinitializes application state: messages
 * already on screen hold their translation pair and redraw in place.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  DEFAULT_LANGUAGE_PREFERENCE,
  formatText,
  isLanguagePreference,
  LOCALE_CONFIG,
  LOCALES,
  resolveLocale,
  type DisplayText,
  type LanguagePreference,
  type Locale,
} from "../shared/i18n.ts";
import { messagesFor, type UiMessages } from "./messages.ts";

export const LANGUAGE_STORAGE_KEY = "emit.language";

function readStoredPreference(): LanguagePreference {
  try {
    const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return isLanguagePreference(stored) ? stored : DEFAULT_LANGUAGE_PREFERENCE;
  } catch {
    return DEFAULT_LANGUAGE_PREFERENCE;
  }
}

function browserLanguages(): readonly string[] {
  if (Array.isArray(navigator.languages) && navigator.languages.length > 0) return navigator.languages;
  return typeof navigator.language === "string" && navigator.language.length > 0 ? [navigator.language] : [];
}

function applyDocument(locale: Locale): void {
  document.documentElement.lang = locale;
  document.title = messagesFor(locale).language.documentTitle;
}

/**
 * Apply the stored language before the first render so the document language
 * and title are right from the start.
 */
export function initializeLanguage(): void {
  applyDocument(resolveLocale(readStoredPreference(), browserLanguages()));
}

type I18nContextValue = {
  preference: LanguagePreference;
  locale: Locale;
  setPreference: (preference: LanguagePreference) => void;
  messages: UiMessages;
  /** Render display text in the current locale. */
  text: (value: DisplayText) => string;
};

const I18nContext = createContext<I18nContextValue | undefined>(undefined);

export function LanguageProvider({ children }: { children: ReactNode }): ReactNode {
  const [preference, setPreferenceState] = useState<LanguagePreference>(readStoredPreference);
  const [browser, setBrowser] = useState<readonly string[]>(browserLanguages);

  const locale = resolveLocale(preference, browser);

  const setPreference = useCallback((next: LanguagePreference) => {
    setPreferenceState(next);
    try {
      window.localStorage.setItem(LANGUAGE_STORAGE_KEY, next);
    } catch {
      // Storage is optional; the preference still applies to this session.
    }
  }, []);

  useEffect(() => {
    applyDocument(locale);
  }, [locale]);

  // Keep tabs in sync when the preference changes elsewhere; a removed or
  // invalid value returns to following the browser.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== LANGUAGE_STORAGE_KEY) return;
      setPreferenceState(isLanguagePreference(event.newValue) ? event.newValue : DEFAULT_LANGUAGE_PREFERENCE);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // A manual choice never follows the browser; system mode tracks it live.
  useEffect(() => {
    if (preference !== "system") return;
    const onLanguageChange = () => setBrowser(browserLanguages());
    window.addEventListener("languagechange", onLanguageChange);
    return () => window.removeEventListener("languagechange", onLanguageChange);
  }, [preference]);

  const messages = messagesFor(locale);
  const text = useCallback((value: DisplayText) => formatText(value, locale), [locale]);
  const value = useMemo<I18nContextValue>(
    () => ({ preference, locale, setPreference, messages, text }),
    [preference, locale, setPreference, messages, text],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const value = useContext(I18nContext);
  if (value === undefined) throw new Error("useI18n must be used within LanguageProvider");
  return value;
}

/** The one interface-language control, reused wherever preferences are edited. */
export function LanguagePicker({ label }: { label?: string } = {}): ReactNode {
  const { preference, setPreference, messages } = useI18n();
  const title = label ?? messages.language.label;
  return (
    <label className="theme-picker language-picker">
      {title}
      <select
        value={preference}
        aria-label={title}
        onChange={(event) => {
          if (!isLanguagePreference(event.target.value)) return;
          setPreference(event.target.value);
        }}
      >
        <option value="system">{messages.language.system}</option>
        {LOCALES.map((locale) => (
          <option key={locale} value={locale}>
            {messages.language[LOCALE_CONFIG[locale].languageLabelKey]}
          </option>
        ))}
      </select>
    </label>
  );
}
