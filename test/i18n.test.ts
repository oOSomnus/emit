/**
 * Language resolution and display-text boundaries.
 *
 * Only the priority rules and wire-data identification are pinned here; the
 * dictionaries themselves are enforced by the compiler.
 */

import { describe, expect, it } from "vitest";
import { errorDisplay, formatText, isLocalizedText, resolveLocale } from "../src/shared/i18n.ts";

describe("resolveLocale", () => {
  it("maps a leading zh browser preference to Simplified Chinese", () => {
    expect(resolveLocale("system", ["zh-CN"])).toBe("zh-CN");
    expect(resolveLocale("system", ["zh-TW"])).toBe("zh-CN");
    expect(resolveLocale("system", ["zh-HK"])).toBe("zh-CN");
  });

  it("maps every other preference, and an empty list, to English", () => {
    expect(resolveLocale("system", ["en-US"])).toBe("en");
    expect(resolveLocale("system", ["fr-FR"])).toBe("en");
    expect(resolveLocale("system", [])).toBe("en");
  });

  it("only looks at the first non-empty preference", () => {
    expect(resolveLocale("system", ["en-US", "zh-CN"])).toBe("en");
    expect(resolveLocale("system", ["", "zh-CN"])).toBe("zh-CN");
    expect(resolveLocale("system", ["", "en-GB", "zh-CN"])).toBe("en");
  });

  it("lets an explicit choice override the browser", () => {
    expect(resolveLocale("en", ["zh-CN"])).toBe("en");
    expect(resolveLocale("zh-CN", ["en-US"])).toBe("zh-CN");
    expect(resolveLocale("zh-CN", [])).toBe("zh-CN");
  });
});

describe("display text", () => {
  it("formats a pair per locale and passes original strings through", () => {
    const pair = { en: "Model unavailable", "zh-CN": "模型不可用" };
    expect(formatText(pair, "en")).toBe("Model unavailable");
    expect(formatText(pair, "zh-CN")).toBe("模型不可用");
    expect(formatText("用户原文", "en")).toBe("用户原文");
  });

  it("narrows only well-formed translation pairs", () => {
    expect(isLocalizedText({ en: "a", "zh-CN": "b" })).toBe(true);
    expect(isLocalizedText({ en: "a" })).toBe(false);
    expect(isLocalizedText({ en: 1, "zh-CN": "b" })).toBe(false);
    expect(isLocalizedText("b")).toBe(false);
    expect(isLocalizedText(null)).toBe(false);
  });

  it("prefers an application error's pair and keeps raw errors untouched", () => {
    const localized = new Error("员工 甲 已停用") as Error & { messageLocalized?: unknown };
    localized.messageLocalized = { en: "Employee 甲 is disabled", "zh-CN": "员工 甲 已停用" };
    expect(errorDisplay(localized)).toEqual({ en: "Employee 甲 is disabled", "zh-CN": "员工 甲 已停用" });

    expect(errorDisplay(new Error("conversation not found"))).toBe("conversation not found");
    expect(errorDisplay("plain")).toBe("plain");

    const malformed = new Error("raw") as Error & { messageLocalized?: unknown };
    malformed.messageLocalized = { en: "half" };
    expect(errorDisplay(malformed)).toBe("raw");
  });
});
