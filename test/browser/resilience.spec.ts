import type { Locator, Page } from "@playwright/test";
import type { MailboxItemDTO, MessageDTO, RoomDTO, WorkContextDTO } from "../../src/shared/contracts.ts";
import { startLoopbackProxy } from "../helpers/loopback-proxy.ts";
import { waitForFixture } from "../helpers/emit-fixture.ts";
import { expect, onboarded, test, type BrowserE2eFixture } from "./fixtures.ts";

async function openMailbox(page: Page, app: BrowserE2eFixture): Promise<void> {
  await onboarded(page, app);
  await showMailbox(page);
}

async function showMailbox(page: Page): Promise<void> {
  const openNavigation = page.getByRole("button", { name: "Open navigation" });
  if (await openNavigation.isVisible()) await openNavigation.click();
  await page.getByRole("button", { name: "Mailbox" }).click();
  await expect(page.getByRole("heading", { name: "Mailbox" })).toBeVisible();
}

async function selectSentFolder(page: Page): Promise<void> {
  const folderSelect = page.getByLabel("Folder").first();
  if (await folderSelect.isVisible()) {
    await folderSelect.selectOption("sent");
    return;
  }
  await page.getByRole("button", { name: "Sent", exact: true }).click();
}

async function selectInboxFolder(page: Page): Promise<void> {
  const folderSelect = page.getByLabel("Folder").first();
  if (await folderSelect.isVisible()) {
    await folderSelect.selectOption("inbox");
    return;
  }
  await page.getByRole("button", { name: "Inbox", exact: true }).click();
}

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const width = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(width.document, "document width must stay inside the mobile viewport").toBeLessThanOrEqual(width.viewport);
  expect(width.body, "body width must stay inside the mobile viewport").toBeLessThanOrEqual(width.viewport);
}

test("the browser reports an outage and recovers its mailbox from the restarted process", async ({ app, page }) => {
  const recoverySubject = "Persisted browser mail after restart";
  const recoveryBody = "The local process wrote this before it stopped.";
  const seeded = await app.request<{ message: MessageDTO; workIds: string[] }>(
    `/api/rooms/${app.workspace.mailRoomId}/mail-send`,
    "POST",
    { body: recoveryBody, subject: recoverySubject, to: [] },
  );
  expect(seeded.status).toBe(200);
  expect(seeded.body.workIds).toEqual([]);

  await openMailbox(page, app);
  await selectSentFolder(page);
  await expect(page.locator(".mail-row").filter({ hasText: recoverySubject })).toHaveCount(1);

  const disconnected = page.getByText("Disconnected from the local service. Reconnecting…", { exact: true });
  await app.emit.stop();
  await expect(disconnected).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.getByRole("button", { name: "Dismiss" })).toBeVisible();

  await app.emit.restart();
  await app.allowOrigin(app.emit.url);
  const eventStream = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.origin === new URL(app.emit.url).origin && url.pathname === "/api/events" && response.status() === 200;
  });
  await page.goto(app.emit.url);
  await eventStream;
  await expect(disconnected).toHaveCount(0);
  await expect(page.locator(".banner.error")).toHaveCount(0);
  await showMailbox(page);
  await selectSentFolder(page);
  const recoveredRow = page.locator(".mail-row").filter({ hasText: recoverySubject });
  await expect(recoveredRow).toHaveCount(1);
  await recoveredRow.locator(".mail-row-open").click();
  await expect(page.locator(".mail-message .content")).toHaveText([recoveryBody]);
});

