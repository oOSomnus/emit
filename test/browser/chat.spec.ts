import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page, Response } from "@playwright/test";
import type { AppConfigDTO, BootstrapDTO, EmployeeDTO, MessageDTO, RoomDTO, WorkContextDTO, WorkDTO, WorkExecutionDTO } from "../../src/shared/contracts.ts";
import { expect, navigateWorkspace, onboarded, selectSettingsSection, test, type BrowserE2eFixture } from "./fixtures.ts";

type SendReceipt = { message: MessageDTO; workIds: string[] };

async function api<T>(app: BrowserE2eFixture, path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await app.request<T>(path, method, body);
  expect(response.status, `${method} ${path}: ${JSON.stringify(response.body)}`).toBe(200);
  return response.body;
}

async function revealNavigation(page: Page): Promise<void> {
  for (const name of ["Open navigation", "打开导航"]) {
    const open = page.getByRole("button", { name, exact: true });
    if (await open.isVisible()) {
      await open.click();
      return;
    }
  }
}

async function openChannel(page: Page, app: BrowserE2eFixture): Promise<void> {
  await onboarded(page, app);
  const channel = page.getByRole("button", { name: "General", exact: true });
  await expect(channel).toBeAttached();
  await revealNavigation(page);
  await channel.click();
  await expect(page.getByRole("heading", { name: /General/ })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
}

function waitForMessagePost(page: Page, roomId: string): Promise<Response> {
  return page.waitForResponse((response) => {
    const request = response.request();
    return request.method() === "POST" && new URL(response.url()).pathname === `/api/rooms/${roomId}/messages`;
  });
}

/** The fake provider's hold gates answer `{ ready: boolean }`. */
async function gateReady(url: string): Promise<boolean> {
  const response = await fetch(url);
  const payload: unknown = await response.json();
  return typeof payload === "object" && payload !== null && "ready" in payload && payload.ready === true;
}

async function createDirect(page: Page, employeeId: string, name = "Alice"): Promise<void> {
  await revealNavigation(page);
  await page.getByRole("button", { name: "Start a direct message", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Start a direct message", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.locator(`[data-employee-id="${employeeId}"]`).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
}

async function waitForWork(app: BrowserE2eFixture, workId: string, status: WorkDTO["status"], timeout = 45_000): Promise<WorkDTO> {
  await expect.poll(async () => {
    const works = await api<WorkDTO[]>(app, "/api/works");
    return works.find((work) => work.id === workId)?.status;
  }, { timeout }).toBe(status);
  const works = await api<WorkDTO[]>(app, "/api/works");
  const work = works.find((entry) => entry.id === workId);
  if (work === undefined) throw new Error(`Work ${workId} disappeared after reaching ${status}`);
  return work;
}

async function roomMessages(app: BrowserE2eFixture, roomId: string): Promise<{ room: RoomDTO; messages: MessageDTO[] }> {
  return api<{ room: RoomDTO; messages: MessageDTO[] }>(app, `/api/rooms/${roomId}/messages`);
}

test("public chat distinguishes ordinary text from a picked recipient without duplicate sends", async ({ app, page }) => {
  await openChannel(page, app);
  const employeeId = app.workspace.employeeIds[0]!;
  const composer = page.getByRole("textbox", { name: "Message" });
  let postedMessages = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === `/api/rooms/${app.workspace.channelId}/messages`) {
      postedMessages += 1;
    }
  });

  const ordinaryText = "Public status without an addressed employee";
  const ordinaryResponsePromise = waitForMessagePost(page, app.workspace.channelId);
  await composer.fill(ordinaryText);
  await page.getByRole("button", { name: "Post", exact: true }).click();
  const ordinaryResponse = await ordinaryResponsePromise;
  expect(ordinaryResponse.status()).toBe(200);
  const ordinary = await ordinaryResponse.json() as SendReceipt;
  expect(ordinary.workIds).toEqual([]);
  expect(ordinary.message).toMatchObject({
    body: ordinaryText,
    addressing: { recipientIds: [], mentionAll: false },
  });
  await expect(page.getByText(ordinaryText, { exact: true })).toHaveCount(1);
  expect(postedMessages).toBe(1);

  await composer.fill("@Ali");
  await expect(page.getByRole("option", { name: /Alice/ })).toBeVisible();
  // Enter accepts the member suggestion: it adds Alice as a recipient and
  // inserts text, and it must not also send the message.
  await composer.press("Enter");
  const addressedDraft = await composer.inputValue();
  expect(postedMessages).toBe(1);
  await expect(page.getByRole("button", { name: "Remove Alice from recipients", exact: true })).toBeVisible();
  const beforeSend = await roomMessages(app, app.workspace.channelId);
  expect(beforeSend.messages.filter((message) => message.author.type === "user")).toHaveLength(1);

  const mentionPrompt = `${addressedDraft}please read notes.txt`;
  await composer.fill(mentionPrompt);
  const mentionBody = await composer.inputValue();
  const mentionResponsePromise = waitForMessagePost(page, app.workspace.channelId);
  await composer.press("Enter");
  const mentionResponse = await mentionResponsePromise;
  expect(mentionResponse.status()).toBe(200);
  const mention = await mentionResponse.json() as SendReceipt;
  expect(mention.workIds).toHaveLength(1);
  expect(mention.message).toMatchObject({
    body: mentionBody,
    addressing: { recipientIds: [employeeId], mentionAll: false },
  });
  expect(postedMessages).toBe(2);
  await expect(page.getByText(mentionBody, { exact: true })).toHaveCount(1);
  // A successful send clears the selected recipients with the draft.
  await expect(page.getByRole("button", { name: "Remove Alice from recipients", exact: true })).toHaveCount(0);

  const persisted = await roomMessages(app, app.workspace.channelId);
  expect(persisted.messages.filter((message) => message.author.type === "user" && message.body === ordinaryText)).toHaveLength(1);
  expect(persisted.messages.filter((message) => message.author.type === "user" && message.body === mentionBody)).toHaveLength(1);
  const work = await waitForWork(app, mention.workIds[0]!, "succeeded");
  expect(work).toMatchObject({
    employeeId,
    roomId: app.workspace.channelId,
    workContextId: app.workspace.workContextId,
    kind: "message",
  });
});

