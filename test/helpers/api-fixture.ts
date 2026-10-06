import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import {
  FAKE_KEY_ENV,
  startFixture,
  startHttpRuntime,
  type Fixture,
  type FixtureAnswer,
  type FixtureRequest,
  type HttpRuntimeFixture,
} from "./emit-fixture.ts";
import { seedTestWorkspace } from "./workspace-fixture.ts";

export type ApiWorkspace = {
  workContextId: string;
  employeeIds: readonly string[];
  channelId: string;
  mailRoomId: string;
};
export type ApiResponse<T> = { status: number; body: T };
export type InjectResult = { statusCode: number; body: string };
export type ApiFixtureCleanups = Array<() => void | Promise<void>>;
export type SeededApiFixture = {
  root: string;
  http: HttpRuntimeFixture;
  provider: Fixture;
  workspace: ApiWorkspace;
};

type ApiMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export async function requestJson<T>(baseUrl: string, path: string, init?: RequestInit): Promise<ApiResponse<T>> {
  const response = await fetch(new URL(path, baseUrl), { ...init, signal: init?.signal ?? AbortSignal.timeout(10_000) });
  const text = await response.text();
  let body: T;
  try {
    body = JSON.parse(text) as T;
  } catch {
    body = text as T;
  }
  return { status: response.status, body };
}

export function jsonInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  };
}

export async function injectRequest(
  server: FastifyInstance,
  method: ApiMethod,
  url: string,
  payload?: unknown,
): Promise<InjectResult> {
  const response = await server.inject({
    method,
    url,
    ...(payload === undefined ? {} : { headers: { "content-type": "application/json" }, payload: JSON.stringify(payload) }),
  });
  return { statusCode: response.statusCode, body: response.body };
}

export function parseInject<T>(response: InjectResult): T {
  return JSON.parse(response.body) as T;
}

function restoreApiKey(previousKey: string | undefined): void {
  if (previousKey === undefined) delete process.env[FAKE_KEY_ENV];
  else process.env[FAKE_KEY_ENV] = previousKey;
}

async function closeRawApiFixture(
  root: string,
  http: HttpRuntimeFixture | undefined,
  provider: Fixture | undefined,
  previousKey: string | undefined,
): Promise<void> {
  try {
    await http?.close();
  } finally {
    try {
      await provider?.close();
    } finally {
      restoreApiKey(previousKey);
      rmSync(root, { recursive: true, force: true });
    }
  }
}

export async function startRawApiFixture(options: {
  prefix: string;
  keyValue: string;
  cleanups: ApiFixtureCleanups;
  decide: (request: FixtureRequest) => FixtureAnswer;
}): Promise<{ root: string; http: HttpRuntimeFixture; provider: Fixture }> {
  const previousKey = process.env[FAKE_KEY_ENV];
  process.env[FAKE_KEY_ENV] = options.keyValue;
  const root = mkdtempSync(join(tmpdir(), options.prefix));
  let provider: Fixture | undefined;
  let http: HttpRuntimeFixture | undefined;
  try {
    provider = await startFixture(options.decide);
    http = await startHttpRuntime(join(root, "data"));
    const fixture = { root, http, provider };
    options.cleanups.push(() => closeRawApiFixture(root, http, provider, previousKey));
    return fixture;
  } catch (error) {
    await closeRawApiFixture(root, http, provider, previousKey);
    throw error;
  }
}

export async function openSeededApiFixture(options: {
  prefix: string;
  cleanups: ApiFixtureCleanups;
  decide?: (root: string, request: FixtureRequest) => FixtureAnswer;
  resume?: boolean;
}): Promise<SeededApiFixture> {
  const root = mkdtempSync(join(tmpdir(), options.prefix));
  options.cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const decide = options.decide;
  const provider = decide === undefined
    ? await startFixture()
    : await startFixture((request) => decide(root, request));
  options.cleanups.push(() => provider.close());
  const http = await startHttpRuntime(join(root, "data"));
  options.cleanups.push(() => http.close());
  const workspace = await seedTestWorkspace({ url: http.url, providerBaseUrl: provider.baseUrl, root });
  if (options.resume !== false) http.runtime.resume();
  return { root, http, provider, workspace };
}
