/**
 * Deterministic coverage for the native credential store and the login bridge.
 *
 * These tests drive real Pi providers (Azure, Cloudflare, Vertex) and real
 * `Models.login` flows, but never touch the network: the flows under test only
 * collect prompts. They assert the consumer-visible contracts — persistence,
 * serialization, release of secrets from wire snapshots, honest terminal
 * states, and rejection of invalid provider configuration.
 *
 * Native login progress is driven entirely by microtasks (promises and
 * synchronous file writes), so the helpers drain microtasks instead of waiting
 * on wall-clock timers.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createModels,
  createProvider,
  envApiKeyAuth,
  type AuthContext,
  type MutableModels,
  type Provider,
  type ProviderAuth,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { AppError } from "../src/server/app-text.ts";
import { EmitCredentialStore } from "../src/server/credentials.ts";
import { ProviderAuthError, ProviderAuthSessions } from "../src/server/provider-auth.ts";
import { configureBuiltinLogin, normalizeCustomProviders } from "../src/server/providers.ts";
import { ModelCatalog } from "../src/server/models.ts";
import type { AuthSessionDTO, CustomProviderConfigDTO } from "../src/shared/contracts.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "emit-credentials-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const NO_FILES: AuthContext = { env: async () => undefined, fileExists: async () => false };

const REFRESH_OK = async () => ({ aborted: false, errors: new Map<string, Error>() });

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

async function drain(): Promise<void> {
  for (let index = 0; index < 50; index += 1) await Promise.resolve();
}

async function waitFor(
  sessions: ProviderAuthSessions,
  id: string,
  predicate: (snapshot: AuthSessionDTO) => boolean,
): Promise<AuthSessionDTO> {
  for (let index = 0; index < 200; index += 1) {
    const snapshot = sessions.get(id);
    if (predicate(snapshot)) return snapshot;
    await drain();
  }
  return sessions.get(id);
}

const waitForPrompt = (sessions: ProviderAuthSessions, id: string) =>
  waitFor(sessions, id, (snapshot) => snapshot.prompt !== null || TERMINAL.has(snapshot.status));

const waitForStatus = (sessions: ProviderAuthSessions, id: string, status: string) =>
  waitFor(sessions, id, (snapshot) => snapshot.status === status);

function requirePrompt(snapshot: AuthSessionDTO): NonNullable<AuthSessionDTO["prompt"]> {
  if (snapshot.prompt === null) throw new Error(`期望有提示，实际状态是 ${snapshot.status}：${snapshot.message ?? ""}`);
  return snapshot.prompt;
}

function captureThrownError(action: () => unknown): Error {
  let caught: unknown;
  expect(() => {
    try {
      action();
    } catch (error) {
      caught = error;
      throw error;
    }
  }).toThrow();
  if (!(caught instanceof Error)) throw new Error("Expected action to throw an Error");
  return caught;
}

function appErrorText(error: AppError): string {
  return [error.message, error.messageLocalized?.en, error.messageLocalized?.["zh-CN"]]
    .filter((value): value is string => value !== undefined)
    .join("\n");
}


/** Answer the current prompt and return the next state (prompt or terminal). */
async function answer(
  sessions: ProviderAuthSessions,
  id: string,
  value: string,
): Promise<AuthSessionDTO> {
  const current = requirePrompt(sessions.get(id));
  sessions.respond(id, current.id, value);
  return waitForPrompt(sessions, id);
}

function customConfig(overrides: Partial<CustomProviderConfigDTO> = {}): CustomProviderConfigDTO {
  return {
    id: "local",
    name: "Local",
    baseUrl: "http://127.0.0.1:1/v1",
    api: "openai-completions",
    apiKeyEnv: "",
    models: [{ id: "m1", name: "M1", contextWindow: 4096, maxTokens: 256, reasoning: false, input: ["text"] }],
    ...overrides,
  };
}