test("a private direct message wakes its employee in the selected work without appearing in the public channel", async ({ app, page }) => {
  await openChannel(page, app);
  const [employeeId, bobId] = app.workspace.employeeIds;
  if (employeeId === undefined || bobId === undefined) throw new Error("The seeded workspace did not create both employees");
  const bootstrap = await api<BootstrapDTO>(app, "/api/bootstrap");
  const alice = bootstrap.employees.find((employee) => employee.id === employeeId)!;
  let roomPosts = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/rooms") roomPosts += 1;
  });

  // The picker searches name, role, and address, and picking a row opens the
  // conversation directly.
  await revealNavigation(page);
  await page.getByRole("button", { name: "Start a direct message", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Start a direct message", exact: true });
  await expect(dialog).toBeVisible();
  const search = dialog.getByLabel("Search name, role, or address", { exact: true });
  const aliceRow = dialog.locator(`[data-employee-id="${employeeId}"]`);
  const bobRow = dialog.locator(`[data-employee-id="${bobId}"]`);
  await search.fill("Ali");
  await expect(aliceRow).toBeVisible();
  await expect(bobRow).toHaveCount(0);
  await search.fill("Test assistant");
  await expect(aliceRow).toBeVisible();
  await expect(bobRow).toBeVisible();
  await search.fill(alice.address);
  await expect(aliceRow).toBeVisible();
  await expect(bobRow).toHaveCount(0);
  await search.fill("");
  await expect(aliceRow).toBeVisible();
  await aliceRow.click();
  await expect(dialog).toHaveCount(0);
  expect(roomPosts).toBe(1);
  await expect(page.getByRole("textbox", { name: "Message" })).toBeFocused();
  await expect(page.locator(".session-work")).toHaveAttribute("aria-label", "Conversation work: Test Workspace");

  const directRooms = await api<RoomDTO[]>(app, "/api/rooms");
  const directRoom = directRooms.find((room) => room.kind === "dm" && room.employeeId === employeeId);
  expect(directRoom).toBeDefined();
  expect(directRoom!.workContextId).toBe(app.workspace.workContextId);

  // Choosing the same person again reuses the same room for this work.
  await revealNavigation(page);
  await page.getByRole("button", { name: "Start a direct message", exact: true }).click();
  const againDialog = page.getByRole("dialog", { name: "Start a direct message", exact: true });
  await expect(againDialog).toBeVisible();
  await againDialog.locator(`[data-employee-id="${employeeId}"]`).click();
  await expect(againDialog).toHaveCount(0);
  expect(roomPosts).toBe(2);
  const afterReopen = await api<RoomDTO[]>(app, "/api/rooms");
  const aliceDms = afterReopen.filter(
    (room) => room.kind === "dm" && room.employeeId === employeeId && room.workContextId === app.workspace.workContextId,
  );
  expect(aliceDms).toHaveLength(1);
  expect(aliceDms[0]!.id).toBe(directRoom!.id);

  const body = "Private chat request: please read notes.txt";
  const post = waitForMessagePost(page, directRoom!.id);
  await page.getByRole("textbox", { name: "Message" }).fill(body);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const response = await post;
  expect(response.status()).toBe(200);
  const receipt = await response.json() as SendReceipt;
  expect(receipt.workIds).toHaveLength(1);
  await expect(page.getByText(body, { exact: true })).toHaveCount(1);

  const direct = await roomMessages(app, directRoom!.id);
  const publicChannel = await roomMessages(app, app.workspace.channelId);
  expect(direct.room).toMatchObject({ kind: "dm", employeeId, workContextId: app.workspace.workContextId });
  expect(direct.messages.filter((message) => message.author.type === "user" && message.body === body)).toHaveLength(1);
  expect(publicChannel.messages.some((message) => message.body === body)).toBe(false);
  const work = await waitForWork(app, receipt.workIds[0]!, "succeeded");
  expect(work).toMatchObject({
    employeeId,
    roomId: directRoom!.id,
    workContextId: app.workspace.workContextId,
    kind: "message",
  });
});

test("each work opens its own direct-message room for the same person", async ({ app, page }) => {
  const secondWork = await api<WorkContextDTO>(app, "/api/work-contexts", "POST", { name: "Second Work" });
  await openChannel(page, app);
  const employeeId = app.workspace.employeeIds[0]!;

  await createDirect(page, employeeId);
  const firstDm = (await api<RoomDTO[]>(app, "/api/rooms")).find(
    (room) => room.kind === "dm" && room.employeeId === employeeId && room.workContextId === app.workspace.workContextId,
  );
  expect(firstDm).toBeDefined();

  await revealNavigation(page);
  await page.getByLabel("Current work", { exact: true }).selectOption(secondWork.id);
  await createDirect(page, employeeId);
  await expect(page.locator(".session-work")).toHaveAttribute("aria-label", "Conversation work: Second Work");

  const dms = (await api<RoomDTO[]>(app, "/api/rooms")).filter(
    (room) => room.kind === "dm" && room.employeeId === employeeId,
  );
  expect(dms).toHaveLength(2);
  const secondDm = dms.find((room) => room.workContextId === secondWork.id);
  expect(secondDm).toBeDefined();
  expect(secondDm!.id).not.toBe(firstDm!.id);
  // The older room keeps the work it was created for.
  expect(dms.find((room) => room.id === firstDm!.id)!.workContextId).toBe(app.workspace.workContextId);

  // Switching back shows the first work's room, not the second's.
  await page.getByLabel("Current work", { exact: true }).selectOption(app.workspace.workContextId);
  await revealNavigation(page);
  await page.locator(".sidebar-rooms .room-dm").first().click();
  await expect(page.locator(".session-work")).toHaveAttribute("aria-label", "Conversation work: Test Workspace");
});

test("the direct-message picker filters the directory, respects disabled employees, and keeps focus in the dialog", async ({ app, page }) => {
  await openChannel(page, app);
  const [aliceId, bobId] = app.workspace.employeeIds;
  if (aliceId === undefined || bobId === undefined) throw new Error("The seeded workspace did not create both employees");
  const narrow = (page.viewportSize()?.width ?? 0) <= 760;
  let roomPosts = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/rooms") roomPosts += 1;
  });

  await revealNavigation(page);
  const plus = page.getByRole("button", { name: "Start a direct message", exact: true });
  await plus.click();
  const dialog = page.getByRole("dialog", { name: "Start a direct message", exact: true });
  await expect(dialog).toBeVisible();
  const search = dialog.getByLabel("Search name, role, or address", { exact: true });
  await expect(search).toBeFocused();

  await search.fill("zzz");
  await expect(dialog.getByText("No matching employees", { exact: true })).toBeVisible();
  await expect(dialog.locator(".direct-person")).toHaveCount(0);
  await search.fill("");
  await expect(dialog.locator(".direct-person")).toHaveCount(2);

  // Escape closes the dialog alone, sends nothing, and returns focus to +.
  await dialog.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(plus).toBeFocused();
  if (narrow) {
    await expect(
      page.locator(".mobile-bar").getByRole("button", { name: "Close navigation", exact: true }),
    ).toBeVisible();
  }
  expect(roomPosts).toBe(0);

  // Tab and Shift+Tab cycle inside the dialog; Enter on a person row opens
  // that conversation.
  await plus.click();
  const keyboardDialog = page.getByRole("dialog", { name: "Start a direct message", exact: true });
  await expect(keyboardDialog).toBeVisible();
  const close = keyboardDialog.getByRole("button", { name: "Close", exact: true });
  await close.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(keyboardDialog.locator(".direct-person").last()).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await keyboardDialog.locator(`[data-employee-id="${aliceId}"]`).focus();
  await page.keyboard.press("Enter");
  await expect(keyboardDialog).toHaveCount(0);
  expect(roomPosts).toBe(1);
  await expect(page.getByRole("heading", { name: "Alice", exact: true })).toBeVisible();

  // A disabled employee disappears from the picker immediately; with nobody
  // enabled the dialog says so instead of offering a stale row.
  await revealNavigation(page);
  await plus.click();
  const disabledDialog = page.getByRole("dialog", { name: "Start a direct message", exact: true });
  await expect(disabledDialog).toBeVisible();
  const disabled = await app.request(`/api/employees/${bobId}`, "PATCH", { enabled: false });
  expect(disabled.status).toBe(200);
  await expect(disabledDialog.locator(`[data-employee-id="${bobId}"]`)).toHaveCount(0);
  await expect(disabledDialog.locator(`[data-employee-id="${aliceId}"]`)).toBeVisible();
  const disableAlice = await app.request(`/api/employees/${aliceId}`, "PATCH", { enabled: false });
  expect(disableAlice.status).toBe(200);
  await expect(disabledDialog.getByText("No employees available for direct messages", { exact: true })).toBeVisible();
  await expect(disabledDialog.locator(".direct-person")).toHaveCount(0);
  expect(roomPosts).toBe(1);
  await disabledDialog.press("Escape");
  await expect(disabledDialog).toHaveCount(0);
});

