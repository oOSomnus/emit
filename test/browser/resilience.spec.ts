import type { Page } from "@playwright/test";
import type { MailboxItemDTO, MessageDTO } from "../../src/shared/contracts.ts";
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
