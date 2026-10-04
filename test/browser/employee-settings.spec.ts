import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { EmployeeDTO, McpServerDTO, SkillDTO } from "../../src/shared/contracts.ts";
import { expect, onboarded, test, type BrowserE2eFixture } from "./fixtures.ts";

async function api<T>(app: BrowserE2eFixture, path: string, method = "GET", body?: unknown): Promise<T> {
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

async function navigate(page: Page, label: string): Promise<void> {
  await revealNavigation(page);
  await page.getByRole("button", { name: label, exact: false }).click();
}

test("settings import a skill and connect MCP, then an employee saves its model and tool bindings", async ({ app, page }) => {
  test.setTimeout(90_000);
  await openWorkspace(page, app);
  await navigate(page, "Settings");
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();

  const skillDirectory = join(app.root, "browser-skills");
  const skillFile = join(skillDirectory, "browser-review", "SKILL.md");
  mkdirSync(join(skillDirectory, "browser-review"), { recursive: true });
  writeFileSync(
    skillFile,
    "---\nname: browser-review\ndescription: Browser-created review skill\n---\n\n# Browser review\n\nUse the review checklist for this workspace.\n",
    "utf8",
  );
  await page.getByPlaceholder("Directory containing SKILL.md, e.g. ~/.claude/skills").fill(skillDirectory);
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await expect.poll(async () => {
    const payload = await api<{ skills: SkillDTO[] }>(app, "/api/skills");
    return payload.skills.find((skill) => skill.name === "browser-review")?.filePath;
  }).toBe(skillFile);
  await expect(page.getByText("browser-review", { exact: true })).toBeVisible();

  const serverName = "Browser MCP";
  const mcpScript = fileURLToPath(new URL("../fixtures/fake-mcp.mjs", import.meta.url));
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

  await navigate(page, "Employees");
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
  await expect(page.getByRole("button", { name: /Browser operator/ })).toBeVisible();
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
  await expect(page.getByRole("button", { name: /Browser operator/ })).toContainText("1 skill");
  await expect(page.getByRole("button", { name: /Browser operator/ })).toContainText("1 MCP");
});
