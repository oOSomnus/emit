import type { Page } from "@playwright/test";
import { expect, onboarded, test } from "./fixtures.ts";

async function openNavigation(page: Page): Promise<void> {
  const open = page.getByRole("button", { name: /^(Open navigation|打开导航)$/ });
  if (await open.isVisible()) await open.click();
}

async function navigate(page: Page, label: string): Promise<void> {
  await openNavigation(page);
  await page.locator("aside.sidebar").getByRole("button", { name: label, exact: true }).click();
}

test("top-level navigation works and language/theme preferences survive a reload", async ({ app, page }) => {
  await onboarded(page, app);

  await navigate(page, "Mailbox");
  await expect(page.getByRole("heading", { name: "Mailbox", exact: true })).toBeVisible();
  await navigate(page, "Employees");
  await expect(page.getByRole("heading", { name: "Employees", exact: true })).toBeVisible();
  await navigate(page, "Settings");
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();

  const workspaceSettings = page.locator(".settings > section").filter({
    has: page.getByRole("heading", { name: "Workspace", exact: true }),
  });
  await workspaceSettings.getByLabel("Appearance", { exact: true }).selectOption("dark");
  await workspaceSettings.getByLabel("Language", { exact: true }).selectOption("zh-CN");
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page).toHaveTitle("Emit · 数字员工工作台");

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page).toHaveTitle("Emit · 数字员工工作台");

  await openNavigation(page);
  const sidebar = page.locator("aside.sidebar");
  await sidebar.getByRole("button", { name: "员工", exact: true }).click();
  await expect(page.getByRole("heading", { name: "员工", exact: true })).toBeVisible();

  const openMenu = page.getByRole("button", { name: "打开导航", exact: true });
  if (await openMenu.isVisible()) {
    await openMenu.click();
    await expect(sidebar).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(openMenu).toBeVisible();
    await expect(openMenu).toBeFocused();
  }

  await navigate(page, "设置");
  await expect(page.getByRole("heading", { name: "设置", exact: true })).toBeVisible();
  const chineseWorkspaceSettings = page.locator(".settings > section").filter({
    has: page.getByRole("heading", { name: "工作台", exact: true }),
  });
  await expect(chineseWorkspaceSettings.getByLabel("外观", { exact: true })).toHaveValue("dark");
  await expect(chineseWorkspaceSettings.getByLabel("语言", { exact: true })).toHaveValue("zh-CN");
});
