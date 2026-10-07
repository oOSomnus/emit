import type { Route } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import type { EmployeeDTO, MailboxItemDTO, MessageDTO, RoomDTO, WorkContextDTO } from "../../src/shared/contracts.ts";
import { startLoopbackProxy } from "../helpers/loopback-proxy.ts";
import { waitForFixture } from "../helpers/emit-fixture.ts";
import { expect, navigateWorkspace, onboarded, test, type BrowserE2eFixture } from "./fixtures.ts";

async function openMailbox(page: Page, app: BrowserE2eFixture): Promise<void> {
  await onboarded(page, app);
  await showMailbox(page);
}

async function showMailbox(page: Page): Promise<void> {
  await navigateWorkspace(page, "Mailbox");
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
  const bootstrapUrl = `${proxy.url}/api/bootstrap`;
  const bootstrapRequested = Promise.withResolvers<void>();
  const releaseBootstrap = Promise.withResolvers<void>();
  const bootstrapHandler = async (route: Route): Promise<void> => {
    const response = await route.fetch();
    bootstrapRequested.resolve();
    await releaseBootstrap.promise;
    await route.fulfill({ response });
  };
  try {
    await app.allowOrigin(proxy.url);
    await onboarded(page, app);
    await page.route(bootstrapUrl, bootstrapHandler);
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
    await bootstrapRequested.promise;
    await expect(page.locator(".boot")).toBeVisible();
    const mailboxOpened = showMailbox(page);
    await expect(page.locator(".boot")).toBeVisible();
    releaseBootstrap.resolve();
    await mailboxOpened;
    await page.unroute(bootstrapUrl, bootstrapHandler);
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
    releaseBootstrap.resolve();
    try {
      if (!page.isClosed()) await page.unroute(bootstrapUrl, bootstrapHandler);
    } finally {
      await proxy.close();
    }
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
  en: {
    openNavigation: "Open navigation",
    currentWork: "Current work",
    channels: "Channels",
    directs: "Direct messages",
    newChannel: "New channel",
    newDirect: "Start a direct message",
    mailbox: "Mailbox",
    workspace: "Workspace",
    appearance: "Appearance",
    language: "Language",
    approvals: "Approvals",
    work: "Work",
    runs: "Runs",
    employees: "Employees",
    settings: "Settings",
  },
  "zh-CN": {
    openNavigation: "打开导航",
    currentWork: "当前工作",
    channels: "频道",
    directs: "私信",
    newChannel: "新建频道",
    newDirect: "开始私信",
    mailbox: "邮箱",
    workspace: "工作台",
    appearance: "外观",
    language: "语言",
    approvals: "审批",
    work: "工作",
    runs: "执行记录",
    employees: "员工",
    settings: "设置",
  },
} as const;

const railScrollFallbackHeight = 480;

async function openSidebarDrawer(page: Page, labels: { openNavigation: string }): Promise<void> {
  if (await page.locator(".shell").evaluate((element) => element.classList.contains("nav-open"))) return;
  const open = page.getByRole("button", { name: labels.openNavigation, exact: true });
  if (!(await open.isVisible())) return;
  await open.click();
  await expect(page.locator(".shell")).toHaveClass(/nav-open/);
  await expect
    .poll(async () => page.locator(".sidebar").evaluate((element) => getComputedStyle(element).transform))
    .toBe("none");
}

async function scrollSidebarRail(page: Page, where: "top" | "bottom"): Promise<void> {
  await page.locator(".sidebar").evaluate((element, position) => {
    element.scrollTop = position === "top" ? 0 : element.scrollHeight;
  }, where);
}

async function scrollRoomList(list: Locator, where: "top" | "bottom"): Promise<void> {
  await list.evaluate((element, position) => {
    element.scrollTop = position === "top" ? 0 : element.scrollHeight;
  }, where);
}

function roomSection(page: Page, heading: string): Locator {
  return page
    .locator(".sidebar-rooms section")
    .filter({ has: page.getByRole("heading", { name: heading }) });
}

type HitTarget = { ok: boolean; detail: string };

/** A rail target must be inside the rail and receive the pointer at its centre. */
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

/** Top-layer menu targets are tested against their own menu, never the rail rectangle. */
async function workspaceMenuHitTarget(locator: Locator): Promise<HitTarget> {
  return locator.evaluate((element) => {
    const menu = document.querySelector(".workspace-menu");
    if (menu === null) return { ok: false, detail: "the workspace menu is missing" };
    const rect = element.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const inside =
      menu.contains(element) &&
      rect.width > 0 &&
      rect.height > 0 &&
      rect.top >= menuRect.top - 1 &&
      rect.bottom <= menuRect.bottom + 1 &&
      rect.left >= menuRect.left - 1 &&
      rect.right <= menuRect.right + 1;
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    const receives = hit !== null && (hit === element || element.contains(hit));
    return {
      ok: inside && receives,
      detail: JSON.stringify({
        rect: { top: Math.round(rect.top), bottom: Math.round(rect.bottom) },
        menu: { top: Math.round(menuRect.top), bottom: Math.round(menuRect.bottom) },
        inside,
        receives,
        hit: hit === null ? null : hit.tagName.toLowerCase(),
      }),
    };
  });
}

async function expectSidebarTarget(locator: Locator, label: string, where: string): Promise<void> {
  await locator.scrollIntoViewIfNeeded();
  const hit = await sidebarHitTarget(locator);
  expect(hit.ok, `${where}: ${label} must receive a pointer inside the rail: ${hit.detail}`).toBe(true);
}

async function expectWorkspaceMenuTarget(locator: Locator, label: string, where: string): Promise<void> {
  await locator.scrollIntoViewIfNeeded();
  const hit = await workspaceMenuHitTarget(locator);
  expect(hit.ok, `${where}: ${label} must receive a pointer inside the menu: ${hit.detail}`).toBe(true);
}

type SidebarFixedTops = { sidebar: number | null; mailbox: number | null; workspace: number | null };

async function sidebarFixedTops(page: Page): Promise<SidebarFixedTops> {
  return page.evaluate(() => {
    const top = (selector: string): number | null => {
      const element = document.querySelector(selector);
      return element === null ? null : element.getBoundingClientRect().top;
    };
    return {
      sidebar: top(".sidebar"),
      mailbox: top(".sidebar-mail"),
      workspace: top(".footer-nav"),
    };
  });
}

function expectSidebarFixedTopsToStay(before: SidebarFixedTops, after: SidebarFixedTops, where: string): void {
  for (const key of ["sidebar", "mailbox", "workspace"] as const) {
    expect(before[key], `${where}: ${key} must exist before room-list scrolling`).not.toBeNull();
    expect(after[key], `${where}: ${key} must exist after room-list scrolling`).not.toBeNull();
    expect(Math.abs((after[key] ?? 0) - (before[key] ?? 0)), `${where}: ${key} must stay fixed while a room list scrolls`).toBeLessThanOrEqual(1);
  }
}

async function openWorkspaceMenu(page: Page, labels: { openNavigation: string; workspace: string }): Promise<void> {
  await openSidebarDrawer(page, labels);
  const trigger = page.locator(".workspace-trigger");
  await trigger.scrollIntoViewIfNeeded();
  const menu = page.locator(".workspace-menu");
  if (!(await menu.isVisible())) await trigger.click();
  await expect(menu).toBeVisible();
}

test.describe("sidebar navigation reachability", () => {
  for (const locale of sidebarLocales) {
    test(`keeps work, room and workspace-menu navigation reachable at 100% zoom (${locale})`, async ({ app, page }) => {
      test.slow();
      const labels = sidebarLabels[locale];
      const overflowNames = Array.from({ length: 12 }, (_, index) => `Overflow channel ${String(index + 1).padStart(2, "0")}`);

      for (const name of overflowNames) {
        const created = await app.request<RoomDTO>("/api/rooms", "POST", {
          kind: "channel",
          name,
          topic: "",
          workContextId: app.workspace.workContextId,
          memberIds: [],
        });
        expect(created.status, `creating ${name}`).toBe(200);
      }

      const bootstrap = await app.request<{ employees: EmployeeDTO[] }>("/api/bootstrap");
      expect(bootstrap.status).toBe(200);
      const seededEmployees = app.workspace.employeeIds.map((id) => {
        const employee = bootstrap.body.employees.find((entry) => entry.id === id);
        expect(employee, `seeded employee ${id} must exist`).toBeDefined();
        return employee!;
      });
      const extraEmployees: EmployeeDTO[] = [];
      for (let index = 1; index <= 4; index += 1) {
        const created = await app.request<EmployeeDTO>("/api/employees", "POST", {
          name: `Overflow assistant ${String(index).padStart(2, "0")}`,
          role: "Assistant",
          executionModel: { model: { providerId: "fake", modelId: "fake-chat" }, effort: "off" },
          generateAddress: true,
        });
        expect(created.status, `creating overflow assistant ${index}`).toBe(200);
        extraEmployees.push(created.body);
      }
      for (const employee of [...seededEmployees, ...extraEmployees]) {
        const created = await app.request<RoomDTO>("/api/rooms", "POST", {
          kind: "dm",
          name: employee.name,
          workContextId: app.workspace.workContextId,
          memberIds: [],
          employeeId: employee.id,
        });
        expect(created.status, `creating a DM for ${employee.name}`).toBe(200);
      }

      const alternate = await app.request<WorkContextDTO>("/api/work-contexts", "POST", { name: "Alternate work" });
      expect(alternate.status).toBe(200);
      await page.addInitScript((value: string) => {
        if (localStorage.getItem("emit.language") === null) localStorage.setItem("emit.language", value);
        if (localStorage.getItem("emit.theme") === null) localStorage.setItem("emit.theme", "light");
      }, locale);
      await onboarded(page, app);
      const workspaceMenu = page.locator(".workspace-menu");
      await expect(workspaceMenu, "workspace menu must be closed by default").toBeHidden();

      for (const viewport of sidebarViewports) {
        const where = `${locale} ${viewport.width}x${viewport.height}`;
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await openSidebarDrawer(page, labels);
        await scrollSidebarRail(page, "top");

        const viewportState = await page.evaluate(() => {
          const sidebar = document.querySelector(".sidebar");
          if (sidebar === null) throw new Error("the sidebar is missing");
          return {
            zoom: getComputedStyle(document.documentElement).zoom,
            sidebarTransform: getComputedStyle(sidebar).transform,
          };
        });
        expect(viewportState.zoom, `${where}: the page must stay at 100% zoom`).toBe("1");
        if (viewport.width <= 760) {
          expect(viewportState.sidebarTransform, `${where}: the open drawer must have no translation`).toBe("none");
        }

        const workSelect = page.getByLabel(labels.currentWork, { exact: true });
        const channels = roomSection(page, labels.channels);
        const directs = roomSection(page, labels.directs);
        const channelHeading = channels.getByRole("heading", { name: labels.channels });
        const directHeading = directs.getByRole("heading", { name: labels.directs });
        const channelPlus = channels.getByRole("button", { name: labels.newChannel, exact: true });
        const directPlus = directs.getByRole("button", { name: labels.newDirect, exact: true });
        const channelList = channels.locator(".room-list");
        const directList = directs.locator(".room-list");
        const firstDirect = directList.getByRole("button").first();
        const mailbox = page.getByRole("button", { name: labels.mailbox, exact: true });
        const workspaceTrigger = page.locator(".workspace-trigger");

        await scrollRoomList(channelList, "top");
        await scrollRoomList(directList, "top");
        await expectSidebarTarget(workSelect, labels.currentWork, where);
        await expectSidebarTarget(channelHeading, labels.channels, where);
        await expectSidebarTarget(channelPlus, labels.newChannel, where);
        await expectSidebarTarget(directHeading, labels.directs, where);
        await expectSidebarTarget(directPlus, labels.newDirect, where);
        await expectSidebarTarget(mailbox, labels.mailbox, where);
        await expectSidebarTarget(workspaceTrigger, labels.workspace, where);

        await workSelect.selectOption(alternate.body.id);
        await expect(workSelect).toHaveValue(alternate.body.id);
        await workSelect.selectOption(app.workspace.workContextId);
        await expect(workSelect).toHaveValue(app.workspace.workContextId);

        if (viewport.height > railScrollFallbackHeight) {
          const channelSize = await channelList.evaluate((element) => ({
            scrollHeight: element.scrollHeight,
            clientHeight: element.clientHeight,
          }));
          const directSize = await directList.evaluate((element) => ({
            scrollHeight: element.scrollHeight,
            clientHeight: element.clientHeight,
          }));
          expect(channelSize.scrollHeight, `${where}: the channel list must own its overflow`).toBeGreaterThan(channelSize.clientHeight);
          expect(directSize.scrollHeight, `${where}: the DM list must own its overflow`).toBeGreaterThan(directSize.clientHeight);
          const railSize = await page.locator(".sidebar").evaluate((element) => ({
            scrollTop: element.scrollTop,
            scrollHeight: element.scrollHeight,
            clientHeight: element.clientHeight,
          }));
          expect(railSize.scrollTop, `${where}: the rail must not scroll while its room lists own overflow`).toBe(0);
          expect(railSize.scrollHeight, `${where}: the rail must not have vertical overflow`).toBeLessThanOrEqual(railSize.clientHeight);

          const beforeChannels = await sidebarFixedTops(page);
          await scrollRoomList(channelList, "bottom");
          expect(await channelList.evaluate((element) => element.scrollTop), `${where}: the channel list must scroll itself`).toBeGreaterThan(0);
          await expectSidebarTarget(firstDirect, "the first direct-message entry", where);
          await expectSidebarTarget(workSelect, labels.currentWork, where);
          expectSidebarFixedTopsToStay(beforeChannels, await sidebarFixedTops(page), where);

          await scrollRoomList(channelList, "top");
          const beforeDirects = await sidebarFixedTops(page);
          await scrollRoomList(directList, "bottom");
          expect(await directList.evaluate((element) => element.scrollTop), `${where}: the DM list must scroll itself`).toBeGreaterThan(0);
          await expectSidebarTarget(channelList.getByRole("button").first(), "the first channel entry", where);
          expectSidebarFixedTopsToStay(beforeDirects, await sidebarFixedTops(page), where);
        } else {
          const railSize = await page.locator(".sidebar").evaluate((element) => ({
            scrollHeight: element.scrollHeight,
            clientHeight: element.clientHeight,
          }));
          expect(railSize.scrollHeight, `${where}: the short rail must be scrollable`).toBeGreaterThan(railSize.clientHeight);
          await scrollSidebarRail(page, "top");
          await expectSidebarTarget(workSelect, labels.currentWork, where);
          await expectSidebarTarget(channelHeading, labels.channels, where);
          await expectSidebarTarget(channelPlus, labels.newChannel, where);
          await expectSidebarTarget(directHeading, labels.directs, where);
          await expectSidebarTarget(directPlus, labels.newDirect, where);
          await expectSidebarTarget(firstDirect, "the first direct-message entry", where);
          await expectSidebarTarget(mailbox, labels.mailbox, where);
          await expectSidebarTarget(workspaceTrigger, labels.workspace, where);
        }

        for (const name of [overflowNames[0]!, overflowNames[overflowNames.length - 1]!]) {
          await openSidebarDrawer(page, labels);
          const button = channelList.getByRole("button", { name, exact: true });
          await expect(button).toBeAttached();
          await expectSidebarTarget(button, name, where);
          await button.click();
          await expect(page.getByRole("heading", { name: `# ${name}`, exact: true })).toBeVisible();
        }

        await openWorkspaceMenu(page, labels);
        await expect(workspaceMenu).toBeVisible();
        const firstMenuItem = workspaceMenu.getByRole("button", { name: labels.approvals, exact: true });
        await expect(firstMenuItem).toBeFocused();
        for (const label of [labels.approvals, labels.work, labels.runs, labels.employees, labels.settings]) {
          const item = workspaceMenu.getByRole("button", { name: label, exact: true });
          await expectWorkspaceMenuTarget(item, label, where);
        }
        await page.keyboard.press("Escape");
        await expect(workspaceMenu).toBeHidden();
        await expect(workspaceTrigger).toBeFocused();
        if (viewport.width <= 760) {
          await page.keyboard.press("Escape");
          await expect(page.locator(".shell")).not.toHaveClass(/nav-open/);
          await expect(page.getByRole("button", { name: labels.openNavigation, exact: true })).toBeFocused();
        }

        await openWorkspaceMenu(page, labels);
        const settingsItem = workspaceMenu.getByRole("button", { name: labels.settings, exact: true });
        await expectWorkspaceMenuTarget(settingsItem, labels.settings, where);
        await settingsItem.click();
        await expect(page.getByRole("heading", { name: labels.settings, exact: true })).toBeVisible();
        await expect(workspaceTrigger.locator(".label")).toHaveText(labels.settings);
        await expect(workspaceMenu).toBeHidden();
        if (viewport.width <= 760) await expect(page.locator(".shell")).not.toHaveClass(/nav-open/);
        await openWorkspaceMenu(page, labels);
        await expect(settingsItem).toHaveAttribute("aria-current", "page");

        await openWorkspaceMenu(page, labels);
        const appearance = workspaceMenu.getByLabel(labels.appearance, { exact: true });
        await expectWorkspaceMenuTarget(appearance, labels.appearance, where);
        await appearance.selectOption("dark");
        await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
        await appearance.selectOption("light");
        await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

        const language = workspaceMenu.getByLabel(labels.language, { exact: true });
        await expectWorkspaceMenuTarget(language, labels.language, where);
        const otherLocale = locale === "en" ? "zh-CN" : "en";
        await language.selectOption(otherLocale);
        await expect(page.locator("html")).toHaveAttribute("lang", otherLocale);
        const otherLabels = sidebarLabels[otherLocale];
        await workspaceMenu.getByLabel(otherLabels.language, { exact: true }).selectOption(locale);
        await expect(page.locator("html")).toHaveAttribute("lang", locale);

        if (await workspaceMenu.isVisible()) {
          await page.keyboard.press("Escape");
          await expect(workspaceMenu).toBeHidden();
        }
        if (viewport.width <= 760 && await page.locator(".shell").evaluate((element) => element.classList.contains("nav-open"))) {
          await page.keyboard.press("Escape");
          await expect(page.locator(".shell")).not.toHaveClass(/nav-open/);
        }

        await assertNoHorizontalOverflow(page);
      }

      const otherLocale = locale === "en" ? "zh-CN" : "en";
      await openWorkspaceMenu(page, labels);
      await workspaceMenu.getByLabel(labels.language, { exact: true }).selectOption(otherLocale);
      await expect(page.locator("html")).toHaveAttribute("lang", otherLocale);
      await page.reload();
      await expect(page.locator("html")).toHaveAttribute("lang", otherLocale);
      await expect(workspaceMenu).toBeHidden();
      const otherLabels = sidebarLabels[otherLocale];
      await openWorkspaceMenu(page, otherLabels);
      await workspaceMenu.getByLabel(otherLabels.language, { exact: true }).selectOption(locale);
      await expect(page.locator("html")).toHaveAttribute("lang", locale);
      await page.keyboard.press("Escape");
      await expect(workspaceMenu).toBeHidden();
      await assertNoHorizontalOverflow(page);

      await page.setViewportSize({ width: 844, height: 300 });
      await openSidebarDrawer(page, labels);
      await scrollSidebarRail(page, "top");
      const shortRailTargets = [
        [page.getByLabel(labels.currentWork, { exact: true }), labels.currentWork],
        [roomSection(page, labels.channels).getByRole("heading", { name: labels.channels }), labels.channels],
        [roomSection(page, labels.channels).getByRole("button", { name: labels.newChannel, exact: true }), labels.newChannel],
        [roomSection(page, labels.directs).getByRole("heading", { name: labels.directs }), labels.directs],
        [roomSection(page, labels.directs).getByRole("button", { name: labels.newDirect, exact: true }), labels.newDirect],
        [roomSection(page, labels.directs).locator(".room-list").getByRole("button").first(), "the first direct-message entry"],
        [page.getByRole("button", { name: labels.mailbox, exact: true }), labels.mailbox],
        [page.locator(".workspace-trigger"), labels.workspace],
      ] as const;
      for (const [target, label] of shortRailTargets) await expectSidebarTarget(target, label, `${locale} 844x300`);
    });
  }
});
