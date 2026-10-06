import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { BootstrapDTO, ChatSelectionDTO, EmployeeDTO, WorkContextDTO, WorkNoteDTO } from "../../src/shared/contracts.ts";
import type { HttpRuntimeFixture } from "../helpers/emit-fixture.ts";
import {
  FAKE_KEY_ENV,
  providerConfig,
  startFixture,
  startHttpRuntime,
  type Fixture,
  type FixtureRequest,
} from "../helpers/emit-fixture.ts";
import { seedTestWorkspace } from "../helpers/workspace-fixture.ts";

const cleanups: Array<() => Promise<void>> = [];
const executionModel: ChatSelectionDTO = { model: { providerId: "fake", modelId: "fake-chat" }, effort: "off" };
const reviewerModel = { model: { providerId: "fake", modelId: "fake-reviewer" }, effort: "off" };
const reviewerAnswer = JSON.stringify({
  outcome: "allow",
  risk: "low",
  rationale: "Local API fixture",
  readOnly: true,
  userAuthorization: "unknown",
});

function answer(request: FixtureRequest) {
  if (request.model === "fake-reviewer") return { content: reviewerAnswer };
  if (request.prompt.includes("localpart")) return { content: '{"localpart":"api-user"}' };
  return { content: "API fixture response" };
}

