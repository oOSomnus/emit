import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test as base, type Page } from "@playwright/test";
import { FAKE_KEY_ENV, providerConfig } from "../helpers/emit-fixture.ts";
import type { E2eFixture } from "../helpers/e2e-fixture.ts";
import { startOAuthTokenServer, type OAuthTokenServerFixture } from "../helpers/oauth-token-server.ts";
import { startEmitProcess, type EmitProcessFixture } from "../helpers/process-fixture.ts";
import { startProviderProcess, type ProviderProcessFixture } from "../helpers/provider-process.ts";
import { seedTestWorkspace } from "../helpers/workspace-fixture.ts";

type BrowserOrigins = {
  readonly browserOrigins: readonly string[];
  allowOrigin(origin: string): void;
};
export type BrowserE2eFixture = E2eFixture & BrowserOrigins;
export type EmptyBrowserApp = Omit<E2eFixture, "workspace"> & BrowserOrigins;
export type OAuthBrowserApp = {
  readonly root: string;
  readonly workRoot: string;
  readonly outsideRoot: string;
  readonly provider: OAuthTokenServerFixture;
  readonly emit: EmitProcessFixture;
  readonly browserOrigins: readonly string[];
  allowOrigin(origin: string): void;
  request<T>(path: string, method?: string, body?: unknown): Promise<{ status: number; body: T }>;
  close(): Promise<void>;
};
const LOOPBACK_HOSTS: Record<string, true> = {
  localhost: true,
  "localhost.": true,
  "127.0.0.1": true,
  "[::1]": true,
};

function privateLoopbackOrigin(value: string): string {
  const url = new URL(value);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !LOOPBACK_HOSTS[url.hostname] ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("Browser network allowlist accepts only private loopback HTTP(S) origins");
  }
  return url.origin;
}

function createBrowserOriginAccess(initial: readonly string[]): BrowserOrigins {
  const allowed = new Set(initial.map(privateLoopbackOrigin));
  return {
    get browserOrigins() {
      return [...allowed];
    },
    allowOrigin(origin: string) {
      allowed.add(privateLoopbackOrigin(origin));
    },
  };
}

type BrowserFixtures = { app: BrowserE2eFixture };

/** A real, isolated Emit process serving the built browser application. */
export function createBrowserApp(): Promise<BrowserE2eFixture>;
export function createBrowserApp(options: { seed?: true }): Promise<BrowserE2eFixture>;
export function createBrowserApp(options: { seed: false }): Promise<EmptyBrowserApp>;
export function createBrowserApp(options: { seed?: boolean }): Promise<BrowserE2eFixture | EmptyBrowserApp>;
export async function createBrowserApp(
  options: { seed?: boolean } = {},
): Promise<BrowserE2eFixture | EmptyBrowserApp> {
  const root = mkdtempSync(join(tmpdir(), "emit-browser-"));
  let provider: ProviderProcessFixture | undefined;
  let emit: EmitProcessFixture | undefined;
  try {
    provider = await startProviderProcess(root);
    emit = await startEmitProcess({
      root,
      dataDir: join(root, "data"),
      webRoot: "dist/web",
      imports: ["test/fixtures/opencode-local-fetch.mjs"],
      env: {
        [FAKE_KEY_ENV]: "local-fixture-key",
        EMIT_TEST_ALLOWED_ORIGINS: JSON.stringify([provider.url]),
        OPENCODE_FAKE_URL: `${provider.url}/zen/go`,
      },
    });
    const instance = emit;
    const fake = provider;
    const originAccess = createBrowserOriginAccess([instance.url, fake.url]);
    let closing: Promise<void> | undefined;
    const common = {
      root,
      workRoot: join(root, "work"),
      outsideRoot: join(root, "outside"),
      provider: fake,
      emit: instance,
      get browserOrigins() { return originAccess.browserOrigins; },
      allowOrigin(origin: string) { originAccess.allowOrigin(origin); },
      async request<T>(path: string, method = "GET", body?: unknown): Promise<{ status: number; body: T }> {
        const response = await fetch(new URL(path, instance.url), {
          method,
          ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(10_000),
        });
        return { status: response.status, body: await response.json() as T };
      },
      close(): Promise<void> {
        closing ??= (async () => {
          try { await instance.stop(); }
          finally {
            try { await fake.close(); }
            finally { rmSync(root, { recursive: true, force: true }); }
          }
        })();
        return closing;
      },
    };
    if (options.seed === false) return common;
    const workspace = await seedTestWorkspace({ url: instance.url, providerBaseUrl: fake.baseUrl, root });
    return Object.assign(common, { workspace });
  } catch (error) {
    try { await emit?.stop(); }
    finally { try { await provider?.close(); } finally { rmSync(root, { recursive: true, force: true }); } }
    throw error;
  }
}

