import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page, Response } from "@playwright/test";
import type { ApprovalDTO, MessageDTO, WorkDTO } from "../../src/shared/contracts.ts";
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

async function startHighRisk(page: Page, app: BrowserE2eFixture, fileName: string): Promise<{ workId: string; approval: ApprovalDTO }> {
  await openChannel(page, app);
  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill("@Ali");
  await expect(page.getByRole("option", { name: /Alice/ })).toBeVisible();
  await composer.press("Enter");
  const body = `${await composer.inputValue()}请写一个 ${fileName}`;
  await composer.fill(body);
  const post = waitForMessagePost(page, app.workspace.channelId);
  await composer.press("Enter");
  const response = await post;
  expect(response.status()).toBe(200);
  const receipt = await response.json() as SendReceipt;
  expect(receipt.workIds).toHaveLength(1);
  const workId = receipt.workIds[0]!;
  await expect.poll(async () => {
    const works = await api<WorkDTO[]>(app, "/api/works");
    return works.find((work) => work.id === workId)?.status;
  }, { timeout: 60_000 }).toBe("waiting-approval");
  const approval = await waitForApproval(app, workId, "pending-human");
  expect(approval).toMatchObject({ risk: "high", status: "pending-human", execution: { state: "not-started" } });
  expect(approval.argumentsPreview).toContain(fileName);
  return { workId, approval };
}

async function waitForApproval(app: BrowserE2eFixture, workId: string, status: ApprovalDTO["status"]): Promise<ApprovalDTO> {
  await expect.poll(async () => {
    const payload = await api<{ approvals: ApprovalDTO[] }>(app, "/api/approvals");
    return payload.approvals.find((approval) => approval.workId === workId)?.status;
  }, { timeout: 60_000 }).toBe(status);
  const payload = await api<{ approvals: ApprovalDTO[] }>(app, "/api/approvals");
  const approval = payload.approvals.find((entry) => entry.workId === workId);
  if (approval === undefined) throw new Error(`Approval for ${workId} disappeared after reaching ${status}`);
  return approval;
}

async function waitForWorkStatus(app: BrowserE2eFixture, workId: string, status: WorkDTO["status"]): Promise<WorkDTO> {
  await expect.poll(async () => {
    const works = await api<WorkDTO[]>(app, "/api/works");
    return works.find((work) => work.id === workId)?.status;
  }, { timeout: 60_000 }).toBe(status);
  const works = await api<WorkDTO[]>(app, "/api/works");
  const work = works.find((entry) => entry.id === workId);
  if (work === undefined) throw new Error(`Work ${workId} disappeared after reaching ${status}`);
  return work;
}

async function showPendingApproval(page: Page, fileName: string): Promise<Locator> {
  await navigate(page, "Approvals");
  await expect(page.getByRole("heading", { name: "Approvals", exact: true })).toBeVisible();
  const card = page.getByRole("article").filter({ hasText: fileName });
  await expect(card).toContainText("Waiting for your decision");
  await expect(card).toContainText("Risk assessment: high");
  return card;
}

async function decideInBrowser(
  page: Page,
  card: Locator,
  approvalId: string,
  decision: "Approve" | "Reject",
  comment: string,
): Promise<ApprovalDTO> {
  await card.getByRole("textbox", { name: "Comment (recorded with the decision)" }).fill(comment);
  const responsePromise = page.waitForResponse((response) => {
    const request = response.request();
    return request.method() === "POST" && new URL(response.url()).pathname === `/api/approvals/${approvalId}/decision`;
  });
  await card.getByRole("button", { name: decision, exact: true }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  return response.json() as Promise<ApprovalDTO>;
}

test("approving a high-risk file write through the browser performs the real write", async ({ app, page }) => {
  test.setTimeout(90_000);
  const fileName = "critical-settings.json";
  const { workId, approval } = await startHighRisk(page, app, fileName);
  expect(existsSync(join(app.workRoot, fileName))).toBe(false);

  const card = await showPendingApproval(page, fileName);
  const decision = await decideInBrowser(page, card, approval.id, "Approve", "Reviewed the target in this work context.");
  expect(decision.status).toBe("approved");
  const work = await waitForWorkStatus(app, workId, "succeeded");
  expect(work).toMatchObject({ roomId: app.workspace.channelId, workContextId: app.workspace.workContextId });
  expect(readFileSync(join(app.workRoot, fileName), "utf8")).toBe("SMOKE-CRITICAL-CONTENT\n");
  const settled = await waitForApproval(app, workId, "approved");
  expect(settled).toMatchObject({
    decidedBy: "user",
    comment: "Reviewed the target in this work context.",
    execution: { state: "succeeded" },
  });
});

test("rejecting a high-risk file write leaves its target untouched", async ({ app, page }) => {
  test.setTimeout(90_000);
  const fileName = "critical-settings.json";
  const { workId, approval } = await startHighRisk(page, app, fileName);
  expect(existsSync(join(app.workRoot, fileName))).toBe(false);

  const card = await showPendingApproval(page, fileName);
  const decision = await decideInBrowser(page, card, approval.id, "Reject", "Do not create this file.");
  expect(decision.status).toBe("rejected");
  await expect.poll(async () => {
    const works = await api<WorkDTO[]>(app, "/api/works");
    const work = works.find((entry) => entry.id === workId);
    return work !== undefined && ["succeeded", "failed", "stopped"].includes(work.status);
  }, { timeout: 60_000 }).toBe(true);
  const settled = await waitForApproval(app, workId, "rejected");
  expect(settled).toMatchObject({ decidedBy: "user", comment: "Do not create this file.", execution: { state: "not-started" } });
  expect(existsSync(join(app.workRoot, fileName))).toBe(false);
});

test("stopping a high-risk run while it waits for approval cancels it before any file effect", async ({ app, page }) => {
  test.setTimeout(90_000);
  const fileName = "critical-settings.json";
  const { workId } = await startHighRisk(page, app, fileName);
  expect(existsSync(join(app.workRoot, fileName))).toBe(false);
  const stop = page.getByRole("button", { name: "Stop", exact: true });
  await expect(stop).toBeVisible();
  await stop.click();

  await waitForWorkStatus(app, workId, "stopped");
  const cancelled = await waitForApproval(app, workId, "cancelled");
  expect(cancelled).toMatchObject({ execution: { state: "not-started" } });
  expect(existsSync(join(app.workRoot, fileName))).toBe(false);
});