async function startApi(): Promise<{ root: string; http: HttpRuntimeFixture; provider: Fixture }> {
  const previousKey = process.env[FAKE_KEY_ENV];
  process.env[FAKE_KEY_ENV] = "api-workspace-fixture-key";
  const root = mkdtempSync(join(tmpdir(), "emit-api-workspace-"));
  let provider: Fixture | undefined;
  let http: HttpRuntimeFixture | undefined;
  try {
    const startedProvider = await startFixture(answer);
    provider = startedProvider;
    const startedHttp = await startHttpRuntime(join(root, "data"));
    http = startedHttp;
    const fixture = { root, http: startedHttp, provider: startedProvider };
    cleanups.push(async () => {
      try {
        await fixture.http.close();
      } finally {
        try {
          await fixture.provider.close();
        } finally {
          if (previousKey === undefined) delete process.env[FAKE_KEY_ENV];
          else process.env[FAKE_KEY_ENV] = previousKey;
          rmSync(root, { recursive: true, force: true });
        }
      }
    });
    return fixture;
  } catch (error) {
    try {
      await http?.close();
    } finally {
      try {
        await provider?.close();
      } finally {
        if (previousKey === undefined) delete process.env[FAKE_KEY_ENV];
        else process.env[FAKE_KEY_ENV] = previousKey;
        rmSync(root, { recursive: true, force: true });
      }
    }
    throw error;
  }
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type InjectResult = { statusCode: number; body: string };

async function call(server: FastifyInstance, method: Method, url: string, payload?: unknown): Promise<InjectResult> {
  const response = await server.inject({
    method,
    url,
    ...(payload === undefined ? {} : { headers: { "content-type": "application/json" }, payload: JSON.stringify(payload) }),
  });
  return { statusCode: response.statusCode, body: response.body };
}

function json<T>(response: InjectResult): T {
  return JSON.parse(response.body) as T;
}

async function seed(http: HttpRuntimeFixture, provider: Fixture, root: string) {
  return seedTestWorkspace({ url: http.url, providerBaseUrl: provider.baseUrl, root });
}

describe("workspace and onboarding HTTP API", () => {
  it("sets up a workspace, reads the app and model catalog back, and rejects incomplete setup without changing it", async () => {
    const fixture = await startApi();
    const { http, provider } = fixture;
    const initial = await call(http.server, "GET", "/api/bootstrap");
    expect(initial.statusCode).toBe(200);
    const initialBootstrap = json<BootstrapDTO>(initial);
    expect(initialBootstrap.app.onboarded).toBe(false);
    expect(initialBootstrap.employees).toEqual([]);
    expect(initialBootstrap.rooms).toEqual([]);
    expect(initialBootstrap.workContexts).toEqual([]);

    const incomplete = await call(http.server, "POST", "/api/setup", { defaultExecutionModel: executionModel });
    expect(json<unknown>(await call(http.server, "GET", "/api/app"))).toEqual(initialBootstrap.app);
    expect(incomplete.statusCode).toBe(400);

    const configured = await call(http.server, "PUT", "/api/providers/custom", {
      providers: [providerConfig(provider.baseUrl)],
    });
    expect(configured.statusCode).toBe(200);
    const setup = await call(http.server, "POST", "/api/setup", {
      userName: "API User",
      defaultExecutionModel: executionModel,
      approval: { kind: "llm", model: reviewerModel.model, effort: reviewerModel.effort, criteriaVersion: 3 },
    });
    expect(setup.statusCode).toBe(200);
    const setupApp = json<BootstrapDTO["app"]>(setup);
    expect(setupApp).toMatchObject({ onboarded: true, user: { name: "API User" } });
    expect(setupApp.defaultExecutionModel).toEqual(executionModel);
    expect(setupApp.approval).toMatchObject({ kind: "llm", model: reviewerModel.model, effort: reviewerModel.effort });
    expect(setupApp.user.address).toBe("api-user@emit");

    const readApp = await call(http.server, "GET", "/api/app");
    expect(readApp.statusCode).toBe(200);
    expect(json<BootstrapDTO["app"]>(readApp)).toEqual(setupApp);
    const modelResponse = await call(http.server, "GET", "/api/models");
    expect(modelResponse.statusCode).toBe(200);
    const models = json<{ models: Array<{ providerId: string; modelId: string }>; providers: Array<{ providerId: string }> }>(modelResponse);
    expect(models.models).toContainEqual(expect.objectContaining({ providerId: "fake", modelId: "fake-chat" }));
    expect(models.models).toContainEqual(expect.objectContaining({ providerId: "fake", modelId: "fake-reviewer" }));
    expect(models.providers).toContainEqual(expect.objectContaining({ providerId: "fake" }));
    const check = await call(http.server, "POST", "/api/models/check", { model: executionModel.model, kind: "chat" });
    expect(check.statusCode).toBe(200);
    expect(json<{ ok: boolean }>(check).ok).toBe(true);
    const missingModel = await call(http.server, "POST", "/api/models/check", { model: {} });
    expect(missingModel.statusCode).toBe(400);

    const patched = await call(http.server, "PATCH", "/api/app", {
      userName: "Updated API User",
      collaboration: { maxDepth: 4, maxCrossEmployeeWakes: 3, maxModelTurns: 12 },
    });
    expect(patched.statusCode).toBe(200);
    const patchedApp = json<BootstrapDTO["app"]>(patched);
    expect(patchedApp.user.name).toBe("Updated API User");
    expect(patchedApp.collaboration).toEqual({ maxDepth: 4, maxCrossEmployeeWakes: 3, maxModelTurns: 12 });
    const bootstrap = await call(http.server, "GET", "/api/bootstrap");
    expect(bootstrap.statusCode).toBe(200);
    expect(json<BootstrapDTO>(bootstrap).app).toEqual(patchedApp);
    expect(bootstrap.body).not.toContain("api-workspace-fixture-key");

    const rejectedSetup = await call(http.server, "POST", "/api/setup", { defaultExecutionModel: executionModel });
    expect(json<BootstrapDTO["app"]>(await call(http.server, "GET", "/api/app"))).toEqual(patchedApp);
    expect(rejectedSetup.statusCode).toBe(400);
  }, 30_000);

  it("creates, updates, lists through bootstrap, rejects invalid employee models, and retires an employee", async () => {
    const fixture = await startApi();
    const { http, provider, root } = fixture;
    await seed(http, provider, root);

    const created = await call(http.server, "POST", "/api/employees", {
      name: "Carol",
      role: "API test assistant",
      instructions: "Initial public profile",
      executionModel,
      generateAddress: false,
    });
    expect(created.statusCode).toBe(200);
    const employee = json<EmployeeDTO>(created);
    expect(employee).toMatchObject({ name: "Carol", role: "API test assistant", instructions: "Initial public profile", enabled: true });
    const listed = json<BootstrapDTO>(await call(http.server, "GET", "/api/bootstrap"));
    expect(listed.employees).toContainEqual(employee);

    const invalidPatch = await call(http.server, "PATCH", `/api/employees/${employee.id}`, {
      executionModel: { model: { providerId: "missing-provider", modelId: "missing-model" }, effort: "off" },
    });
    const unchanged = json<BootstrapDTO>(await call(http.server, "GET", "/api/bootstrap"));
    expect(unchanged.employees.find(({ id }) => id === employee.id)).toEqual(employee);
    expect(invalidPatch.statusCode).toBe(400);

    const updated = await call(http.server, "PATCH", `/api/employees/${employee.id}`, {
      name: "Carol Updated",
      instructions: "Updated through the public API",
      enabled: false,
    });
    expect(updated.statusCode).toBe(200);
    const updatedEmployee = json<EmployeeDTO>(updated);
    expect(updatedEmployee).toMatchObject({
      id: employee.id,
      name: "Carol Updated",
      instructions: "Updated through the public API",
      enabled: false,
      configVersion: employee.configVersion + 1,
    });
    expect(json<BootstrapDTO>(await call(http.server, "GET", "/api/bootstrap")).employees).toContainEqual(updatedEmployee);

    const missingUpdate = await call(http.server, "PATCH", "/api/employees/missing-employee", { name: "Ghost" });
    const missingDelete = await call(http.server, "DELETE", "/api/employees/missing-employee");
    expect(json<BootstrapDTO>(await call(http.server, "GET", "/api/bootstrap")).employees).toContainEqual(updatedEmployee);
    expect(missingUpdate.statusCode).toBe(404);
    expect(missingDelete.statusCode).toBe(404);
    const deleted = await call(http.server, "DELETE", `/api/employees/${employee.id}`);
    expect(deleted.statusCode).toBe(200);
    expect(json<BootstrapDTO>(await call(http.server, "GET", "/api/bootstrap")).employees.some(({ id }) => id === employee.id)).toBe(false);
  }, 30_000);

  it("creates and reads work contexts and notes, with version conflicts leaving saved values intact", async () => {
    const fixture = await startApi();
    const { http, provider, root } = fixture;
    const seeded = await seed(http, provider, root);
    const directory = join(root, "work");
    mkdirSync(directory, { recursive: true });
    const reference = join(directory, "reference.txt");
    writeFileSync(reference, "public resource content");

    const created = await call(http.server, "POST", "/api/work-contexts", {
      name: "Research",
      goal: "Read public sources",
      instructions: "Keep notes in this work",
      directories: { paths: [directory], defaultPath: directory },
      resources: [
        { kind: "file", name: "Local reference", location: reference },
        { kind: "url", name: "Remote reference", location: "https://example.test/reference" },
      ],
    });
    expect(created.statusCode).toBe(200);
    const workContext = json<WorkContextDTO>(created);
    expect(workContext).toMatchObject({ name: "Research", goal: "Read public sources", instructions: "Keep notes in this work" });
    expect(workContext.resources).toHaveLength(2);
    expect(json<{ workContexts: WorkContextDTO[] }>(await call(http.server, "GET", "/api/work-contexts")).workContexts).toContainEqual(workContext);
    expect(json<WorkContextDTO>(await call(http.server, "GET", `/api/work-contexts/${workContext.id}`))).toEqual(workContext);
    expect((await call(http.server, "GET", "/api/work-contexts/missing-context")).statusCode).toBe(404);

    const patch = await call(http.server, "PATCH", `/api/work-contexts/${workContext.id}`, {
      expectedVersion: workContext.version,
      name: "Research Updated",
      goal: "Compare source material",
    });
    expect(patch.statusCode).toBe(200);
    const updatedContext = json<WorkContextDTO>(patch);
    expect(updatedContext).toMatchObject({
      id: workContext.id,
      name: "Research Updated",
      goal: "Compare source material",
      version: workContext.version + 1,
    });
    const conflict = await call(http.server, "PATCH", `/api/work-contexts/${workContext.id}`, {
      expectedVersion: workContext.version,
      name: "Conflict must not be saved",
    });
    expect(json<WorkContextDTO>(await call(http.server, "GET", `/api/work-contexts/${workContext.id}`))).toEqual(updatedContext);
    expect(conflict.statusCode).toBe(409);

    const noteResult = await call(http.server, "POST", `/api/work-contexts/${workContext.id}/notes`, {
      title: "Evidence",
      body: "The public API stored this note.",
      expectedVersion: updatedContext.version,
    });
    expect(noteResult.statusCode).toBe(200);
    const note = json<{ note: WorkNoteDTO; workContext: WorkContextDTO }>(noteResult).note;
    const contextWithNote = json<{ note: WorkNoteDTO; workContext: WorkContextDTO }>(noteResult).workContext;
    expect(note).toMatchObject({ title: "Evidence", body: "The public API stored this note.", authorId: "user" });
    expect(contextWithNote.version).toBe(updatedContext.version + 1);
    expect(contextWithNote.notes).toEqual([{ id: note.id, title: note.title, authorId: "user", sourceRoomId: "", sourceEntryId: "", sourceWorkId: "", createdAt: note.createdAt, updatedAt: note.updatedAt }]);
    expect(json<WorkNoteDTO>(await call(http.server, "GET", `/api/work-contexts/${workContext.id}/notes/${note.id}`))).toEqual(note);

    const notePatch = await call(http.server, "PATCH", `/api/work-contexts/${workContext.id}/notes/${note.id}`, {
      expectedVersion: contextWithNote.version,
      title: "Evidence Updated",
      body: "The revised note is publicly readable.",
    });
    expect(notePatch.statusCode).toBe(200);
    const patchedNote = json<{ note: WorkNoteDTO; workContext: WorkContextDTO }>(notePatch);
    expect(patchedNote.note).toMatchObject({ id: note.id, title: "Evidence Updated", body: "The revised note is publicly readable." });
    const staleNotePatch = await call(http.server, "PATCH", `/api/work-contexts/${workContext.id}/notes/${note.id}`, {
      expectedVersion: contextWithNote.version,
      title: "Stale overwrite",
      body: "Must not replace the saved value.",
    });
    expect(json<WorkNoteDTO>(await call(http.server, "GET", `/api/work-contexts/${workContext.id}/notes/${note.id}`))).toEqual(patchedNote.note);
    expect(staleNotePatch.statusCode).toBe(409);

    const staleDelete = await call(http.server, "DELETE", `/api/work-contexts/${workContext.id}/notes/${note.id}`, {
      expectedVersion: contextWithNote.version,
    });
    expect(json<WorkNoteDTO>(await call(http.server, "GET", `/api/work-contexts/${workContext.id}/notes/${note.id}`))).toEqual(patchedNote.note);
    expect(staleDelete.statusCode).toBe(409);
    const deleted = await call(http.server, "DELETE", `/api/work-contexts/${workContext.id}/notes/${note.id}`, {
      expectedVersion: patchedNote.workContext.version,
    });
    expect(deleted.statusCode).toBe(200);
    const finalContext = json<WorkContextDTO>(deleted);
    expect(finalContext.notes).toEqual([]);
    expect(finalContext.version).toBe(patchedNote.workContext.version + 1);
    expect((await call(http.server, "GET", `/api/work-contexts/${workContext.id}/notes/${note.id}`)).statusCode).toBe(404);
    expect(json<BootstrapDTO>(await call(http.server, "GET", "/api/bootstrap")).workContexts).toContainEqual(finalContext);
    expect(seeded.workContextId).not.toBe(workContext.id);
  }, 30_000);
});
