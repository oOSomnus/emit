import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApprovalDTO, WorkDTO, WorkStatusDTO } from "../../src/shared/contracts.ts";
import {
  FAKE_KEY_ENV,
  startFixture,
  startHttpRuntime,
  waitForFixture,
  type FixtureAnswer,
  type FixtureRequest,
  type HttpRuntimeFixture,
} from "../helpers/emit-fixture.ts";
import { seedTestWorkspace } from "../helpers/workspace-fixture.ts";

const cleanup: Array<() => Promise<void> | void> = [];
let previousApiKey: string | undefined;

beforeEach(() => {
  previousApiKey = process.env[FAKE_KEY_ENV];
  process.env[FAKE_KEY_ENV] = "api-approval-fixture-key";
});

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    try {
      await close();
    } catch {
      // Preserve the assertion result while still releasing this test's resources.
    }
  }
  if (previousApiKey === undefined) delete process.env[FAKE_KEY_ENV];
  else process.env[FAKE_KEY_ENV] = previousApiKey;
});

type ApiWorkspace = { workContextId: string; employeeIds: readonly string[]; channelId: string; mailRoomId: string };
type ApiResponse<T> = { status: number; body: T };
type TestApi = { root: string; http: HttpRuntimeFixture; workspace: ApiWorkspace };

