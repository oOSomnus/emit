import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { EmployeeDTO, McpServerDTO, MessageDTO, RoomDTO, SkillDTO, WorkContextDTO, WorkDTO } from "../../src/shared/contracts.ts";
import { providerConfig } from "../helpers/emit-fixture.ts";
import { createBrowserApp, expect, navigateWorkspace, onboarded, selectSettingsSection, test, type BrowserE2eFixture } from "./fixtures.ts";

async function api<T>(app: Pick<BrowserE2eFixture, "request">, path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await app.request<T>(path, method, body);
  expect(response.status, `${method} ${path}: ${JSON.stringify(response.body)}`).toBe(200);
  return response.body;
}

async function revealNavigation(page: Page): Promise<void> {
  const open = page.getByRole("button", { name: "Open navigation", exact: true });
  if (await open.isVisible()) await open.click();
}

async function openWorkspace(page: Page, app: BrowserE2eFixture): Promise<void> {
  await onboarded(page, app);
  const channel = page.getByRole("button", { name: "General", exact: true });
  await expect(channel).toBeAttached();
  await revealNavigation(page);
  await channel.click();
  await expect(page.getByRole("heading", { name: /General/ })).toBeVisible();
}

test("settings import a skill and connect MCP, then an employee saves its model and tool bindings", async ({ app, page }) => {
  test.setTimeout(90_000);
  await openWorkspace(page, app);
  await navigateWorkspace(page, "Settings");
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();

  const skillDirectory = join(app.root, "browser-skills");
  const skillFile = join(skillDirectory, "browser-review", "SKILL.md");
  mkdirSync(join(skillDirectory, "browser-review"), { recursive: true });
  writeFileSync(
    skillFile,
    "---\nname: browser-review\ndescription: Browser-created review skill\n---\n\n# Browser review\n\nUse the review checklist for this workspace.\n",
    "utf8",
  );
  await selectSettingsSection(page, "skills");
  await page.getByPlaceholder("Directory containing SKILL.md, e.g. ~/.claude/skills").fill(skillDirectory);
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await expect.poll(async () => {
    const payload = await api<{ skills: SkillDTO[] }>(app, "/api/skills");
    return payload.skills.find((skill) => skill.name === "browser-review")?.filePath;
  }).toBe(skillFile);
  await expect(page.getByText("browser-review", { exact: true })).toBeVisible();

  const serverName = "Browser MCP";
  const mcpScript = fileURLToPath(new URL("../fixtures/fake-mcp.mjs", import.meta.url));
  await selectSettingsSection(page, "mcp");
  await page.getByPlaceholder("Name", { exact: true }).fill(serverName);
  await page.getByPlaceholder("Command, e.g. npx", { exact: true }).fill(process.execPath);
  await page.getByPlaceholder("Arguments, space-separated", { exact: true }).fill(mcpScript);
  await page.getByRole("button", { name: "Add server", exact: true }).click();

  const mcpRow = page.getByRole("listitem").filter({ hasText: serverName });
  await expect(mcpRow).toBeVisible();
  const servers = await api<{ servers: McpServerDTO[] }>(app, "/api/mcp");
  const server = servers.servers.find((entry) => entry.name === serverName);
  expect(server).toBeDefined();
  await mcpRow.getByRole("button", { name: "Connect", exact: true }).click();
  await expect.poll(async () => {
    const payload = await api<{ servers: McpServerDTO[] }>(app, "/api/mcp");
    return payload.servers.find((entry) => entry.id === server!.id)?.connection.state;
  }, { timeout: 20_000 }).toBe("connected");
  const connected = (await api<{ servers: McpServerDTO[] }>(app, "/api/mcp")).servers.find((entry) => entry.id === server!.id)!;
  expect(connected.tools).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "echo_notes", readOnly: true }),
    expect.objectContaining({ name: "shout", readOnly: false }),
  ]));
  await expect(mcpRow).toContainText("2 tools");

  await navigateWorkspace(page, "Employees");
  await expect(page.getByRole("heading", { name: "Employees", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "New employee", exact: true }).click();
  await expect(page.getByRole("heading", { name: "New employee", exact: true })).toBeVisible();
  await page.getByLabel("Name", { exact: true }).fill("Browser operator");
  await page.getByLabel("Role", { exact: true }).fill("Workspace reviewer");
  await page.getByLabel("Instructions", { exact: true }).fill("Use the imported review skill and the connected MCP server when needed.");
  await page.getByLabel("Employee model", { exact: true }).selectOption("fake|fake-chat");
  await page.getByLabel("Employee model reasoning effort", { exact: true }).selectOption("off");

  const skillBindings = page.getByRole("group", { name: "Skills", exact: true });
  await skillBindings.getByRole("checkbox").check();
  const mcpBindings = page.getByRole("group", { name: "MCP servers", exact: true });
  await mcpBindings.getByRole("checkbox").check();
  const trustedTools = page.getByRole("group", { name: "MCP tools trusted as read-only", exact: true });
  await expect(trustedTools.getByRole("checkbox")).toHaveCount(2);
  await trustedTools.getByRole("checkbox").first().check();
  const allowedTools = page.getByRole("group", { name: "Allowed tools", exact: true });
  for (const tool of ["write_file", "edit_file", "run_shell", "load_skill"]) {
    await allowedTools.getByRole("checkbox", { name: tool, exact: true }).uncheck();
  }
  await allowedTools.getByRole("checkbox", { name: "read_file", exact: true }).check();

  await page.getByRole("button", { name: "Save", exact: true }).click();
  const card = page.getByRole("article", { name: "Browser operator" });
  await expect(card).toBeVisible();
  const employees = (await api<{ employees: EmployeeDTO[] }>(app, "/api/bootstrap")).employees;
  const employee = employees.find((entry) => entry.name === "Browser operator");
  expect(employee).toBeDefined();
  expect(employee).toMatchObject({
    role: "Workspace reviewer",
    instructions: "Use the imported review skill and the connected MCP server when needed.",
    executionModel: { model: { providerId: "fake", modelId: "fake-chat" }, effort: "off" },
    skillIds: [expect.any(String)],
    mcpServerIds: [server!.id],
    toolPolicy: {
      allowedTools: ["read_file"],
      trustedReadOnlyTools: [`${server!.id}/echo_notes`],
    },
  });
  expect(employee!.skillIds).toContain((await api<{ skills: SkillDTO[] }>(app, "/api/skills")).skills.find((skill) => skill.name === "browser-review")!.id);
  await expect(card).toContainText("Workspace reviewer");
  await expect(card).toContainText("1 skill");
  await expect(card).toContainText("1 MCP");
  await expect(card).toContainText("Model");
});

