import type { WorkContextDTO, WorkNoteDTO } from "../../src/shared/contracts.ts";
import { type Page } from "@playwright/test";
import { expect, navigateWorkspace, onboarded, test, type BrowserE2eFixture } from "./fixtures.ts";

async function api<T>(app: BrowserE2eFixture, path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await app.request<T>(path, method, body);
  expect(response.status, `${method} ${path}: ${JSON.stringify(response.body)}`).toBe(200);
  return response.body;
}

async function createAndWaitForNote(
  page: Page,
  app: BrowserE2eFixture,
  workContextId: string,
  title: string,
  body: string,
): Promise<WorkContextDTO> {
  await page.getByRole("button", { name: "New note", exact: true }).click();
  await page.getByLabel("Note title", { exact: true }).fill(title);
  await page.getByRole("textbox", { name: "Note body", exact: true }).fill(body);
  await page.getByRole("button", { name: "Save note", exact: true }).click();
  await expect.poll(async () => {
    const updated = await api<WorkContextDTO>(app, `/api/work-contexts/${workContextId}`);
    return updated.notes.find((note) => note.title === title)?.id;
  }).toBeDefined();
  return api<WorkContextDTO>(app, `/api/work-contexts/${workContextId}`);
}


test("work page keeps a narrow list beside the wide editable content", async ({ app, page }) => {
  await api<WorkContextDTO>(app, "/api/work-contexts", "POST", {
    name: "Research",
    goal: "Compare sources",
    instructions: "Keep citations",
  });
  await onboarded(page, app);

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1280, height: 660 },
  ]) {
    await page.setViewportSize(viewport);
    await navigateWorkspace(page, "Work");
    await page.locator(".work-context-list").getByRole("button", { name: /Research/ }).click();

    const listWidth = await page.locator(".work-context-list").evaluate((element) => element.getBoundingClientRect().width);
    const content = page.locator(".work-context-content");
    const contentWidth = await content.evaluate((element) => element.getBoundingClientRect().width);
    expect(listWidth).toBeLessThan((listWidth + contentWidth) * 0.3);
    expect(contentWidth).toBeGreaterThanOrEqual(listWidth * 2);

    await expect(content.getByLabel("Name", { exact: true })).toHaveValue("Research");
    await expect(content.getByRole("textbox", { name: "Goal", exact: true })).toBeAttached();
  }
});

test("compact work picker on narrow viewports", async ({ app, page }) => {
  const research = await api<WorkContextDTO>(app, "/api/work-contexts", "POST", {
    name: "Research",
    goal: "Compare sources",
    instructions: "Keep citations",
  });
  await onboarded(page, app);

  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1024, height: 768 },
  ]) {
    await page.setViewportSize(viewport);
    await navigateWorkspace(page, "Work");

    const workList = page.locator(".work-context-list");
    const picker = page.getByLabel("Select work", { exact: true });
    await expect(workList).toBeHidden();
    await page.locator(".work-context-content").evaluate((element) => {
      element.scrollTop = 0;
    });
    await expect(picker).toBeVisible();
    await expect(picker).toBeInViewport();
    await picker.selectOption(research.id);

    const name = page.getByLabel("Name", { exact: true });
    const goal = page.getByRole("textbox", { name: "Goal", exact: true });
    await expect(name).toHaveValue("Research");
    await expect(name).toBeInViewport();
    await expect(goal).toBeInViewport();
    const nextGoal = `Compare sources at ${viewport.width}px`;
    await goal.fill(nextGoal);
    await page.getByRole("button", { name: "Save work", exact: true }).click();

    await expect.poll(async () => {
      const works = await api<{ workContexts: WorkContextDTO[] }>(app, "/api/work-contexts");
      return works.workContexts.find((work) => work.id === research.id)?.goal;
    }).toBe(nextGoal);
    const savedWorks = await api<{ workContexts: WorkContextDTO[] }>(app, "/api/work-contexts");
    expect(savedWorks.workContexts.find((work) => work.name === "Research")).toMatchObject({
      id: research.id,
      goal: nextGoal,
    });
    await expect(name).toHaveValue("Research");

    const activeWorkId = await picker.inputValue();
    expect(activeWorkId).toBe(research.id);
    await page.locator(".pane-header").getByRole("button", { name: "New work", exact: true }).click();
    await expect(picker).toHaveValue("");
    await expect(picker.locator("option:checked")).toHaveText("New work");
    await expect(picker.locator("option:checked")).not.toHaveText("Research");
    await page.locator(".work-context-content").getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(picker).toHaveValue(activeWorkId);
  }
});

