import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MessageDTO, WorkDTO, WorkExecutionDTO, WorkStatusDTO } from "../../src/shared/contracts.ts";
import {
  FAKE_KEY_ENV,
  startFixture,
  startHttpRuntime,
  waitForFixture,
  type Fixture,
  type FixtureAnswer,
  type FixtureRequest,
  type HttpRuntimeFixture,
} from "../helpers/emit-fixture.ts";
import { seedTestWorkspace } from "../helpers/workspace-fixture.ts";

type Workspace = { workContextId: string; employeeIds: readonly string[]; channelId: string; mailRoomId: string };
type JsonResponse<T> = { status: number; body: T };

const cleanup: Array<() => Promise<void> | void> = [];
let previousApiKey: string | undefined;

beforeEach(() => {
  previousApiKey = process.env[FAKE_KEY_ENV];
  process.env[FAKE_KEY_ENV] = "fault-provider-fixture-key";
});

afterEach(async () => {
  const failures: unknown[] = [];
  for (const close of cleanup.splice(0).reverse()) {
    try { await close(); } catch (error) { failures.push(error); }
  }
  if (previousApiKey === undefined) delete process.env[FAKE_KEY_ENV];
  else process.env[FAKE_KEY_ENV] = previousApiKey;
  if (failures.length > 0) throw new AggregateError(failures, "Provider fixture cleanup failed");
});

