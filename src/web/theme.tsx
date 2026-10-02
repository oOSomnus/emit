/**
 * Light and dark themes.
 *
 * The stylesheet defines both palettes and selects one through `data-theme` on
 * the root element; this module is the only place that decides which. The
 * preference is a user choice (`system` follows the OS, `light`/`dark` pin it),
 * stored in localStorage. Reading and writing storage can fail (private mode,
 * disabled storage), so a failure only costs persistence — the in-memory
 * preference keeps working.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "emit.theme";

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

function readStoredPreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

function systemTheme(): ResolvedTheme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  return preference === "system" ? systemTheme() : preference;
}

function applyTheme(resolved: ResolvedTheme): void {
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.style.colorScheme = resolved;
}

/**
 * Apply the stored theme before the first render so the window never flashes
 * the wrong palette.
 */
export function initializeTheme(): void {
  applyTheme(resolveTheme(readStoredPreference()));
}

type ThemeContextValue = {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
};

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

export function ThemeProvider({ children }: { children: ReactNode }): ReactNode {
  const [preference, setPreferenceState] = useState<ThemePreference>(readStoredPreference);
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(readStoredPreference()));

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Storage is optional; the preference still applies to this session.
    }
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => {
      const next = resolveTheme(preference);
      setResolved(next);
      applyTheme(next);
    };
    update();
    // A manual choice never follows the OS; system mode tracks it live.
    if (preference !== "system") return;
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [preference]);

  // Keep tabs in sync when the preference changes elsewhere.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== THEME_STORAGE_KEY || !isThemePreference(event.newValue)) return;
      setPreferenceState(event.newValue);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ preference, resolved, setPreference }),
    [preference, resolved, setPreference],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (value === undefined) throw new Error("useTheme 必须在 ThemeProvider 内使用");
  return value;
}

/** The one theme control, reused in the sidebar, settings, and first-run setup. */
export function ThemePicker({ label = "外观" }: { label?: string }): ReactNode {
  const { preference, setPreference } = useTheme();
  return (
    <label className="theme-picker">
      {label}
      <select
        value={preference}
        aria-label={label}
        onChange={(event) => {
          if (!isThemePreference(event.target.value)) return;
          setPreference(event.target.value);
        }}
      >
        <option value="system">跟随系统</option>
        <option value="light">浅色</option>
        <option value="dark">深色</option>
      </select>
    </label>
  );
}
