import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApprovalDTO, AppConfigDTO, EmployeeDTO, McpServerDTO, ServerEvent, SkillDTO, WorkContextDTO, WorkDTO } from "../../src/shared/contracts.ts";
import {
  FAKE_KEY_ENV,
  waitForFixture,
  type FixtureAnswer,
  type FixtureRequest,
} from "../helpers/emit-fixture.ts";
import { openEventStream } from "../helpers/sse-client.ts";
import {
  jsonInit as json,
  openSeededApiFixture,
  requestJson as request,
  type ApiResponse,
} from "../helpers/api-fixture.ts";

type EventStreamReader = {
  next(predicate: (event: ServerEvent) => boolean, timeoutMs?: number): Promise<ServerEvent>;
  close(): Promise<void>;
};

const cleanup: Array<() => Promise<void> | void> = [];
let previousApiKey: string | undefined;

beforeEach(() => {
  previousApiKey = process.env[FAKE_KEY_ENV];
  process.env[FAKE_KEY_ENV] = "api-events-fixture-key";
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


function eventFor(request: FixtureRequest, root: string): FixtureAnswer {
  if (request.model === "fake-reviewer") {
    return {
      content: JSON.stringify({
        outcome: "allow",
        risk: "high",
        rationale: "The file write waits for a human decision.",
        readOnly: false,
        userAuthorization: "unknown",
      }),
    };
  }
  if (request.prompt.includes("API_SSE_APPROVAL") && !request.prompt.includes('"role":"tool"')) {
    return {
      toolCall: {
        name: "write_file",
        args: { path: join(root, "work", "sse-approved.txt"), content: "SSE approval committed" },
      },
    };
  }
  return { content: "SSE response completed." };
}

async function observeOnBoth(
  first: EventStreamReader,
  second: EventStreamReader,
  type: ServerEvent["type"],
  action: () => Promise<unknown>,
): Promise<[ServerEvent, ServerEvent]> {
  const bothEvents = Promise.all([
    first.next((event) => event.type === type),
    second.next((event) => event.type === type),
  ]);
  await action();
  const [left, right] = await bothEvents;
  expect(left.type).toBe(type);
  expect(right.type).toBe(type);
  return [left, right];
}

async function responseAction<T>(url: string, path: string, init: RequestInit): Promise<ApiResponse<T>> {
  const response = await request<T>(url, path, init);
  expect(response.status).toBe(200);
  return response;
}

async function waitForWorkStatus(url: string, workId: string, status: string): Promise<void> {
  await waitForFixture(async () => {
    const response = await request<WorkDTO[]>(url, "/api/works");
    return response.body.some((work) => work.id === workId && work.status === status);
  }, `SSE work ${workId} to become ${status}`, 45_000);
}


async function trackedStream(url: string): Promise<EventStreamReader> {
  const stream = await openEventStream(`${url}/api/events`);
  cleanup.push(() => stream.close());
  return stream;
}

describe("real application SSE", () => {
  it("fans out real actions to two clients, survives one disconnect, resyncs through GET, and ends on server close", async () => {
    const { root, http, workspace } = await openSeededApiFixture({
      prefix: "emit-api-events-",
      cleanups: cleanup,
      decide: (root, request) => eventFor(request, root),
    });
    const first = await trackedStream(http.url);
    const second = await trackedStream(http.url);

    const [appLeft, appRight] = await observeOnBoth(first, second, "app", async () => {
      const response = await responseAction<AppConfigDTO>(http.url, "/api/app", json("PATCH", { userName: "SSE Test User" }));
      expect(response.body.user.name).toBe("SSE Test User");
    });
    expect(appLeft).toMatchObject({ type: "app", app: { user: { name: "SSE Test User" } } });
    expect(appRight).toEqual(appLeft);

    const [contextLeft, contextRight] = await observeOnBoth(first, second, "work-context", async () => {
      const current = await request<WorkContextDTO>(http.url, `/api/work-contexts/${workspace.workContextId}`);
      expect(current.status).toBe(200);
      const updated = await responseAction<WorkContextDTO>(http.url, `/api/work-contexts/${workspace.workContextId}`, json("PATCH", {
        expectedVersion: current.body.version,
        goal: "A goal observed by both SSE clients.",
      }));
      expect(updated.body.goal).toBe("A goal observed by both SSE clients.");
    });
    expect(contextLeft).toMatchObject({ type: "work-context", workContext: { id: workspace.workContextId, goal: "A goal observed by both SSE clients." } });
    expect(contextRight).toEqual(contextLeft);

    const [employeeLeft, employeeRight] = await observeOnBoth(first, second, "employee", async () => {
      const response = await responseAction<EmployeeDTO>(http.url, `/api/employees/${workspace.employeeIds[0]}`, json("PATCH", { role: "SSE-updated role" }));
      expect(response.body.role).toBe("SSE-updated role");
    });
    expect(employeeLeft).toMatchObject({ type: "employee", employee: { id: workspace.employeeIds[0], role: "SSE-updated role" } });
    expect(employeeRight).toEqual(employeeLeft);

    const skillsDirectory = join(root, "skills");
    mkdirSync(join(skillsDirectory, "sse-guide"), { recursive: true });
    writeFileSync(join(skillsDirectory, "sse-guide", "SKILL.md"), ["---", "name: sse-guide", "description: A skill imported while SSE listeners are connected.", "---", "", "Private fixture content."].join("\n"), "utf8");
    const [skillsLeft, skillsRight] = await observeOnBoth(first, second, "skills", async () => {
      const imported = await responseAction<{ imported: SkillDTO[]; diagnostics: unknown[] }>(http.url, "/api/skills/import", json("POST", { directory: skillsDirectory }));
      expect(imported.body.imported).toHaveLength(1);
    });
    expect(skillsLeft).toEqual({ type: "skills" });
    expect(skillsRight).toEqual(skillsLeft);

    const [mcpLeft, mcpRight] = await observeOnBoth(first, second, "mcp", async () => {
      const server = await responseAction<McpServerDTO>(http.url, "/api/mcp", json("POST", {
        name: "SSE MCP",
        transport: "stdio",
        command: process.execPath,
        args: [resolve("test/fixtures/fake-mcp.mjs")],
        cwd: process.cwd(),
        enabled: true,
      }));
      expect(server.body.connection.state).toBe("unknown");
    });
    expect(mcpLeft).toEqual({ type: "mcp" });
    expect(mcpRight).toEqual(mcpLeft);

    const progressLeft = first.next((event) => event.type === "work-progress");
    const progressRight = second.next((event) => event.type === "work-progress");
    const approvalPendingLeft = first.next((event) => event.type === "approval" && event.approval.status === "pending-human");
    const approvalPendingRight = second.next((event) => event.type === "approval" && event.approval.status === "pending-human");
    const messageLeft = first.next((event) => event.type === "message");
    const messageRight = second.next((event) => event.type === "message");
    const roomLeft = first.next((event) => event.type === "room");
    const roomRight = second.next((event) => event.type === "room");
    const workLeft = first.next((event) => event.type === "work");
    const workRight = second.next((event) => event.type === "work");
    const sent = await responseAction<{ message: { id: string }; workIds: string[] }>(http.url, `/api/rooms/${workspace.channelId}/messages`, json("POST", {
      body: "API_SSE_APPROVAL",
      recipientIds: [workspace.employeeIds[0]],
    }));
    const workId = sent.body.workIds[0];
    if (workId === undefined) throw new Error("The SSE message did not create a work");
    const [messageA, messageB, roomA, roomB, workA, workB, progressA, progressB, approvalA, approvalB] = await Promise.all([
      messageLeft,
      messageRight,
      roomLeft,
      roomRight,
      workLeft,
      workRight,
      progressLeft,
      progressRight,
      approvalPendingLeft,
      approvalPendingRight,
    ]);
    expect(messageA).toMatchObject({ type: "message", message: { id: sent.body.message.id }, roomId: workspace.channelId });
    expect(messageB).toEqual(messageA);
    expect(roomA).toMatchObject({ type: "room", room: { id: workspace.channelId } });
    expect(roomB).toEqual(roomA);
    expect(workA).toMatchObject({ type: "work", work: { id: workId } });
    expect(workB).toEqual(workA);
    expect(progressA).toMatchObject({ type: "work-progress", workId });
    expect(progressB).toEqual(progressA);
    expect(approvalA.type).toBe("approval");
    expect(approvalA).toMatchObject({ type: "approval", approval: { workId } });
    expect(approvalB).toEqual(approvalA);
    if (approvalA.type !== "approval") throw new Error("Missing pending approval event");
    const approval = approvalA.approval;

    const approvedLeftWait = first.next((event) => event.type === "approval" && event.approval.id === approval.id && event.approval.status === "approved");
    const approvedRightWait = second.next((event) => event.type === "approval" && event.approval.id === approval.id && event.approval.status === "approved");
    const decision = await responseAction<ApprovalDTO>(http.url, `/api/approvals/${approval.id}/decision`, json("POST", { decision: "approved" }));
    expect(decision.body.status).toBe("approved");
    const [approvedLeft, approvedRight] = await Promise.all([approvedLeftWait, approvedRightWait]);
    expect(approvedLeft).toMatchObject({ type: "approval", approval: { id: approval.id, status: "approved" } });
    expect(approvedRight).toEqual(approvedLeft);
    await waitForWorkStatus(http.url, workId, "succeeded");

    await first.close();
    await expect(first.next(() => false, 100)).rejects.toThrow("Event stream closed");

    const stillConnected = second.next((event) => event.type === "app");
    const changed = await responseAction<AppConfigDTO>(http.url, "/api/app", json("PATCH", { userName: "Still connected" }));
    expect(changed.body.user.name).toBe("Still connected");
    expect(await stillConnected).toMatchObject({ type: "app", app: { user: { name: "Still connected" } } });

    const resynced = await request<{ messages: Array<{ id: string; body: string }> }>(http.url, `/api/rooms/${workspace.channelId}/messages`);
    const works = await request<WorkDTO[]>(http.url, "/api/works");
    expect(resynced.body.messages.some((message) => message.id === sent.body.message.id && message.body === "API_SSE_APPROVAL")).toBe(true);
    expect(works.body.find((work) => work.id === workId)?.status).toBe("succeeded");

    const reconnected = await trackedStream(http.url);
    const resyncFuture = reconnected.next((event) => event.type === "app" && event.app.user.name === "Resynced connection");
    const refreshed = await responseAction<AppConfigDTO>(http.url, "/api/app", json("PATCH", { userName: "Resynced connection" }));
    expect(refreshed.body.user.name).toBe("Resynced connection");
    expect(await resyncFuture).toMatchObject({ type: "app", app: { user: { name: "Resynced connection" } } });

    const endingReads = [second.next(() => false, 5_000), reconnected.next(() => false, 5_000)];
    await http.close();
    const endings = await Promise.allSettled(endingReads);
    expect(endings).toHaveLength(2);
    for (const ending of endings) {
      expect(ending.status).toBe("rejected");
      if (ending.status === "rejected") expect(ending.reason.name).not.toBe("TimeoutError");
    }
  }, 90_000);
});
