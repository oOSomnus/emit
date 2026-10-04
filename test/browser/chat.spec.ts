import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page, Response } from "@playwright/test";
import type { AppConfigDTO, MessageDTO, RoomDTO, WorkDTO, WorkExecutionDTO } from "../../src/shared/contracts.ts";
import { expect, onboarded, test, type BrowserE2eFixture } from "./fixtures.ts";

type SendReceipt = { message: MessageDTO; workIds: string[] };

async function api<T>(app: BrowserE2eFixture, path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await app.request<T>(path, method, body);
  expect(response.status, `${method} ${path}: ${JSON.stringify(response.body)}`).toBe(200);
  return response.body;
}

async function revealNavigation(page: Page): Promise<void> {
  const open = page.getByRole("button", { name: "Open navigation", exact: true });
  if (await open.isVisible()) await open.click();
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
  expect(addressedDraft).toMatch(/^@[^\s]+\s$/u);
  await expect(page.getByText("Visible to everyone; replies: Alice", { exact: true })).toBeVisible();
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