test("a failed direct-message creation keeps the picker open for a retry", async ({ app, page }) => {
  await openChannel(page, app);
  const employeeId = app.workspace.employeeIds[0]!;
  let failures = 0;
  let posts = 0;
  await page.route("**/api/rooms", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    posts += 1;
    if (failures === 0) {
      failures += 1;
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ message: "Fixture direct-message failure" }),
      });
      return;
    }
    await route.continue();
  });

  await revealNavigation(page);
  await page.getByRole("button", { name: "Start a direct message", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Start a direct message", exact: true });
  const search = dialog.getByLabel("Search name, role, or address", { exact: true });
  await search.fill("Ali");
  await dialog.locator(`[data-employee-id="${employeeId}"]`).click();
  await expect(dialog.getByRole("alert")).toContainText("Fixture direct-message failure");
  await expect(dialog).toBeVisible();
  expect(await search.inputValue()).toBe("Ali");
  expect(posts).toBe(1);

  const retry = page.waitForResponse(
    (response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/rooms",
  );
  await dialog.locator(`[data-employee-id="${employeeId}"]`).click();
  expect((await retry).status()).toBe(200);
  await expect(dialog).toHaveCount(0);
  expect(posts).toBe(2);
  await expect(page.getByRole("heading", { name: "Alice", exact: true })).toBeVisible();
});

test("a slow direct-message creation accepts one click and disables the picker", async ({ app, page }) => {
  await openChannel(page, app);
  const employeeId = app.workspace.employeeIds[0]!;
  let posts = 0;
  await page.route("**/api/rooms", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    posts += 1;
    const delay = Promise.withResolvers<void>();
    setTimeout(delay.resolve, 400);
    await delay.promise;
    await route.continue();
  });

  await revealNavigation(page);
  await page.getByRole("button", { name: "Start a direct message", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Start a direct message", exact: true });
  const row = dialog.locator(`[data-employee-id="${employeeId}"]`);
  await row.click();
  await expect(row).toBeDisabled();
  await expect(dialog.getByLabel("Search name, role, or address", { exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeDisabled();
  // A second click while the first request is still open must not create
  // another room.
  await row.dispatchEvent("click");
  await expect(dialog).toHaveCount(0);
  expect(posts).toBe(1);
  const rooms = await api<RoomDTO[]>(app, "/api/rooms");
  expect(rooms.filter((room) => room.kind === "dm" && room.employeeId === employeeId)).toHaveLength(1);
});

test("a failed transcript read after creation is a global error, not a failed creation", async ({ app, page }) => {
  await openChannel(page, app);
  const employeeId = app.workspace.employeeIds[0]!;
  let failedRead = false;
  await page.route("**/api/rooms/*/messages", async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === "GET" && !failedRead && !url.pathname.endsWith(`${app.workspace.channelId}/messages`)) {
      failedRead = true;
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ message: "fixture transcript failure" }),
      });
      return;
    }
    await route.continue();
  });

  await revealNavigation(page);
  await page.getByRole("button", { name: "Start a direct message", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Start a direct message", exact: true });
  await dialog.locator(`[data-employee-id="${employeeId}"]`).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".banner.error")).toContainText("fixture transcript failure");
  await expect(page.getByRole("heading", { name: "Alice", exact: true })).toBeVisible();

  const room = (await api<RoomDTO[]>(app, "/api/rooms")).find(
    (entry) => entry.kind === "dm" && entry.employeeId === employeeId,
  );
  expect(room).toBeDefined();
  const refresh = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      new URL(response.url()).pathname === `/api/rooms/${room!.id}/messages`,
  );
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  expect((await refresh).status()).toBe(200);

  const body = "after the transcript refresh";
  const post = waitForMessagePost(page, room!.id);
  await page.getByRole("textbox", { name: "Message" }).fill(body);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const receipt = await (await post).json() as SendReceipt;
  expect(receipt.workIds).toHaveLength(1);
  await expect(page.getByText(body, { exact: true })).toHaveCount(1);
  await waitForWork(app, receipt.workIds[0]!, "succeeded");
});

