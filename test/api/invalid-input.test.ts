import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { BootstrapDTO, MessageDTO, RoomDTO, WorkContextDTO, WorkDTO, WorkNoteDTO } from "../../src/shared/contracts.ts";
import {
  FAKE_KEY_ENV,
  startFixture,
  startHttpRuntime,
  type Fixture,
  type FixtureRequest,
  type HttpRuntimeFixture,
} from "../helpers/emit-fixture.ts";
import { seedTestWorkspace } from "../helpers/workspace-fixture.ts";

const cleanups: Array<() => Promise<void>> = [];
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
  return { content: "Invalid-input fixture response" };
}

async function startApi(): Promise<{ root: string; http: HttpRuntimeFixture; provider: Fixture }> {
  const previousKey = process.env[FAKE_KEY_ENV];
  process.env[FAKE_KEY_ENV] = "api-invalid-input-fixture-key";
  const root = mkdtempSync(join(tmpdir(), "emit-api-invalid-input-"));
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

async function publicSnapshot(http: HttpRuntimeFixture, channelId: string, mailRoomId: string) {
  const [bootstrap, rooms, channel, mailRoom, mailbox, works] = await Promise.all([
    call(http.server, "GET", "/api/bootstrap"),
    call(http.server, "GET", "/api/rooms"),
    call(http.server, "GET", `/api/rooms/${channelId}/messages`),
    call(http.server, "GET", `/api/rooms/${mailRoomId}/messages`),
    call(http.server, "GET", "/api/mail"),
    call(http.server, "GET", "/api/works"),
  ]);
  for (const response of [bootstrap, rooms, channel, mailRoom, mailbox, works]) expect(response.statusCode).toBe(200);
  return {
    bootstrap: json<BootstrapDTO>(bootstrap),
    rooms: json<RoomDTO[]>(rooms),
    channelMessages: json<{ messages: MessageDTO[] }>(channel).messages,
    mailMessages: json<{ messages: MessageDTO[] }>(mailRoom).messages,
    mailbox: json<{ items: unknown[] }>(mailbox).items,
    works: json<WorkDTO[]>(works),
  };
}

function exactSizeAppPatch(byteLength: number): string {
  const prefix = '{"userName":"';
  const suffix = '"}';
  const contentBytes = byteLength - Buffer.byteLength(prefix + suffix, "utf8");
  const value = "界".repeat(Math.floor(contentBytes / 3)) + "x".repeat(contentBytes % 3);
  const body = `${prefix}${value}${suffix}`;
  if (Buffer.byteLength(body, "utf8") !== byteLength || JSON.parse(body).userName !== value) {
    throw new Error(`Could not create valid JSON of exactly ${byteLength} UTF-8 bytes`);
  }
  return body;
}

async function wirePatch(http: HttpRuntimeFixture, body: string): Promise<Response> {
  return fetch(new URL("/api/app", http.url), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body,
    signal: AbortSignal.timeout(10_000),
  });
}