/** Run the same real UI against Emit's local OAuth test provider and token endpoint. */
export async function createOAuthBrowserApp(): Promise<OAuthBrowserApp> {
  const root = mkdtempSync(join(tmpdir(), "emit-browser-oauth-"));
  let provider: OAuthTokenServerFixture | undefined;
  let emit: EmitProcessFixture | undefined;
  try {
    provider = await startOAuthTokenServer();
    emit = await startEmitProcess({
      root,
      dataDir: join(root, "data"),
      webRoot: "dist/web",
      entrypoint: "test/fixtures/oauth-ui-server.ts",
      env: {
        EMIT_TEST_OAUTH_URL: provider.url,
        EMIT_TEST_ALLOWED_ORIGINS: JSON.stringify([provider.url]),
      },
    });
    const instance = emit;
    const fake = provider;
    const originAccess = createBrowserOriginAccess([instance.url, fake.url]);
    let closing: Promise<void> | undefined;
    return {
      root,
      workRoot: join(root, "work"),
      outsideRoot: join(root, "outside"),
      provider: fake,
      emit: instance,
      get browserOrigins() { return originAccess.browserOrigins; },
      allowOrigin(origin: string) { originAccess.allowOrigin(origin); },
      async request<T>(path: string, method = "GET", body?: unknown): Promise<{ status: number; body: T }> {
        const response = await fetch(new URL(path, instance.url), {
          method,
          ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(10_000),
        });
        return { status: response.status, body: await response.json() as T };
      },
      close(): Promise<void> {
        closing ??= (async () => {
          try { await instance.stop(); }
          finally {
            try { await fake.close(); }
            finally { rmSync(root, { recursive: true, force: true }); }
          }
        })();
        return closing;
      },
    };
  } catch (error) {
    try { await emit?.stop(); }
    finally { try { await provider?.close(); } finally { rmSync(root, { recursive: true, force: true }); } }
    throw error;
  }
}

export const test = base.extend<BrowserFixtures>({
  app: async ({}, use) => {
    const app = await createBrowserApp();
    try { await use(app); }
    finally { await app.close(); }
  },
  page: async ({ page, app }, use) => {
    await page.context().route("**/*", async (route) => {
      let url: URL;
      try { url = new URL(route.request().url()); }
      catch { await route.abort(); return; }
      if ((url.protocol === "http:" || url.protocol === "https:") && !app.browserOrigins.includes(url.origin)) {
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });
    await use(page);
  },
});

/** Load the pre-seeded workspace with stable browser preferences. */
export async function onboarded(page: Page, app: BrowserE2eFixture): Promise<void> {
  await page.addInitScript(() => {
    if (localStorage.getItem("emit.language") === null) localStorage.setItem("emit.language", "en");
    if (localStorage.getItem("emit.theme") === null) localStorage.setItem("emit.theme", "light");
  });
  await page.goto(app.emit.url);
  await expect(page.getByRole("button", { name: "General", exact: true })).toBeAttached();
}

/**
 * Reach a workspace destination from the rail.
 *
 * The mailbox keeps a fixed entry; every management destination lives behind
 * the workspace menu, which is closed by default. The label is the visible
 * destination text in the current interface language, matching what the test
 * asserts on screen.
 */
export async function navigateWorkspace(page: Page, label: string): Promise<void> {
  const language = await page.locator("html").getAttribute("lang");
  const drawerOpen = await page.locator(".shell").evaluate((element) => element.classList.contains("nav-open"));
  if (!drawerOpen) {
    const open = page.getByRole("button", { name: /^(Open navigation|打开导航)$/ });
    if (await open.isVisible()) await open.click();
  }
  if (label === "Mailbox" || label === "邮箱") {
    await page.getByRole("button", { name: label, exact: true }).click();
    return;
  }
  await page.locator(".workspace-trigger").click();
  await page.locator(".workspace-menu").getByRole("button", { name: label, exact: true }).click();
}

/**
 * Switch the settings section through whichever control the pane shows: the
 * fixed directory on wide panes, the picker on narrow ones.
 */
export async function selectSettingsSection(page: Page, section: string): Promise<void> {
  await expect(page.locator(".settings-layout")).toBeVisible();
  const picker = page.locator(".settings-section-picker select");
  if (await picker.isVisible()) {
    await picker.selectOption(section);
  } else {
    await page.locator(`.settings-nav button[aria-controls="settings-panel-${section}"]`).click();
  }
  await expect(page.locator(`#settings-panel-${section}`)).toBeVisible();
}

/** Select a provider through the list row or the narrow-pane picker. */
export async function selectProviderInUi(page: Page, providerId: string): Promise<void> {
  await expect(page.locator(".provider-manager")).toBeVisible();
  const picker = page.locator(".provider-picker select");
  if (await picker.isVisible()) {
    await picker.selectOption(providerId);
  } else {
    await page.locator(`.provider-item[data-provider-id="${providerId}"]`).click();
  }
}

export { expect };