test("work drafts and notes survive concurrent server changes", async ({ app, page }) => {
  const research = await api<WorkContextDTO>(app, "/api/work-contexts", "POST", {
    name: "Research",
    goal: "Compare sources",
    instructions: "Keep citations",
  });
  await onboarded(page, app);
  await page.setViewportSize({ width: 1440, height: 900 });
  await navigateWorkspace(page, "Work");
  await page.locator(".work-context-list").getByRole("button", { name: /Research/ }).click();

  const goal = page.getByRole("textbox", { name: "Goal", exact: true });
  await goal.fill("Unsaved goal");
  const otherWork = await api<WorkContextDTO>(app, `/api/work-contexts/${app.workspace.workContextId}`);
  await api<WorkContextDTO>(app, `/api/work-contexts/${app.workspace.workContextId}`, "PATCH", {
    name: "Test Workspace renamed",
    expectedVersion: otherWork.version,
  });
  await expect(page.locator(".work-context-list").getByText("Test Workspace renamed", { exact: true })).toBeVisible();
  await expect(goal).toHaveValue("Unsaved goal");

  const researchWithNote = await createAndWaitForNote(page, app, research.id, "Evidence", "Source A supports the claim.");
  const evidence = researchWithNote.notes.find((note) => note.title === "Evidence");
  expect(evidence).toBeDefined();
  const savedNote = await api<WorkNoteDTO>(app, `/api/work-contexts/${research.id}/notes/${evidence!.id}`);
  expect(savedNote.body).toBe("Source A supports the claim.");

  await goal.fill("Stale draft");
  const beforeWorkConflict = await api<WorkContextDTO>(app, `/api/work-contexts/${research.id}`);
  await api<WorkContextDTO>(app, `/api/work-contexts/${research.id}`, "PATCH", {
    goal: "Server goal",
    expectedVersion: beforeWorkConflict.version,
  });
  await page.getByRole("button", { name: "Save work", exact: true }).click();
  const workConflict = page.locator(".work-context-editor .directory-conflict");
  await expect(workConflict).toBeVisible();
  await expect(workConflict).toContainText("Your draft is kept");
  await expect(goal).toHaveValue("Stale draft");
  await workConflict.getByRole("button", { name: "Reload", exact: true }).click();
  await expect(goal).toHaveValue("Server goal");

  const evidenceButton = page.locator(".work-note-list").getByRole("button", { name: /Evidence/ });
  await evidenceButton.click();
  const noteBody = page.getByRole("textbox", { name: "Note body", exact: true });
  await expect(noteBody).toHaveValue("Source A supports the claim.");
  await noteBody.fill("Local note draft");
  const beforeNoteConflict = await api<WorkContextDTO>(app, `/api/work-contexts/${research.id}`);
  const notePatch = await app.request<unknown>(
    `/api/work-contexts/${research.id}/notes/${evidence!.id}`,
    "PATCH",
    { title: "Evidence", body: "Server note body", expectedVersion: beforeNoteConflict.version },
  );
  expect(notePatch.status, `note patch: ${JSON.stringify(notePatch.body)}`).toBe(200);
  await page.getByRole("button", { name: "Save note", exact: true }).click();
  const noteConflict = page.locator(".work-notes-layout .directory-conflict");
  await expect(noteConflict).toBeVisible();
  await expect(noteConflict).toContainText("Your draft is kept");
  await expect(noteBody).toHaveValue("Local note draft");
  await noteConflict.getByRole("button", { name: "Reload", exact: true }).click();
  await expect(noteBody).toHaveValue("Server note body");

  await page.getByRole("button", { name: /^Directories · \d+$/ }).click();
  const directoriesDialog = page.getByRole("dialog");
  await expect(directoriesDialog.getByRole("heading", { name: "Directories", exact: true })).toBeVisible();
  await directoriesDialog.getByRole("button", { name: "Add directory", exact: true }).click();
  await directoriesDialog.getByRole("textbox").first().fill("/tmp/research-directory");
  await directoriesDialog.getByRole("button", { name: /^Close/ }).click();
  const discardConfirm = directoriesDialog.getByRole("group", { name: "Unsaved directory changes", exact: true });
  await expect(discardConfirm).toBeVisible();
  await discardConfirm.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(directoriesDialog).toBeHidden();
});