test("the live mailbox reconnects to real backend mail after its SSE stream is interrupted", async ({ app, page }) => {
  const proxy = await startLoopbackProxy(app.emit.url);
  try {
    await app.allowOrigin(proxy.url);
    await onboarded(page, app);
    const proxyOrigin = new URL(proxy.url).origin;
    let mainFrameNavigations = 0;
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) mainFrameNavigations += 1;
    });
    const firstEventStream = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.origin === proxyOrigin && url.pathname === "/api/events" && response.status() === 200;
    });
    await page.goto(proxy.url);
    await firstEventStream;
    await showMailbox(page);
    await selectInboxFolder(page);
    expect(mainFrameNavigations).toBe(1);

    const disconnected = page.getByText("Disconnected from the local service. Reconnecting…", { exact: true });
    proxy.pauseEvents();
    await expect(disconnected).toBeVisible({ timeout: 15_000 });
    const mailboxRefresh = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.origin === proxyOrigin && url.pathname === "/api/mail" && response.status() === 200;
    });
    await page.getByRole("button", { name: "Refresh" }).click();
    expect((await mailboxRefresh).status()).toBe(200);

    const reconnectedStream = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.origin === proxyOrigin && url.pathname === "/api/events" && response.status() === 200;
    });
    proxy.resumeEvents();
    await reconnectedStream;
    await expect(disconnected).toHaveCount(0);
    await expect(page.locator(".banner.error")).toHaveCount(0);

    const employeeId = app.workspace.employeeIds[0];
    expect(employeeId).toBeDefined();
    const outgoing = await app.request<{ message: MessageDTO; workIds: string[] }>(
      `/api/rooms/${app.workspace.mailRoomId}/messages`,
      "POST",
      {
        body: "请回复 BROWSER_SSE_REPLY",
        subject: "Browser SSE reply",
        to: [employeeId!],
      },
    );
    expect(outgoing.status).toBe(200);
    expect(outgoing.body.workIds).toHaveLength(1);
    await waitForFixture(async () => {
      const mailbox = await app.request<{ items: MailboxItemDTO[] }>("/api/mail");
      return mailbox.status === 200 && mailbox.body.items.some(
        (item) => item.message.workId === outgoing.body.workIds[0] && item.message.author.type === "employee" && item.message.body === "BROWSER_SSE_REPLY_CONTENT",
      );
    }, "real employee mail after SSE reconnect", 45_000);

    const incomingRow = page.locator(".mail-row").filter({ hasText: "BROWSER_SSE_REPLY_CONTENT" });
    await expect(incomingRow).toHaveCount(1);
    expect(mainFrameNavigations).toBe(1);
    expect(new URL(page.url()).origin).toBe(proxyOrigin);
  } finally {
    await proxy.close();
  }
});


test.describe("mobile mailbox surface", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("fits the viewport and lets users dismiss both navigation and compose drawers", async ({ app, page }) => {
    await openMailbox(page, app);
    await assertNoHorizontalOverflow(page);

    const openNavigation = page.getByRole("button", { name: "Open navigation" });
    await openNavigation.click();
    await expect(page.locator(".shell")).toHaveClass(/nav-open/);
    await page.keyboard.press("Escape");
    await expect(page.locator(".shell")).not.toHaveClass(/nav-open/);
    await expect(openNavigation).toBeFocused();

    await openNavigation.click();
    await page.locator(".sidebar-scrim").click({ position: { x: 360, y: 400 } });
    await expect(page.locator(".shell")).not.toHaveClass(/nav-open/);

    await page.getByRole("button", { name: "Compose" }).click();
    await expect(page.locator(".mail-compose")).toBeVisible();
    await assertNoHorizontalOverflow(page);
    const discardedSubject = "Unsaved mobile composition";
    await page.getByLabel("Subject").fill(discardedSubject);
    await page.getByLabel("Body").fill("This content is intentionally discarded.");
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.getByText("There is unsaved content", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Discard", exact: true }).click();
    await expect(page.locator(".mail-compose")).toHaveCount(0);
    await assertNoHorizontalOverflow(page);

    const mailbox = await app.request<{ items: MailboxItemDTO[] }>("/api/mail");
    expect(mailbox.status).toBe(200);
    expect(mailbox.body.items.some((item) => item.message.mail?.subject === discardedSubject)).toBe(false);
  });
});

/* ------------------------------------------------- sidebar reachability ---- */

/**
 * The left rail is measured at real CSS viewports with the page at 100% zoom.
 * Clipped rows are not "visible": a control must be inside the rail's rect and
 * receive the pointer at its own centre before it counts as reachable.
 */

const sidebarLocales = ["en", "zh-CN"] as const;

const sidebarViewports = [
  { width: 1568, height: 825 },
  { width: 1280, height: 660 },
  { width: 1280, height: 480 },
  { width: 390, height: 844 },
  { width: 844, height: 390 },
] as const;