test("starts, reuses, and re-scopes a direct message from the employee directory", async ({ app, page }) => {
  await openWorkspace(page, app);
  await navigateWorkspace(page, "Employees");

  const worksBefore = (await api<WorkDTO[]>(app, "/api/works")).length;
  const roomsBefore = await api<RoomDTO[]>(app, "/api/rooms");
  expect(roomsBefore.filter((room) => room.kind === "dm")).toHaveLength(0);
  const aliceId = app.workspace.employeeIds[0]!;
  const originalWorkId = app.workspace.workContextId;
  const aliceCard = page.getByRole("article", { name: "Alice" });
  await aliceCard.getByRole("button", { name: "Message", exact: true }).click();

  await expect(page.getByRole("heading", { name: /Alice/ })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
  const roomsAfterFirstOpen = await api<RoomDTO[]>(app, "/api/rooms");
  const originalRooms = roomsAfterFirstOpen.filter((room) =>
    room.kind === "dm" && room.workContextId === originalWorkId && room.employeeId === aliceId,
  );
  expect(originalRooms).toHaveLength(1);
  const originalRoom = originalRooms[0]!;
  expect(originalRoom.dmParticipantIds).toEqual(expect.arrayContaining(["user", aliceId]));
  expect(originalRoom.employeeId).toBe(aliceId);
  const transcript = await api<{ room: RoomDTO; messages: MessageDTO[] }>(
    app,
    `/api/rooms/${originalRoom.id}/messages`,
  );
  expect(transcript.messages).toHaveLength(0);
  expect((await api<WorkDTO[]>(app, "/api/works")).length).toBe(worksBefore);

  await navigateWorkspace(page, "Employees");
  await page.getByRole("article", { name: "Alice" }).getByRole("button", { name: "Message", exact: true }).click();
  await expect(page.getByRole("heading", { name: /Alice/ })).toBeVisible();
  const roomsAfterReuse = await api<RoomDTO[]>(app, "/api/rooms");
  const reusedRooms = roomsAfterReuse.filter((room) =>
    room.kind === "dm" && room.workContextId === originalWorkId && room.employeeId === aliceId,
  );
  expect(reusedRooms).toHaveLength(1);
  expect(reusedRooms[0]!.id).toBe(originalRoom.id);

  const alternate = await api<WorkContextDTO>(app, "/api/work-contexts", "POST", { name: "Alternate work" });
  await revealNavigation(page);
  await page.getByLabel("Current work", { exact: true }).selectOption(alternate.id);
  await navigateWorkspace(page, "Employees");
  await page.getByRole("article", { name: "Alice" }).getByRole("button", { name: "Message", exact: true }).click();
  await expect(page.getByRole("heading", { name: /Alice/ })).toBeVisible();
  const roomsAfterRescope = await api<RoomDTO[]>(app, "/api/rooms");
  const alternateRooms = roomsAfterRescope.filter((room) =>
    room.kind === "dm" && room.workContextId === alternate.id && room.employeeId === aliceId,
  );
  expect(alternateRooms).toHaveLength(1);
  expect(alternateRooms[0]!.id).not.toBe(originalRoom.id);
  expect(alternateRooms[0]!.workContextId).toBe(alternate.id);
  expect(roomsAfterRescope.find((room) => room.id === originalRoom.id)?.workContextId).toBe(originalWorkId);

  await api<EmployeeDTO>(app, `/api/employees/${aliceId}`, "PATCH", { enabled: false });
  await navigateWorkspace(page, "Employees");
  const disabledAliceCard = page.getByRole("article", { name: "Alice" });
  await expect(disabledAliceCard).toContainText("Disabled");
  await expect(disabledAliceCard).toContainText("This employee is disabled; direct messages are unavailable.");
  await expect(disabledAliceCard.getByRole("button", { name: "Message", exact: true })).toBeDisabled();
});

test("a workspace without work sends Message to work creation instead of opening a DM", async ({ app, page }) => {
  test.setTimeout(60_000);
  const fresh = await createBrowserApp({ seed: false });
  app.allowOrigin(fresh.emit.url);
  app.allowOrigin(fresh.provider.url);
  try {
    await api<unknown>(fresh, "/api/providers/custom", "PUT", {
      providers: [providerConfig(fresh.provider.baseUrl)],
    });
    await api<unknown>(fresh, "/api/setup", "POST", {
      userName: "Founder",
      defaultExecutionModel: { model: { providerId: "fake", modelId: "fake-chat" }, effort: "off" },
      approval: {
        kind: "llm",
        model: { providerId: "fake", modelId: "fake-reviewer" },
        effort: "off",
        criteriaVersion: 3,
      },
    });
    await api<EmployeeDTO>(fresh, "/api/employees", "POST", {
      name: "Alice",
      role: "Assistant",
      executionModel: { model: { providerId: "fake", modelId: "fake-chat" }, effort: "off" },
      generateAddress: true,
    });
    await page.addInitScript(() => {
      localStorage.setItem("emit.language", "en");
      localStorage.setItem("emit.theme", "light");
    });
    await page.goto(fresh.emit.url);

    await navigateWorkspace(page, "Employees");
    await page.getByRole("article", { name: "Alice" }).getByRole("button", { name: "Message", exact: true }).click();
    await expect(page.getByRole("heading", { name: "No work yet", exact: true })).toBeVisible();
    const rooms = await api<RoomDTO[]>(fresh, "/api/rooms");
    expect(rooms.filter((room) => room.kind === "dm")).toHaveLength(0);
  } finally {
    await fresh.close();
  }
});
