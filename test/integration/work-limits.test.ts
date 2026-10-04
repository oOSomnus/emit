import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConversationId, TaskId, ToolExecutionApi, ToolExecutionResult } from "@earendil-works/pi-durable";
import type { MessageDTO, ServerEvent } from "../../src/shared/contracts.ts";
import { buildMessageTools, sendQueuedMessage } from "../../src/server/channel-messages.ts";
import type { EmployeeRecord, RoomRecord } from "../../src/server/documents.ts";
import { createRoom } from "../../src/server/rooms.ts";
import { ensureWorkConversation, findWork, listWorks, type Resume } from "../../src/server/work.ts";
import { readWorkExecution } from "../../src/server/work-execution.ts";
import type { EmitRuntime } from "../../src/server/runtime.ts";
import { readApp, updateAppConfig } from "../../src/server/workspace.ts";
import {
  createWorkContextFixture,
  FAKE_KEY_ENV,
  mkdtempDataDir,
  openRuntime,
  providerConfig,
  readFixtureRoomMessages,
  setupFixtureWorkspace,
  startFixture,
  startHttpRuntime,
  waitForFixture,
  type FixtureRequest,
} from "../helpers/emit-fixture.ts";

const cleanups: Array<() => Promise<void> | void> = [];
let previousApiKey: string | undefined;

beforeEach(() => {
  previousApiKey = process.env[FAKE_KEY_ENV];
  process.env[FAKE_KEY_ENV] = "local-work-limits-key";
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch {
      // Keep cleanup failures from replacing the test's primary assertion.
    }
  }
  if (previousApiKey === undefined) delete process.env[FAKE_KEY_ENV];
  else process.env[FAKE_KEY_ENV] = previousApiKey;
});

const userAuthor = { type: "user" as const, id: "user", name: "Test User", address: "" };

function employeeNamed(employees: readonly EmployeeRecord[], name: string): EmployeeRecord {
  const employee = employees.find((candidate) => candidate.name === name);
  if (employee === undefined) throw new Error(`Missing employee ${name}`);
  return employee;
}

function reviewerAnswer() {
  return {
    content: JSON.stringify({
      outcome: "allow",
      risk: "low",
      rationale: "Local test read",
      readOnly: true,
      userAuthorization: "unknown",
    }),
  };
}
function workFixtureAnswer(request: FixtureRequest) {
  if (request.model === "fake-reviewer") return reviewerAnswer();
  if (request.prompt.includes("localpart")) return { content: '{"localpart":"fixture-user"}' };
  return { content: "Done." };
}

async function executeMessageTool(
  resume: Resume,
  employee: EmployeeRecord,
  workId: string,
  args: unknown,
  taskId: number,
): Promise<ToolExecutionResult> {
  const conversation = await ensureWorkConversation(resume, workId);
  const tool = buildMessageTools(resume, employee).find((candidate) => candidate.name === "send_message");
  if (tool === undefined) throw new Error("Missing send_message tool");
  const api = {
    taskId: taskId as TaskId,
    conversationId: conversation.id as ConversationId,
  } as unknown as ToolExecutionApi;
  return tool.execute(args as never, api, resume.runtime.ctx);
}

async function createChannel(runtime: EmitRuntime, contextId: string, members: readonly EmployeeRecord[]): Promise<RoomRecord> {
  return createRoom(runtime, {
    kind: "channel",
    name: "Collaboration limits",
    workContextId: contextId,
    memberIds: members.map((employee) => employee.id),
  });
}

async function createRootWork(resume: Resume, room: RoomRecord, employee: EmployeeRecord, body: string): Promise<string> {
  const result = await sendQueuedMessage(resume, {
    roomId: room.id,
    author: userAuthor,
    body,
    recipientIds: [employee.id],
  });
  const workId = result.workIds[0];
  if (workId === undefined) throw new Error("Root message did not create work");
  return workId;
}