test("the shared notes frame stays fully visible at the bottom of the work page", async ({ app, page }) => {
  const research = await api<WorkContextDTO>(app, "/api/work-contexts", "POST", {
    name: "Research",
    goal: "Compare sources",
    instructions: "Keep citations",
  });
  await onboarded(page, app);

  type Frame = {
    borderBottom: number;
    borderStyle: string;
    borderColor: string;
    editor: { left: number; right: number; bottom: number };
    scrollport: { left: number; right: number; bottom: number };
    noteSelectBottom: number | undefined;
    viewportHeight: number;
  };

  async function measureFrame(): Promise<Frame> {
    return page.evaluate(() => {
      const content = document.querySelector<HTMLElement>(".work-context-content");
      const editor = document.querySelector<HTMLElement>(".work-notes-layout > .editor");
      if (content === null || editor === null) throw new Error("the work page is missing its notes frame");
      const style = getComputedStyle(editor);
      const contentRect = content.getBoundingClientRect();
      const editorRect = editor.getBoundingClientRect();
      const noteSelect = document.querySelector<HTMLElement>(".work-note-select");
      return {
        borderBottom: Number.parseFloat(style.borderBottomWidth),
        borderStyle: style.borderBottomStyle,
        borderColor: style.borderBottomColor,
        editor: { left: editorRect.left, right: editorRect.right, bottom: editorRect.bottom },
        scrollport: { left: contentRect.left, right: contentRect.right, bottom: contentRect.bottom },
        noteSelectBottom: noteSelect === null ? undefined : noteSelect.getBoundingClientRect().bottom,
        viewportHeight: window.innerHeight,
      };
    });
  }

  function expectFrameVisible(frame: Frame): void {
    expect(frame.borderStyle, "the notes frame keeps a real border").not.toBe("none");
    expect(frame.borderColor).not.toBe("rgba(0, 0, 0, 0)");
    expect(frame.borderColor).not.toBe("transparent");
    expect(frame.borderBottom).toBeGreaterThanOrEqual(1);
    // The frame sits inside the scrollport, and its bottom edge clears the
    // clip by more than the border itself — `toBeVisible` cannot prove that.
    expect(frame.editor.left).toBeGreaterThanOrEqual(frame.scrollport.left - 0.5);
    expect(frame.editor.right).toBeLessThanOrEqual(frame.scrollport.right + 0.5);
    expect(frame.scrollport.bottom - frame.editor.bottom).toBeGreaterThan(frame.borderBottom);
    expect(frame.editor.bottom).toBeLessThanOrEqual(frame.viewportHeight + 0.5);
    if (frame.noteSelectBottom !== undefined) {
      expect(frame.noteSelectBottom).toBeLessThanOrEqual(frame.scrollport.bottom + 0.5);
    }
  }

  async function openResearch(viewport: { width: number; height: number }): Promise<void> {
    await page.setViewportSize(viewport);
    await navigateWorkspace(page, "Work");
    const picker = page.getByLabel("Select work", { exact: true });
    if (await picker.isVisible()) await picker.selectOption(research.id);
    else await page.locator(".work-context-list").getByRole("button", { name: /Research/ }).click();
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Research");
    await page.locator(".work-context-content").evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
  }

  const viewports = [
    { width: 1440, height: 900 },
    { width: 1280, height: 660 },
    { width: 390, height: 844 },
  ];

  // The empty editor is the last block of the page: its whole frame must stay
  // inside the scrollport at every width.
  for (const viewport of viewports) {
    await openResearch(viewport);
    await expect(page.locator(".work-notes-layout > .editor")).toContainText("Select a note to read or edit it");
    expectFrameVisible(await measureFrame());
  }

  // A real note, saved through the UI, keeps the same frame contract.
  const researchWithNote = await createAndWaitForNote(page, app, research.id, "Evidence", "Source A supports the claim.");
  const evidence = researchWithNote.notes.find((note) => note.title === "Evidence")!;
  const savedNote = await api<WorkNoteDTO>(app, `/api/work-contexts/${research.id}/notes/${evidence.id}`);
  expect(savedNote.body).toBe("Source A supports the claim.");

  for (const viewport of viewports) {
    await openResearch(viewport);
    const saveNote = page.getByRole("button", { name: "Save note", exact: true });
    await expect(saveNote).toBeInViewport();
    await expect(saveNote).toBeEnabled();
    expectFrameVisible(await measureFrame());
    await saveNote.click();
    await expect(page.locator(".work-notes-layout").getByRole("status")).toContainText(
      "Note saved to this work's shared notes.",
    );
    // The saved notice adds a row; the frame must still end clear of the clip.
    await page.locator(".work-context-content").evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    expectFrameVisible(await measureFrame());
    await expect(saveNote).toBeInViewport();
  }
});