function testProvider(id: string, auth: ProviderAuth): Provider {
  return createProvider({
    id,
    name: id,
    auth,
    models: [
      {
        id: "m1",
        name: "M1",
        api: "openai-completions",
        provider: id,
        baseUrl: "http://127.0.0.1:1/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 4096,
        maxTokens: 256,
      },
    ],
    api: { "openai-completions": openAICompletionsApi() },
  });
}

function sessionsFor(
  store: EmitCredentialStore,
  models: MutableModels,
): ProviderAuthSessions {
  return new ProviderAuthSessions(models, () => store.deviceId, REFRESH_OK);
}

describe("credential store", () => {
  it("serializes concurrent writes and preserves the committed state across reopen", async () => {
    const store = await EmitCredentialStore.open(dir);
    let observed: unknown;
    await Promise.all([
      store.modify("p", async () => ({ type: "api_key", key: "one" })),
      store.modify("p", async (current) => {
        observed = current;
        return { type: "api_key", key: "two" };
      }),
    ]);
    expect(observed).toEqual({ type: "api_key", key: "one" });

    const reopened = await EmitCredentialStore.open(dir);
    expect(await reopened.read("p")).toEqual({ type: "api_key", key: "two" });
    expect(await reopened.list()).toEqual([{ providerId: "p", type: "api_key" }]);
  });

  it("persists provider list and catalog cache together, and drops both on removal", async () => {
    const store = await EmitCredentialStore.open(dir);
    const config = customConfig({ apiKeyEnv: "LOCAL_KEY" });
    await Promise.all([store.replaceProviders([config]), store.modelsStore.write("local", { models: [] })]);
    await store.modify("local", async () => ({ type: "api_key", key: "secret" }));

    const reopened = await EmitCredentialStore.open(dir);
    expect(await reopened.configuration().providers).toEqual([config]);
    expect(await reopened.modelsStore.read("local")).toEqual({ models: [] });
    expect(await reopened.read("local")).toEqual({ type: "api_key", key: "secret" });

    await reopened.replaceProviders([]);
    expect(await reopened.read("local")).toBeUndefined();
    expect(await reopened.modelsStore.read("local")).toBeUndefined();
    expect((await EmitCredentialStore.open(dir)).configuration().providers).toEqual([]);
  });

  it("drops a saved key when a provider switches from keyed to keyless", async () => {
    const store = await EmitCredentialStore.open(dir);
    await store.replaceProviders([customConfig({ apiKeyEnv: "LOCAL_KEY" })]);
    await store.modify("local", async () => ({ type: "api_key", key: "secret" }));
    await store.replaceProviders([customConfig({ apiKeyEnv: "" })]);
    expect(await store.read("local")).toBeUndefined();
  });

  it("writes owner-only permissions and keeps the device id stable across reopen", async () => {
    const store = await EmitCredentialStore.open(dir);
    expect(store.deviceId.length).toBeGreaterThan(0);
    expect(statSync(join(dir, "credentials.json")).mode & 0o777).toBe(0o600);
    expect((await EmitCredentialStore.open(dir)).deviceId).toBe(store.deviceId);
  });

  it("opens a legacy file that only has env and providers", async () => {
    const legacy = { env: { KEEP_ME: "1" }, providers: [customConfig()] };
    writeFileSync(join(dir, "credentials.json"), JSON.stringify(legacy));
    const reopened = await EmitCredentialStore.open(dir);
    expect(reopened.configuration().env).toEqual({ KEEP_ME: "1" });
    expect(reopened.configuration().providers).toEqual([customConfig()]);
    expect(reopened.deviceId.length).toBeGreaterThan(0);
  });

  it.skipIf(typeof process.getuid === "function" && process.getuid() === 0)(
    "does not publish an in-memory credential when the write fails",
    async () => {
      const store = await EmitCredentialStore.open(dir);
      chmodSync(dir, 0o500);
      try {
        await expect(store.modify("p", async () => ({ type: "api_key", key: "x" }))).rejects.toThrow();
      } finally {
        chmodSync(dir, 0o700);
      }
      expect(await store.read("p")).toBeUndefined();
      expect(JSON.parse(readFileSync(join(dir, "credentials.json"), "utf8")).auth).toEqual({});
    },
  );
});