test("execution details load an earlier page of real tool history without duplicate steps", async ({ app, page }) => {
  test.setTimeout(120_000);
  await openChannel(page, app);
  await navigateWorkspace(page, "Settings");
  await selectSettingsSection(page, "collaboration");
  await page.getByLabel("Model turns", { exact: true }).fill("80");
  await expect.poll(async () => (await api<AppConfigDTO>(app, "/api/app")).collaboration.maxModelTurns).toBe(80);

  for (let index = 0; index < 60; index += 1) {
    const marker = String(index).padStart(3, "0");
    writeFileSync(join(app.workRoot, `browser-page-${marker}.txt`), `BROWSER_PAGE_RESULT_${marker}\n`, "utf8");
  }

  await createDirect(page, app.workspace.employeeIds[0]!);
  const rooms = await api<RoomDTO[]>(app, "/api/rooms");
  const directRoom = rooms.find((room) => room.kind === "dm" && room.employeeId === app.workspace.employeeIds[0]);
  expect(directRoom).toBeDefined();
  const requestBody = "BROWSER_PAGINATION: read every browser history marker";
  const post = waitForMessagePost(page, directRoom!.id);
  await page.getByRole("textbox", { name: "Message" }).fill(requestBody);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const response = await post;
  expect(response.status()).toBe(200);
  const receipt = await response.json() as SendReceipt;
  expect(receipt.workIds).toHaveLength(1);
  const workId = receipt.workIds[0]!;
  const work = await waitForWork(app, workId, "succeeded", 100_000);
  expect(work.answer).toContain("BROWSER_PAGINATION_COMPLETE");
  expect(readFileSync(join(app.workRoot, "browser-page-000.txt"), "utf8")).toBe("BROWSER_PAGE_RESULT_000\n");
  expect(readFileSync(join(app.workRoot, "browser-page-059.txt"), "utf8")).toBe("BROWSER_PAGE_RESULT_059\n");
  expect(existsSync(join(app.workRoot, "browser-page-060.txt"))).toBe(false);

  await navigateWorkspace(page, "Runs");
  await expect(page.getByRole("heading", { name: "Runs", exact: true })).toBeVisible();
  const row = page.getByRole("row").filter({ hasText: "Alice" });
  await expect(row).toHaveCount(1);
  const executionUrl = new URL(app.emit.url);
  const isExecutionPage = (url: string, withCursor: boolean): boolean => {
    const parsed = new URL(url);
    return parsed.origin === executionUrl.origin && parsed.pathname === `/api/works/${workId}/execution` && parsed.searchParams.has("cursor") === withCursor;
  };
  const latestResponsePromise = page.waitForResponse((candidate) => isExecutionPage(candidate.url(), false));
  await row.getByRole("button", { name: "View execution", exact: true }).click();
  const latestResponse = await latestResponsePromise;
  expect(latestResponse.status()).toBe(200);
  const latestPage = await latestResponse.json() as WorkExecutionDTO;
  const dialog = page.getByRole("dialog", { name: "Execution details" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("BROWSER_PAGE_RESULT_059", { exact: false })).toBeVisible();
  await expect(dialog.getByText("BROWSER_PAGE_RESULT_000", { exact: false })).toHaveCount(0);
  await expect(dialog.getByText("BROWSER_PAGINATION_COMPLETE", { exact: false })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Load earlier steps", exact: true })).toBeVisible();
  expect(latestPage.nextCursor).toBeDefined();
  expect(latestPage.steps.some((step) => step.text?.includes("BROWSER_PAGE_RESULT_059"))).toBe(true);
  expect(latestPage.steps.some((step) => step.text?.includes("BROWSER_PAGE_RESULT_000"))).toBe(false);

  const earlierResponsePromise = page.waitForResponse((candidate) => isExecutionPage(candidate.url(), true));
  await dialog.getByRole("button", { name: "Load earlier steps", exact: true }).click();
  const earlierResponse = await earlierResponsePromise;
  expect(earlierResponse.status()).toBe(200);
  const earlierPage = await earlierResponse.json() as WorkExecutionDTO;
  expect(earlierPage.steps.some((step) => step.text?.includes("BROWSER_PAGE_RESULT_000"))).toBe(true);
  await expect(dialog.getByText("BROWSER_PAGE_RESULT_000", { exact: false })).toBeVisible();
  await expect(dialog.getByText("BROWSER_PAGE_RESULT_059", { exact: false })).toBeVisible();

  const combinedIds = [...latestPage.steps, ...earlierPage.steps].map((step) => step.id);
  expect(new Set(combinedIds).size).toBe(combinedIds.length);
  await expect(dialog.getByRole("list").getByRole("listitem")).toHaveCount(combinedIds.length);
});

test("creating a channel uses a batch member picker bound to the current work", async ({ app, page }) => {
  await onboarded(page, app);
  const aliceId = app.workspace.employeeIds[0]!;
  const bobId = app.workspace.employeeIds[1]!;
  const roomsBefore = await api<RoomDTO[]>(app, "/api/rooms");
  const narrow = (page.viewportSize()?.width ?? 0) <= 760;

  await revealNavigation(page);
  const channelButton = page.getByRole("button", { name: "New channel", exact: true });
  await channelButton.click();
  const dialog = page.getByRole("dialog", { name: "New channel", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Channel name", { exact: true }).fill("Planning Team");
  const search = dialog.getByLabel("Search name, role, or address", { exact: true });
  await search.fill("Ali");
  await dialog.getByRole("checkbox", { name: /Alice/ }).check();
  await search.fill("Bob");
  await dialog.getByRole("button", { name: "Select all results", exact: true }).click();
  await expect(dialog.getByRole("checkbox", { name: /Bob/ })).toBeChecked();
  await search.fill("");
  await expect(dialog.getByRole("checkbox", { name: /Alice/ })).toBeChecked();
  await expect(dialog.getByRole("checkbox", { name: /Bob/ })).toBeChecked();
  await dialog.getByRole("checkbox", { name: /Bob/ }).uncheck();
  const createResponse = page.waitForResponse((response) => {
    const request = response.request();
    return request.method() === "POST" && new URL(response.url()).pathname === "/api/rooms";
  });
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  const created = await createResponse;
  expect(created.status()).toBe(200);
  const room = await created.json() as RoomDTO;
  expect(room).toMatchObject({
    kind: "channel",
    name: "Planning Team",
    workContextId: app.workspace.workContextId,
    memberIds: [aliceId],
  });
  await expect(page.getByRole("heading", { name: /Planning Team/ })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
  const roomsAfterCreate = await api<RoomDTO[]>(app, "/api/rooms");
  expect(roomsAfterCreate.filter((entry) => entry.name === "Planning Team")).toHaveLength(1);

  // Cancel and Escape leave no record and return focus to the entry button.
  await revealNavigation(page);
  await channelButton.click();
  const cancelDialog = page.getByRole("dialog", { name: "New channel", exact: true });
  await expect(cancelDialog).toBeVisible();
  await cancelDialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(cancelDialog).toHaveCount(0);
  await expect(channelButton).toBeFocused();
  expect((await api<RoomDTO[]>(app, "/api/rooms")).length).toBe(roomsBefore.length + 1);

  await channelButton.click();
  const escapeDialog = page.getByRole("dialog", { name: "New channel", exact: true });
  await expect(escapeDialog).toBeVisible();
  await escapeDialog.press("Escape");
  await expect(escapeDialog).toHaveCount(0);
  if (narrow) {
    // The dialog's Escape must not also close the narrow-screen navigation.
    await expect(
      page.locator(".mobile-bar").getByRole("button", { name: "Close navigation", exact: true }),
    ).toBeVisible();
  }
  expect((await api<RoomDTO[]>(app, "/api/rooms")).length).toBe(roomsBefore.length + 1);

  // A selected member disabled elsewhere blocks creation until deselected.
  await channelButton.click();
  const staleDialog = page.getByRole("dialog", { name: "New channel", exact: true });
  await expect(staleDialog).toBeVisible();
  await staleDialog.getByLabel("Channel name", { exact: true }).fill("Stale Team");
  await staleDialog.getByRole("checkbox", { name: /Bob/ }).check();
  const disabled = await app.request(`/api/employees/${bobId}`, "PATCH", { enabled: false });
  expect(disabled.status).toBe(200);
  await expect(staleDialog.getByRole("alert")).toContainText("disabled or removed");
  await expect(staleDialog.getByRole("button", { name: "Create", exact: true })).toBeDisabled();
  await staleDialog.getByRole("checkbox", { name: /Bob/ }).click();
  await expect(staleDialog.getByRole("alert")).toHaveCount(0);
  await expect(staleDialog.getByRole("button", { name: "Create", exact: true })).toBeEnabled();
  await staleDialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(staleDialog).toHaveCount(0);

  // Filtering, empty results, and an intentionally empty channel.
  await revealNavigation(page);
  await channelButton.click();
  const emptyDialog = page.getByRole("dialog", { name: "New channel", exact: true });
  await expect(emptyDialog).toBeVisible();
  await emptyDialog.getByLabel("Channel name", { exact: true }).fill("Quiet Room");
  const emptySearch = emptyDialog.getByLabel("Search name, role, or address", { exact: true });
  await emptySearch.fill("zzz");
  await expect(emptyDialog.getByText("No matching employees", { exact: true })).toBeVisible();
  await expect(emptyDialog.getByRole("button", { name: "Select all results", exact: true })).toBeDisabled();
  await emptySearch.fill("");
  await expect(emptyDialog.getByRole("checkbox", { name: /Alice/ })).toBeVisible();
  await emptyDialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("heading", { name: /Quiet Room/ })).toBeVisible();
  const quiet = (await api<RoomDTO[]>(app, "/api/rooms")).find((entry) => entry.name === "Quiet Room");
  expect(quiet?.memberIds).toEqual([]);
});

test("a channel message wakes exactly the selected recipients", async ({ app, page }) => {
  await openChannel(page, app);
  const [aliceId, bobId] = app.workspace.employeeIds;
  if (aliceId === undefined || bobId === undefined) throw new Error("The seeded workspace did not create both employees");
  const composer = page.getByRole("textbox", { name: "Message" });
  let posted = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === `/api/rooms/${app.workspace.channelId}/messages`) {
      posted += 1;
    }
  });

  // Accepting @all inserts "@all " and selects everyone without posting.
  await composer.fill("@all");
  await expect(page.getByRole("option", { name: "Everyone", exact: true })).toBeVisible();
  await composer.press("Enter");
  expect(await composer.inputValue()).toBe("@all ");
  expect(posted).toBe(0);
  await expect(page.getByRole("button", { name: "Remove Everyone from recipients", exact: true })).toBeVisible();

  // Removing the Everyone chip leaves the "@all" text, which now wakes nobody.
  await page.getByRole("button", { name: "Remove Everyone from recipients", exact: true }).click();
  await expect(page.getByRole("button", { name: "Remove Everyone from recipients", exact: true })).toHaveCount(0);
  const inertPost = waitForMessagePost(page, app.workspace.channelId);
  await composer.press("Enter");
  const inertReceipt = await (await inertPost).json() as SendReceipt;
  expect(inertReceipt).toMatchObject({
    workIds: [],
    message: { body: "@all", addressing: { recipientIds: [], mentionAll: false } },
  });
  expect(posted).toBe(1);

  // Picking Everyone again broadcasts even though the body has no mention.
  await composer.fill("@all");
  await composer.press("Enter");
  await composer.fill("broadcast body");
  const allPost = waitForMessagePost(page, app.workspace.channelId);
  await composer.press("Enter");
  const allReceipt = await (await allPost).json() as SendReceipt;
  expect(allReceipt.message.body).toBe("broadcast body");
  expect(allReceipt.message.addressing?.mentionAll).toBe(true);
  expect([...(allReceipt.message.addressing?.recipientIds ?? [])].sort()).toEqual([aliceId, bobId].sort());
  expect(allReceipt.workIds).toHaveLength(2);
  await waitForWork(app, allReceipt.workIds[0]!, "succeeded");
  await waitForWork(app, allReceipt.workIds[1]!, "succeeded");
  expect(posted).toBe(2);

  // Picking a member after Everyone switches to that member alone, and
  // accepting the same member twice does not duplicate the recipient.
  await composer.fill("@all");
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "Remove Everyone from recipients", exact: true })).toBeVisible();
  await composer.fill("@Ali");
  await expect(page.getByRole("option", { name: /Alice/ })).toBeVisible();
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "Remove Everyone from recipients", exact: true })).toHaveCount(0);
  await composer.fill("@Ali");
  await expect(page.getByRole("option", { name: /Alice/ })).toBeVisible();
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "Remove Alice from recipients", exact: true })).toHaveCount(1);
  await page.getByRole("button", { name: "Remove Alice from recipients", exact: true }).click();
  await expect(page.locator(".composer-recipients .chip-toggle")).toHaveCount(0);
  await composer.fill("");

  // A selected recipient disabled elsewhere blocks Send until the chip is
  // removed; removing it lets a plain body send without recipients.
  await page.getByRole("button", { name: "Select reply recipients", exact: true }).click();
  await expect(page.getByRole("listbox", { name: "Members", exact: true })).toBeVisible();
  await page.getByRole("option", { name: /Bob/ }).click();
  await composer.fill("bob will be disabled");
  const disabled = await app.request(`/api/employees/${bobId}`, "PATCH", { enabled: false });
  expect(disabled.status).toBe(200);
  await expect(page.getByRole("alert")).toContainText("disabled");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Remove Bob from recipients", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await composer.fill("plain body after removal");
  const afterRemovalPost = waitForMessagePost(page, app.workspace.channelId);
  await composer.press("Enter");
  const afterRemovalReceipt = await (await afterRemovalPost).json() as SendReceipt;
  expect(afterRemovalReceipt).toMatchObject({
    workIds: [],
    message: { body: "plain body after removal", addressing: { recipientIds: [], mentionAll: false } },
  });
  expect(posted).toBe(3);
  const reenabled = await app.request(`/api/employees/${bobId}`, "PATCH", { enabled: true });
  expect(reenabled.status).toBe(200);

  // The trigger opens the menu; picking a member selects that recipient and
  // never edits the text or the caret.
  await composer.fill("notes handled");
  await composer.press("End");
  const caretBefore = await composer.evaluate((element: HTMLTextAreaElement) => element.selectionStart);
  await page.getByRole("button", { name: "Select reply recipients", exact: true }).click();
  await expect(page.getByRole("listbox", { name: "Members", exact: true })).toBeVisible();
  await page.getByRole("option", { name: /Alice/ }).click();
  expect(await composer.inputValue()).toBe("notes handled");
  expect(await composer.evaluate((element: HTMLTextAreaElement) => element.selectionStart)).toBe(caretBefore);
  expect(posted).toBe(3);
  const alicePost = waitForMessagePost(page, app.workspace.channelId);
  await composer.press("Enter");
  const aliceReceipt = await (await alicePost).json() as SendReceipt;
  expect(aliceReceipt.workIds).toHaveLength(1);
  expect(aliceReceipt.message).toMatchObject({
    body: "notes handled",
    addressing: { recipientIds: [aliceId], mentionAll: false },
  });
  const aliceWork = await waitForWork(app, aliceReceipt.workIds[0]!, "succeeded");
  expect(aliceWork.employeeId).toBe(aliceId);
  expect(posted).toBe(4);

  // Escape closes the menu and keeps the text; Shift+Enter inserts a newline.
  await composer.fill("@Ali");
  await expect(page.getByRole("option", { name: /Alice/ })).toBeVisible();
  await composer.press("Escape");
  await expect(page.getByRole("listbox", { name: "Members", exact: true })).toHaveCount(0);
  expect(await composer.inputValue()).toBe("@Ali");
  await composer.press("Shift+Enter");
  expect(await composer.inputValue()).toBe("@Ali\n");
  expect(posted).toBe(4);

  // Switching rooms drops the draft, the menu, and the selected recipients.
  await composer.fill("@Ali");
  await expect(page.getByRole("option", { name: /Alice/ })).toBeVisible();
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "Remove Alice from recipients", exact: true })).toBeVisible();
  await createDirect(page, aliceId);
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("");
  await revealNavigation(page);
  await page.getByRole("button", { name: "General", exact: true }).click();
  await expect(page.getByRole("heading", { name: /General/ })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("");
  await expect(page.getByRole("listbox", { name: "Members", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Remove Alice from recipients", exact: true })).toHaveCount(0);
});

test("a failed send keeps the draft and recipients until a retry succeeds", async ({ app, page }) => {
  await openChannel(page, app);
  const aliceId = app.workspace.employeeIds[0]!;
  const body = "retry after failure";
  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill("@Ali");
  await expect(page.getByRole("option", { name: /Alice/ })).toBeVisible();
  await composer.press("Enter");
  await expect(composer).toHaveValue("@Alice ");
  expect(await composer.evaluate((element: HTMLTextAreaElement) => element.selectionStart)).toBe("@Alice ".length);
  await composer.fill(body);

  let failures = 0;
  await page.route(`**/api/rooms/${app.workspace.channelId}/messages`, async (route) => {
    if (route.request().method() === "POST" && failures === 0) {
      failures += 1;
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ message: "fixture failure" }),
      });
      return;
    }
    await route.continue();
  });
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => failures).toBe(1);
  await expect(page.getByRole("button", { name: "Remove Alice from recipients", exact: true })).toBeVisible();
  expect(await composer.inputValue()).toBe(body);

  const retry = waitForMessagePost(page, app.workspace.channelId);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const receipt = await (await retry).json() as SendReceipt;
  expect(receipt).toMatchObject({
    message: { body, addressing: { recipientIds: [aliceId], mentionAll: false } },
  });
  expect(receipt.workIds).toHaveLength(1);
  await expect(page.getByRole("button", { name: "Remove Alice from recipients", exact: true })).toHaveCount(0);
  expect(await composer.inputValue()).toBe("");
  await waitForWork(app, receipt.workIds[0]!, "succeeded");
});

