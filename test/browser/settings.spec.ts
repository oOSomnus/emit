import type { Page } from "@playwright/test";
import type { AppConfigDTO, ModelInfoDTO, ProviderStatusDTO } from "../../src/shared/contracts.ts";
import { providerConfig } from "../helpers/emit-fixture.ts";
import {
  createOAuthBrowserApp,
  expect,
  navigateWorkspace,
  onboarded,
  selectProviderInUi,
  selectSettingsSection,
  test,
  type BrowserE2eFixture,
} from "./fixtures.ts";

async function api<T>(app: BrowserE2eFixture, path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await app.request<T>(path, method, body);
  expect(response.status, `${method} ${path}: ${JSON.stringify(response.body)}`).toBe(200);
  return response.body;
}

async function expectSecretsAbsent(page: Page, secrets: readonly string[]): Promise<void> {
  const browserState = await page.evaluate(() => JSON.stringify({
    html: document.documentElement.outerHTML,
    localStorage: Object.entries(localStorage),
    sessionStorage: Object.entries(sessionStorage),
  }));
  for (const secret of secrets) expect(browserState).not.toContain(secret);
}

async function openSettings(page: Page, app: BrowserE2eFixture): Promise<void> {
  await onboarded(page, app);
  await navigateWorkspace(page, "Settings");
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
}

test("settings sections switch without losing drafts and only the active panel shows", async ({ app, page }) => {
  await openSettings(page, app);

  // One panel at a time; the others stay mounted but leave the tab order.
  await expect(page.locator(".settings-panel:visible")).toHaveCount(1);
  await expect(page.locator("#settings-panel-mcp")).toHaveAttribute("hidden", "");

  // A workspace edit is a draft: switching sections keeps it, and nothing is
  // written until Save.
  await page.getByLabel("Workspace name", { exact: true }).fill("Unsaved workspace");
  await selectSettingsSection(page, "mcp");
  await page.getByPlaceholder("Name", { exact: true }).fill("Draft MCP");
  await selectSettingsSection(page, "skills");
  await selectSettingsSection(page, "workspace");
  await expect(page.getByLabel("Workspace name", { exact: true })).toHaveValue("Unsaved workspace");
  expect((await api<AppConfigDTO>(app, "/api/app")).workspace.name).toBe("Test Workspace");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(async () => (await api<AppConfigDTO>(app, "/api/app")).workspace.name).toBe("Unsaved workspace");

  // The MCP draft survives the round trip too.
  await selectSettingsSection(page, "mcp");
  await expect(page.getByPlaceholder("Name", { exact: true })).toHaveValue("Draft MCP");

  // An unsaved custom-provider editor survives section switches.
  await selectSettingsSection(page, "providers");
  await page.getByRole("button", { name: "Add custom provider", exact: true }).click();
  const editor = page.locator(".provider-manager .editor");
  await editor.getByLabel("Provider id").fill("draft-provider");
  await editor.getByLabel("Name", { exact: true }).nth(0).fill("Draft Provider");
  await selectSettingsSection(page, "workspace");
  await selectSettingsSection(page, "providers");
  await expect(editor.getByLabel("Provider id")).toHaveValue("draft-provider");
  await expect(editor.getByLabel("Name", { exact: true }).nth(0)).toHaveValue("Draft Provider");
});

test("settings navigation is keyboard-operable and localized", async ({ app, page }) => {
  await openSettings(page, app);
  const narrow = (page.viewportSize()?.width ?? 0) <= 760;

  if (narrow) {
    await page.locator(".settings-section-picker select").selectOption("approval");
  } else {
    await page.locator("#settings-nav-approval").focus();
    await page.keyboard.press("Enter");
  }
  await expect(page.locator("#settings-panel-approval")).toBeVisible();

  await page.evaluate(() => localStorage.setItem("emit.language", "zh-CN"));
  await page.reload();
  await onboarded(page, app);
  await navigateWorkspace(page, "设置");
  await expect(page.getByRole("heading", { name: "设置", exact: true })).toBeVisible();
  if (narrow) {
    await expect(page.locator(".settings-section-picker")).toContainText("设置分区");
  } else {
    await expect(page.locator("#settings-nav-approval")).toHaveText("审批判断者");
  }
  await selectSettingsSection(page, "skills");
  await expect(page.getByRole("heading", { name: "技能", exact: true })).toBeVisible();
});