describe("native provider status", () => {
  it("reports every native provider with its auth methods and no secrets", async () => {
    const store = await EmitCredentialStore.open(dir);
    const catalog = new ModelCatalog([], { credentials: store, modelsStore: store.modelsStore });
    const statuses = await catalog.providerStatuses();
    expect(statuses.length).toBe(42);

    const azure = statuses.find((status) => status.providerId === "azure-openai-responses");
    expect(azure?.authMethods).toEqual([
      { type: "api_key", label: "Azure OpenAI API key", interactive: true, subscription: false },
    ]);

    const openaiCodex = statuses.find((status) => status.providerId === "openai-codex");
    expect(openaiCodex?.authMethods.map((method) => method.type)).toEqual(["oauth"]);

    const anthropic = statuses.find((status) => status.providerId === "anthropic");
    expect(anthropic?.authMethods.map((method) => method.type)).toEqual(["api_key", "oauth"]);
    expect(anthropic?.authMethods[1]?.subscription).toBe(true);

    // A stored secret must never reach the status payload.
    await store.modify("openai", async () => ({ type: "api_key", key: "sk-leak-check" }));
    const withCredential = await catalog.providerStatuses();
    expect(JSON.stringify(withCredential)).not.toContain("sk-leak-check");
    expect(withCredential.find((status) => status.providerId === "openai")?.storedAuthType).toBe("api_key");
  });

  it("marks model availability per credential rather than per provider", async () => {
    const store = await EmitCredentialStore.open(dir);
    const catalog = new ModelCatalog([customConfig()], { credentials: store, modelsStore: store.modelsStore });
    const models = await catalog.catalog();
    expect(models.find((model) => model.providerId === "local")?.configured).toBe(true);
  });
});

describe("custom provider validation", () => {
  const builtins = new Set(["openai"]);

  it("fills defaults and rejects an invalid submission as a whole", () => {
    const normalized = normalizeCustomProviders(
      [{ id: "gateway", baseUrl: "https://gw.example.com/v1", api: "openai-responses", models: [{ id: "m" }] }],
      builtins,
    );
    expect(normalized[0]?.name).toBe("gateway");
    expect(normalized[0]?.apiKeyEnv).toBe("");
    expect(normalized[0]?.models[0]).toEqual({
      id: "m",
      name: "m",
      contextWindow: 32768,
      maxTokens: 8192,
      reasoning: false,
      input: ["text"],
    });

    const base = { id: "a", baseUrl: "https://x.test/v1", api: "openai-completions", models: [{ id: "m" }] };

    const conflictingBuiltin = captureThrownError(() =>
      normalizeCustomProviders([{ ...base, id: "openai" }], builtins),
    );
    expect(conflictingBuiltin).toBeInstanceOf(AppError);
    expect(appErrorText(conflictingBuiltin as AppError)).toContain("openai");

    expect(
      captureThrownError(() =>
        normalizeCustomProviders([{ ...base, baseUrl: "https://user:pass@x.test/v1" }], builtins),
      ),
    ).toBeInstanceOf(AppError);
    expect(
      captureThrownError(() => normalizeCustomProviders([{ ...base, baseUrl: "ftp://x.test" }], builtins)),
    ).toBeInstanceOf(AppError);
    expect(
      captureThrownError(() => normalizeCustomProviders([{ ...base, api: "nope" }], builtins)),
    ).toBeInstanceOf(AppError);
    expect(captureThrownError(() => normalizeCustomProviders([{ ...base, models: [] }], builtins))).toBeInstanceOf(
      AppError,
    );

    const duplicateModelId = captureThrownError(() =>
      normalizeCustomProviders([{ ...base, models: [{ id: "m" }, { id: "m" }] }], builtins),
    );
    expect(duplicateModelId).toBeInstanceOf(AppError);
    expect(appErrorText(duplicateModelId as AppError)).toContain("m");

    expect(
      captureThrownError(() => normalizeCustomProviders([{ ...base, apiKeyEnv: "lower" }], builtins)),
    ).toBeInstanceOf(AppError);
    expect(
      captureThrownError(() =>
        normalizeCustomProviders([{ ...base, models: [{ id: "m", contextWindow: -1 }] }], builtins),
      ),
    ).toBeInstanceOf(AppError);
  });

  it("resolves a keyless endpoint and leaves native providers alone when customs are cleared", async () => {
    const store = await EmitCredentialStore.open(dir);
    const catalog = new ModelCatalog([customConfig()], { credentials: store, modelsStore: store.modelsStore });
    expect(await catalog.models.getAuth("local")).toBeDefined();

    catalog.applyCustomProviders([]);
    expect(catalog.models.getProvider("local")).toBeUndefined();
    expect(catalog.models.getProvider("openai")).toBeDefined();
  });
});

