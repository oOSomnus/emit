import type { Locator, Page } from "@playwright/test";
import type { LlmCallDetailDTO, LlmCallPageDTO, LlmCallSummaryDTO, WorkDTO } from "../../src/shared/contracts.ts";
import { startLoopbackProxy, type LoopbackProxy } from "../helpers/loopback-proxy.ts";
import { expect, navigateWorkspace, onboarded, test, type BrowserE2eFixture } from "./fixtures.ts";

async function waitForWork(app: BrowserE2eFixture, workId: string, status: WorkDTO["status"]): Promise<void> {
  await expect.poll(async () => {
    const response = await app.request<WorkDTO[]>("/api/works");
    return response.body.find((work) => work.id === workId)?.status;
  }, { timeout: 45_000 }).toBe(status);
}

function summary(workId: string, employeeId: string, sequence: number, revision = 1): LlmCallSummaryDTO {
  return {
    id: `call-${sequence}`,
    workId,
    sequence,
    revision,
    kind: "employee",
    employeeId,
    model: { providerId: "fixture", modelId: "fake-chat" },
    startedAt: sequence,
    status: "returned",
    reasoning: "",
    inputBytes: 1,
    messageCount: 0,
    toolCount: 0,
    redactionApplied: true,
    captureBoundary: "models-sdk",
  };
}

async function createCompletedWork(app: BrowserE2eFixture): Promise<{ workId: string; employeeId: string }> {
  const employeeId = app.workspace.employeeIds[0];
  if (employeeId === undefined) throw new Error("The seeded workspace has no employee");
  const sent = await app.request<{ workIds: string[] }>(`/api/rooms/${app.workspace.channelId}/messages`, "POST", {
    body: "LLM timeline regression task",
    recipientIds: [employeeId],
  });
  expect(sent.status).toBe(200);
  const workId = sent.body.workIds[0];
  if (workId === undefined) throw new Error("The regression task did not create work");
  await waitForWork(app, workId, "succeeded");
  return { workId, employeeId };
}

function callPage(items: LlmCallSummaryDTO[], nextCursor?: string): LlmCallPageDTO {
  return {
    items,
    ...(nextCursor !== undefined ? { nextCursor } : {}),
    captureHealth: { failedCount: 0, accepting: true },
  };
}

function callDetail(call: LlmCallSummaryDTO): LlmCallDetailDTO {
  return {
    ...call,
    input: { systemUpdates: [], messages: [], tools: [] },
    responses: [],
    omitted: [],
  };
}

type PaginationRouteControl = {
  setFailureCount(value: number): void;
  holdOlderPage(): void;
  olderPageRequested: Promise<void>;
  releaseOlderPage(): void;
};

async function installPaginationRoutes(page: Page, workId: string, employeeId: string): Promise<PaginationRouteControl> {
  const calls = Array.from({ length: 51 }, (_, index) => summary(workId, employeeId, index + 1));
  const callsById = new Map(calls.map((call) => [call.id, call]));
  const latest = calls.slice(1).reverse();
  const oldest = calls[0]!;
  const cursor = Buffer.from(JSON.stringify({ beforeSequence: 2 }), "utf8").toString("base64url");
  const listPath = `/api/works/${workId}/llm-calls`;
  let failureCount = 0;
  let holdOlder = false;
  let releaseOlder!: () => void;
  const olderGate = new Promise<void>((resolve) => { releaseOlder = resolve; });
  let notifyOlderRequested!: () => void;
  const olderPageRequested = new Promise<void>((resolve) => { notifyOlderRequested = resolve; });

  await page.route((url) => url.pathname === listPath, async (route) => {
    const requestCursor = new URL(route.request().url()).searchParams.get("cursor");
    if (requestCursor !== null) {
      if (requestCursor !== cursor) {
        await route.fulfill({ status: 400 });
        return;
      }
      const responseFailureCount = failureCount;
      notifyOlderRequested();
      if (holdOlder) await olderGate;
      await route.fulfill({
        json: { items: [oldest], captureHealth: { failedCount: responseFailureCount, accepting: true } },
      });
      return;
    }
    await route.fulfill({
      json: { items: latest, nextCursor: cursor, captureHealth: { failedCount: failureCount, accepting: true } },
    });
  });
  await page.route((url) => url.pathname.startsWith(`${listPath}/`), async (route) => {
    const callId = new URL(route.request().url()).pathname.slice(`${listPath}/`.length);
    const call = callsById.get(callId);
    if (call === undefined) {
      await route.fulfill({ status: 404 });
      return;
    }
    await route.fulfill({ json: callDetail(call) });
  });

  return {
    setFailureCount(value) { failureCount = value; },
    holdOlderPage() { holdOlder = true; },
    olderPageRequested,
    releaseOlderPage() { releaseOlder(); },
  };
}