const sidebarLabels = {
  en: { openNavigation: "Open navigation", currentWork: "Current work", theme: "Appearance", language: "Language", settings: "Settings" },
  "zh-CN": { openNavigation: "打开导航", currentWork: "当前工作", theme: "外观", language: "语言", settings: "设置" },
} as const;

const shortestSidebarHeight = 600;

async function openSidebarDrawer(page: Page, labels: { openNavigation: string }): Promise<void> {
  if (await page.locator(".shell").evaluate((element) => element.classList.contains("nav-open"))) return;
  const open = page.getByRole("button", { name: labels.openNavigation });
  if (!(await open.isVisible())) return;
  await open.click();
  await expect(page.locator(".shell")).toHaveClass(/nav-open/);
  await expect
    .poll(async () => page.locator(".sidebar").evaluate((element) => getComputedStyle(element).transform))
    .toBe("none");
}

async function scrollSidebar(page: Page, where: "top" | "bottom"): Promise<void> {
  await page.evaluate((position) => {
    for (const selector of [".sidebar", ".sidebar-rooms"]) {
      const element = document.querySelector(selector);
      if (element === null) continue;
      element.scrollTop = position === "top" ? 0 : element.scrollHeight;
    }
  }, where);
}

/** Which elements actually scroll when asked, in preference order. */
async function sidebarScrollOwners(page: Page): Promise<readonly string[]> {
  return page.evaluate(() => {
    const owners: string[] = [];
    for (const selector of [".sidebar-rooms", ".sidebar"]) {
      const element = document.querySelector(selector);
      if (element === null) continue;
      const before = element.scrollTop;
      element.scrollTop = before + 2_000;
      if (element.scrollTop > before + 1) owners.push(selector);
      element.scrollTop = before;
    }
    return owners;
  });
}

type HitTarget = { ok: boolean; detail: string };

async function sidebarHitTarget(locator: Locator): Promise<HitTarget> {
  return locator.evaluate((element) => {
    const sidebar = document.querySelector(".sidebar");
    if (sidebar === null) return { ok: false, detail: "the sidebar is missing" };
    const rect = element.getBoundingClientRect();
    const sidebarRect = sidebar.getBoundingClientRect();
    const inside =
      rect.width > 0 &&
      rect.height > 0 &&
      rect.top >= sidebarRect.top - 1 &&
      rect.bottom <= sidebarRect.bottom + 1 &&
      rect.left >= sidebarRect.left - 1 &&
      rect.right <= sidebarRect.right + 1;
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    const receives = hit !== null && (hit === element || element.contains(hit));
    return {
      ok: inside && receives,
      detail: JSON.stringify({
        rect: { top: Math.round(rect.top), bottom: Math.round(rect.bottom) },
        sidebar: { top: Math.round(sidebarRect.top), bottom: Math.round(sidebarRect.bottom) },
        inside,
        receives,
        hit: hit === null ? null : hit.tagName.toLowerCase(),
      }),
    };
  });
}