test("mention suggestions align member and @all rows and insert without posting", async ({ app, page }) => {
  await openChannel(page, app);
  const composer = page.getByRole("textbox", { name: "Message" });
  let posted = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === `/api/rooms/${app.workspace.channelId}/messages`) {
      posted += 1;
    }
  });

  type RowGeometry = { id: string; avatarLeft: number; nameLeft: number; nameRight: number };
  async function measureMenu(): Promise<{ rows: RowGeometry[]; left: number; right: number; overflow: number }> {
    const popover = page.locator(".mention-popover");
    await expect(popover).toBeVisible();
    return popover.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const rows = [...element.querySelectorAll<HTMLElement>(".mention-option")].map((row) => {
        const avatar = row.querySelector<HTMLElement>(".avatar, .employee-avatar");
        const name = row.querySelector<HTMLElement>(".mention-option-text > strong");
        if (avatar === null || name === null) throw new Error(`mention row ${row.id} is missing its avatar or name`);
        return {
          id: row.id,
          avatarLeft: avatar.getBoundingClientRect().left,
          nameLeft: name.getBoundingClientRect().left,
          nameRight: name.getBoundingClientRect().right,
        };
      });
      return {
        rows,
        left: bounds.left,
        right: bounds.right,
        overflow: element.scrollWidth - element.clientWidth,
      };
    });
  }

  function expectAligned(geometry: Awaited<ReturnType<typeof measureMenu>>): void {
    expect(geometry.rows).toHaveLength(3);
    expect(geometry.rows.some((row) => row.id === "address-suggestion-all")).toBe(true);
    for (const edge of ["avatarLeft", "nameLeft"] as const) {
      const values = geometry.rows.map((row) => row[edge]);
      expect(Math.max(...values) - Math.min(...values), `${edge} spread across mention options`).toBeLessThanOrEqual(1);
    }
    // A long name or address wraps inside the menu instead of widening it.
    expect(geometry.overflow).toBeLessThanOrEqual(1);
    for (const row of geometry.rows) {
      expect(row.nameRight, `${row.id} name stays inside the menu`).toBeLessThanOrEqual(geometry.right - 4);
    }
  }

  // Both members and @all share the same avatar and name-column left edge.
  await composer.fill("@");
  const english = await measureMenu();
  expectAligned(english);

  // Clicking @all selects everyone and inserts text without posting.
  await page.locator("#address-suggestion-all").click();
  expect(await composer.inputValue()).toBe("@all ");
  await expect(page.getByRole("button", { name: "Remove Everyone from recipients", exact: true })).toBeVisible();
  expect(posted).toBe(0);
  await page.getByRole("button", { name: "Remove Everyone from recipients", exact: true }).click();

  // The keyboard path inserts the same text without posting.
  await composer.fill("@all");
  await composer.press("Enter");
  expect(await composer.inputValue()).toBe("@all ");
  expect(posted).toBe(0);
  await page.getByRole("button", { name: "Remove Everyone from recipients", exact: true }).click();

  // A long, unbreakable member name still stays inside the menu at this width.
  const longName = "AlexandertheGreatMemberNameWithoutBreaks0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const renamed = await app.request(`/api/employees/${app.workspace.employeeIds[1]!}`, "PATCH", { name: longName });
  expect(renamed.status).toBe(200);
  await page.reload();
  await openChannel(page, app);
  await composer.fill("@");
  const wrapped = await measureMenu();
  expectAligned(wrapped);

  // Chinese labels keep the same alignment and stay inside the menu.
  await page.evaluate(() => localStorage.setItem("emit.language", "zh-CN"));
  await page.reload();
  await onboarded(page, app);
  const chineseComposer = page.getByRole("textbox", { name: "消息内容" });
  await revealNavigation(page);
  await page.getByRole("button", { name: "General", exact: true }).click();
  await expect(chineseComposer).toBeVisible();
  await chineseComposer.fill("@");
  await expect(page.getByRole("option", { name: "全体成员", exact: true })).toBeVisible();
  const chinese = await measureMenu();
  expectAligned(chinese);
});