describe("work and collaboration limits", () => {
  it("allows work at the depth limit, then refuses self-wakes and deeper delegation without writes", async () => {
    const fixture = await startFixture(workFixtureAnswer);
    cleanups.push(() => fixture.close());
    const root = mkdtempDataDir("emit-depth-limit-");
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const { runtime, resume } = await openRuntime(root);
    cleanups.push(() => runtime.close());
    await runtime.storeCustomProviders([providerConfig(fixture.baseUrl)]);
    const employees = await setupFixtureWorkspace(runtime, resume, ["Alpha", "Beta", "Cara"]);
    const alpha = employeeNamed(employees, "Alpha");
    const beta = employeeNamed(employees, "Beta");
    const cara = employeeNamed(employees, "Cara");
    const context = await createWorkContextFixture(runtime, "Depth boundary");
    const room = await createChannel(runtime, context.id, employees);
    const app = await readApp(runtime);
    await updateAppConfig(runtime, {
      collaboration: { ...app.collaboration, maxDepth: 1, maxCrossEmployeeWakes: 8 },
    });
    const rootWorkId = await createRootWork(resume, room, alpha, "ROOT-DEPTH-BOUNDARY");
    await ensureWorkConversation(resume, rootWorkId);

    const beforeSelfMessages = await readFixtureRoomMessages(runtime, room);
    const beforeSelfWorks = await listWorks(runtime);
    const selfWake = await executeMessageTool(
      resume,
      alpha,
      rootWorkId,
      { roomId: room.id, body: "SELF-WAKE-MUST-NOT-COMMIT", recipientIds: [alpha.id] },
      10_101,
    );
    expect(selfWake.isError).toBe(true);
    expect(await readFixtureRoomMessages(runtime, room)).toEqual(beforeSelfMessages);
    expect(await listWorks(runtime)).toEqual(beforeSelfWorks);

    const firstChildSend = await executeMessageTool(
      resume,
      alpha,
      rootWorkId,
      { roomId: room.id, body: "DEPTH-ONE-ALLOWED", recipientIds: [beta.id] },
      10_102,
    );
    expect(firstChildSend.isError).not.toBe(true);
    const firstChild = (await listWorks(runtime)).find((work) => work.parentWorkId === rootWorkId && work.employeeId === beta.id);
    expect(firstChild).toMatchObject({ depth: 1, parentWorkId: rootWorkId });
    if (firstChild === undefined) throw new Error("The depth-one child was not created");
    await ensureWorkConversation(resume, firstChild.id);

    const beforeOverDepthMessages = await readFixtureRoomMessages(runtime, room);
    const beforeOverDepthWorks = await listWorks(runtime);
    const tooDeep = await executeMessageTool(
      resume,
      beta,
      firstChild.id,
      { roomId: room.id, body: "DEPTH-TWO-REFUSED", recipientIds: [cara.id] },
      10_103,
    );
    expect(tooDeep.isError).toBe(true);
    expect(await readFixtureRoomMessages(runtime, room)).toEqual(beforeOverDepthMessages);
    expect(await listWorks(runtime)).toEqual(beforeOverDepthWorks);
  }, 60_000);

  it("spends exactly the allowed cross-employee wake and rejects the next wake atomically", async () => {
    const fixture = await startFixture(workFixtureAnswer);
    cleanups.push(() => fixture.close());
    const root = mkdtempDataDir("emit-wake-limit-");
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const { runtime, resume } = await openRuntime(root);
    cleanups.push(() => runtime.close());
    await runtime.storeCustomProviders([providerConfig(fixture.baseUrl)]);
    const employees = await setupFixtureWorkspace(runtime, resume, ["Alpha", "Beta", "Cara"]);
    const alpha = employeeNamed(employees, "Alpha");
    const beta = employeeNamed(employees, "Beta");
    const cara = employeeNamed(employees, "Cara");
    const context = await createWorkContextFixture(runtime, "Wake boundary");
    const room = await createChannel(runtime, context.id, employees);
    const app = await readApp(runtime);
    await updateAppConfig(runtime, {
      collaboration: { ...app.collaboration, maxDepth: 3, maxCrossEmployeeWakes: 1 },
    });
    const rootWorkId = await createRootWork(resume, room, alpha, "ROOT-WAKE-BOUNDARY");
    await ensureWorkConversation(resume, rootWorkId);

    const atLimit = await executeMessageTool(
      resume,
      alpha,
      rootWorkId,
      { roomId: room.id, body: "WAKE-ONE-ALLOWED", recipientIds: [beta.id] },
      10_201,
    );
    expect(atLimit.isError).not.toBe(true);
    const afterAllowed = await listWorks(runtime);
    expect(afterAllowed.filter((work) => work.parentWorkId === rootWorkId)).toHaveLength(1);
    const beforeRefusalMessages = await readFixtureRoomMessages(runtime, room);

    const overLimit = await executeMessageTool(
      resume,
      alpha,
      rootWorkId,
      { roomId: room.id, body: "WAKE-TWO-REFUSED", recipientIds: [cara.id] },
      10_202,
    );
    expect(overLimit.isError).toBe(true);
    expect(await readFixtureRoomMessages(runtime, room)).toEqual(beforeRefusalMessages);
    expect(await listWorks(runtime)).toEqual(afterAllowed);
  }, 60_000);

  it("routes mail only to To employees while retaining CC and external addresses as copies", async () => {
    const fixture = await startFixture((request) => {
      if (request.model === "fake-reviewer") return reviewerAnswer();
      if (request.prompt.includes("localpart")) return { content: '{"localpart":"fixture-user"}' };
      return { content: "The addressed request was handled." };
    });
    cleanups.push(() => fixture.close());
    const root = mkdtempDataDir("emit-mail-to-cc-external-");
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const http = await startHttpRuntime(root);
    cleanups.push(() => http.close());
    await http.runtime.storeCustomProviders([providerConfig(fixture.baseUrl)]);
    const employees = await setupFixtureWorkspace(http.runtime, http.resume, ["To Recipient", "Cc Recipient"]);
    const toEmployee = employeeNamed(employees, "To Recipient");
    const ccEmployee = employeeNamed(employees, "Cc Recipient");
    const context = await createWorkContextFixture(http.runtime, "External mail routing");
    const room = await createRoom(http.runtime, { kind: "mail", name: "External mail routing", workContextId: context.id });
    http.runtime.resume();

    const response = await http.server.inject({
      method: "POST",
      url: `/api/rooms/${room.id}/mail-send`,
      payload: {
        subject: "To, CC, and external recipients",
        body: "Route this mail to the To employee only.",
        to: [toEmployee.id, "vendor@example.invalid"],
        cc: [ccEmployee.id, "copy@example.invalid"],
      },
    });
    expect(response.statusCode).toBe(200);
    const sent = response.json<{ message: MessageDTO; workIds: string[] }>();
    expect(sent.workIds).toHaveLength(1);
    expect(sent.message.mail?.to.map((address) => address.address)).toEqual([toEmployee.address, "vendor@example.invalid"]);
    expect(sent.message.mail?.cc.map((address) => address.address)).toEqual([ccEmployee.address, "copy@example.invalid"]);
    expect(sent.message.mail?.recipients).toEqual([toEmployee.id]);
    expect(sent.message.mail?.copies).toEqual([ccEmployee.id]);
    await waitForFixture(
      async () => (await findWork(http.runtime, sent.workIds[0]!))?.status === "succeeded",
      "the To recipient's mail work to finish",
    );
    const works = await listWorks(http.runtime);
    expect(works).toHaveLength(1);
    expect(works[0]?.employeeId).toBe(toEmployee.id);
  }, 60_000);

  it("stops a collaboration chain after the configured model-turn budget and emits a visible notice", async () => {
    const marker = `TURN-LIMIT-${randomUUID()}`;
    const fixture = await startFixture((request) => {
      if (request.model === "fake-reviewer") return reviewerAnswer();
      if (request.prompt.includes("localpart")) return { content: '{"localpart":"fixture-user"}' };
      if (request.prompt.includes(marker) && !request.prompt.includes('"role":"tool"')) {
        return { toolCall: { name: "read_file", args: { path: "missing-local-file.txt" } } };
      }
      if (request.prompt.includes('"role":"tool"')) return { content: "This answer must not bypass the turn limit." };
      return { content: "Unexpected request." };
    });
    cleanups.push(() => fixture.close());
    const root = mkdtempDataDir("emit-model-turn-limit-");
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const { runtime, resume } = await openRuntime(root);
    cleanups.push(() => runtime.close());
    await runtime.storeCustomProviders([providerConfig(fixture.baseUrl)]);
    const employees = await setupFixtureWorkspace(runtime, resume, ["Turn Limited"]);
    const employee = employeeNamed(employees, "Turn Limited");
    const context = await createWorkContextFixture(runtime, "Model turn boundary", { paths: [root], defaultPath: root });
    const room = await createChannel(runtime, context.id, employees);
    const app = await readApp(runtime);
    await updateAppConfig(runtime, {
      collaboration: { ...app.collaboration, maxModelTurns: 1 },
    });
    const events: ServerEvent[] = [];
    const unsubscribe = runtime.subscribe((event) => events.push(event));
    cleanups.push(unsubscribe);
    const sent = await sendQueuedMessage(resume, {
      roomId: room.id,
      author: userAuthor,
      body: marker,
      recipientIds: [employee.id],
    });
    const workId = sent.workIds[0];
    if (workId === undefined) throw new Error("Turn-limit message did not create a work");
    runtime.resume();

    await waitForFixture(
      async () => {
        const work = await findWork(runtime, workId);
        return work !== undefined && ["succeeded", "failed", "stopped"].includes(work.status);
      },
      "the model-turn-limited work to settle",
    );
    const execution = await readWorkExecution(runtime, workId);
    expect(execution?.steps.some((step) => step.kind === "tool-result")).toBe(true);
    expect(events.some((event) => event.type === "notice" && event.textLocalized.en.includes("model turn limit"))).toBe(true);
    const roomMessages = await readFixtureRoomMessages(runtime, room);
    expect(roomMessages.some((message) => message.body === "This answer must not bypass the turn limit.")).toBe(false);
    expect(fixture.requests.some((request) => request.prompt.includes(marker))).toBe(true);
  }, 60_000);
});
