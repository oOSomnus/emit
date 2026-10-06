import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AppConfigDTO, AuthSessionDTO, BootstrapDTO, EmployeeDTO, MessageDTO, ModelInfoDTO, ProviderStatusDTO, RoomDTO, WorkDTO, WorkExecutionDTO } from "../../src/shared/contracts.ts";
import type { E2eFixture } from "../helpers/e2e-fixture.ts";
import { FAKE_KEY_ENV, providerConfig, waitForFixture } from "../helpers/emit-fixture.ts";
import { startEmitProcess } from "../helpers/process-fixture.ts";
import { openOwnedE2eFixture, useSuiteCleanup } from "../helpers/suite-hooks.ts";

const cleanups = useSuiteCleanup({ errorMode: "propagate" });
async function call<T>(fixture: E2eFixture, path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fixture.request<T>(path, method, body);
  expect(response.status, `${method} ${path}: ${JSON.stringify(response.body)}`).toBe(200);
  return response.body;
}
async function keyWizard(fixture: E2eFixture, providerId: string, key: string) {
  const started = await fixture.request<AuthSessionDTO>("/api/auth/sessions", "POST", { providerId, type: "api_key" });
  expect(started.status).toBe(201);
  const auth = started.body;
  expect(auth).toMatchObject({ providerId, status: "waiting", prompt: { type: "secret" } });
  await call(fixture, `/api/auth/sessions/${auth.id}/respond`, "POST", { promptId: auth.prompt!.id, value: key });
  await waitForFixture(async () => (await call<AuthSessionDTO>(fixture, `/api/auth/sessions/${auth.id}`)).status === "succeeded", `${providerId} API key saved`);
  const done = await call<AuthSessionDTO>(fixture, `/api/auth/sessions/${auth.id}`);
  expect(done.prompt).toBeNull();
  expect(JSON.stringify(done)).not.toContain(key);
  expect(JSON.stringify(await call<BootstrapDTO>(fixture, "/api/bootstrap"))).not.toContain(key);
  return done;
}
type GoRequest = { model: string; sessionId: string };
async function goSessions(fixture: E2eFixture): Promise<GoRequest[]> {
  const response = await fetch(`${fixture.provider.url}/_opencode_sessions`, { signal: AbortSignal.timeout(10_000) });
  expect(response.status).toBe(200);
  return await response.json() as GoRequest[];
}