test("IME confirmation and duplicate names never mis-address a channel message", async ({ app, page }) => {
  await openChannel(page, app);
  const bobId = app.workspace.employeeIds[1]!;
  const composer = page.getByRole("textbox", { name: "Message" });
  let posted = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === `/api/rooms/${app.workspace.channelId}/messages`) {
      posted += 1;
    }
  });

  // An Enter that confirms an IME composition neither sends nor accepts.
  await composer.fill("@Al");
  await expect(page.getByRole("option", { name: /Alice/ })).toBeVisible();
  await composer.evaluate((element) => {
    element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    element.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, isComposing: true }),
    );
    element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  });
  expect(await composer.inputValue()).toBe("@Al");
  expect(posted).toBe(0);
  await composer.fill("");

  // Renaming Bob to Alice makes the display name ambiguous: both candidates
  // fall back to addresses, and the chosen address wakes only its employee.
  const renamed = await app.request(`/api/employees/${bobId}`, "PATCH", { name: "Alice" });
  expect(renamed.status).toBe(200);
  const bootstrap = await api<BootstrapDTO>(app, "/api/bootstrap");
  const bobAddress = bootstrap.employees.find((employee) => employee.id === bobId)!.address;
  await composer.fill("@Ali");
  await expect(page.getByRole("option", { name: /Alice/ })).toHaveCount(2);
  await page.getByRole("option").filter({ hasText: bobAddress }).click();
  expect(await composer.inputValue()).toBe(`@${bobAddress} `);
  await composer.fill(`${await composer.inputValue()}please read notes.txt`);
  const post = waitForMessagePost(page, app.workspace.channelId);
  await composer.press("Enter");
  const receipt = await (await post).json() as SendReceipt;
  expect(receipt.workIds).toHaveLength(1);
  expect(receipt.message).toMatchObject({ addressing: { recipientIds: [bobId], mentionAll: false } });
  const work = await waitForWork(app, receipt.workIds[0]!, "succeeded");
  expect(work.employeeId).toBe(bobId);
});

test("employee Markdown renders safely in final answers and survives a reload", async ({ app, page }) => {
  test.setTimeout(120_000);
  await openChannel(page, app);
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));

  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill("@Ali");
  await expect(page.getByRole("option", { name: /Alice/ })).toBeVisible();
  await composer.press("Enter");
  await composer.fill("BROWSER_MARKDOWN");
  const post = waitForMessagePost(page, app.workspace.channelId);
  await composer.press("Enter");
  const response = await post;
  expect(response.status()).toBe(200);
  const receipt = await response.json() as SendReceipt;
  expect(receipt.workIds).toHaveLength(1);
  const work = await waitForWork(app, receipt.workIds[0]!, "succeeded");
  expect(work.answer).toContain("MARKDOWN_HEADING");

  const body = page.locator(".message.employee .markdown-body").last();
  await expect(body).toBeVisible();
  await expect(body.getByRole("heading", { name: "MARKDOWN_HEADING", exact: true })).toBeVisible();
  await expect(body.locator("strong", { hasText: "MARKDOWN_BOLD" })).toBeVisible();
  await expect(body.locator("code", { hasText: "MARKDOWN_CODE" })).toBeVisible();
  await expect(body.getByText("MARKDOWN_ITEM", { exact: true })).toBeVisible();
  await expect(body.getByText("MARKDOWN_QUOTE", { exact: true })).toBeVisible();
  await expect(body.getByText("MARKDOWN_CELL", { exact: true })).toBeVisible();
  const task = body.locator('input[type="checkbox"]');
  await expect(task).toBeDisabled();
  await expect(task).toBeChecked();
  const codeBlock = body.locator("pre code");
  await expect(codeBlock).toContainText("**literal**");
  await expect(codeBlock).toContainText("@all");
  expect(await codeBlock.locator("strong").count()).toBe(0);

  // Raw HTML stays text; unsafe URLs and remote images never execute or fetch.
  expect(await body.locator("script").count()).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __markdownExecuted?: boolean }).__markdownExecuted)).toBeUndefined();
  expect(await body.locator('a[href^="javascript:"]').count()).toBe(0);
  await expect(body.getByRole("link", { name: "safe", exact: true })).toHaveAttribute(
    "href",
    "https://example.test/docs",
  );
  await expect(body.getByRole("link", { name: "remote", exact: true })).toHaveAttribute(
    "href",
    "https://example.test/image.png",
  );
  expect(requests.some((url) => url.includes("example.test"))).toBe(false);

  // The stored message keeps the original Markdown, and a reload re-renders it.
  const stored = await roomMessages(app, app.workspace.channelId);
  const answer = stored.messages.find((message) => message.body.includes("MARKDOWN_HEADING"));
  expect(answer?.body).toContain("**MARKDOWN_BOLD**");
  expect(answer?.body).toContain("```txt");
  await page.reload();
  await onboarded(page, app);
  await expect(
    page.locator(".message.employee .markdown-body").last().getByRole("heading", { name: "MARKDOWN_HEADING", exact: true }),
  ).toBeVisible();
});

