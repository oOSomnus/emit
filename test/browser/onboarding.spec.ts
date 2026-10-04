import type { Page } from "@playwright/test";
import { createBrowserApp, createOAuthBrowserApp, expect, test } from "./fixtures.ts";

const browserModel = "browser-chat";
const browserProvider = "browser-fixture";
const browserModelKey = `${browserProvider}|${browserModel}`;
const apiKey = "local-fixture-key";

async function setDeterministicPreferences(page: Page): Promise<void> {
  await page.addInitScript(() => {
    if (localStorage.getItem("emit.language") === null) localStorage.setItem("emit.language", "en");
    if (localStorage.getItem("emit.theme") === null) localStorage.setItem("emit.theme", "light");
  });
}

async function expectSecretsAbsent(page: Page, secrets: readonly string[]): Promise<void> {
  const browserState = await page.evaluate(() => JSON.stringify({
    html: document.documentElement.outerHTML,
    localStorage: Object.entries(localStorage),
    sessionStorage: Object.entries(sessionStorage),
  }));
  for (const secret of secrets) expect(browserState).not.toContain(secret);
}

async function revealNavigation(page: Page): Promise<void> {
  const open = page.getByRole("button", { name: "Open navigation", exact: true });
  if (await open.isVisible()) await open.click();
}

test("a first-run workspace connects a local provider and creates its first employee through the UI", async ({ app, page }) => {
  const browserApp = await createBrowserApp({ seed: false });
  app.allowOrigin(browserApp.emit.url);
  app.allowOrigin(browserApp.provider.url);
  try {
    await setDeterministicPreferences(page);
    await page.goto(browserApp.emit.url);
    await expect(page.getByRole("heading", { name: "Emit", exact: true })).toBeVisible();
    await page.getByLabel("Workspace name").fill("Local Company");
    await page.getByLabel("Your name").fill("Workspace Founder");

    const providers = page.locator(".provider-manager");
    await providers.getByRole("button", { name: "Add custom provider", exact: true }).click();
    const editor = providers.locator(".editor").last();
    await editor.getByLabel("Provider id").fill(browserProvider);
    await editor.getByLabel("Name", { exact: true }).nth(0).fill("Browser Fixture Provider");
    await editor.getByLabel("Base URL").fill(browserApp.provider.baseUrl);
    await editor.getByRole("combobox", { name: /^API/ }).selectOption("openai-completions");
    await editor.getByLabel("model id").fill(browserModel);
    await editor.getByLabel("Name", { exact: true }).nth(1).fill("Browser Chat");
    await editor.getByLabel("contextWindow").fill("32768");
    await editor.getByLabel("maxTokens").fill("4096");
    await editor.getByRole("button", { name: "Save configuration", exact: true }).click();

    const credentialPrompt = providers.locator(".auth-session input[type='password']");
    await expect(credentialPrompt).toBeVisible();
    await credentialPrompt.fill(apiKey);
    await providers.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(providers.getByText("Authentication status: Saved", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Default employee model")).toHaveValue(browserModelKey);
    await expect(page.getByLabel("Approval judge model")).toHaveValue(browserModelKey);
    await expect(page.getByText("No provider credentials yet:", { exact: false })).toHaveCount(0);
    await expectSecretsAbsent(page, [apiKey]);
    const viewport = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      contentWidth: document.documentElement.scrollWidth,
    }));
    expect(viewport.contentWidth, "onboarding must fit the viewport before submitting").toBeLessThanOrEqual(viewport.clientWidth);

    await page.getByRole("button", { name: "Enter workspace", exact: true }).click();
    await expect(page.locator(".workspace-name")).toHaveText("Local Company");
    await expect(page.locator(".workspace-user")).toContainText("@");

    await revealNavigation(page);
    const sidebar = page.locator("aside.sidebar");
    await sidebar.getByRole("button", { name: "Employees", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Employees", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "New employee", exact: true }).click();
    await page.getByLabel("Name", { exact: true }).fill("Local Teammate");
    await page.getByLabel("Role", { exact: true }).fill("Research and writing assistant");
    await expect(page.getByLabel("Employee model", { exact: true })).toHaveValue(browserModelKey);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    const employee = page.getByRole("button").filter({ hasText: "Local Teammate" });
    await expect(employee).toContainText("Research and writing assistant");
    await expectSecretsAbsent(page, [apiKey]);
  } finally {
    await browserApp.close();
  }
});

test("OAuth login waits for a manual code, saves locally, and cancels without exposing credentials", async ({ app, page }) => {
  const oauthApp = await createOAuthBrowserApp();
  app.allowOrigin(oauthApp.emit.url);
  app.allowOrigin(oauthApp.provider.url);
  try {
    await setDeterministicPreferences(page);
    await page.goto(oauthApp.emit.url);
    const providers = page.locator(".provider-manager");
    const search = providers.getByRole("searchbox", { name: "Search providers" });
    await search.fill("fixture-oauth");
    await providers.getByRole("button", { name: /Fixture OAuth/ }).click();

    const login = providers.getByRole("button", { name: /Sign-in.*Local OAuth/i });
    await login.click();
    await expect(providers.getByText("Authentication status: Waiting for input", { exact: true })).toBeVisible();
    await expect(providers.getByText("FIXTURE-CODE", { exact: true })).toBeVisible();
    const authorization = providers.getByRole("link", { name: "Open authorization page", exact: true });
    await expect(authorization).toHaveAttribute("href", `${oauthApp.provider.url}/authorize`);
    const manualCode = providers.getByLabel("Enter fixture authorization code");
    await expect(manualCode).toBeVisible();
    await manualCode.fill("fixture-code");
    await providers.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(providers.getByText("Authentication status: Saved", { exact: true })).toBeVisible();
    expect(oauthApp.provider.acceptsAccess("fixture-access-1")).toBe(true);
    await expectSecretsAbsent(page, ["fixture-code", "fixture-access-1", "fixture-refresh-1"]);

    await login.click();
    await expect(providers.getByLabel("Enter fixture authorization code")).toBeVisible();
    await providers.getByRole("button", { name: "Cancel authentication", exact: true }).click();
    await expect(providers.getByText("Authentication status: Cancelled", { exact: true })).toBeVisible();
    expect(oauthApp.provider.acceptsAccess("fixture-access-2")).toBe(false);
    await expectSecretsAbsent(page, ["fixture-code", "fixture-access-1", "fixture-refresh-1", "fixture-access-2"]);
  } finally {
    await oauthApp.close();
  }
});