describe("provider auth sessions", () => {
  async function keyedModels(store: EmitCredentialStore): Promise<MutableModels> {
    const models = createModels({ credentials: store, modelsStore: store.modelsStore, authContext: NO_FILES });
    models.setProvider(testProvider("test-key", { apiKey: envApiKeyAuth("Test Key", ["TEST_KEY_ENV"]) }));
    return models;
  }

  it("runs an API key login, persists it, and never exposes the key", async () => {
    const store = await EmitCredentialStore.open(dir);
    const models = await keyedModels(store);
    const refreshed: string[] = [];
    const sessions = new ProviderAuthSessions(models, () => store.deviceId, async (providerId) => {
      refreshed.push(providerId);
      return { aborted: false, errors: new Map() };
    });

    const started = sessions.start("test-key", "api_key");
    const prompt = requirePrompt(sessions.get(started.id));
    expect(prompt.type).toBe("secret");
    sessions.respond(started.id, prompt.id, "sk-super-secret");

    const done = await waitForStatus(sessions, started.id, "succeeded");
    expect(done.message).toBeNull();
    expect(refreshed).toEqual(["test-key"]);
    expect(JSON.stringify(done)).not.toContain("sk-super-secret");

    expect(await store.read("test-key")).toEqual({ type: "api_key", key: "sk-super-secret" });
    expect(await models.checkAuth("test-key")).toMatchObject({ type: "api_key" });
    expect(await store.list()).toEqual([{ providerId: "test-key", type: "api_key" }]);

    await models.logout("test-key");
    expect(await store.read("test-key")).toBeUndefined();
    expect(await models.checkAuth("test-key")).toBeUndefined();
  });

  it("reports a refresh failure as a succeeded login with a note", async () => {
    const store = await EmitCredentialStore.open(dir);
    const models = await keyedModels(store);
    const sessions = new ProviderAuthSessions(models, () => store.deviceId, async () => ({
      aborted: false,
      errors: new Map([["test-key", new Error("目录不可用")]]),
    }));

    const started = sessions.start("test-key", "api_key");
    const prompt = requirePrompt(sessions.get(started.id));
    sessions.respond(started.id, prompt.id, "sk");

    const done = await waitForStatus(sessions, started.id, "succeeded");
    expect(done.status).toBe("succeeded");
    expect(await store.read("test-key")).toEqual({ type: "api_key", key: "sk" });
    expect(done.message).toContain("目录不可用");
    expect(done.messageLocalized?.en).toContain("目录不可用");
  });

  it("allows only one login at a time and rejects stale or empty answers", async () => {
    const store = await EmitCredentialStore.open(dir);
    const models = await keyedModels(store);
    models.setProvider(testProvider("b", { apiKey: envApiKeyAuth("B", []) }));
    const sessions = sessionsFor(store, models);

    const started = sessions.start("test-key", "api_key");
    expect(() => sessions.start("b", "api_key")).toThrowError(ProviderAuthError);
    try {
      sessions.start("b", "api_key");
    } catch (error) {
      expect((error as ProviderAuthError).status).toBe(409);
    }

    const prompt = requirePrompt(sessions.get(started.id));
    const stalePrompt = captureThrownError(() => sessions.respond(started.id, "wrong-id", "x"));
    expect(stalePrompt).toBeInstanceOf(ProviderAuthError);
    expect((stalePrompt as ProviderAuthError).status).toBe(409);

    const emptySecret = captureThrownError(() => sessions.respond(started.id, prompt.id, ""));
    expect(emptySecret).toBeInstanceOf(ProviderAuthError);
    expect((emptySecret as ProviderAuthError).status).toBe(400);
    sessions.respond(started.id, prompt.id, "ok");
    await waitForStatus(sessions, started.id, "succeeded");
  });

  it("cancels a pending login without persisting a credential", async () => {
    const store = await EmitCredentialStore.open(dir);
    const models = await keyedModels(store);
    const sessions = sessionsFor(store, models);

    const started = sessions.start("test-key", "api_key");
    const cancelled = await sessions.cancel(started.id);
    expect(cancelled.status).toBe("cancelled");
    expect(await store.read("test-key")).toBeUndefined();
    await sessions.close();
  });

  it("reports a completed login honestly even when cancel arrives after commit", async () => {
    const store = await EmitCredentialStore.open(dir);
    const models = createModels({ credentials: store, authContext: NO_FILES });
    models.setProvider(
      testProvider("instant", {
        apiKey: {
          name: "Instant",
          login: async () => ({ type: "api_key", key: "k" }),
          resolve: async () => ({ auth: { apiKey: "k" } }),
        },
      }),
    );
    const sessions = sessionsFor(store, models);
    const started = sessions.start("instant", "api_key");
    await waitForStatus(sessions, started.id, "succeeded");
    const afterCancel = await sessions.cancel(started.id);
    expect(afterCancel.status).toBe("succeeded");
    expect(await store.read("instant")).toEqual({ type: "api_key", key: "k" });
  });

  it("cancels and waits out a login for one provider before another surface adopts it", async () => {
    const store = await EmitCredentialStore.open(dir);
    const models = await keyedModels(store);
    const sessions = sessionsFor(store, models);
    const started = sessions.start("test-key", "api_key");
    await sessions.cancelProvider("test-key");
    expect(sessions.get(started.id).status).toBe("cancelled");
    expect(await store.read("test-key")).toBeUndefined();
  });
});

