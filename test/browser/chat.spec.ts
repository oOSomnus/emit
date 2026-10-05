import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page, Response } from "@playwright/test";
import type { AppConfigDTO, BootstrapDTO, MessageDTO, RoomDTO, WorkDTO, WorkExecutionDTO } from "../../src/shared/contracts.ts";
import { expect, onboarded, test, type BrowserE2eFixture } from "./fixtures.ts";

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

async function navigate(page: Page, label: string): Promise<void> {
  await revealNavigation(page);
  await page.getByRole("button", { name: label, exact: false }).click();
}

function waitForMessagePost(page: Page, roomId: string): Promise<Response> {
  return page.waitForResponse((response) => {
    const request = response.request();
    return request.method() === "POST" && new URL(response.url()).pathname === `/api/rooms/${roomId}/messages`;
  });
}

async function createDirect(page: Page, employeeId: string): Promise<void> {
  await revealNavigation(page);
  await page.getByRole("button", { name: "Start a direct message", exact: true }).click();
  await page.getByRole("combobox", { name: "Start a direct message", exact: true }).selectOption(employeeId);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Alice", exact: true })).toBeVisible();
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

test("public chat distinguishes ordinary text from an @mention wake without duplicate sends", async ({ app, page }) => {
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
  await page.getByRole("button", { name: "Send", exact: true }).click();
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
  // Enter accepts the member suggestion. It must not also send the message.
  await composer.press("Enter");
  const addressedDraft = await composer.inputValue();
  expect(postedMessages).toBe(1);
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
  const employeeId = app.workspace.employeeIds[0]!;
  await createDirect(page, employeeId);
  await expect(page.getByText("Work: Test Workspace", { exact: true })).toBeVisible();

  const directRooms = await api<RoomDTO[]>(app, "/api/rooms");
  const directRoom = directRooms.find((room) => room.kind === "dm" && room.employeeId === employeeId);
  expect(directRoom).toBeDefined();
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

test("execution details load an earlier page of real tool history without duplicate steps", async ({ app, page }) => {
  test.setTimeout(120_000);
  await openChannel(page, app);
  await navigate(page, "Settings");
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

  await navigate(page, "Runs");
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

test("a channel message wakes exactly the employees mentioned in its text", async ({ app, page }) => {
  await openChannel(page, app);
  const aliceId = app.workspace.employeeIds[0]!;
  const composer = page.getByRole("textbox", { name: "Message" });
  let posted = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === `/api/rooms/${app.workspace.channelId}/messages`) {
      posted += 1;
    }
  });

  // @all is plain text: deleting it before sending removes the wake.
  await composer.fill("@all");
  await expect(page.getByRole("option", { name: "Everyone", exact: true })).toBeVisible();
  await composer.press("Enter");
  expect(await composer.inputValue()).toBe("@all ");
  expect(posted).toBe(0);
  await composer.fill("ordinary after deleting mentions");
  const plainPost = waitForMessagePost(page, app.workspace.channelId);
  await composer.press("Enter");
  const plainReceipt = await (await plainPost).json() as SendReceipt;
  expect(plainReceipt).toMatchObject({
    workIds: [],
    message: { addressing: { recipientIds: [], mentionAll: false } },
  });
  expect(posted).toBe(1);

  // The trigger inserts text without posting; sending it wakes Alice only.
  await page.getByRole("button", { name: "Mention a member", exact: true }).click();
  await expect(page.getByRole("listbox", { name: "Members", exact: true })).toBeVisible();
  await page.getByRole("option", { name: /Alice/ }).click();
  expect(await composer.inputValue()).toBe("@Alice ");
  expect(posted).toBe(1);
  await composer.fill(`${await composer.inputValue()}please read notes.txt`);
  const alicePost = waitForMessagePost(page, app.workspace.channelId);
  await composer.press("Enter");
  const aliceReceipt = await (await alicePost).json() as SendReceipt;
  expect(aliceReceipt.workIds).toHaveLength(1);
  expect(aliceReceipt.message).toMatchObject({ addressing: { recipientIds: [aliceId], mentionAll: false } });
  const aliceWork = await waitForWork(app, aliceReceipt.workIds[0]!, "succeeded");
  expect(aliceWork.employeeId).toBe(aliceId);
  expect(posted).toBe(2);

  // Deleting the mention removes the wake again.
  await composer.fill("notes handled without a mention");
  const deletedPost = waitForMessagePost(page, app.workspace.channelId);
  await composer.press("Enter");
  const deletedReceipt = await (await deletedPost).json() as SendReceipt;
  expect(deletedReceipt).toMatchObject({
    workIds: [],
    message: { addressing: { recipientIds: [], mentionAll: false } },
  });
  expect(posted).toBe(3);

  // Escape closes the menu and keeps the text; Shift+Enter inserts a newline.
  await composer.fill("@Ali");
  await expect(page.getByRole("option", { name: /Alice/ })).toBeVisible();
  await composer.press("Escape");
  await expect(page.getByRole("listbox", { name: "Members", exact: true })).toHaveCount(0);
  expect(await composer.inputValue()).toBe("@Ali");
  await composer.press("Shift+Enter");
  expect(await composer.inputValue()).toBe("@Ali\n");
  expect(posted).toBe(3);

  // Switching rooms drops the draft and the menu state with it.
  await composer.fill("@Ali");
  await expect(page.getByRole("option", { name: /Alice/ })).toBeVisible();
  await createDirect(page, aliceId);
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("");
  await revealNavigation(page);
  await page.getByRole("button", { name: "General", exact: true }).click();
  await expect(page.getByRole("heading", { name: /General/ })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("");
  await expect(page.getByRole("listbox", { name: "Members", exact: true })).toHaveCount(0);
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

  // Clicking @all inserts the text without posting.
  await page.locator("#address-suggestion-all").click();
  expect(await composer.inputValue()).toBe("@all ");
  expect(posted).toBe(0);

  // The keyboard path inserts the same text without posting.
  await composer.fill("@all");
  await composer.press("Enter");
  expect(await composer.inputValue()).toBe("@all ");
  expect(posted).toBe(0);

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
  await composer.fill("@Alice BROWSER_MARKDOWN");
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

test("live Markdown progress renders before the answer completes", async ({ app, page }) => {
  test.setTimeout(120_000);
  await openChannel(page, app);
  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill("@Alice BROWSER_MARKDOWN_STREAM");
  const post = waitForMessagePost(page, app.workspace.channelId);
  await composer.press("Enter");
  const receipt = await (await post).json() as SendReceipt;
  expect(receipt.workIds).toHaveLength(1);
  const workId = receipt.workIds[0]!;
  try {
    await expect.poll(async () => {
      const ready = await fetch(`${app.provider.url}/_markdown_stream_ready`);
      return ((await ready.json()) as { ready: boolean }).ready;
    }, { timeout: 30_000 }).toBe(true);
    const live = page.locator(".work-live .markdown-body");
    await expect(live.getByRole("heading", { name: "MARKDOWN_HEADING", exact: true })).toBeVisible();
    await expect(live.locator("pre code")).toContainText("**literal**");
    await fetch(`${app.provider.url}/_release_markdown_stream`, { method: "POST" });
    const work = await waitForWork(app, workId, "succeeded");
    expect(work.answer).toContain("MARKDOWN_HEADING");
    await expect(
      page.locator(".message.employee .markdown-body").last().getByRole("heading", { name: "MARKDOWN_HEADING", exact: true }),
    ).toBeVisible();
  } finally {
    await fetch(`${app.provider.url}/_release_markdown_stream`, { method: "POST" }).catch(() => {});
  }
});
