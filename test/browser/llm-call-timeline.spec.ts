import type { LlmCallPageDTO, WorkDTO } from "../../src/shared/contracts.ts";
import { expect, navigateWorkspace, onboarded, test, type BrowserE2eFixture } from "./fixtures.ts";

async function waitForWork(app: BrowserE2eFixture, workId: string, status: WorkDTO["status"]): Promise<void> {
  await expect.poll(async () => {
    const response = await app.request<WorkDTO[]>("/api/works");
    return response.body.find((work) => work.id === workId)?.status;
  }, { timeout: 45_000 }).toBe(status);
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