function rawFrame(delta: Record<string, unknown>, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({ id: "fault-provider-frame", object: "chat.completion.chunk", created: 0, model: "fake-chat", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
}

function encoded(...frames: string[]): Uint8Array {
  return new TextEncoder().encode(frames.join(""));
}

function providerAnswer(request: FixtureRequest): FixtureAnswer {
  if (request.model === "fake-reviewer") {
    return {
      content: JSON.stringify({ outcome: "allow", risk: "low", rationale: "Provider fault fixture", readOnly: true, userAuthorization: "unknown" }),
    };
  }
  const marker = /PROVIDER_FAULT_(MALFORMED|PARTIAL|DISCONNECTED|EMPTY_THINKING|HTTP_400|HTTP_401|HTTP_429|HTTP_500)/.exec(request.prompt)?.[0];
  switch (marker) {
    case "PROVIDER_FAULT_MALFORMED":
      return { chunks: [encoded("data: {not valid JSON}\n\n", "data: [DONE]\n\n")] };
    case "PROVIDER_FAULT_PARTIAL":
      return {
        chunks: [encoded(rawFrame({ role: "assistant" }), rawFrame({ content: "PRIVATE_PARTIAL_PROVIDER_TEXT" }), `data: {"id":"truncated`) ],
      };
    case "PROVIDER_FAULT_DISCONNECTED":
      return {
        chunks: [encoded(rawFrame({ role: "assistant" })), encoded(rawFrame({ content: "PRIVATE_DISCONNECTED_PROVIDER_TEXT" }))],
        disconnectAfterChunk: 1,
      };
    case "PROVIDER_FAULT_EMPTY_THINKING":
      return {
        chunks: [encoded(
          rawFrame({ reasoning_content: "PRIVATE_EMPTY_THINKING_CANARY" }),
          rawFrame({}, "stop"),
          "data: [DONE]\n\n",
        )],
      };
    case "PROVIDER_FAULT_HTTP_400": return { httpStatus: 400 };
    case "PROVIDER_FAULT_HTTP_401": return { httpStatus: 401 };
    case "PROVIDER_FAULT_HTTP_429": return { httpStatus: 429 };
    case "PROVIDER_FAULT_HTTP_500": return { httpStatus: 500 };
    default: return { content: "Unmatched provider fault fixture request." };
  }
}

async function openApi(): Promise<{ http: HttpRuntimeFixture; provider: Fixture; workspace: Workspace }> {
  const root = mkdtempSync(join(tmpdir(), "emit-fault-provider-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const provider = await startFixture(providerAnswer);
  cleanup.push(() => provider.close());
  const http = await startHttpRuntime(join(root, "data"));
  cleanup.push(() => http.close());
  const workspace = await seedTestWorkspace({ url: http.url, providerBaseUrl: provider.baseUrl, root });
  http.runtime.resume();
  return { http, provider, workspace };
}

async function request<T>(url: string, path: string, init?: RequestInit): Promise<JsonResponse<T>> {
  const response = await fetch(new URL(path, url), { ...init, signal: init?.signal ?? AbortSignal.timeout(10_000) });
  const text = await response.text();
  let body: T;
  try {
    body = JSON.parse(text) as T;
  } catch {
    body = text as T;
  }
  return { status: response.status, body };
}

async function waitForWork(url: string, id: string, expected: WorkStatusDTO): Promise<WorkDTO> {
  let observed: WorkDTO | undefined;
  await waitForFixture(async () => {
    const response = await request<WorkDTO[]>(url, "/api/works");
    observed = response.body.find((work) => work.id === id);
    if (observed !== undefined && ["succeeded", "failed", "stopped"].includes(observed.status) && observed.status !== expected) {
      throw new Error(`Work ${id} reached ${observed.status}; expected ${expected}`);
    }
    return observed?.status === expected;
  }, `provider fault work ${id} to reach ${expected}`, 45_000);
  if (observed === undefined) throw new Error(`Work ${id} was not returned after reaching ${expected}`);
  return observed;
}

async function sendFault(api: { http: HttpRuntimeFixture; workspace: Workspace }, marker: string): Promise<string> {
  const employeeId = api.workspace.employeeIds[0];
  if (employeeId === undefined) throw new Error("Seeded workspace did not include Alice");
  const response = await request<{ workIds: string[] }>(api.http.url, `/api/rooms/${api.workspace.channelId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body: marker, recipientIds: [employeeId] }),
  });
  expect(response.status).toBe(200);
  const id = response.body.workIds[0];
  if (id === undefined) throw new Error(`Provider fault request ${marker} created no work`);
  return id;
}

async function assertFailedWithoutVisibleReply(
  api: { http: HttpRuntimeFixture; workspace: Workspace },
  id: string,
  privateCanaries: readonly string[] = [],
): Promise<void> {
  const work = await waitForWork(api.http.url, id, "failed");
  expect(work.answer).toBeUndefined();
  const execution = await request<WorkExecutionDTO>(api.http.url, `/api/works/${id}/execution`);
  expect(execution.status).toBe(200);
  expect(execution.body.work.status).toBe("failed");
  const serialized = JSON.stringify(execution.body);
  for (const canary of privateCanaries) expect(serialized).not.toContain(canary);
  const room = await request<{ messages: MessageDTO[] }>(api.http.url, `/api/rooms/${api.workspace.channelId}/messages`);
  expect(room.status).toBe(200);
  expect(room.body.messages.filter((entry) => entry.workId === id && entry.author.type === "employee")).toEqual([]);
}

describe("provider protocol faults at the public work boundary", () => {
  it.each([
    { marker: "PROVIDER_FAULT_MALFORMED", canaries: [] },
    { marker: "PROVIDER_FAULT_PARTIAL", canaries: [] },
    { marker: "PROVIDER_FAULT_DISCONNECTED", canaries: [] },
    { marker: "PROVIDER_FAULT_EMPTY_THINKING", canaries: ["PRIVATE_EMPTY_THINKING_CANARY"] },
  ])("fails $marker without delivering partial answers or exposing private thinking", async (fault) => {
    const api = await openApi();
    const id = await sendFault(api, fault.marker);
    await assertFailedWithoutVisibleReply(api, id, fault.canaries);
  }, 60_000);

  it.each([400, 401, 429, 500] as const)("fails a provider HTTP %i response without an answer or room delivery", async (status) => {
    const api = await openApi();
    const marker = `PROVIDER_FAULT_HTTP_${status}`;
    const id = await sendFault(api, marker);
    await assertFailedWithoutVisibleReply(api, id);
  }, 60_000);
});