test("provider rows stay readable and narrow panes select providers without the long list", async ({ app, page }) => {
  await openSettings(page, app);
  await selectSettingsSection(page, "providers");

  const models = await api<{ models: ModelInfoDTO[]; providers: ProviderStatusDTO[] }>(app, "/api/models");
  const bedrock = models.providers.find((provider) => /Amazon Bedrock/i.test(provider.name));
  const azure = models.providers.find((provider) => /Azure OpenAI/i.test(provider.name));
  expect(bedrock, "the Pi catalog lists Amazon Bedrock").toBeDefined();
  expect(azure, "the Pi catalog lists Azure OpenAI").toBeDefined();

  const narrow = (page.viewportSize()?.width ?? 0) <= 760;
  if (!narrow) {
    for (const provider of [bedrock!, azure!]) {
      await selectProviderInUi(page, provider.providerId);
      const row = page.locator(`.provider-item[data-provider-id="${provider.providerId}"]`);
      const geometry = await row.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const copy = element.querySelector(".provider-item-copy")!.getBoundingClientRect();
        const meta = element.querySelector(".provider-item-meta")!.getBoundingClientRect();
        return {
          overflow: element.scrollWidth - element.clientWidth,
          copyRight: copy.right,
          metaRight: meta.right,
          copyBottom: copy.bottom,
          metaTop: meta.top,
          right: bounds.right,
        };
      });
      expect(geometry.overflow, `${provider.name} row does not overflow horizontally`).toBeLessThanOrEqual(1);
      expect(geometry.copyRight).toBeLessThanOrEqual(geometry.right + 1);
      expect(geometry.metaRight).toBeLessThanOrEqual(geometry.right + 1);
      expect(geometry.copyBottom, `${provider.name} status wraps below the name`).toBeLessThanOrEqual(geometry.metaTop + 1);
      await expect(page.locator(".provider-detail h3")).toContainText(provider.name);
    }
    const listOverflow = await page.locator(".provider-list").evaluate((element) => element.scrollWidth - element.clientWidth);
    expect(listOverflow).toBeLessThanOrEqual(1);
  }

  // A long, unbroken provider name and id wrap inside their row.
  const fake = providerConfig(app.provider.baseUrl);
  const longId = "fixture-long-provider-0123456789abcdefghijklmnopqrstuvwxyz";
  const longName = "EnterpriseProviderNameWithoutSpaces0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const put = await app.request("/api/providers/custom", "PUT", { providers: [fake, { ...fake, id: longId, name: longName }] });
  expect(put.status).toBe(200);
  await page.reload();
  await openSettings(page, app);
  await selectSettingsSection(page, "providers");

  if (!narrow) {
    await selectProviderInUi(page, longId);
    const row = page.locator(`.provider-item[data-provider-id="${longId}"]`);
    await expect(row.locator("strong")).toHaveText(longName);
    await expect(row.locator("code")).toHaveText(longId);
    const geometry = await row.evaluate((element) => {
      const copy = element.querySelector(".provider-item-copy")!.getBoundingClientRect();
      const meta = element.querySelector(".provider-item-meta")!.getBoundingClientRect();
      return {
        overflow: element.scrollWidth - element.clientWidth,
        copyBottom: copy.bottom,
        metaTop: meta.top,
      };
    });
    expect(geometry.overflow).toBeLessThanOrEqual(1);
    expect(geometry.copyBottom).toBeLessThanOrEqual(geometry.metaTop + 1);
  }

  // Mid and phone widths pick the provider above a single-column detail; the
  // 42-entry list is never shown there.
  for (const size of [
    { width: 1080, height: 670 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(size);
    await expect(page.locator(".provider-picker select")).toBeVisible();
    await expect(page.locator(".provider-list")).toBeHidden();
    await selectProviderInUi(page, longId);
    await expect(page.locator(".provider-detail h3 code")).toHaveText(longId);
    const documentOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(documentOverflow, `no horizontal page overflow at ${size.width}px`).toBeLessThanOrEqual(1);
    const detailOverflow = await page.locator(".provider-detail").evaluate((element) => element.scrollWidth - element.clientWidth);
    expect(detailOverflow).toBeLessThanOrEqual(1);
    const modelsOverflow = await page.locator(".provider-detail ul.plain").evaluate((element) => element.scrollWidth - element.clientWidth);
    expect(modelsOverflow).toBeLessThanOrEqual(1);
  }

  // A filtered-empty list keeps the current detail and selection; clearing the
  // filter restores it. No credential or authentication state changes.
  const search = page.locator(".provider-manager input[type='search']");
  await search.fill("zzz-no-such-provider");
  await expect(page.locator(".provider-picker select")).toBeDisabled();
  await expect(page.locator(".provider-list")).toContainText("No matching providers.");
  await expect(page.locator(".provider-detail h3 code")).toHaveText(longId);
  await expect(page.locator(".auth-session")).toHaveCount(0);
  await search.fill("");
  await expect(page.locator(".provider-picker select")).toBeEnabled();
  await expect(page.locator(".provider-picker select")).toHaveValue(longId);
  await page.getByLabel("Configured only", { exact: true }).check();
  await expect(page.locator(".provider-picker select")).toHaveValue(longId);
  await page.getByLabel("Configured only", { exact: true }).uncheck();
});