test.describe("sidebar navigation reachability", () => {
  for (const locale of sidebarLocales) {
    test(`keeps work and room selection reachable at 100% zoom (${locale})`, async ({ app, page }) => {
      test.slow();
      const labels = sidebarLabels[locale];
      const development = await app.request<RoomDTO>("/api/rooms", "POST", {
        kind: "channel",
        name: "Development discussion",
        topic: "Development and testing collaboration",
        workContextId: app.workspace.workContextId,
        memberIds: app.workspace.employeeIds,
      });
      expect(development.status).toBe(200);
      const alternate = await app.request<WorkContextDTO>("/api/work-contexts", "POST", { name: "Alternate work" });
      expect(alternate.status).toBe(200);

      await page.addInitScript((value: string) => {
        localStorage.setItem("emit.language", value);
        localStorage.setItem("emit.theme", "light");
      }, locale);
      await onboarded(page, app);

      for (const viewport of sidebarViewports) {
        const where = `${locale} ${viewport.width}x${viewport.height}`;
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await openSidebarDrawer(page, labels);
        await scrollSidebar(page, "top");

        const coarsePointer = await page.evaluate(() => window.matchMedia("(pointer: coarse)").matches);
        const geometry = await page.evaluate(() => {
          const sidebar = document.querySelector(".sidebar");
          const nav = document.querySelector(".sidebar-rooms");
          if (sidebar === null || nav === null) throw new Error("the sidebar is missing");
          const sections = [...nav.children].filter((child): child is HTMLElement => child instanceof HTMLElement);
          const select = sections[0]?.querySelector("select");
          const hint = sections[0]?.querySelector(".sidebar-work-hint");
          const channelsHeading = sections[1]?.querySelector("h3");
          if (
            select === null ||
            select === undefined ||
            hint === null ||
            hint === undefined ||
            channelsHeading === null ||
            channelsHeading === undefined
          ) {
            throw new Error("the sidebar work section is incomplete");
          }
          return {
            zoom: getComputedStyle(document.documentElement).zoom,
            sidebarTransform: getComputedStyle(sidebar).transform,
            selectHeight: select.getBoundingClientRect().height,
            hintBottom: hint.getBoundingClientRect().bottom,
            channelsTop: channelsHeading.getBoundingClientRect().top,
            sections: sections.map((section) => {
              const box = section.getBoundingClientRect();
              return { top: box.top, bottom: box.bottom };
            }),
          };
        });

        expect(geometry.zoom, `${where}: the page must stay at 100% zoom`).toBe("1");
        if (viewport.width <= 760) {
          expect(geometry.sidebarTransform, `${where}: the navigation drawer must be fully open`).toBe("none");
        }
        const minimumRowHeight = coarsePointer ? 44 : 40;
        expect(geometry.selectHeight, `${where}: the work selector must keep its native height`).toBeGreaterThanOrEqual(minimumRowHeight);
        expect(
          geometry.hintBottom,
          `${where}: the work hint must not overlap the Channels heading`,
        ).toBeLessThanOrEqual(geometry.channelsTop + 0.5);
        for (let index = 0; index + 1 < geometry.sections.length; index += 1) {
          expect(
            geometry.sections[index]!.bottom,
            `${where}: sidebar sections ${index} and ${index + 1} must not overlap`,
          ).toBeLessThanOrEqual(geometry.sections[index + 1]!.top + 0.5);
        }

        const developmentButton = page.getByRole("button", { name: "Development discussion" });
        await developmentButton.scrollIntoViewIfNeeded();
        const developmentHit = await sidebarHitTarget(developmentButton);
        expect(developmentHit.ok, `${where}: the second channel must be clickable: ${developmentHit.detail}`).toBe(true);
        const messagesLoaded = page.waitForResponse((response) => {
          const url = new URL(response.url());
          return url.pathname === `/api/rooms/${development.body.id}/messages` && response.status() === 200;
        });
        await developmentButton.click();
        expect((await messagesLoaded).status()).toBe(200);
        await expect(page.getByRole("heading", { name: "# Development discussion" })).toBeVisible();

        await openSidebarDrawer(page, labels);
        await scrollSidebar(page, "top");
        const generalButton = page.getByRole("button", { name: "General", exact: true });
        await generalButton.scrollIntoViewIfNeeded();
        const generalHit = await sidebarHitTarget(generalButton);
        expect(generalHit.ok, `${where}: the first channel must stay clickable: ${generalHit.detail}`).toBe(true);
        await generalButton.click();
        await expect(page.getByRole("heading", { name: "# General" })).toBeVisible();

        await openSidebarDrawer(page, labels);
        await scrollSidebar(page, "top");
        const workSelect = page.getByLabel(labels.currentWork);
        await workSelect.scrollIntoViewIfNeeded();
        const workSelectHit = await sidebarHitTarget(workSelect);
        expect(workSelectHit.ok, `${where}: the work selector must be clickable: ${workSelectHit.detail}`).toBe(true);
        await workSelect.selectOption(alternate.body.id);
        expect(await workSelect.inputValue()).toBe(alternate.body.id);
        await workSelect.selectOption(app.workspace.workContextId);
        expect(await workSelect.inputValue()).toBe(app.workspace.workContextId);

        await assertNoHorizontalOverflow(page);
      }

      const overflowNames = Array.from({ length: 12 }, (_, index) => `Overflow channel ${String(index + 1).padStart(2, "0")}`);
      for (const name of overflowNames) {
        const created = await app.request<RoomDTO>("/api/rooms", "POST", {
          kind: "channel",
          name,
          topic: "",
          workContextId: app.workspace.workContextId,
          memberIds: [],
        });
        expect(created.status).toBe(200);
      }

      for (const viewport of sidebarViewports) {
        const where = `${locale} ${viewport.width}x${viewport.height} (overflow)`;
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.reload();
        await expect(page.getByRole("button", { name: "General", exact: true })).toBeAttached();
        await openSidebarDrawer(page, labels);

        if (viewport.height > shortestSidebarHeight) {
          const owners = await sidebarScrollOwners(page);
          expect(owners, `${where}: the room navigation must own the scrolling`).toContain(".sidebar-rooms");
          const before = await page.evaluate(() => ({
            mail: document.querySelector(".sidebar-mail")?.getBoundingClientRect().top ?? null,
            footer: document.querySelector(".footer-nav")?.getBoundingClientRect().top ?? null,
          }));
          expect(before.mail, `${where}: the mailbox entry must exist`).not.toBeNull();
          expect(before.footer, `${where}: the footer navigation must exist`).not.toBeNull();
          await scrollSidebar(page, "bottom");
          const after = await page.evaluate(() => ({
            mail: document.querySelector(".sidebar-mail")?.getBoundingClientRect().top ?? null,
            footer: document.querySelector(".footer-nav")?.getBoundingClientRect().top ?? null,
          }));
          expect(Math.abs((after.mail ?? 0) - (before.mail ?? 0)), `${where}: the mailbox entry must stay fixed`).toBeLessThanOrEqual(1);
          expect(Math.abs((after.footer ?? 0) - (before.footer ?? 0)), `${where}: the footer navigation must stay fixed`).toBeLessThanOrEqual(1);

          const settings = page.getByRole("button", { name: labels.settings, exact: true });
          await settings.scrollIntoViewIfNeeded();
          const settingsHit = await sidebarHitTarget(settings);
          expect(settingsHit.ok, `${where}: the settings entry must be clickable: ${settingsHit.detail}`).toBe(true);
          await settings.click();
          await expect(settings).toHaveAttribute("aria-current", "page");
        } else {
          await scrollSidebar(page, "bottom");

          const themeSelect = page.getByLabel(labels.theme);
          await themeSelect.scrollIntoViewIfNeeded();
          const themeHit = await sidebarHitTarget(themeSelect);
          expect(themeHit.ok, `${where}: the appearance control must be clickable: ${themeHit.detail}`).toBe(true);
          await themeSelect.selectOption("dark");
          await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
          await themeSelect.selectOption("light");
          await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

          const languageSelect = page.locator(".footer-nav .language-picker select");
          await languageSelect.scrollIntoViewIfNeeded();
          const languageHit = await sidebarHitTarget(languageSelect);
          expect(languageHit.ok, `${where}: the language control must be clickable: ${languageHit.detail}`).toBe(true);
          const originalLanguage = await languageSelect.inputValue();
          const otherLanguage = originalLanguage === "en" ? "zh-CN" : "en";
          await languageSelect.selectOption(otherLanguage);
          await expect(page.locator("html")).toHaveAttribute("lang", otherLanguage);
          await languageSelect.selectOption(originalLanguage);
          await expect(page.locator("html")).toHaveAttribute("lang", originalLanguage);

          const settings = page.getByRole("button", { name: labels.settings, exact: true });
          await settings.scrollIntoViewIfNeeded();
          const settingsHit = await sidebarHitTarget(settings);
          expect(settingsHit.ok, `${where}: the settings entry must be clickable: ${settingsHit.detail}`).toBe(true);
          await settings.click();
          await expect(settings).toHaveAttribute("aria-current", "page");
        }

        for (const name of [overflowNames[0]!, overflowNames[11]!]) {
          await openSidebarDrawer(page, labels);
          const button = page.getByRole("button", { name });
          await button.scrollIntoViewIfNeeded();
          const hit = await sidebarHitTarget(button);
          expect(hit.ok, `${where}: ${name} must be clickable: ${hit.detail}`).toBe(true);
          await button.click();
          await expect(page.getByRole("heading", { name: `# ${name}` })).toBeVisible();
        }

        await assertNoHorizontalOverflow(page);
      }
    });
  }
});