/**
 * The streaming contract for one run: the room shows only who is typing, the
 * execution record carries the live progress, and the settled answer lands in
 * the room exactly once. Leaves the execution modal closed on Runs.
 */
async function expectStreamingProgress(page: Page, app: BrowserE2eFixture, workId: string): Promise<void> {
  await expect.poll(() => gateReady(`${app.provider.url}/_markdown_stream_ready`), { timeout: 30_000 }).toBe(true);

  const typing = page.locator(".chat-typing");
  await expect(typing).toHaveText("Alice is typing…");
  await expect(page.locator(".messages")).not.toContainText("MARKDOWN_HEADING");
  await expect(page.locator(".messages")).not.toContainText("**literal**");
  await expect(typing).not.toContainText("MARKDOWN_HEADING");
  const typingBox = (await typing.boundingBox())!;
  const textareaBox = (await page.getByRole("textbox", { name: "Message" }).boundingBox())!;
  const composerBox = (await page.locator(".composer-box").boundingBox())!;
  expect(typingBox.y + typingBox.height).toBeLessThanOrEqual(textareaBox.y + 1);
  expect(Math.abs(typingBox.x - composerBox.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(typingBox.x + typingBox.width - (composerBox.x + composerBox.width))).toBeLessThanOrEqual(1);

  // The streamed answer is process, not a message: it lives in the execution
  // record while the run is generating.
  await navigateWorkspace(page, "Runs");
  const row = page.getByRole("row").filter({ hasText: "Alice" });
  await expect(row).toHaveCount(1);
  await row.getByRole("button", { name: "View execution", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Execution details" });
  await expect(dialog).toBeVisible();
  const live = dialog.locator(".execution-live");
  await expect(live.getByRole("heading", { name: "Live progress", exact: true })).toBeVisible();
  await expect(live.getByRole("heading", { name: "MARKDOWN_HEADING", exact: true })).toBeVisible();
  await expect(live.locator("pre code")).toContainText("**literal**");

  await fetch(`${app.provider.url}/_release_markdown_stream`, { method: "POST" });
  const work = await waitForWork(app, workId, "succeeded");
  expect(work.answer).toContain("MARKDOWN_HEADING");
  await expect(dialog.locator(".execution-live")).toHaveCount(0);
  await expect(dialog.locator(".work-step.kind-assistant").filter({ hasText: "MARKDOWN_HEADING" })).toHaveCount(1);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

test("a running answer shows only typing in chat while its execution record streams", async ({ app, page }) => {
  test.setTimeout(120_000);
  await openChannel(page, app);
  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill("@Ali");
  await expect(page.getByRole("option", { name: /Alice/ })).toBeVisible();
  await composer.press("Enter");
  await composer.fill("BROWSER_MARKDOWN_STREAM");
  const post = waitForMessagePost(page, app.workspace.channelId);
  await composer.press("Enter");
  const receipt = await (await post).json() as SendReceipt;
  expect(receipt.workIds).toHaveLength(1);
  const workId = receipt.workIds[0]!;
  try {
    // The draft stays editable while the run streams.
    await composer.fill("draft while streaming");
    await expect(composer).toHaveValue("draft while streaming");
    await composer.fill("");

    // A room without live work shows no typing; the channel gets it back.
    await createDirect(page, app.workspace.employeeIds[1]!, "Bob");
    await expect(page.locator(".chat-typing")).toHaveCount(0);
    await revealNavigation(page);
    await page.getByRole("button", { name: "General", exact: true }).click();
    await expect(page.getByRole("heading", { name: /General/ })).toBeVisible();

    await expectStreamingProgress(page, app, workId);

    await revealNavigation(page);
    await page.getByRole("button", { name: "General", exact: true }).click();
    await expect(page.getByRole("heading", { name: /General/ })).toBeVisible();
    await expect(page.locator(".chat-typing")).toHaveCount(0);
    const answer = page.locator(".message.employee .markdown-body").last();
    await expect(answer.getByRole("heading", { name: "MARKDOWN_HEADING", exact: true })).toBeVisible();
    await expect(answer.locator("pre code")).toContainText("**literal**");
    const stored = await roomMessages(app, app.workspace.channelId);
    expect(
      stored.messages.filter((message) => message.author.type === "employee" && message.body.includes("MARKDOWN_HEADING")),
    ).toHaveLength(1);
  } finally {
    await fetch(`${app.provider.url}/_release_markdown_stream`, { method: "POST" }).catch(() => {});
  }
});

test("a direct message shows typing while its run streams and the record carries the progress", async ({ app, page }) => {
  test.setTimeout(120_000);
  await openChannel(page, app);
  const employeeId = app.workspace.employeeIds[0]!;
  await createDirect(page, employeeId);
  const room = (await api<RoomDTO[]>(app, "/api/rooms")).find(
    (entry) => entry.kind === "dm" && entry.employeeId === employeeId,
  );
  expect(room).toBeDefined();
  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill("BROWSER_MARKDOWN_STREAM");
  const post = waitForMessagePost(page, room!.id);
  await composer.press("Enter");
  const receipt = await (await post).json() as SendReceipt;
  expect(receipt.workIds).toHaveLength(1);
  const workId = receipt.workIds[0]!;
  try {
    await expectStreamingProgress(page, app, workId);

    await revealNavigation(page);
    await page.locator(".sidebar-rooms .room-dm").first().click();
    await expect(page.locator(".chat-typing")).toHaveCount(0);
    const answer = page.locator(".message.employee .markdown-body").last();
    await expect(answer.getByRole("heading", { name: "MARKDOWN_HEADING", exact: true })).toBeVisible();
    const stored = await roomMessages(app, room!.id);
    expect(
      stored.messages.filter((message) => message.author.type === "employee" && message.body.includes("MARKDOWN_HEADING")),
    ).toHaveLength(1);
  } finally {
    await fetch(`${app.provider.url}/_release_markdown_stream`, { method: "POST" }).catch(() => {});
  }
});

test("group typing names each running employee once with a second live request", async ({ app, page }) => {
  test.setTimeout(120_000);
  await openChannel(page, app);
  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill("@all");
  await composer.press("Enter");
  await composer.fill("BROWSER_MARKDOWN_STREAM");
  const post = waitForMessagePost(page, app.workspace.channelId);
  await composer.press("Enter");
  const receipt = await (await post).json() as SendReceipt;
  expect(receipt.workIds).toHaveLength(2);
  try {
    await expect.poll(() => gateReady(`${app.provider.url}/_markdown_stream_ready`), { timeout: 30_000 }).toBe(true);

    const typing = page.locator(".chat-typing");
    await expect(typing).toContainText("Alice");
    await expect(typing).toContainText("Bob");
    const names = await typing.innerText();
    expect(names.match(/Alice/g)).toHaveLength(1);
    expect(names.match(/Bob/g)).toHaveLength(1);

    // A second request to Alice is still live behind her running one — the
    // dispatch marks it running before the busy conversation admits its input,
    // so it may never be observable as "queued" — and must not add a second
    // typing entry for the same employee.
    await composer.fill("@Ali");
    await expect(page.getByRole("option", { name: /Alice/ })).toBeVisible();
    await composer.press("Enter");
    await composer.fill("BROWSER_MARKDOWN_STREAM");
    const secondPost = waitForMessagePost(page, app.workspace.channelId);
    await composer.press("Enter");
    const second = await (await secondPost).json() as SendReceipt;
    expect(second.workIds).toHaveLength(1);
    expect(second.workIds[0]).not.toBe(receipt.workIds[0]);
    await expect.poll(async () => {
      const works = await api<WorkDTO[]>(app, "/api/works");
      const queued = works.find((work) => work.id === second.workIds[0]!);
      return queued === undefined ? undefined : ["queued", "running"].includes(queued.status);
    }, { timeout: 30_000 }).toBe(true);
    const afterSecond = await typing.innerText();
    expect(afterSecond.match(/Alice/g)).toHaveLength(1);
    expect(afterSecond.match(/Bob/g)).toHaveLength(1);
  } finally {
    await fetch(`${app.provider.url}/_release_markdown_stream`, { method: "POST" }).catch(() => {});
  }
});

test("waiting for a reply is not typing and the run record shows the wait", async ({ app, page }) => {
  test.setTimeout(120_000);
  const aliceId = app.workspace.employeeIds[0]!;
  // Alice can ask a colleague for a result; the answerer's reply is held by
  // the fake provider until released.
  await api<EmployeeDTO>(app, "/api/employees", "POST", {
    name: "求助应答员工",
    role: "Test assistant",
    executionModel: { model: { providerId: "fake", modelId: "fake-chat" }, effort: "off" },
    toolPolicy: { allowedTools: [], trustedReadOnlyTools: [] },
    generateAddress: true,
  });
  const policy = await app.request(`/api/employees/${aliceId}`, "PATCH", {
    toolPolicy: {
      allowedTools: ["read_file", "write_file", "edit_file", "run_shell", "load_skill", "send_mail"],
      trustedReadOnlyTools: [],
    },
  });
  expect(policy.status).toBe(200);

  await openChannel(page, app);
  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill("@Ali");
  await expect(page.getByRole("option", { name: /Alice/ })).toBeVisible();
  await composer.press("Enter");
  await composer.fill("ASK_BACK_START");
  const post = waitForMessagePost(page, app.workspace.channelId);
  await composer.press("Enter");
  const receipt = await (await post).json() as SendReceipt;
  expect(receipt.workIds).toHaveLength(1);
  const workId = receipt.workIds[0]!;
  try {
    await expect.poll(() => gateReady(`${app.provider.url}/_ask_back_ready`), { timeout: 60_000 }).toBe(true);
    await expect.poll(async () => {
      const works = await api<WorkDTO[]>(app, "/api/works");
      return works.find((work) => work.id === workId)?.status;
    }, { timeout: 60_000 }).toBe("waiting-mail");

    // The parent is not generating, and its mail child belongs to the mailbox:
    // this room shows no typing.
    await expect(page.locator(".chat-typing")).toHaveCount(0);
    await navigateWorkspace(page, "Runs");
    const row = page.getByRole("row").filter({ hasText: "Alice" });
    await expect(row).toContainText("Waiting for reply");

    await fetch(`${app.provider.url}/_release_ask_back`, { method: "POST" });
    const work = await waitForWork(app, workId, "succeeded", 60_000);
    expect(work.answer).toBe("最终答复：回信结果已使用。");
  } finally {
    await fetch(`${app.provider.url}/_release_ask_back`, { method: "POST" }).catch(() => {});
  }
});

test("the composer stays compact until the draft needs more room", async ({ app, page }) => {
  await openChannel(page, app);
  const composerBox = page.locator(".composer");
  const textarea = page.getByRole("textbox", { name: "Message" });
  const boxHeight = async (): Promise<number> => (await composerBox.boundingBox())!.height;
  const textareaHeight = async (): Promise<number> => (await textarea.boundingBox())!.height;

  const rest = await textareaHeight();
  expect(await boxHeight(), "the empty composer stays compact").toBeLessThanOrEqual(160);
  expect(rest).toBeGreaterThanOrEqual(64);
  expect(rest).toBeLessThanOrEqual(80);

  // Focusing an empty draft does not expand the editor.
  await textarea.click();
  expect(await textareaHeight()).toBe(rest);

  // Selecting a recipient never draws an explanation row; the state is only
  // announced through the hidden polite region.
  await page.getByRole("button", { name: "Select reply recipients", exact: true }).click();
  await page.getByRole("option", { name: /Alice/ }).click();
  await expect(page.getByRole("button", { name: "Remove Alice from recipients", exact: true })).toBeVisible();
  const live = page.locator(".composer .visually-hidden");
  await expect(live).toHaveText("Replies: Alice");
  expect((await live.boundingBox())!.height).toBeLessThanOrEqual(2);

  // A long draft grows the textarea up to its cap and scrolls inside it.
  const lines = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n");
  await textarea.fill(lines);
  const grown = await textareaHeight();
  expect(grown).toBeGreaterThan(rest);
  expect(grown).toBeLessThanOrEqual(161);
  expect(await textarea.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);

  // Shortening the draft returns the compact height; so does sending.
  await textarea.fill("short");
  expect(await textareaHeight()).toBeLessThanOrEqual(rest + 1);
  await textarea.fill(lines);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(textarea).toHaveValue("");
  await expect(page.getByRole("button", { name: "Remove Alice from recipients", exact: true })).toHaveCount(0);
  expect(await textareaHeight()).toBeLessThanOrEqual(rest + 1);

  // A failed send keeps the draft, the height, and the retry path.
  let failures = 0;
  await page.route(`**/api/rooms/${app.workspace.channelId}/messages`, async (route) => {
    if (route.request().method() === "POST" && failures === 0) {
      failures += 1;
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ message: "fixture failure" }),
      });
      return;
    }
    await route.continue();
  });
  await textarea.fill(lines);
  const beforeFailure = await textareaHeight();
  await page.getByRole("button", { name: "Post", exact: true }).click();
  await expect.poll(() => failures).toBe(1);
  await expect(page.locator(".banner.error")).toBeVisible();
  await expect(textarea).toHaveValue(lines);
  expect(await textareaHeight()).toBe(beforeFailure);
  await textarea.fill("");
});