test("switching settings sections keeps an in-progress authentication session", async ({ app, page }) => {
  const oauthApp = await createOAuthBrowserApp();
  app.allowOrigin(oauthApp.emit.url);
  app.allowOrigin(oauthApp.provider.url);
  try {
    await page.addInitScript(() => {
      if (localStorage.getItem("emit.language") === null) localStorage.setItem("emit.language", "en");
      if (localStorage.getItem("emit.theme") === null) localStorage.setItem("emit.theme", "light");
    });
    await page.goto(oauthApp.emit.url);

    // Save a local OAuth credential through the real first-run UI.
    await selectProviderInUi(page, "fixture-oauth");
    await page.getByRole("button", { name: /Sign-in.*Local OAuth/i }).click();
    await page.getByLabel("Enter fixture authorization code").fill("fixture-code");
    await page.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(page.getByText("Authentication status: Saved", { exact: true })).toBeVisible();

    const setup = await oauthApp.request("/api/setup", "POST", {
      workspaceName: "OAuth Workspace",
      userName: "Tester",
      defaultExecutionModel: { model: { providerId: "fixture-oauth", modelId: "fixture-oauth-chat" }, effort: "off" },
      approval: {
        kind: "llm",
        model: { providerId: "fixture-oauth", modelId: "fixture-oauth-chat" },
        effort: "off",
        criteriaVersion: 3,
      },
    });
    expect(setup.status).toBe(200);
    await page.reload();
    await expect(page.locator(".workspace-name")).toHaveText("OAuth Workspace");

    await navigateWorkspace(page, "Settings");
    await selectSettingsSection(page, "providers");
    await selectProviderInUi(page, "fixture-oauth");
    await page.getByRole("button", { name: /Sign-in.*Local OAuth/i }).click();
    await expect(page.getByText("Authentication status: Waiting for input", { exact: true })).toBeVisible();
    const manualCode = page.getByLabel("Enter fixture authorization code");
    await manualCode.fill("fixture-code");

    // Leave and re-enter the section: the same prompt, input, and session stay.
    await selectSettingsSection(page, "workspace");
    await expect(page.locator(".auth-session")).toBeHidden();
    await selectSettingsSection(page, "providers");
    await expect(page.getByText("Authentication status: Waiting for input", { exact: true })).toBeVisible();
    await expect(manualCode).toHaveValue("fixture-code");
    await expect(page.getByRole("button", { name: "Submit", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(page.getByText("Authentication status: Saved", { exact: true })).toBeVisible();
    expect(oauthApp.provider.acceptsAccess("fixture-access-2")).toBe(true);
    await expectSecretsAbsent(page, ["fixture-code", "fixture-access-2", "fixture-refresh-2"]);
  } finally {
    await oauthApp.close();
  }
});