async function request<T>(url: string, path: string, init?: RequestInit): Promise<ApiResponse<T>> {
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

function json(method: string, body?: unknown): RequestInit {
  return {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  };
}

async function openApi(prefix: string): Promise<TestApi> {
  const root = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const fixture = await startFixture((request) => approvalAnswer(root, request));
  cleanup.push(() => fixture.close());
  const http = await startHttpRuntime(join(root, "data"));
  cleanup.push(() => http.close());
  const workspace = await seedTestWorkspace({ url: http.url, providerBaseUrl: fixture.baseUrl, root });
  http.runtime.resume();
  return { root, http, workspace };
}

function approvalAnswer(root: string, request: FixtureRequest): FixtureAnswer {
  if (request.model === "fake-reviewer") {
    return {
      content: JSON.stringify({
        outcome: "allow",
        risk: "high",
        rationale: "The requested file write requires human approval.",
        readOnly: false,
        userAuthorization: "unknown",
      }),
    };
  }
  const markers = [...request.prompt.matchAll(/API_APPROVAL_(?:APPROVED|REJECTED|STOPPED)/g)];
  const marker = markers.at(-1)?.[0];
  if (marker !== undefined && !request.prompt.includes('"role":"tool"')) {
    const fileName = marker.replace("API_APPROVAL_", "").toLowerCase();
    return {
      toolCall: {
        name: "write_file",
        args: { path: join(root, "work", `${fileName}.txt`), content: `${marker} write committed` },
      },
    };
  }
  return { content: "The tool response has been handled." };
}

async function sendWork(api: TestApi, body: string): Promise<string> {
  const response = await request<{ workIds: string[] }>(api.http.url, `/api/rooms/${api.workspace.channelId}/messages`, {
    ...json("POST", { body, recipientIds: [api.workspace.employeeIds[0]] }),
  });
  expect(response.status).toBe(200);
  const id = response.body.workIds[0];
  if (id === undefined) throw new Error(`${body} did not create a work`);
  return id;
}

async function pendingApproval(api: TestApi, workId: string): Promise<ApprovalDTO> {
  let approval: ApprovalDTO | undefined;
  await waitForFixture(async () => {
    const response = await request<{ approvals: ApprovalDTO[] }>(api.http.url, "/api/approvals");
    approval = response.body.approvals.find((item) => item.workId === workId && item.status === "pending-human");
    return approval !== undefined;
  }, `human approval for work ${workId}`, 45_000);
  if (approval === undefined) throw new Error(`Work ${workId} did not receive a human approval`);
  return approval;
}

async function waitForWorkStatus(api: TestApi, id: string, status: WorkStatusDTO): Promise<void> {
  await waitForFixture(async () => {
    const response = await request<WorkDTO[]>(api.http.url, "/api/works");
    return response.body.some((work) => work.id === id && work.status === status);
  }, `work ${id} to become ${status}`, 45_000);
}

async function waitForTerminalWork(api: TestApi, id: string): Promise<WorkDTO> {
  let found: WorkDTO | undefined;
  await waitForFixture(async () => {
    const response = await request<WorkDTO[]>(api.http.url, "/api/works");
    found = response.body.find((work) => work.id === id);
    return found !== undefined && ["succeeded", "failed", "stopped"].includes(found.status);
  }, `work ${id} to finish`, 45_000);
  if (found === undefined) throw new Error(`Work ${id} disappeared`);
  return found;
}

describe("approval HTTP lifecycle", () => {
  it("approves only through the approved decision and performs the authorized file effect once", async () => {
    const api = await openApi("emit-api-approval-approved-");
    const workId = await sendWork(api, "API_APPROVAL_APPROVED");
    const approval = await pendingApproval(api, workId);
    const file = join(api.root, "work", "approved.txt");

    const illegal = await request<{ message: string }>(api.http.url, `/api/approvals/${approval.id}/decision`, json("POST", { decision: "cancel" }));
    expect(illegal.status).toBe(400);
    expect(existsSync(file)).toBe(false);

    const approved = await request<ApprovalDTO>(api.http.url, `/api/approvals/${approval.id}/decision`, json("POST", {
      decision: "approved",
      comment: "Reviewed in the API test",
    }));
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ id: approval.id, status: "approved", decidedBy: "user", comment: "Reviewed in the API test" });
    await waitForWorkStatus(api, workId, "succeeded");
    expect(existsSync(file)).toBe(true);
    const original = readFileSync(file, "utf8");
    expect(original).toContain("API_APPROVAL_APPROVED write committed");

    const repeated = await request<{ message: string }>(api.http.url, `/api/approvals/${approval.id}/decision`, json("POST", { decision: "rejected" }));
    expect(repeated.status).toBe(409);
    expect(readFileSync(file, "utf8")).toBe(original);
  }, 60_000);

  it("rejects a pending tool call without applying its file effect", async () => {
    const api = await openApi("emit-api-approval-rejected-");
    const workId = await sendWork(api, "API_APPROVAL_REJECTED");
    const approval = await pendingApproval(api, workId);
    const file = join(api.root, "work", "rejected.txt");

    const rejected = await request<ApprovalDTO>(api.http.url, `/api/approvals/${approval.id}/decision`, json("POST", { decision: "rejected" }));
    expect(rejected.status).toBe(200);
    expect(rejected.body).toMatchObject({ id: approval.id, status: "rejected", decidedBy: "user" });
    await waitForTerminalWork(api, workId);
    expect(existsSync(file)).toBe(false);

    const repeated = await request<{ message: string }>(api.http.url, `/api/approvals/${approval.id}/decision`, json("POST", { decision: "approved" }));
    expect(repeated.status).toBe(409);
    expect(existsSync(file)).toBe(false);
  }, 60_000);

  it("cancels an undecided approval when its work is stopped and rejects a late decision", async () => {
    const api = await openApi("emit-api-approval-stopped-");
    const workId = await sendWork(api, "API_APPROVAL_STOPPED");
    const approval = await pendingApproval(api, workId);
    const file = join(api.root, "work", "stopped.txt");

    const stopped = await request<{ ok: boolean }>(api.http.url, `/api/works/${workId}/stop`, json("POST", {}));
    expect(stopped.status).toBe(200);
    expect(stopped.body).toEqual({ ok: true });
    await waitForWorkStatus(api, workId, "stopped");
    const approvals = await request<{ approvals: ApprovalDTO[] }>(api.http.url, "/api/approvals");
    expect(approvals.body.approvals.find((item) => item.id === approval.id)?.status).toBe("cancelled");

    const late = await request<{ message: string }>(api.http.url, `/api/approvals/${approval.id}/decision`, json("POST", { decision: "approved" }));
    expect(late.status).toBe(409);
    expect(existsSync(file)).toBe(false);
  }, 60_000);
});