describe("native login flows", () => {
  function nativeModels(store: EmitCredentialStore, authContext: AuthContext = NO_FILES): MutableModels {
    return builtinModels({ credentials: store, modelsStore: store.modelsStore, authContext });
  }

  it("collects Azure endpoint parameters into the stored credential", async () => {
    const store = await EmitCredentialStore.open(dir);
    const models = nativeModels(store);
    configureBuiltinLogin(models);
    const sessions = sessionsFor(store, models);

    const started = sessions.start("azure-openai-responses", "api_key");
    const secret = requirePrompt(sessions.get(started.id));
    expect(secret.type).toBe("secret");
    expect(secret.id.length).toBeGreaterThan(0);
    expect(secret.message).toBe("Enter Azure OpenAI API key");
    expect(secret.messageLocalized).toBeUndefined();
    expect(secret.options).toBeUndefined();
    sessions.respond(started.id, secret.id, "azure-key");

    let next = await waitForPrompt(sessions, started.id);
    const endpointMode = requirePrompt(next);
    expect(endpointMode.id.length).toBeGreaterThan(0);
    expect(endpointMode.type).toBe("select");
    expect(endpointMode.messageLocalized?.["zh-CN"]).toBe(endpointMode.message);
    expect(endpointMode.options?.map((option) => option.id)).toEqual(["base-url", "resource-name"]);
    expect(endpointMode.options?.map((option) => option.label)).toEqual(["Base URL", "Resource name"]);
    expect(
      endpointMode.options?.every(
        (option) => option.descriptionLocalized?.["zh-CN"] === option.description,
      ),
    ).toBe(true);
    sessions.respond(started.id, endpointMode.id, "base-url");

    next = await waitForPrompt(sessions, started.id);
    sessions.respond(started.id, requirePrompt(next).id, "not a url");
    const retry = await waitForPrompt(sessions, started.id);
    expect(retry.events.some((event) => event.type === "info")).toBe(true);
    sessions.respond(started.id, requirePrompt(retry).id, "https://res.openai.azure.com/openai/v1");

    next = await waitForPrompt(sessions, started.id);
    const apiVersion = requirePrompt(next);
    expect(apiVersion.id.length).toBeGreaterThan(0);
    expect(apiVersion.type).toBe("text");
    expect(apiVersion.options).toBeUndefined();
    expect(apiVersion.messageLocalized?.["zh-CN"]).toBe(apiVersion.message);
    sessions.respond(started.id, apiVersion.id, "");

    next = await waitForPrompt(sessions, started.id);
    const deploymentMap = requirePrompt(next);
    expect(deploymentMap.id.length).toBeGreaterThan(0);
    expect(deploymentMap.type).toBe("text");
    expect(deploymentMap.options).toBeUndefined();
    expect(deploymentMap.messageLocalized?.["zh-CN"]).toBe(deploymentMap.message);
    sessions.respond(started.id, deploymentMap.id, "gpt-4o=deploy-a");

    const done = await waitForStatus(sessions, started.id, "succeeded");
    expect(JSON.stringify(done)).not.toContain("azure-key");

    const credential = await store.read("azure-openai-responses");
    if (credential?.type !== "api_key") throw new Error("缺少已保存的 Azure 凭据");
    expect(credential.env).toMatchObject({
      AZURE_OPENAI_BASE_URL: "https://res.openai.azure.com/openai/v1",
      AZURE_OPENAI_DEPLOYMENT_NAME_MAP: "gpt-4o=deploy-a",
    });
    expect(credential.env?.AZURE_OPENAI_API_VERSION).toBeUndefined();
    const auth = await models.getAuth("azure-openai-responses");
    expect(auth?.env?.AZURE_OPENAI_BASE_URL).toBe("https://res.openai.azure.com/openai/v1");
  });

  it("runs the native Cloudflare multi-step login and keeps its env", async () => {
    const store = await EmitCredentialStore.open(dir);
    const models = nativeModels(store);
    const sessions = sessionsFor(store, models);

    const started = sessions.start("cloudflare-workers-ai", "api_key");
    const secret = requirePrompt(sessions.get(started.id));
    expect(secret.type).toBe("secret");
    sessions.respond(started.id, secret.id, "cf-key");

    const next = await waitForPrompt(sessions, started.id);
    expect(requirePrompt(next).type).toBe("text");
    sessions.respond(started.id, requirePrompt(next).id, "account-42");

    await waitForStatus(sessions, started.id, "succeeded");
    expect((await store.read("cloudflare-workers-ai"))?.env).toMatchObject({ CLOUDFLARE_ACCOUNT_ID: "account-42" });
    expect((await models.getAuth("cloudflare-workers-ai"))?.env?.CLOUDFLARE_ACCOUNT_ID).toBe("account-42");
  });

  it("reports Vertex ADC as unconfigured when the credentials file is absent, and configured when present", async () => {
    const store = await EmitCredentialStore.open(dir);
    const missing = nativeModels(store, { env: async () => undefined, fileExists: async () => false });
    const missingSessions = sessionsFor(store, missing);

    const started = missingSessions.start("google-vertex", "api_key");
    await answer(missingSessions, started.id, "adc");
    await answer(missingSessions, started.id, "proj");
    await answer(missingSessions, started.id, "us-central1");
    await waitForStatus(missingSessions, started.id, "succeeded");
    expect(await missing.checkAuth("google-vertex")).toBeUndefined();

    const present = nativeModels(store, { env: async () => undefined, fileExists: async () => true });
    const presentSessions = sessionsFor(store, present);
    const second = presentSessions.start("google-vertex", "api_key");
    // A second login for the same provider is only legal once the first settled;
    // the credential already exists in the shared store, but the flow replaces it.
    await answer(presentSessions, second.id, "adc");
    await answer(presentSessions, second.id, "proj");
    await answer(presentSessions, second.id, "us-central1");
    await waitForStatus(presentSessions, second.id, "succeeded");
    expect(await present.checkAuth("google-vertex")).toMatchObject({ type: "api_key" });
  });
});