describe("real-process native key wizards and OpenCode Go", () => {
  it("authenticates a new custom provider through the native secret wizard despite the seeded fake key", async () => {
    const fixture = await openOwnedE2eFixture(cleanups);
    // A distinct provider and absent environment variable prevent the initial fake key from satisfying this wizard.
    const custom = { ...providerConfig(fixture.provider.baseUrl), id: "wizard-fixture", name: "向导测试接口", apiKeyEnv: "EMIT_TEST_WIZARD_KEY" };
    const created = await call<{ statuses: ProviderStatusDTO[] }>(fixture, "/api/providers/custom", "PUT", { providers: [providerConfig(fixture.provider.baseUrl), custom] });
    expect(created.statuses.find((entry) => entry.providerId === custom.id)).toMatchObject({ custom: true, storedAuthType: null, configured: false });
    const key = "private-native-wizard-key-canary";
    await keyWizard(fixture, custom.id, key);
    const catalog = await call<{ providers: ProviderStatusDTO[]; models: ModelInfoDTO[] }>(fixture, "/api/models");
    expect(catalog.providers.find((entry) => entry.providerId === custom.id)).toMatchObject({ configured: true, storedAuthType: "api_key" });
    expect(catalog.models.find((entry) => entry.providerId === custom.id && entry.modelId === "fake-chat")).toMatchObject({ configured: true });
    const saved = await call<{ providers: Array<{ id: string }> }>(fixture, "/api/providers/custom");
    expect(saved.providers.map((entry) => entry.id).sort()).toEqual(["fake", custom.id].sort());
    const check = await call<{ ok: boolean }>(fixture, "/api/models/check", "POST", { model: { providerId: custom.id, modelId: "fake-chat" }, kind: "chat" });
    expect(check.ok).toBe(true);
    await fixture.emit.stop();
    await fixture.emit.restart();
    expect((await call<{ providers: ProviderStatusDTO[] }>(fixture, "/api/models")).providers.find((entry) => entry.providerId === custom.id)).toMatchObject({ configured: true, storedAuthType: "api_key" });
    expect((await call<{ ok: boolean }>(fixture, "/api/models/check", "POST", { model: { providerId: custom.id, modelId: "fake-chat" }, kind: "chat" })).ok).toBe(true);
    expect(JSON.stringify(await call(fixture, "/api/bootstrap"))).not.toContain(key);
  }, 90_000);

  it("requires an independent reviewer at onboarding, rejects its removal, and generates a Chinese employee address", async () => {
    const fixture = await openOwnedE2eFixture(cleanups);
    await fixture.emit.stop();
    const empty = await startEmitProcess({ root: fixture.root, dataDir: join(fixture.root, "onboarding-data"), env: {
      [FAKE_KEY_ENV]: "local-onboarding-fixture-key", EMIT_TEST_ALLOWED_ORIGINS: JSON.stringify([fixture.provider.url]),
    } });
    cleanups.push(() => empty.stop());
    async function request<T>(path: string, method = "GET", body?: unknown) {
      const response = await fetch(new URL(path, empty.url), { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
      return { status: response.status, body: await response.json() as T };
    }
    expect((await request<BootstrapDTO>("/api/bootstrap")).body.app.onboarded).toBe(false);
    expect((await request("/api/providers/custom", "PUT", { providers: [providerConfig(fixture.provider.baseUrl)] })).status).toBe(200);
    const setup = { userName: "测试者", defaultExecutionModel: { model: { providerId: "fake", modelId: "fake-chat" }, effort: "off" } };
    const rejected = await request("/api/setup", "POST", { ...setup, approval: null });
    expect(rejected.status).toBe(400);
    expect((await request<BootstrapDTO>("/api/bootstrap")).body.app.onboarded).toBe(false);
    const approval = { kind: "llm", model: { providerId: "fake", modelId: "fake-reviewer" }, effort: "off", criteriaVersion: 3 };
    const configured = await request<AppConfigDTO>("/api/setup", "POST", { ...setup, approval });
    expect(configured.status).toBe(200);
    expect(configured.body).toMatchObject({ onboarded: true, approval });
    expect(configured.body.defaultExecutionModel?.model).not.toEqual(configured.body.approval?.model);
    const removal = await request<{ error: string }>("/api/app", "PATCH", { approval: null });
    expect(removal.status).toBe(400);
    expect(JSON.stringify(removal.body)).toMatch(/审批|reviewer|approval/i);
    expect((await request<AppConfigDTO>("/api/app")).body.approval).toEqual(configured.body.approval);
    const created = await request<EmployeeDTO>("/api/employees", "POST", {
      name: "小柯", role: "文档助手", instructions: "简洁回答。", executionModel: setup.defaultExecutionModel,
      toolPolicy: { allowedTools: ["read_file", "write_file", "edit_file", "run_shell", "load_skill"], trustedReadOnlyTools: [] }, generateAddress: true,
    });
    expect(created.status).toBe(200);
    expect(created.body.address).toMatch(/^[^@\s]+@[^@\s]+$/);
    expect(created.body.address.split("@")[0]).not.toBe("employee");
    expect((await request<BootstrapDTO>("/api/bootstrap")).body.employees).toContainEqual(created.body);
  }, 90_000);

  it("stores the Go key and sends distinct check/work sessions with stable multi-turn request headers", async () => {
    const fixture = await openOwnedE2eFixture(cleanups);
    const key = "private-go-wizard-key-canary";
    await keyWizard(fixture, "opencode-go", key);
    const goModel = { providerId: "opencode-go", modelId: "deepseek-v4.1-flash" };
    const beforeCheck = await goSessions(fixture);
    const check = await call<{ ok: boolean }>(fixture, "/api/models/check", "POST", { model: goModel, kind: "chat" });
    expect(check.ok).toBe(true);
    const checkRequests = (await goSessions(fixture)).slice(beforeCheck.length);
    expect(checkRequests.length).toBeGreaterThan(0);
    for (const request of checkRequests) {
      expect(request.model).toBe(goModel.modelId);
      expect(request.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    }
    const checkIds = new Set(checkRequests.map((request) => request.sessionId));
    expect(checkIds.size).toBe(1);
    writeFileSync(join(fixture.workRoot, "notes.txt"), "GO-PRIVATE-NOTES 中文笔记\n");
    const worker = await call<EmployeeDTO>(fixture, "/api/employees", "POST", {
      name: "Go 员工", role: "资料助手", instructions: "读取工作目录内的文件并汇报。", executionModel: { model: goModel, effort: "low" },
      toolPolicy: { allowedTools: ["read_file"], trustedReadOnlyTools: [] }, generateAddress: true,
    });
    const dm = await call<RoomDTO>(fixture, "/api/rooms", "POST", { kind: "dm", name: worker.name, employeeId: worker.id, workContextId: fixture.workspace.workContextId });
    const workSessions: string[] = [];
    for (const body of ["帮我读一下 notes.txt", "再读一次 notes.txt"]) {
      const offset = (await goSessions(fixture)).length;
      const started = await call<{ workIds: string[] }>(fixture, `/api/rooms/${dm.id}/messages`, "POST", { body });
      expect(started.workIds).toHaveLength(1);
      const workId = started.workIds[0]!;
      await waitForFixture(async () => (await call<WorkDTO[]>(fixture, "/api/works")).some((work) => work.id === workId && ["succeeded", "failed", "stopped"].includes(work.status)), `Go work ${workId}`);
      const execution = await call<WorkExecutionDTO>(fixture, `/api/works/${workId}/execution`);
      expect(execution.work, JSON.stringify(execution.work)).toMatchObject({ status: "succeeded" });
      const read = execution.steps.find((step) => step.kind === "tool-call" && step.toolName === "read_file");
      expect(JSON.parse(read!.arguments!)).toEqual({ path: "notes.txt" });
      expect(execution.steps).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "tool-result", isError: false, text: expect.stringContaining("GO-PRIVATE-NOTES 中文笔记") })]));
      const answers = (await call<{ messages: MessageDTO[] }>(fixture, `/api/rooms/${dm.id}/messages`)).messages.filter((message) => message.author.type === "employee" && message.workId === workId);
      expect(answers).toHaveLength(1);
      expect(answers[0]!.body).toBe(execution.work.answer);
      expect(execution.work.answer).toContain("已完成");
      const requests = (await goSessions(fixture)).slice(offset);
      expect(requests.length).toBeGreaterThanOrEqual(2); // read_file round and final answer round
      const durableId = requests[0]!.sessionId;
      expect(durableId).toMatch(/^[1-9]\d*$/);
      expect(requests.every((request) => request.sessionId === durableId && request.model === goModel.modelId)).toBe(true);
      expect(checkIds.has(durableId)).toBe(false);
      workSessions.push(durableId);
      expect(JSON.stringify(execution)).not.toContain(key);
    }
    expect(workSessions[0]).not.toBe(workSessions[1]);
    // Compaction/restart durability is covered by opencode-session.test.ts:
    // "keeps the same session across a compaction restart", with exact conversation-id equality.
    expect(JSON.stringify(await call(fixture, "/api/bootstrap"))).not.toContain(key);
  }, 90_000);
});