test("the reply picker stays inside the viewport and returns focus", async ({ app, page }) => {
  await openChannel(page, app);
  const textarea = page.getByRole("textbox", { name: "Message" });
  const viewport = page.viewportSize()!;
  const lines = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n");
  await textarea.fill(lines);

  // The menu opens above the capped textarea without being clipped by the pane.
  const replyTrigger = page.getByRole("button", { name: "Select reply recipients", exact: true });
  await replyTrigger.click();
  const listbox = page.getByRole("listbox", { name: "Members", exact: true });
  await expect(listbox).toBeVisible();
  const menuBounds = (await listbox.boundingBox())!;
  expect(menuBounds.y).toBeGreaterThanOrEqual(0);
  expect(menuBounds.y + menuBounds.height).toBeLessThanOrEqual(viewport.height + 1);

  // Arrow keys move the active option; Enter picks without touching the draft
  // and without sending.
  let posted = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === `/api/rooms/${app.workspace.channelId}/messages`) {
      posted += 1;
    }
  });
  await textarea.press("ArrowDown");
  await textarea.press("Enter");
  await expect(listbox).toHaveCount(0);
  expect(await textarea.inputValue()).toBe(lines);
  await expect(page.locator(".composer-recipients .chip-toggle")).toHaveCount(1);
  expect(posted).toBe(0);

  // Escape closes the menu and leaves focus in the textarea.
  await replyTrigger.click();
  await expect(listbox).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(listbox).toHaveCount(0);
  await expect(textarea).toBeFocused();
});
