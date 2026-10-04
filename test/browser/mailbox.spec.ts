import type { Page } from "@playwright/test";
import type { MailboxItemDTO, MessageDTO } from "../../src/shared/contracts.ts";
import { expect, onboarded, test, type BrowserE2eFixture } from "./fixtures.ts";

async function openMailbox(page: Page, app: BrowserE2eFixture): Promise<void> {
  await onboarded(page, app);
  const openNavigation = page.getByRole("button", { name: "Open navigation" });
  if (await openNavigation.isVisible()) await openNavigation.click();
  await page.getByRole("button", { name: "Mailbox" }).click();
  await expect(page.getByRole("heading", { name: "Mailbox" })).toBeVisible();
}

async function selectFolder(page: Page, folder: "sent" | "drafts"): Promise<void> {
  const folderSelect = page.getByLabel("Folder").first();
  if (await folderSelect.isVisible()) {
    await folderSelect.selectOption(folder);
    return;
  }
  await page.getByRole("button", { name: folder === "sent" ? "Sent" : "Drafts", exact: true }).click();
}

test("editing and sending a draft retires each immutable entry", async ({ app, page }) => {
  await openMailbox(page, app);
  const originalSubject = "Browser draft before edit";
  const originalBody = "The first saved version stays separate.";
  const editedSubject = "Browser draft after edit";
  const editedBody = "The replacement is a new entry and this is the version sent.";

  await page.getByRole("button", { name: "Compose" }).click();
  await page.getByLabel("Subject").fill(originalSubject);
  await page.getByLabel("Body").fill(originalBody);
  // Do not wake an employee: this browser flow is about the user-owned draft lifecycle.
  await page.getByRole("button", { name: "Alice", exact: true }).click();
  await page.getByRole("button", { name: "Save as draft" }).click();

  const originalRow = page.locator(".mail-row").filter({ hasText: originalSubject });
  await expect(originalRow).toHaveCount(1);
  const firstDraftResponse = await app.request<{ items: MailboxItemDTO[] }>("/api/mail");
  expect(firstDraftResponse.status).toBe(200);
  const firstDraft = firstDraftResponse.body.items.find(
    (item) => item.message.author.type === "user" && item.message.mail?.subject === originalSubject,
  );
  expect(firstDraft?.message).toMatchObject({ body: originalBody, mail: { draft: true, sent: false } });
  expect(firstDraft).toBeDefined();

  await originalRow.getByRole("button", { name: "Edit draft" }).click();
  await page.getByLabel("Subject").fill(editedSubject);
  await page.getByLabel("Body").fill(editedBody);
  await page.getByRole("button", { name: "Save draft" }).click();

  const editedRow = page.locator(".mail-row").filter({ hasText: editedSubject });
  await expect(editedRow).toHaveCount(1);
  const editedDraftResponse = await app.request<{ items: MailboxItemDTO[] }>("/api/mail");
  expect(editedDraftResponse.status).toBe(200);
  expect(editedDraftResponse.body.items.some((item) => item.message.id === firstDraft!.message.id)).toBe(false);
  const editedDraft = editedDraftResponse.body.items.find(
    (item) => item.roomId === firstDraft!.roomId && item.message.mail?.subject === editedSubject,
  );
  expect(editedDraft?.message).toMatchObject({ body: editedBody, mail: { draft: true, sent: false } });
  expect(editedDraft).toBeDefined();
  expect(editedDraft!.message.id).not.toBe(firstDraft!.message.id);

  await editedRow.getByRole("button", { name: "Send draft" }).click();
  await selectFolder(page, "sent");
  const sentRow = page.locator(".mail-row").filter({ hasText: editedSubject });
  await expect(sentRow).toHaveCount(1);

  const sentMailboxResponse = await app.request<{ items: MailboxItemDTO[] }>("/api/mail");
  expect(sentMailboxResponse.status).toBe(200);
  expect(sentMailboxResponse.body.items.some((item) => item.message.id === firstDraft!.message.id)).toBe(false);
  expect(sentMailboxResponse.body.items.some((item) => item.message.id === editedDraft!.message.id)).toBe(false);
  const sent = sentMailboxResponse.body.items.find(
    (item) => item.roomId === firstDraft!.roomId && item.message.author.type === "user" && item.message.mail?.subject === editedSubject && item.message.mail.sent,
  );
  expect(sent?.message).toMatchObject({ body: editedBody, mail: { draft: false, sent: true } });
  expect(sent).toBeDefined();
  expect(sent!.message.id).not.toBe(editedDraft!.message.id);

  await selectFolder(page, "drafts");
  await expect(page.locator(".mail-row")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "This folder is empty" })).toBeVisible();
});

test("a mail thread shows its latest 200 entries in chronological history order", async ({ app, page }) => {
  const history = Array.from({ length: 201 }, (_, index) => `Browser mailbox history entry ${String(index + 1).padStart(3, "0")}`);
  for (const [index, body] of history.entries()) {
    const response = await app.request<{ message: MessageDTO; workIds: string[] }>(
      `/api/rooms/${app.workspace.mailRoomId}/mail-send`,
      "POST",
      { body, subject: "Browser mailbox history", to: [] },
    );
    expect(response.status, `saving history entry ${index + 1}`).toBe(200);
    expect(response.body.message.body).toBe(body);
    expect(response.body.workIds).toEqual([]);
  }

  await openMailbox(page, app);
  await selectFolder(page, "sent");
  const historyRow = page.locator(".mail-row").filter({ hasText: "Browser mailbox history" });
  await expect(historyRow).toHaveCount(1);
  await expect(historyRow.locator(".who .hint")).toHaveText("200");
  await historyRow.locator(".mail-row-open").click();

  const visibleHistory = page.locator(".mail-message .content");
  await expect(visibleHistory).toHaveCount(200);
  await expect(visibleHistory.first()).toHaveText("Browser mailbox history entry 002");
  await expect(visibleHistory.last()).toHaveText("Browser mailbox history entry 201");
  await expect(visibleHistory.filter({ hasText: "Browser mailbox history entry 001" })).toHaveCount(0);
});
