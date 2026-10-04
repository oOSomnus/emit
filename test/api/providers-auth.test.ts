import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AuthSessionDTO, CheckResultDTO, ModelInfoDTO, ProviderStatusDTO } from "../../src/shared/contracts.ts";
import { createFixtureOAuthProvider } from "../helpers/oauth-fixture.ts";
import { startOAuthTokenServer } from "../helpers/oauth-token-server.ts";
import { providerConfig, startHttpRuntime } from "../helpers/emit-fixture.ts";
import type { HttpRuntimeFixture } from "../helpers/emit-fixture.ts";
import { startProviderProcess } from "../helpers/provider-process.ts";
import { openEventStream } from "../helpers/sse-client.ts";

type HttpResult<T> = { status: number; body: T };
type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

type ModelCatalogResponse = { models: ModelInfoDTO[]; providers: ProviderStatusDTO[] };

async function request<T>(
  baseUrl: string,
  method: Method,
  path: string,
  body?: unknown,
): Promise<HttpResult<T>> {
  const response = await fetch(new URL(path, baseUrl), {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  return { status: response.status, body: (text.length === 0 ? undefined : JSON.parse(text)) as T };
}

async function waitForSession(
  baseUrl: string,
  id: string,
  predicate: (session: AuthSessionDTO) => boolean,
  description: string,
): Promise<AuthSessionDTO> {
  let latest: AuthSessionDTO | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await request<AuthSessionDTO>(baseUrl, "GET", `/api/auth/sessions/${id}`);
    if (result.status !== 200) throw new Error(`GET auth session returned ${result.status}`);
    latest = result.body;
    if (predicate(latest)) return latest;
  }
  throw new Error(`Timed out waiting for ${description}; latest session: ${JSON.stringify(latest)}`);
}

function isTerminal(session: AuthSessionDTO): boolean {
  return session.status === "succeeded" || session.status === "failed" || session.status === "cancelled";
}

describe("provider and authentication HTTP contracts", () => {
  it("configures, selects, checks, refreshes, and removes a custom provider credential without publishing it", async () => {
    const root = mkdtempSync(join(tmpdir(), "emit-api-provider-auth-"));
    const dataDir = join(root, "data");
    const canary = "fixture-custom-api-key-canary";
    let providerClose: (() => Promise<void>) | undefined;
    let httpFixture: HttpRuntimeFixture | undefined;
    let closeEvents: (() => Promise<void>) | undefined;
    try {
      const provider = await startProviderProcess(root);
      providerClose = provider.close;
      const http = await startHttpRuntime(dataDir);
      httpFixture = http;
      const events = await openEventStream(`${http.url}/api/events`);
      closeEvents = events.close;

      const draft = providerConfig(provider.baseUrl);
      const put = await request<{ providers: Array<{ id: string; name: string; apiKeyEnv: string }>; statuses: ProviderStatusDTO[] }>(
        http.url,
        "PUT",
        "/api/providers/custom",
        { providers: [draft] },
      );
      expect(put.status).toBe(200);
      expect(put.body.providers).toMatchObject([{ id: "fake", name: "Fake Provider", apiKeyEnv: "EMIT_MAIL_TEST_KEY" }]);
      expect((await request<{ providers: Array<{ id: string }> }>(http.url, "GET", "/api/providers/custom")).body.providers)
        .toMatchObject([{ id: "fake" }]);

      const initialCatalog = await request<ModelCatalogResponse>(http.url, "GET", "/api/models");
      expect(initialCatalog.body.models.find((model) => model.providerId === "fake" && model.modelId === "fake-chat"))
        .toMatchObject({ configured: false });
      expect(initialCatalog.body.providers.find((provider) => provider.providerId === "fake"))
        .toMatchObject({ custom: true, configured: false, storedAuthType: null });

      const started = await request<AuthSessionDTO>(http.url, "POST", "/api/auth/sessions", {
        providerId: "fake",
        type: "api_key",
      });
      expect(started.status).toBe(201);
      const promptSession = await waitForSession(
        http.url,
        started.body.id,
        (session) => session.prompt !== null || isTerminal(session),
        "custom provider key prompt",
      );
      expect(promptSession.prompt?.type).toBe("secret");
      const promptId = promptSession.prompt?.id;
      if (promptId === undefined) throw new Error("Custom provider did not request a key");
      const emptySecret = await request(http.url, "POST", `/api/auth/sessions/${started.body.id}/respond`, { promptId, value: "" });
      expect(emptySecret.status).toBe(400);
      expect((await request<AuthSessionDTO>(http.url, "GET", `/api/auth/sessions/${started.body.id}`)).body.prompt?.id).toBe(promptId);

      const submitted = await request<AuthSessionDTO>(http.url, "POST", `/api/auth/sessions/${started.body.id}/respond`, {
        promptId,
        value: canary,
      });
      expect(submitted.status).toBe(200);
      const completed = await waitForSession(
        http.url,
        started.body.id,
        isTerminal,
        "custom provider key login",
      );
      expect(completed.status).toBe("succeeded");
      const cancelledAfterCommit = await request<AuthSessionDTO>(http.url, "DELETE", `/api/auth/sessions/${started.body.id}`);
      expect(cancelledAfterCommit.body.status).toBe("succeeded");
      expect(JSON.stringify([started.body, promptSession, submitted.body, completed])).not.toContain(canary);

      const catalogAfterLogin = await request<ModelCatalogResponse>(http.url, "GET", "/api/models");
      expect(catalogAfterLogin.body.models.find((model) => model.providerId === "fake" && model.modelId === "fake-chat"))
        .toMatchObject({ configured: true });
      expect(catalogAfterLogin.body.providers.find((provider) => provider.providerId === "fake"))
        .toMatchObject({ custom: true, configured: true, storedAuthType: "api_key" });

      const selected = {
        model: { providerId: "fake", modelId: "fake-chat" },
        effort: "off",
      };
      const setup = await request<unknown>(http.url, "POST", "/api/setup", {
        workspaceName: "Auth Fixture Workspace",
        userName: "Auth Fixture User",
        defaultExecutionModel: selected,
        approval: {
          kind: "llm",
          model: { providerId: "fake", modelId: "fake-reviewer" },
          effort: "off",
          criteriaVersion: 3,
        },
      });
      expect(setup.status).toBe(200);
      const app = await request<{ defaultExecutionModel: typeof selected }>(http.url, "GET", "/api/app");
      expect(app.body.defaultExecutionModel).toEqual(selected);
      expect((await request(http.url, "PATCH", "/api/app", { workspaceName: "Edited Auth Workspace" })).status).toBe(200);
      const appEvent = await events.next((event) => event.type === "app");
      expect(appEvent).toMatchObject({ type: "app", app: { defaultExecutionModel: selected } });
      expect(JSON.stringify(appEvent)).not.toContain(canary);

      const check = await request<CheckResultDTO>(http.url, "POST", "/api/models/check", {
        model: { providerId: "fake", modelId: "fake-chat" },
        kind: "chat",
      });
      expect(check.status).toBe(200);
      expect(check.body.ok).toBe(true);

      const refresh = await request<{ ok: boolean }>(http.url, "POST", "/api/providers/fake/refresh");
      expect(refresh.status).toBe(200);
      expect(refresh.body.ok).toBe(true);

      const deleted = await request<{ ok: boolean }>(http.url, "DELETE", "/api/providers/fake/credential");
      expect(deleted.status).toBe(200);
      expect(deleted.body.ok).toBe(true);
      const catalogAfterDelete = await request<ModelCatalogResponse>(http.url, "GET", "/api/models");
      expect(catalogAfterDelete.body.models.find((model) => model.providerId === "fake" && model.modelId === "fake-chat"))
        .toMatchObject({ configured: false });
      expect(catalogAfterDelete.body.providers.find((provider) => provider.providerId === "fake"))
        .toMatchObject({ configured: false, storedAuthType: null });
      const allPublicData = JSON.stringify([put.body, initialCatalog.body, catalogAfterLogin.body, setup.body, app.body,
        check.body, refresh.body, deleted.body, catalogAfterDelete.body]);
      expect(allPublicData).not.toContain(canary);
    } finally {
      await closeEvents?.();
      await httpFixture?.close();
      await providerClose?.();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs OAuth login, single-use concurrent token refresh, failure, cancellation, and public-secret checks", async () => {
    const root = mkdtempSync(join(tmpdir(), "emit-api-oauth-auth-"));
    const dataDir = join(root, "data");
    const accessCanary = "fixture-access-1";
    const refreshCanary = "fixture-refresh-1";
    const tokenServer = await startOAuthTokenServer();
    tokenServer.setLifetimeSeconds(0);
    let httpFixture: HttpRuntimeFixture | undefined;
    let closeEvents: (() => Promise<void>) | undefined;
    try {
      const http = await startHttpRuntime(dataDir);
      httpFixture = http;
      expect((await request(http.url, "PUT", "/api/providers/custom", { providers: [providerConfig(`${tokenServer.url}/v1`)] })).status).toBe(200);
      http.runtime.catalog.models.setProvider(createFixtureOAuthProvider(tokenServer.url));
      const events = await openEventStream(`${http.url}/api/events`);
      closeEvents = events.close;

      const started = await request<AuthSessionDTO>(http.url, "POST", "/api/auth/sessions", {
        providerId: "fixture-oauth",
        type: "oauth",
      });
      expect(started.status).toBe(201);
      const promptSession = await waitForSession(
        http.url,
        started.body.id,
        (session) => session.prompt !== null || isTerminal(session),
        "OAuth manual-code prompt",
      );
      expect(promptSession.prompt?.type).toBe("manual_code");
      expect(promptSession.events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "auth_url", url: `${tokenServer.url}/authorize` }),
        expect.objectContaining({ type: "device_code", userCode: "FIXTURE-CODE" }),
      ]));
      const promptId = promptSession.prompt?.id;
      if (promptId === undefined) throw new Error("OAuth provider did not request a manual code");

      const competing = await request<unknown>(http.url, "POST", "/api/auth/sessions", {
        providerId: "fixture-oauth",
        type: "oauth",
      });
      expect(competing.status).toBe(409);
      const differentProvider = await request(http.url, "POST", "/api/auth/sessions", { providerId: "fake", type: "api_key" });
      expect(differentProvider.status).toBe(409);
      const stalePrompt = await request<unknown>(http.url, "POST", `/api/auth/sessions/${started.body.id}/respond`, {
        promptId: "stale-prompt-id",
        value: "fixture-code",
      });
      expect(stalePrompt.status).toBe(409);
      const invalidValue = await request<unknown>(http.url, "POST", `/api/auth/sessions/${started.body.id}/respond`, {
        promptId,
        value: 42,
      });
      expect(invalidValue.status).toBe(400);

      const submitted = await request<AuthSessionDTO>(http.url, "POST", `/api/auth/sessions/${started.body.id}/respond`, {
        promptId,
        value: "fixture-code",
      });
      expect(submitted.status).toBe(200);
      const completed = await waitForSession(
        http.url,
        started.body.id,
        isTerminal,
        "OAuth login",
      );
      expect(completed.status).toBe("succeeded");
      expect(JSON.stringify([started.body, promptSession, submitted.body, completed])).not.toContain(accessCanary);
      expect(JSON.stringify([started.body, promptSession, submitted.body, completed])).not.toContain(refreshCanary);

      const initialCredential = await http.runtime.credentialStore.read("fixture-oauth");
      expect(initialCredential).toMatchObject({
        type: "oauth",
        access: accessCanary,
        refresh: refreshCanary,
      });
      if (initialCredential?.type !== "oauth") throw new Error("OAuth login did not store a native OAuth credential");
      expect(initialCredential.expires).toBeLessThanOrEqual(Date.now());

      tokenServer.setLifetimeSeconds(3600);
      const concurrentAuth = await Promise.all(
        Array.from({ length: 20 }, () => http!.runtime.catalog.models.getAuth("fixture-oauth")),
      );
      expect(concurrentAuth).toHaveLength(20);
      expect(concurrentAuth.every((auth) => auth?.auth.apiKey === "fixture-access-2")).toBe(true);
      expect(tokenServer.acceptsAccess("fixture-access-2")).toBe(true);
      expect(tokenServer.acceptsAccess(accessCanary)).toBe(false);
      const rotatedCredential = await http.runtime.credentialStore.read("fixture-oauth");
      expect(rotatedCredential).toMatchObject({
        type: "oauth",
        access: "fixture-access-2",
        refresh: "fixture-refresh-2",
      });

      const catalog = await request<ModelCatalogResponse>(http.url, "GET", "/api/models");
      expect(catalog.body.models.find((model) => model.providerId === "fixture-oauth" && model.modelId === "fixture-oauth-chat"))
        .toMatchObject({ configured: true });
      const selection = {
        model: { providerId: "fixture-oauth", modelId: "fixture-oauth-chat" },
        effort: "off",
      };
      const setup = await request<unknown>(http.url, "POST", "/api/setup", {
        workspaceName: "OAuth Fixture Workspace",
        userName: "OAuth Fixture User",
        defaultExecutionModel: selection,
        approval: {
          kind: "llm",
          model: selection.model,
          effort: selection.effort,
          criteriaVersion: 3,
        },
      });
      expect(setup.status).toBe(200);
      expect((await request(http.url, "PATCH", "/api/app", { workspaceName: "Edited OAuth Workspace" })).status).toBe(200);
      const appEvent = await events.next((event) => event.type === "app");
      expect(appEvent).toMatchObject({ type: "app", app: { defaultExecutionModel: selection } });
      expect(JSON.stringify([catalog.body, setup.body, appEvent])).not.toContain("fixture-access-2");
      expect(JSON.stringify([catalog.body, setup.body, appEvent])).not.toContain("fixture-refresh-2");

      const deleteStoredCredential = await request<{ ok: boolean }>(
        http.url,
        "DELETE",
        "/api/providers/fixture-oauth/credential",
      );
      expect(deleteStoredCredential.status).toBe(200);
      expect(await http.runtime.credentialStore.read("fixture-oauth")).toBeUndefined();

      tokenServer.setMode("invalid-grant");
      const failedStart = await request<AuthSessionDTO>(http.url, "POST", "/api/auth/sessions", {
        providerId: "fixture-oauth",
        type: "oauth",
      });
      expect(failedStart.status).toBe(201);
      const failedPrompt = await waitForSession(
        http.url,
        failedStart.body.id,
        (session) => session.prompt !== null || isTerminal(session),
        "failed OAuth prompt",
      );
      const failedPromptId = failedPrompt.prompt?.id;
      if (failedPromptId === undefined) throw new Error("OAuth failure flow did not request a code");
      await request<AuthSessionDTO>(http.url, "POST", `/api/auth/sessions/${failedStart.body.id}/respond`, {
        promptId: failedPromptId,
        value: "fixture-code",
      });
      const failed = await waitForSession(http.url, failedStart.body.id, isTerminal, "failed OAuth login");
      expect(failed.status).toBe("failed");
      expect(await http.runtime.credentialStore.read("fixture-oauth")).toBeUndefined();

      tokenServer.setMode("hang");
      const cancelStart = await request<AuthSessionDTO>(http.url, "POST", "/api/auth/sessions", {
        providerId: "fixture-oauth",
        type: "oauth",
      });
      expect(cancelStart.status).toBe(201);
      const cancelPrompt = await waitForSession(
        http.url,
        cancelStart.body.id,
        (session) => session.prompt !== null || isTerminal(session),
        "cancellable OAuth prompt",
      );
      const cancelPromptId = cancelPrompt.prompt?.id;
      if (cancelPromptId === undefined) throw new Error("OAuth cancellation flow did not request a code");
      await request<AuthSessionDTO>(http.url, "POST", `/api/auth/sessions/${cancelStart.body.id}/respond`, {
        promptId: cancelPromptId,
        value: "fixture-code",
      });
      const cancelled = await request<AuthSessionDTO>(http.url, "DELETE", `/api/auth/sessions/${cancelStart.body.id}`);
      expect(cancelled.status).toBe(200);
      expect(cancelled.body.status).toBe("cancelled");
      expect(await http.runtime.credentialStore.read("fixture-oauth")).toBeUndefined();
      expect(JSON.stringify([failed, cancelled.body])).not.toContain(accessCanary);
      expect(JSON.stringify([failed, cancelled.body])).not.toContain(refreshCanary);
    } finally {
      await closeEvents?.();
      await httpFixture?.close();
      await tokenServer.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("rejects an unknown native login option without consuming its prompt or saving credentials", async () => {
    const root = mkdtempSync(join(tmpdir(), "emit-api-auth-option-"));
    const http = await startHttpRuntime(join(root, "data"));
    try {
      const started = await request<AuthSessionDTO>(http.url, "POST", "/api/auth/sessions", { providerId: "azure-openai-responses", type: "api_key" });
      expect(started.status).toBe(201);
      const secret = await waitForSession(http.url, started.body.id, session => session.prompt !== null, "Azure secret prompt");
      if (secret.prompt === null) throw new Error("Missing secret prompt");
      expect((await request(http.url, "POST", `/api/auth/sessions/${started.body.id}/respond`, { promptId: secret.prompt.id, value: "fixture-azure-key" })).status).toBe(200);
      const selected = await waitForSession(http.url, started.body.id, session => session.prompt?.type === "select", "Azure endpoint selection");
      if (selected.prompt === null) throw new Error("Missing selection prompt");
      const rejected = await request(http.url, "POST", `/api/auth/sessions/${started.body.id}/respond`, { promptId: selected.prompt.id, value: "unknown-option" });
      expect(rejected.status).toBe(400);
      expect((await request<AuthSessionDTO>(http.url, "GET", `/api/auth/sessions/${started.body.id}`)).body.prompt?.id).toBe(selected.prompt.id);
      expect((await request<AuthSessionDTO>(http.url, "DELETE", `/api/auth/sessions/${started.body.id}`)).body.status).toBe("cancelled");
      expect(await http.runtime.credentialStore.read("azure-openai-responses")).toBeUndefined();
    } finally {
      await http.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