describe("HTTP invalid-input boundaries", () => {
  it("returns client errors without persisting rejected workspace, employee, context, note, room, message, mail, or flag writes", async () => {
    const fixture = await startApi();
    const { http, provider, root } = fixture;
    const workspace = await seed(http, provider, root);
    const [alice] = workspace.employeeIds;
    if (alice === undefined) throw new Error("Workspace seed did not create Alice");
    const bootstrap = json<BootstrapDTO>(await call(http.server, "GET", "/api/bootstrap"));
    const context = bootstrap.workContexts.find(({ id }) => id === workspace.workContextId);
    const channel = bootstrap.rooms.find(({ id }) => id === workspace.channelId);
    if (context === undefined || channel === undefined) throw new Error("Seeded workspace context or channel was absent from bootstrap");
    const noteCreate = await call(http.server, "POST", `/api/work-contexts/${context.id}/notes`, {
      title: "Baseline note",
      body: "Existing public state for rejected patch assertions.",
      expectedVersion: context.version,
    });
    expect(noteCreate.statusCode).toBe(200);
    const note = json<{ note: WorkNoteDTO; workContext: WorkContextDTO }>(noteCreate);
    const currentContext = note.workContext;
    const before = await publicSnapshot(http, workspace.channelId, workspace.mailRoomId);

    const cases: Array<{ name: string; method: Method; url: string; body: unknown; status: number }> = [
      { name: "setup missing user name", method: "POST", url: "/api/setup", body: {}, status: 400 },
      { name: "empty approval patch", method: "PATCH", url: "/api/app", body: { approval: null }, status: 400 },
      { name: "model check missing model identity", method: "POST", url: "/api/models/check", body: { model: {} }, status: 400 },
      {
        name: "employee creation with unavailable model",
        method: "POST",
        url: "/api/employees",
        body: {
          name: "Rejected Employee",
          role: "No unavailable model can be saved",
          generateAddress: false,
          executionModel: { model: { providerId: "missing-provider", modelId: "missing-model" }, effort: "off" },
        },
        status: 400,
      },
      {
        name: "employee update with unavailable model",
        method: "PATCH",
        url: `/api/employees/${alice}`,
        body: { executionModel: { model: { providerId: "missing-provider", modelId: "missing-model" }, effort: "off" } },
        status: 400,
      },
      { name: "missing employee update", method: "PATCH", url: "/api/employees/missing-employee", body: { name: "Ghost" }, status: 404 },
      { name: "missing employee delete", method: "DELETE", url: "/api/employees/missing-employee", body: {}, status: 404 },
      {
        name: "work context creation with malformed directories",
        method: "POST",
        url: "/api/work-contexts",
        body: { name: "Rejected context", directories: { paths: "not-an-array", defaultPath: "" } },
        status: 400,
      },
      {
        name: "work context patch with relative directory",
        method: "PATCH",
        url: `/api/work-contexts/${context.id}`,
        body: { expectedVersion: currentContext.version, directories: { paths: ["relative/path"], defaultPath: "relative/path" } },
        status: 400,
      },
      {
        name: "missing work context update",
        method: "PATCH",
        url: "/api/work-contexts/missing-context",
        body: { expectedVersion: 1, name: "Ghost" },
        status: 404,
      },
      {
        name: "work note creation with an empty title",
        method: "POST",
        url: `/api/work-contexts/${context.id}/notes`,
        body: { title: "  ", body: "A title is required", expectedVersion: currentContext.version },
        status: 400,
      },
      {
        name: "work note creation for a missing context",
        method: "POST",
        url: "/api/work-contexts/missing-context/notes",
        body: { title: "Ghost", body: "No context exists", expectedVersion: 1 },
        status: 404,
      },
      {
        name: "work note update with an empty body",
        method: "PATCH",
        url: `/api/work-contexts/${context.id}/notes/${note.note.id}`,
        body: { title: "Rejected note", body: "  ", expectedVersion: currentContext.version },
        status: 400,
      },
      {
        name: "work note delete without a version",
        method: "DELETE",
        url: `/api/work-contexts/${context.id}/notes/${note.note.id}`,
        body: {},
        status: 400,
      },
      {
        name: "work note delete for a missing note",
        method: "DELETE",
        url: `/api/work-contexts/${context.id}/notes/missing-note`,
        body: { expectedVersion: currentContext.version },
        status: 404,
      },
      {
        name: "room creation with an unknown kind",
        method: "POST",
        url: "/api/rooms",
        body: { kind: "group", name: "Rejected room", workContextId: context.id, memberIds: [alice] },
        status: 400,
      },
      {
        name: "room creation for a missing work context",
        method: "POST",
        url: "/api/rooms",
        body: { kind: "channel", name: "Rejected room", workContextId: "missing-context", memberIds: [] },
        status: 404,
      },
      {
        name: "member update with non-array members",
        method: "PATCH",
        url: `/api/rooms/${workspace.channelId}/members`,
        body: { memberIds: "not-an-array", expectedVersion: channel.membershipVersion },
        status: 400,
      },
      {
        name: "channel message with empty content",
        method: "POST",
        url: `/api/rooms/${workspace.channelId}/messages`,
        body: { body: "   " },
        status: 400,
      },
      {
        name: "channel message with a non-string recipient id",
        method: "POST",
        url: `/api/rooms/${workspace.channelId}/messages`,
        body: { body: "Rejected addressing", recipientIds: [null] },
        status: 400,
      },
      {
        name: "message in a missing room",
        method: "POST",
        url: "/api/rooms/missing-room/messages",
        body: { body: "No room exists" },
        status: 404,
      },
      {
        name: "mail draft to an unknown recipient",
        method: "POST",
        url: `/api/rooms/${workspace.mailRoomId}/messages`,
        body: { body: "Rejected draft", to: ["unknown-employee-id"], draft: true },
        status: 400,
      },
      {
        name: "mail send with a non-array To field",
        method: "POST",
        url: `/api/rooms/${workspace.mailRoomId}/mail-send`,
        body: { body: "Rejected send", to: "not-an-array" },
        status: 400,
      },
      {
        name: "mail flag without an entry id",
        method: "POST",
        url: `/api/rooms/${workspace.mailRoomId}/mail-flag`,
        body: { read: true, archived: true },
        status: 400,
      },
    ];

    for (const scenario of cases) {
      const response = await call(http.server, scenario.method, scenario.url, scenario.body);
      expect(await publicSnapshot(http, workspace.channelId, workspace.mailRoomId), `${scenario.name} mutated public state`).toEqual(before);
      expect(response.statusCode, scenario.name).toBe(scenario.status);
    }

  }, 30_000);

  it("accepts valid JSON bodies of exactly 199999 and 200000 UTF-8 bytes and reads each value back", async () => {
    const fixture = await startApi();
    const { http, provider, root } = fixture;
    await seed(http, provider, root);

    for (const byteLength of [199_999, 200_000]) {
      const rawBody = exactSizeAppPatch(byteLength);
      const response = await wirePatch(http, rawBody);
      expect(Buffer.byteLength(rawBody, "utf8")).toBe(byteLength);
      expect(response.status, `PATCH body length ${byteLength}`).toBe(200);
      const app = json<BootstrapDTO["app"]>(await call(http.server, "GET", "/api/app"));
      const requestValue = JSON.parse(rawBody).userName as string;
      expect(app.user.name).toBe(requestValue);
    }
  }, 30_000);

  it("rejects a valid 200001-byte JSON body as a client error without updating the app", async () => {
    const fixture = await startApi();
    const { http, provider, root } = fixture;
    await seed(http, provider, root);
    const before = json<BootstrapDTO["app"]>(await call(http.server, "GET", "/api/app"));
    const rawBody = exactSizeAppPatch(200_001);
    const response = await wirePatch(http, rawBody);
    expect(Buffer.byteLength(rawBody, "utf8")).toBe(200_001);
    expect(json<BootstrapDTO["app"]>(await call(http.server, "GET", "/api/app"))).toEqual(before);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  }, 30_000);

  it("reports malformed JSON as a client error and leaves the app unchanged", async () => {
    const fixture = await startApi();
    const { http, provider, root } = fixture;
    await seed(http, provider, root);
    const before = json<BootstrapDTO["app"]>(await call(http.server, "GET", "/api/app"));
    const response = await wirePatch(http, '{"userName":');
    expect(json<BootstrapDTO["app"]>(await call(http.server, "GET", "/api/app"))).toEqual(before);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  }, 30_000);
});