async function openTimelineThroughProxy(
  app: BrowserE2eFixture,
  page: Page,
  proxy: LoopbackProxy,
): Promise<{ dialog: Locator; timeline: Locator }> {
  await onboarded(page, app);
  const eventsOpened = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/events" && response.status() === 200;
  });
  await page.goto(proxy.url);
  await eventsOpened;
  await expect(page.getByRole("button", { name: "General", exact: true })).toBeAttached();
  await navigateWorkspace(page, "Runs");
  const row = page.getByRole("row").filter({ hasText: "Alice" });
  await expect(row).toHaveCount(1);
  await row.getByRole("button", { name: "View execution", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Execution details" });
  await dialog.getByRole("button", { name: "LLM calls", exact: true }).click();
  const timeline = dialog.getByRole("region", { name: "LLM invocation timeline" });
  await expect(timeline).toBeVisible();
  return { dialog, timeline };
}

async function markdownStreamReady(app: BrowserE2eFixture): Promise<boolean> {
  const response = await fetch(`${app.provider.url}/_markdown_stream_ready`);
  const payload: unknown = await response.json();
  return typeof payload === "object" && payload !== null && "ready" in payload && payload.ready === true;
}

test("execution details visualize a running LLM request and its returned response", async ({ app, page }) => {
  test.setTimeout(120_000);
  await onboarded(page, app);
  const employeeId = app.workspace.employeeIds[0];
  if (employeeId === undefined) throw new Error("The seeded workspace has no employee");

  const sent = await app.request<{ workIds: string[] }>(`/api/rooms/${app.workspace.channelId}/messages`, "POST", {
    body: "BROWSER_MARKDOWN_STREAM LLM_TIMELINE_INPUT_CANARY",
    recipientIds: [employeeId],
  });
  expect(sent.status).toBe(200);
  const workId = sent.body.workIds[0];
  if (workId === undefined) throw new Error("The timeline fixture did not create work");

  try {
    await expect.poll(() => markdownStreamReady(app), { timeout: 30_000 }).toBe(true);
    await navigateWorkspace(page, "Runs");
    const row = page.getByRole("row").filter({ hasText: "Alice" });
    await expect(row).toHaveCount(1);
    await row.getByRole("button", { name: "View execution", exact: true }).click();

    const dialog = page.getByRole("dialog", { name: "Execution details" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "LLM calls", exact: true }).click();
    const timeline = dialog.getByRole("region", { name: "LLM invocation timeline" });
    await expect(timeline).toBeVisible();

    const callPage = await app.request<LlmCallPageDTO>(`/api/works/${workId}/llm-calls`);
    expect(callPage.status).toBe(200);
    const runningCall = callPage.body.items.find((call) => call.status === "running");
    expect(runningCall).toBeDefined();
    if (runningCall === undefined) throw new Error("The gated model invocation was not indexed");
    const entry = timeline.locator(".llm-timeline-entry").filter({ hasText: "Employee model call" });
    await expect(entry).toHaveCount(1);
    await expect(entry).toContainText("Running");
    await expect(dialog.locator(".llm-input-panel > h3")).toHaveText("Input");
    await expect(dialog.locator(".llm-input-panel .llm-message-card")).toContainText("LLM_TIMELINE_INPUT_CANARY");
    await expect(dialog.locator(".llm-input-panel")).toContainText("System instructions");
    await expect(dialog.locator(".llm-input-panel")).toContainText("Available tool definitions");
    await expect(dialog.locator(".llm-output-panel > h3")).toHaveText("Output");
    await expect(dialog.locator(".llm-output-panel")).toContainText("The model has not returned a response yet.");
    const metadata = dialog.locator(".llm-call-expanded > .llm-category").first();
    await metadata.locator("summary").click();
    await expect(metadata).toContainText(runningCall.id);

    await fetch(`${app.provider.url}/_release_markdown_stream`, { method: "POST" });
    await waitForWork(app, workId, "succeeded");
    await expect(entry).toContainText("Returned");
    await expect(dialog.locator(".llm-output-panel")).toContainText("MARKDOWN_HEADING");
    await expect(dialog.locator(".llm-output-panel")).toContainText("MARKDOWN_BOLD");
    await expect(dialog.locator(".llm-output-panel .llm-response-card")).toHaveCount(1);
  } finally {
    await fetch(`${app.provider.url}/_release_markdown_stream`, { method: "POST" }).catch(() => {});
  }
});

test("a call detail newer than its summary renders without refetching", async ({ app, page }) => {
  const { workId, employeeId } = await createCompletedWork(app);
  const current = summary(workId, employeeId, 1);
  const detail: LlmCallDetailDTO = {
    ...current,
    revision: 2,
    input: { systemUpdates: [], messages: [], tools: [] },
    responses: [{
      receivedAt: 2,
      source: "request",
      type: "response",
      stopReason: "stop",
      content: [{ type: "text", text: "LLM_DETAIL_REVISION_CANARY" }],
    }],
    omitted: [],
  };
  let detailRequests = 0;
  await page.route((url) => url.pathname === `/api/works/${workId}/llm-calls`, (route) =>
    route.fulfill({ json: callPage([current]) }),
  );
  await page.route((url) => url.pathname === `/api/works/${workId}/llm-calls/${current.id}`, async (route) => {
    detailRequests += 1;
    await route.fulfill({ json: detail });
  });

  await onboarded(page, app);
  await navigateWorkspace(page, "Runs");
  const row = page.getByRole("row").filter({ hasText: "Alice" });
  await row.getByRole("button", { name: "View execution", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Execution details" });
  await dialog.getByRole("button", { name: "LLM calls", exact: true }).click();

  const output = dialog.locator(".llm-output-panel");
  await expect(output).toContainText("LLM_DETAIL_REVISION_CANARY");
  await page.waitForTimeout(300);
  expect(detailRequests).toBe(1);
});

test("a refresh after earlier pages load keeps the oldest cursor", async ({ app, page }) => {
  const { workId, employeeId } = await createCompletedWork(app);
  const proxy = await startLoopbackProxy(app.emit.url);
  app.allowOrigin(proxy.url);
  const routes = await installPaginationRoutes(page, workId, employeeId);

  try {
    const { timeline } = await openTimelineThroughProxy(app, page, proxy);
    const entries = timeline.locator(".llm-timeline-entry");
    await expect(entries).toHaveCount(50);
    await expect(timeline.locator(".llm-load-older")).toBeVisible();
    await timeline.locator(".llm-load-older").click();
    await expect(entries).toHaveCount(51);
    const oldestEntry = entries.first();
    const latestEntry = entries.last();
    await oldestEntry.locator(".llm-timeline-trigger").click();
    await expect(oldestEntry.locator(".llm-call-detail")).toBeVisible();
    await expect(timeline.locator(".llm-load-older")).toHaveCount(0);

    routes.setFailureCount(2);
    proxy.pauseEvents();
    await expect(timeline.locator(".llm-capture-health")).toContainText("2 capture failures");
    await expect(entries).toHaveCount(51);
    await expect(timeline.locator(".llm-load-older")).toHaveCount(0);
    await expect(oldestEntry.locator(".llm-call-detail")).toBeVisible();
    await expect(latestEntry.locator(".llm-call-detail")).toBeVisible();
  } finally {
    await proxy.close();
  }
});

test("a refresh does not discard an earlier page already in flight", async ({ app, page }) => {
  const { workId, employeeId } = await createCompletedWork(app);
  const proxy = await startLoopbackProxy(app.emit.url);
  app.allowOrigin(proxy.url);
  const routes = await installPaginationRoutes(page, workId, employeeId);
  routes.holdOlderPage();

  try {
    const { timeline } = await openTimelineThroughProxy(app, page, proxy);
    const entries = timeline.locator(".llm-timeline-entry");
    await expect(entries).toHaveCount(50);
    await expect(timeline.locator(".llm-load-older")).toBeVisible();
    await timeline.locator(".llm-load-older").click();
    await routes.olderPageRequested;

    routes.setFailureCount(2);
    proxy.pauseEvents();
    await expect(timeline.locator(".llm-capture-health")).toContainText("2 capture failures");
    routes.releaseOlderPage();

    await expect(entries).toHaveCount(51);
    await expect(timeline.locator(".llm-capture-health")).toContainText("2 capture failures");
    const oldestEntry = entries.first();
    const latestEntry = entries.last();
    await expect(oldestEntry.locator(".llm-call-sequence")).toHaveText("01");
    await expect(timeline.locator(".llm-load-older")).toHaveCount(0);
    await expect(latestEntry.locator(".llm-call-detail")).toBeVisible();
    await oldestEntry.locator(".llm-timeline-trigger").click();
    await expect(oldestEntry.locator(".llm-call-detail")).toBeVisible();
  } finally {
    routes.releaseOlderPage();
    await proxy.close();
  }
});
