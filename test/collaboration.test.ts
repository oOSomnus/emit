import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import type { ConversationId, TaskId, ToolExecutionApi, ToolExecutionResult } from "@earendil-works/pi-durable";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CollaborationDoc, type EmployeeRecord, type RoomRecord } from "../src/server/documents.ts";
import { buildMessageTools, sendQueuedMessage } from "../src/server/channel-messages.ts";
import { sendQueuedMail } from "../src/server/mail.ts";
import { createWorkContextFixture } from "./helpers/emit-fixture.ts";
import {
  createRoom,
  ensureEmployeeDm,
  findRoom,
  listRooms,
  mailEnvelope,
  messageData,
  updateRoomMembers,
} from "../src/server/rooms.ts";
import {
  ensureWorkConversation,
  findWork,
  installEmployeeExtension,
  isTerminal,
  listWorks,
  reconcileWorks,
  stopWork,
  type Resume,
} from "../src/server/work.ts";
import { createEmployee, listEmployees, readApp, updateAppConfig, updateEmployee } from "../src/server/workspace.ts";
import type { ChatSelectionDTO, MessageDTO } from "../src/shared/contracts.ts";
import {
  FAKE_KEY_ENV,
  mkdtempDataDir,
  openRuntime,
  providerConfig,
  readFixtureRoomMessages,
  setupFixtureWorkspace,
  startFixture,
  waitForFixture,
  type Fixture,
  type FixtureRequest,
} from "./helpers/emit-fixture.ts";

const cleanup: Array<() => Promise<void> | void> = [];
let previousApiKey: string | undefined;

beforeEach(() => {
  previousApiKey = process.env[FAKE_KEY_ENV];
  process.env[FAKE_KEY_ENV] = "local-fixture-key";
});

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    try {
      await close();
    } catch {
      // Cleanup is best effort and must not hide the assertion that failed.
    }
  }
  if (previousApiKey === undefined) delete process.env[FAKE_KEY_ENV];
  else process.env[FAKE_KEY_ENV] = previousApiKey;
});

const userAuthor = { type: "user" as const, id: "user", name: "Test User", address: "" };
const executionModel: ChatSelectionDTO = { model: { providerId: "fake", modelId: "fake-chat" }, effort: "off" };

function defaultAnswer(request: FixtureRequest) {
  if (request.model === "fake-reviewer") {
    return {
      content: JSON.stringify({
        outcome: "allow",
        risk: "low",
        rationale: "Local test action",
        readOnly: true,
        userAuthorization: "unknown",
      }),
    };
  }
  return { content: `Completed: ${randomUUID()}` };
}

function employeeNamed(employees: readonly EmployeeRecord[], name: string): EmployeeRecord {
  const employee = employees.find((candidate) => candidate.name === name);
  if (employee === undefined) throw new Error(`Missing employee ${name}`);
  return employee;
}

async function openTestRuntime(fixture: Fixture, prefix: string) {
  const dataDir = mkdtempDataDir(prefix);
  cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const opened = await openRuntime(dataDir);
  cleanup.push(() => opened.runtime.close());
  await opened.runtime.storeCustomProviders([providerConfig(fixture.baseUrl)]);
  return { ...opened, dataDir };
}

async function waitForWorks(resume: Resume, workIds: readonly string[], description = "works to finish"): Promise<void> {
  await waitForFixture(async () => {
    const works = await Promise.all(workIds.map((id) => findWork(resume.runtime, id)));
    return works.every((work) => work !== undefined && isTerminal(work.status));
  }, description, 45_000);
}

async function sendChannelMessage(resume: Resume, room: RoomRecord, body: string, recipientIds: string[] = [], mentionAll = false) {
  return sendQueuedMessage(resume, {
    roomId: room.id,
    author: userAuthor,
    body,
    recipientIds,
    mentionAll,
  });
}

function countToolResults(request: FixtureRequest): number {
  return request.prompt.match(/"role":"tool"/g)?.length ?? 0;
}

type DirectoryEntry = {
  id: string;
  name: string;
  address: string;
  enabled: boolean;
  member: boolean;
};

/** The current-channel fragment the employee actually received, parsed as data. */
function contextChannel(request: FixtureRequest): { id: string; name: string } | null {
  const match = /Current channel \(use the id for send_message\.roomId\): (\{[^\n]*\})/.exec(request.system);
  return match === null ? null : (JSON.parse(match[1]!) as { id: string; name: string });
}

/** The employee-directory fragment the employee actually received, parsed as data. */
function contextDirectory(request: FixtureRequest): DirectoryEntry[] {
  const match = /Workspace employee directory \(\d+ people\): (\[[^\n]*\])/.exec(request.system);
  return match === null ? [] : (JSON.parse(match[1]!) as DirectoryEntry[]);
}

function toolText(result: ToolExecutionResult): string {
  return (result.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

async function executeCollaborationTool(
  resume: Resume,
  employee: EmployeeRecord,
  workId: string,
  toolName: string,
  args: unknown,
  taskId: number,
): Promise<ToolExecutionResult> {
  const conversation = await ensureWorkConversation(resume, workId);
  const tool = buildMessageTools(resume, employee).find((candidate) => candidate.name === toolName);
  if (tool === undefined) throw new Error(`Missing collaboration tool ${toolName}`);
  const api = {
    taskId: taskId as TaskId,
    conversationId: conversation.id as ConversationId,
  } as unknown as ToolExecutionApi;
  return tool.execute(args as never, api, resume.runtime.ctx);
}

function mailTo(employee: EmployeeRecord, body: string) {
  return messageData({
    author: userAuthor,
    body,
    mail: mailEnvelope({
      subject: `Subject ${body}`,
      to: [{ name: employee.name, address: employee.address }],
      recipients: [employee.id],
      sent: true,
    }),
  });
}

function expectStatus(error: unknown, status: number): void {
  expect(error).toMatchObject({ status });
}

describe("explicit channel addressing and employee collaboration", () => {
  it("stores the exact user wake set and leaves ordinary visible posts inert", async () => {
    const fixture = await startFixture(defaultAnswer);
    cleanup.push(() => fixture.close());
    const { runtime, resume } = await openTestRuntime(fixture, "emit-collab-routing-");
    const employees = await setupFixtureWorkspace(runtime, resume, ["Alice", "Bob", "Cara", "Dana"]);
    const alice = employeeNamed(employees, "Alice");
    const bob = employeeNamed(employees, "Bob");
    const cara = employeeNamed(employees, "Cara");
    const dana = employeeNamed(employees, "Dana");
    const context = await createWorkContextFixture(runtime, "Addressing work");
    const room = await createRoom(runtime, {
      kind: "channel",
      name: "Addressing channel",
      workContextId: context.id,
      memberIds: [alice.id, bob.id, cara.id],
    });
    runtime.resume();

    const baselineRequests = fixture.requests.length;
    const plain = await sendChannelMessage(resume, room, `plain-public-${randomUUID()}`);
    expect(plain.workIds).toEqual([]);
    expect(plain.message.addressing).toEqual({ recipientIds: [], mentionAll: false });
    expect((await listWorks(runtime))).toHaveLength(0);
    expect(fixture.requests).toHaveLength(baselineRequests);

    const onlyAliceText = `@Alice one-person-${randomUUID()}`;
    const onlyAlice = await sendChannelMessage(resume, room, onlyAliceText);
    expect(onlyAlice.message.addressing).toEqual({ recipientIds: [alice.id], mentionAll: false });
    expect(onlyAlice.workIds).toHaveLength(1);
    await waitForWorks(resume, onlyAlice.workIds);
    expect((await listWorks(runtime)).filter((work) => work.sourceEntryId === onlyAlice.message.id).map((work) => work.employeeId)).toEqual([
      alice.id,
    ]);

    const twoNamesText = `@Alice @Bob two-person-${randomUUID()}`;
    const twoNames = await sendChannelMessage(resume, room, twoNamesText);
    expect(twoNames.message.addressing?.recipientIds).toEqual([alice.id, bob.id]);
    expect(twoNames.workIds).toHaveLength(2);
    await waitForWorks(resume, twoNames.workIds);
    expect(
      (await listWorks(runtime))
        .filter((work) => work.sourceEntryId === twoNames.message.id)
        .map((work) => work.employeeId)
        .sort(),
    ).toEqual([alice.id, bob.id].sort());

    const allText = `everyone-${randomUUID()}`;
    const all = await sendChannelMessage(resume, room, allText, [], true);
    expect(all.message.addressing).toEqual({ recipientIds: [alice.id, bob.id, cara.id], mentionAll: true });
    expect(all.workIds).toHaveLength(3);
    await waitForWorks(resume, all.workIds);
    expect(
      (await listWorks(runtime))
        .filter((work) => work.sourceEntryId === all.message.id)
        .map((work) => work.employeeId)
        .sort(),
    ).toEqual([alice.id, bob.id, cara.id].sort());
    const priorBobWork = (await listWorks(runtime)).find(
      (work) => work.sourceEntryId === twoNames.message.id && work.employeeId === bob.id,
    );
    const priorBobReply = (await readFixtureRoomMessages(runtime, room)).find(
      (message) => message.workId === priorBobWork?.id,
    );
    expect(priorBobReply).toBeDefined();
    expect(
      fixture.requests.some(
        (request) => request.prompt.includes(allText) && request.prompt.includes(priorBobReply!.body),
      ),
    ).toBe(true);
    const allAliasesText = `@all @全体 alias-${randomUUID()}`;
    const allAliases = await sendChannelMessage(resume, room, allAliasesText);
    expect(allAliases.message.addressing).toEqual({ recipientIds: [alice.id, bob.id, cara.id], mentionAll: true });
    expect(allAliases.workIds).toHaveLength(3);
    await waitForWorks(resume, allAliases.workIds);

    const selectedText = `@Alice and explicitly selected Cara ${randomUUID()}`;
    const selected = await sendChannelMessage(resume, room, selectedText, [cara.id]);
    expect(selected.message.addressing?.recipientIds.sort()).toEqual([alice.id, cara.id].sort());
    expect(selected.message.addressing?.mentionAll).toBe(false);
    expect(selected.workIds).toHaveLength(2);
    await waitForWorks(resume, selected.workIds);

    const duplicateText = `@Alice @Alice duplicate-${randomUUID()}`;
    const duplicate = await sendChannelMessage(resume, room, duplicateText);
    expect(duplicate.message.addressing?.recipientIds).toEqual([alice.id]);
    expect(duplicate.workIds).toHaveLength(1);
    await waitForWorks(resume, duplicate.workIds);

    const previousWorks = await listWorks(runtime);
    const memberChange = await updateRoomMembers(runtime, room.id, [alice.id, bob.id, cara.id, dana.id], room.membershipVersion);
    expect(memberChange.room.memberIds).toEqual([alice.id, bob.id, cara.id, dana.id]);
    expect(await listWorks(runtime)).toEqual(previousWorks);
    expect((await listWorks(runtime)).some((work) => work.sourceEntryId === all.message.id && work.employeeId === dana.id)).toBe(false);

    for (const sent of [onlyAlice, twoNames, all, allAliases, selected, duplicate]) {
      const works = (await listWorks(runtime)).filter((work) => work.sourceEntryId === sent.message.id);
      const messages = await readFixtureRoomMessages(runtime, room);
      for (const work of works) {
        const reply = messages.find((message) => message.workId === work.id);
        expect(reply?.author.id).toBe(work.employeeId);
        expect(reply?.roomId).toBe(room.id);
      }
    }
    const requestsForAcceptedMessages = fixture.requests.filter((request) =>
      [onlyAliceText, twoNamesText, allText, allAliasesText, selectedText, duplicateText].some((body) =>
        request.prompt.includes(body),
      ),
    );
    expect(requestsForAcceptedMessages).toHaveLength(12);
  }, 60_000);

  it("rejects invalid mentions without side effects and enforces whole-send wake budgets", async () => {
    const fixture = await startFixture(defaultAnswer);
    cleanup.push(() => fixture.close());
    const { runtime, resume } = await openTestRuntime(fixture, "emit-collab-validation-");
    const employees = await setupFixtureWorkspace(runtime, resume, ["Ada", "Bert", "Cara", "Dee"]);
    const ada = employeeNamed(employees, "Ada");
    const bert = employeeNamed(employees, "Bert");
    const cara = employeeNamed(employees, "Cara");
    const dee = employeeNamed(employees, "Dee");
    const context = await createWorkContextFixture(runtime, "Mention validation work");
    const room = await createRoom(runtime, {
      kind: "channel",
      name: "Mention validation channel",
      workContextId: context.id,
      memberIds: [ada.id, bert.id, cara.id],
    });

    const rejectWithoutWrites = async (body: string, extra: { mentionAll?: boolean; recipientIds?: string[] } = {}) => {
      const beforeMessages = await readFixtureRoomMessages(runtime, room);
      const beforeWorks = await listWorks(runtime);
      let error: unknown;
      try {
        await sendQueuedMessage(resume, {
          roomId: room.id,
          author: userAuthor,
          body,
          recipientIds: extra.recipientIds ?? [],
          mentionAll: extra.mentionAll ?? false,
        });
      } catch (caught) {
        error = caught;
      }
      expectStatus(error, 400);
      expect(await readFixtureRoomMessages(runtime, room)).toEqual(beforeMessages);
      expect(await listWorks(runtime)).toEqual(beforeWorks);
    };

    await rejectWithoutWrites(`@Dee nonmember-${randomUUID()}`);
    await rejectWithoutWrites(`selected nonmember ${randomUUID()}`, { recipientIds: [dee.id] });
    await rejectWithoutWrites(`@Nobody unknown-${randomUUID()}`);
    await updateEmployee(runtime, cara.id, { enabled: false });
    await rejectWithoutWrites(`@Cara disabled-${randomUUID()}`);
    await rejectWithoutWrites(`selected disabled ${randomUUID()}`, { recipientIds: [cara.id] });
    const partialAllBody = `@all skip-disabled-${randomUUID()}`;
    const partialAll = await sendChannelMessage(resume, room, partialAllBody);
    expect(partialAll.message.addressing).toEqual({ recipientIds: [ada.id, bert.id], mentionAll: true });
    expect(partialAll.workIds).toHaveLength(2);
    await updateEmployee(runtime, cara.id, { enabled: true });

    await updateEmployee(runtime, bert.id, { name: "Ada" });
    await rejectWithoutWrites(`@Ada ambiguous-${randomUUID()}`);
    await updateEmployee(runtime, bert.id, { name: "Bert" });

    for (const employee of [ada, bert, cara]) await updateEmployee(runtime, employee.id, { enabled: false });
    await rejectWithoutWrites("@all no-enabled-member", { mentionAll: false });
    for (const employee of [ada, bert, cara]) await updateEmployee(runtime, employee.id, { enabled: true });
    const emptyRoom = await createRoom(runtime, {
      kind: "channel",
      name: "Empty addressing channel",
      workContextId: context.id,
      memberIds: [],
    });
    const emptyPlain = await sendQueuedMessage(resume, {
      roomId: emptyRoom.id,
      author: userAuthor,
      body: `empty-room-public-${randomUUID()}`,
    });
    expect(emptyPlain.workIds).toEqual([]);
    expect(emptyPlain.message.addressing).toEqual({ recipientIds: [], mentionAll: false });
    const emptyMessages = await readFixtureRoomMessages(runtime, emptyRoom);
    let emptyAllError: unknown;
    try {
      await sendQueuedMessage(resume, {
        roomId: emptyRoom.id,
        author: userAuthor,
        body: "@all",
        mentionAll: true,
      });
    } catch (error) {
      emptyAllError = error;
    }
    expectStatus(emptyAllError, 400);
    expect(await readFixtureRoomMessages(runtime, emptyRoom)).toEqual(emptyMessages);

    const inertBody = `person@example.com and code \`@Ada\` ${randomUUID()}`;
    const inert = await sendChannelMessage(resume, room, inertBody);
    expect(inert.workIds).toEqual([]);
    expect(inert.message.addressing).toEqual({ recipientIds: [], mentionAll: false });

    const uniqueBody = `@Ada answer this ${randomUUID()}`;
    const uniqueName = await sendChannelMessage(resume, room, uniqueBody);
    expect(uniqueName.message.addressing?.recipientIds).toEqual([ada.id]);
    const fullAddressBody = `Please review @${ada.address} ${randomUUID()}`;
    const fullAddress = await sendChannelMessage(resume, room, fullAddressBody);
    expect(fullAddress.message.addressing?.recipientIds).toEqual([ada.id]);

    const app = await readApp(runtime);
    await updateAppConfig(runtime, {
      collaboration: { ...app.collaboration, maxCrossEmployeeWakes: 1 },
    });
    const parentWorkId = uniqueName.workIds[0]!;
    const parent = await findWork(runtime, parentWorkId);
    if (parent === undefined) throw new Error("Missing parent work");
    await ensureWorkConversation(resume, parentWorkId);
    const beforeRefusedMessage = await readFixtureRoomMessages(runtime, room);
    const beforeRefusedWorks = await listWorks(runtime);
    const refused = await executeCollaborationTool(
      resume,
      ada,
      parentWorkId,
      "send_message",
      { roomId: room.id, body: `over-limit-${randomUUID()}`, recipientIds: [bert.id, cara.id] },
      5501,
    );
    expect(refused.isError).toBe(true);
    expect(await readFixtureRoomMessages(runtime, room)).toEqual(beforeRefusedMessage);
    expect(await listWorks(runtime)).toEqual(beforeRefusedWorks);

    runtime.resume();
    await waitForWorks(resume, [...partialAll.workIds, ...uniqueName.workIds, ...fullAddress.workIds]);
    expect(fixture.requests.some((request) => request.prompt.includes(uniqueBody))).toBe(true);
    expect(fixture.requests.filter((request) => request.prompt.includes(fullAddressBody))).toHaveLength(1);
    expect((await listWorks(runtime)).some((work) => work.parentWorkId === parentWorkId)).toBe(false);
  }, 60_000);

  it("lets a running member invite without waking invitees, then explicitly routes them in the original channel", async () => {
    const marker = `INVITE-FLOW-${randomUUID()}`;
    const followUp = `INVITE-FOLLOW-UP-${randomUUID()}`;
    const sendGate = Promise.withResolvers<void>();
    let channelId = "";
    let betaId = "";
    let deltaId = "";
    const fixture = await startFixture((request) => {
      if (request.model === "fake-reviewer") return defaultAnswer(request);
      if (request.prompt.includes(followUp)) return { content: "The invited employees completed their assigned work." };
      if (request.prompt.includes(marker)) {
        const toolResults = countToolResults(request);
        if (toolResults === 0) {
          return { toolCall: { name: "invite_to_channel", args: { employeeIds: [betaId, deltaId] } } };
        }
        if (toolResults === 1) {
          return {
            toolCall: {
              name: "send_message",
              args: { roomId: channelId, body: followUp, recipientIds: [betaId, deltaId] },
            },
            gate: sendGate.promise,
          };
        }
      }
      return { content: "The initiating work completed." };
    });
    cleanup.push(() => fixture.close());
    const { runtime, resume } = await openTestRuntime(fixture, "emit-collab-invite-flow-");
    cleanup.push(() => sendGate.resolve());
    const employees = await setupFixtureWorkspace(runtime, resume, ["Alpha", "Beta", "Gamma", "Delta"]);
    const alpha = employeeNamed(employees, "Alpha");
    const beta = employeeNamed(employees, "Beta");
    const gamma = employeeNamed(employees, "Gamma");
    const delta = employeeNamed(employees, "Delta");
    betaId = beta.id;
    deltaId = delta.id;
    const context = await createWorkContextFixture(runtime, "Invite work");
    const room = await createRoom(runtime, {
      kind: "channel",
      name: "Invitations",
      workContextId: context.id,
      memberIds: [alpha.id, beta.id, gamma.id],
    });
    channelId = room.id;
    const setupRequests = fixture.requests.length;
    const initiating = await sendChannelMessage(resume, room, marker, [alpha.id]);
    runtime.resume();

    await waitForFixture(
      async () => fixture.requests.some((request) => request.prompt.includes(marker) && countToolResults(request) === 1),
      "the initiating employee to receive the invitation tool result",
    );
    const afterInvite = await findRoom(runtime, room.id);
    expect(afterInvite?.memberIds).toEqual([alpha.id, beta.id, gamma.id, delta.id]);
    expect(afterInvite?.membershipVersion).toBe(room.membershipVersion + 1);
    const entriesAfterInvite = await readFixtureRoomMessages(runtime, room);
    const inviteNotices = entriesAfterInvite.filter((entry) => entry.notice && entry.author.type === "system");
    expect(inviteNotices).toHaveLength(1);
    expect(inviteNotices[0]?.body).toContain(alpha.name);
    expect(inviteNotices[0]?.body).toContain(delta.name);
    // Only the initiating employee has made requests; the response containing
    // the send tool call is held until this assertion has observed the invite.
    expect(fixture.requests).toHaveLength(setupRequests + 2);

    sendGate.resolve();
    await waitForFixture(
      async () => (await listWorks(runtime)).filter((work) => work.parentWorkId === initiating.workIds[0]).length === 2,
      "two explicitly addressed child works",
    );
    const childWorks = (await listWorks(runtime)).filter((work) => work.parentWorkId === initiating.workIds[0]);
    expect(childWorks.map((work) => work.employeeId).sort()).toEqual([beta.id, delta.id].sort());
    expect(childWorks.every((work) => work.roomId === room.id)).toBe(true);
    await waitForWorks(resume, [initiating.workIds[0]!, ...childWorks.map((work) => work.id)]);
    const messages = await readFixtureRoomMessages(runtime, room);
    const followUpEntry = messages.find((entry) => entry.author.id === alpha.id && entry.body === followUp);
    expect(followUpEntry).toBeDefined();
    expect(childWorks.every((work) => work.sourceEntryId === followUpEntry?.id)).toBe(true);
    for (const work of childWorks) {
      const reply = messages.find((entry) => entry.workId === work.id);
      expect(reply?.author.id).toBe(work.employeeId);
      expect(reply?.roomId).toBe(room.id);
    }
    expect((await listRooms(runtime)).filter((candidate) => candidate.kind === "dm")).toHaveLength(0);
    expect(fixture.requests).toHaveLength(setupRequests + 5);
  }, 60_000);

  it("takes the current channel and employee ids from injected context, invites, then addresses the new member", async () => {
    const marker = `CONTEXT-INVITE-${randomUUID()}`;
    const followUp = `CONTEXT-FOLLOW-${randomUUID()}`;
    const sendGate = Promise.withResolvers<void>();
    let secondRound: { channelId: string | null; delta: { enabled: boolean; member: boolean } | undefined } | null = null;
    const fixture = await startFixture((request) => {
      if (request.model === "fake-reviewer") return defaultAnswer(request);
      if (request.prompt.includes(marker)) {
        const toolResults = countToolResults(request);
        if (toolResults === 0) {
          // The invitee id comes only from the injected directory.
          const delta = contextDirectory(request).find(
            (entry) => entry.name === "Delta" && entry.enabled && !entry.member,
          );
          if (delta === undefined) return { content: "DELTA-MISSING-FROM-INITIAL-DIRECTORY" };
          return { toolCall: { name: "invite_to_channel", args: { employeeIds: [delta.id] } } };
        }
        if (toolResults === 1) {
          // The re-rendered directory must already mark the new member.
          const delta = contextDirectory(request).find(
            (entry) => entry.name === "Delta" && entry.enabled && entry.member,
          );
          const channel = contextChannel(request);
          secondRound = {
            channelId: channel?.id ?? null,
            delta: delta === undefined ? undefined : { enabled: delta.enabled, member: delta.member },
          };
          if (delta === undefined || channel === null) return { content: "CONTEXT-MISSING-FOR-SEND" };
          return {
            toolCall: {
              name: "send_message",
              args: { roomId: channel.id, body: followUp, recipientIds: [delta.id] },
            },
            gate: sendGate.promise,
          };
        }
        return { content: "The initiating work completed." };
      }
      return { content: "The addressed member completed the follow-up." };
    });
    cleanup.push(() => fixture.close());
    const { runtime, resume } = await openTestRuntime(fixture, "emit-collab-context-ids-");
    cleanup.push(() => sendGate.resolve());
    const employees = await setupFixtureWorkspace(runtime, resume, ["Alpha", "Beta", "Delta"]);
    const alpha = employeeNamed(employees, "Alpha");
    const beta = employeeNamed(employees, "Beta");
    const delta = employeeNamed(employees, "Delta");
    const disabled = await createEmployee(runtime, {
      name: "Disabled",
      role: "Research",
      generateAddress: false,
      executionModel,
    });
    const disabledOff = await updateEmployee(runtime, disabled.id, { enabled: false });
    const context = await createWorkContextFixture(runtime, "Context identity work");
    const room = await createRoom(runtime, {
      kind: "channel",
      name: "Context channel",
      workContextId: context.id,
      memberIds: [alpha.id, beta.id],
    });
    const initiating = await sendChannelMessage(resume, room, marker, [alpha.id]);
    runtime.resume();

    await waitForFixture(
      async () => secondRound !== null,
      "the initiating employee to re-render context after the invitation",
    );

    // The first round saw the real channel and the full directory before the invite.
    const inviteRound = fixture.requests.find(
      (request) => request.prompt.includes(marker) && countToolResults(request) === 0,
    );
    expect(inviteRound).toBeDefined();
    expect(contextChannel(inviteRound!)).toEqual({ id: room.id, name: room.name });
    const initialDirectory = contextDirectory(inviteRound!);
    expect(initialDirectory.find((entry) => entry.id === alpha.id)).toMatchObject({ enabled: true, member: true });
    expect(initialDirectory.find((entry) => entry.id === delta.id)).toMatchObject({ enabled: true, member: false });
    expect(initialDirectory.find((entry) => entry.id === disabledOff.id)).toMatchObject({
      enabled: false,
      member: false,
    });

    // The invitation changed membership and never woke the invitee.
    const afterInvite = await findRoom(runtime, room.id);
    expect(afterInvite?.membershipVersion).toBe(room.membershipVersion + 1);
    expect(afterInvite?.memberIds).toEqual([alpha.id, beta.id, delta.id]);
    const notices = (await readFixtureRoomMessages(runtime, room)).filter(
      (message) => message.notice && message.author.type === "system",
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]?.body).toContain(delta.name);
    expect((await listWorks(runtime)).filter((work) => work.parentWorkId === initiating.workIds[0])).toHaveLength(0);
    expect(secondRound).toEqual({ channelId: room.id, delta: { enabled: true, member: true } });

    sendGate.resolve();
    await waitForFixture(
      async () => (await listWorks(runtime)).filter((work) => work.parentWorkId === initiating.workIds[0]).length === 1,
      "the explicitly addressed follow-up work",
    );
    const children = (await listWorks(runtime)).filter((work) => work.parentWorkId === initiating.workIds[0]);
    expect(children.map((work) => work.employeeId)).toEqual([delta.id]);
    await waitForWorks(resume, [initiating.workIds[0]!, ...children.map((work) => work.id)]);

    const messages = await readFixtureRoomMessages(runtime, room);
    const sent = messages.find((message) => message.author.id === alpha.id && message.body === followUp);
    expect(sent).toBeDefined();
    expect(sent?.addressing?.recipientIds).toEqual([delta.id]);
    expect(children[0]?.sourceEntryId).toBe(sent?.id);
    const deltaReply = messages.find((message) => message.workId === children[0]?.id);
    expect(deltaReply?.author.id).toBe(delta.id);
    // Alpha's own send never wakes Alpha.
    expect(
      (await listWorks(runtime)).filter(
        (work) => work.employeeId === alpha.id && work.parentWorkId === initiating.workIds[0],
      ),
    ).toHaveLength(0);
  }, 60_000);

  it("never borrows a channel id across channels, delegations, DMs, or mail", async () => {
    const roomOneMarker = `CHANNEL-ONE-${randomUUID()}`;
    const roomTwoMarker = `CHANNEL-TWO-${randomUUID()}`;
    const plainCanary = `PLAIN-ONLY-IN-TWO-${randomUUID()}`;
    const delegationMarker = `DELEGATE-${randomUUID()}`;
    const dmMarker = `DM-TASK-${randomUUID()}`;
    const mailMarker = `MAIL-TASK-${randomUUID()}`;
    const seen = new Map<
      string,
      { channel: string | null; system: string; directory: DirectoryEntry[] }
    >();
    const capture = (key: string, request: FixtureRequest): void => {
      seen.set(key, {
        channel: contextChannel(request)?.id ?? null,
        system: request.system,
        directory: contextDirectory(request),
      });
    };
    const fixture = await startFixture((request) => {
      if (request.model === "fake-reviewer") return defaultAnswer(request);
      if (request.prompt.includes(delegationMarker) && countToolResults(request) === 0) {
        capture("delegation", request);
        return { content: "Delegated work completed." };
      }
      if (request.prompt.includes(dmMarker) && countToolResults(request) === 0) {
        capture("dm", request);
        return { content: "DM work completed." };
      }
      if (request.prompt.includes(mailMarker) && countToolResults(request) === 0) {
        capture("mail", request);
        return { content: "Mail work completed." };
      }
      if (request.prompt.includes(roomTwoMarker)) {
        if (countToolResults(request) === 0) {
          capture("roomTwo", request);
          const channel = contextChannel(request);
          if (channel === null) return { content: "ROOM-TWO-CHANNEL-MISSING" };
          return { toolCall: { name: "send_message", args: { roomId: channel.id, body: plainCanary } } };
        }
        return { content: "Room two work completed." };
      }
      if (request.prompt.includes(roomOneMarker)) {
        if (countToolResults(request) === 0) {
          capture("roomOne", request);
          return { toolCall: { name: "delegate_task", args: { employee: "Delta", task: delegationMarker } } };
        }
        return { content: "Room one work completed." };
      }
      return { content: "No identity task matched." };
    });
    cleanup.push(() => fixture.close());
    const { runtime, resume } = await openTestRuntime(fixture, "emit-collab-channel-identity-");
    const employees = await setupFixtureWorkspace(runtime, resume, ["Alpha", "Beta", "Delta"]);
    const alpha = employeeNamed(employees, "Alpha");
    const beta = employeeNamed(employees, "Beta");
    const delta = employeeNamed(employees, "Delta");
    const context = await createWorkContextFixture(runtime, "Channel identity work");
    const roomOne = await createRoom(runtime, {
      kind: "channel",
      name: "First channel",
      workContextId: context.id,
      memberIds: [alpha.id, beta.id, delta.id],
    });
    const roomTwo = await createRoom(runtime, {
      kind: "channel",
      name: "Second channel",
      workContextId: context.id,
      memberIds: [alpha.id, beta.id],
    });

    const one = await sendChannelMessage(resume, roomOne, roomOneMarker, [alpha.id]);
    const two = await sendChannelMessage(resume, roomTwo, roomTwoMarker, [alpha.id]);
    const dm = await ensureEmployeeDm(runtime, {
      workContextId: context.id,
      participantIds: ["user", alpha.id],
      name: "User ↔ Alpha",
      topic: "Direct",
      employeeId: alpha.id,
    });
    const dmSend = await sendQueuedMessage(resume, { roomId: dm.room.id, author: userAuthor, body: dmMarker });
    const mailRoom = await createRoom(runtime, { kind: "mail", name: "Alpha mail", workContextId: context.id });
    const mailSend = await sendQueuedMail(resume, { room: { id: mailRoom.id }, data: mailTo(alpha, mailMarker) });
    runtime.resume();

    const workIds = [one.workIds[0]!, two.workIds[0]!, dmSend.workIds[0]!, mailSend.workIds[0]!];
    await waitForWorks(resume, workIds);

    // Every work derived its own channel from its own binding.
    expect(seen.get("roomOne")?.channel).toBe(roomOne.id);
    expect(seen.get("roomTwo")?.channel).toBe(roomTwo.id);
    // A delegation inherits its parent's directory but not its channel.
    expect(seen.get("delegation")?.channel).toBeNull();
    expect(seen.get("delegation")?.system).not.toContain("Current channel (use the id for send_message.roomId)");
    expect(seen.get("delegation")?.system).not.toContain(roomOne.id);
    expect(seen.get("delegation")?.directory.every((entry) => !entry.member)).toBe(true);
    expect(seen.get("dm")?.channel).toBeNull();
    expect(seen.get("mail")?.channel).toBeNull();

    const delegationWork = (await listWorks(runtime)).find((work) => work.parentWorkId === one.workIds[0]);
    expect(delegationWork?.employeeId).toBe(delta.id);
    if (delegationWork !== undefined) await waitForWorks(resume, [delegationWork.id]);

    // The plain message landed only in the second channel and woke nobody.
    const twoMessages = await readFixtureRoomMessages(runtime, roomTwo);
    const plain = twoMessages.find((message) => message.body === plainCanary);
    expect(plain).toBeDefined();
    expect(plain?.addressing?.recipientIds ?? []).toEqual([]);
    const oneMessages = await readFixtureRoomMessages(runtime, roomOne);
    expect(oneMessages.some((message) => message.body === plainCanary)).toBe(false);
    expect(
      (await listWorks(runtime)).filter((work) => work.employeeId === beta.id && work.roomId === roomTwo.id),
    ).toHaveLength(0);
  }, 60_000);

  it("replays invite and send receipts once and blocks invalid invite or ancestor actions", async () => {
    const fixture = await startFixture(defaultAnswer);
    cleanup.push(() => fixture.close());
    const { runtime, resume } = await openTestRuntime(fixture, "emit-collab-receipts-");
    const employees = await setupFixtureWorkspace(runtime, resume, ["Alpha", "Beta", "Gamma", "Delta"]);
    const alpha = employeeNamed(employees, "Alpha");
    const beta = employeeNamed(employees, "Beta");
    const gamma = employeeNamed(employees, "Gamma");
    const delta = employeeNamed(employees, "Delta");
    const context = await createWorkContextFixture(runtime, "Receipt work");
    const room = await createRoom(runtime, {
      kind: "channel",
      name: "Receipt channel",
      workContextId: context.id,
      memberIds: [alpha.id, beta.id, gamma.id],
    });
    const parentSend = await sendChannelMessage(resume, room, `receipt-parent-${randomUUID()}`, [alpha.id]);
    const parentWorkId = parentSend.workIds[0]!;
    const beforeInviteRequestCount = fixture.requests.length;
    const inviteArgs = { employeeIds: [delta.id] };
    const inviteFirst = await executeCollaborationTool(resume, alpha, parentWorkId, "invite_to_channel", inviteArgs, 7601);
    const inviteReplay = await executeCollaborationTool(resume, alpha, parentWorkId, "invite_to_channel", inviteArgs, 7601);
    expect(inviteFirst.isError).not.toBe(true);
    expect(inviteReplay.isError).not.toBe(true);
    const afterInviteRoom = (await findRoom(runtime, room.id))!;
    expect(afterInviteRoom.memberIds).toEqual([alpha.id, beta.id, gamma.id, delta.id]);
    const invitationNotices = (await readFixtureRoomMessages(runtime, room)).filter(
      (message) => message.notice && message.author.type === "system",
    );
    expect(invitationNotices).toHaveLength(1);
    expect(invitationNotices[0]?.body).toContain(alpha.name);
    expect(invitationNotices[0]?.body).toContain(delta.name);
    expect(fixture.requests).toHaveLength(beforeInviteRequestCount);

    const sendArgs = { roomId: room.id, body: `receipt-send-${randomUUID()}`, recipientIds: [beta.id, delta.id] };
    const firstSend = await executeCollaborationTool(resume, alpha, parentWorkId, "send_message", sendArgs, 7602);
    const sendReplay = await executeCollaborationTool(resume, alpha, parentWorkId, "send_message", sendArgs, 7602);
    expect(firstSend.isError).not.toBe(true);
    expect(sendReplay.isError).not.toBe(true);
    const children = (await listWorks(runtime)).filter((work) => work.parentWorkId === parentWorkId);
    expect(children).toHaveLength(2);
    expect(children.map((work) => work.employeeId).sort()).toEqual([beta.id, delta.id].sort());
    expect((await listRooms(runtime)).filter((candidate) => candidate.kind === "dm")).toHaveLength(0);
    const collaboration = await runtime.readFamily(CollaborationDoc, parentWorkId, { rootWorkId: parentWorkId });
    expect(collaboration?.crossEmployeeWakes).toBe(2);
    const afterFirstSendEntries = await readFixtureRoomMessages(runtime, room);
    const followUpEntry = afterFirstSendEntries.find((entry) => entry.author.id === alpha.id && entry.body === sendArgs.body);
    expect(followUpEntry).toBeDefined();
    expect(afterFirstSendEntries.filter((entry) => entry.author.id === alpha.id && entry.body === sendArgs.body)).toHaveLength(
      1,
    );
    expect(followUpEntry?.addressing?.recipientIds).toEqual([beta.id, delta.id]);

    const betaWork = children.find((work) => work.employeeId === beta.id)!;
    const beforeAncestorAttempt = await readFixtureRoomMessages(runtime, room);
    const beforeAncestorWorks = (await listWorks(runtime)).map((work) => work.id).sort();
    const ancestorSend = await executeCollaborationTool(
      resume,
      beta,
      betaWork.id,
      "send_message",
      { roomId: room.id, body: `ancestor-${randomUUID()}`, recipientIds: [alpha.id] },
      7603,
    );
    expect(ancestorSend.isError).toBe(true);
    expect(await readFixtureRoomMessages(runtime, room)).toEqual(beforeAncestorAttempt);
    expect((await listWorks(runtime)).map((work) => work.id).sort()).toEqual(beforeAncestorWorks);

    const removal = await updateRoomMembers(runtime, room.id, [beta.id, gamma.id, delta.id], afterInviteRoom.membershipVersion);
    expect(removal.removed).toEqual([alpha.id]);
    const beforeRemovedInvite = await readFixtureRoomMessages(runtime, room);
    const removedInvite = await executeCollaborationTool(
      resume,
      alpha,
      parentWorkId,
      "invite_to_channel",
      { employeeIds: [gamma.id] },
      7604,
    );
    expect(removedInvite.isError).toBe(true);
    expect(await readFixtureRoomMessages(runtime, room)).toEqual(beforeRemovedInvite);

    const dm = await ensureEmployeeDm(runtime, {
      workContextId: context.id,
      participantIds: ["user", alpha.id],
      name: "User ↔ Alpha",
      topic: "Direct",
      employeeId: alpha.id,
    });
    const dmSend = await sendQueuedMessage(resume, {
      roomId: dm.room.id,
      author: userAuthor,
      body: `dm-invite-attempt-${randomUUID()}`,
    });
    const mailRoom = await createRoom(runtime, { kind: "mail", name: "Alpha mail", workContextId: context.id });
    const mailSend = await sendQueuedMail(resume, {
      room: { id: mailRoom.id },
      data: mailTo(alpha, `mail-invite-attempt-${randomUUID()}`),
    });
    const dmInvite = await executeCollaborationTool(resume, alpha, dmSend.workIds[0]!, "invite_to_channel", { employeeIds: [gamma.id] }, 7605);
    const mailInvite = await executeCollaborationTool(
      resume,
      alpha,
      mailSend.workIds[0]!,
      "invite_to_channel",
      { employeeIds: [gamma.id] },
      7606,
    );
    expect(dmInvite.isError).toBe(true);
    expect(mailInvite.isError).toBe(true);
    expect((await findRoom(runtime, room.id))?.memberIds).toEqual([beta.id, gamma.id, delta.id]);
    expect((await readFixtureRoomMessages(runtime, dm.room)).some((message) => message.notice)).toBe(false);
    expect((await readFixtureRoomMessages(runtime, mailRoom)).some((message) => message.notice)).toBe(false);
  }, 60_000);

  it("recovers committed multi-recipient dispatches, preserves stopped work, and isolates one unavailable model", async () => {
    const fixture = await startFixture(defaultAnswer);
    cleanup.push(() => fixture.close());
    const dataDir = mkdtempDataDir("emit-collab-restart-");
    cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const first = await openRuntime(dataDir);
    cleanup.push(() => first.runtime.close());
    const fakeProvider = providerConfig(fixture.baseUrl);
    const brokenProvider = {
      ...providerConfig(fixture.baseUrl),
      id: "broken",
      name: "Broken provider",
      models: [
        {
          id: "broken-chat",
          name: "Broken Chat",
          contextWindow: 32768,
          maxTokens: 4096,
          reasoning: false,
          input: ["text" as const],
        },
      ],
    };
    await first.runtime.storeCustomProviders([fakeProvider, brokenProvider]);
    const employees = await setupFixtureWorkspace(first.runtime, first.resume, ["One", "Two", "Stopped"]);
    const one = employeeNamed(employees, "One");
    const two = employeeNamed(employees, "Two");
    const stopped = employeeNamed(employees, "Stopped");
    const unavailable = await createEmployee(first.runtime, {
      name: "Unavailable",
      role: "Research",
      generateAddress: false,
      executionModel: { model: { providerId: "broken", modelId: "broken-chat" }, effort: "off" },
    });
    await installEmployeeExtension(first.resume, unavailable);
    const workContext = await createWorkContextFixture(first.runtime, "Restart dispatch work");
    const room = await createRoom(first.runtime, {
      kind: "channel",
      name: "Restart dispatch channel",
      workContextId: workContext.id,
      memberIds: [one.id, two.id, stopped.id, unavailable.id],
    });
    const source = `restart-fanout-${randomUUID()}`;
    const sent = await sendChannelMessage(first.resume, room, source, [one.id, two.id, stopped.id, unavailable.id]);
    expect(sent.workIds).toHaveLength(4);
    const stoppedWork = (await Promise.all(sent.workIds.map((id) => findWork(first.runtime, id)))).find(
      (work) => work?.employeeId === stopped.id,
    );
    if (stoppedWork === undefined) throw new Error("Missing work selected for stop");
    await stopWork(first.resume, stoppedWork.id);
    // Removing the provider after enqueue models a validly configured model
    // becoming unavailable before its persisted dispatch is resumed.
    await first.runtime.storeCustomProviders([fakeProvider]);
    const policyVersion = (await readApp(first.runtime)).policyVersion;
    const beforeRestartRequests = fixture.requests.length;
    await first.runtime.close();

    const reopened = await openRuntime(dataDir);
    cleanup.push(() => reopened.runtime.close());
    const reopenedEmployees = await listEmployees(reopened.runtime);
    for (const employee of reopenedEmployees) await installEmployeeExtension(reopened.resume, employee);
    expect((await readApp(reopened.runtime)).policyVersion).toBe(policyVersion);
    reopened.runtime.resume();
    await reconcileWorks(reopened.resume);
    await waitForWorks(reopened.resume, sent.workIds, "recovered and terminal recipient works");

    const workByEmployee = new Map((await listWorks(reopened.runtime)).map((work) => [work.employeeId, work]));
    expect(workByEmployee.get(one.id)?.status).toBe("succeeded");
    expect(workByEmployee.get(two.id)?.status).toBe("succeeded");
    expect(workByEmployee.get(stopped.id)?.status).toBe("stopped");
    expect(workByEmployee.get(unavailable.id)?.status).toBe("failed");
    const recoveredRequests = fixture.requests.slice(beforeRestartRequests).filter((request) => request.prompt.includes(source));
    expect(recoveredRequests).toHaveLength(2);
    const finalRoom = (await findRoom(reopened.runtime, room.id))!;
    const replies = (await readFixtureRoomMessages(reopened.runtime, finalRoom)).filter(
      (message) => message.author.type === "employee" && message.workId !== undefined,
    );
    expect(replies.map((message) => message.author.id).sort()).toEqual([one.id, two.id].sort());
    for (const employee of [one, two]) {
      const work = workByEmployee.get(employee.id)!;
      expect(replies.filter((message) => message.workId === work.id)).toHaveLength(1);
    }
    expect(replies.some((message) => message.author.id === unavailable.id || message.author.id === stopped.id)).toBe(false);
  }, 60_000);

  it("stops an executing member after removal while other channel work still delivers", async () => {
    const marker = `MEMBERSHIP-REMOVAL-${randomUUID()}`;
    const answerGate = Promise.withResolvers<void>();
    const gatedModel = {
      id: "fake-gated",
      name: "Gated Chat",
      contextWindow: 32768,
      maxTokens: 4096,
      reasoning: false,
      input: ["text" as const],
    };
    const fixture = await startFixture((request) => {
      if (request.model === "fake-reviewer") return defaultAnswer(request);
      if (request.model === "fake-gated") return { content: `A must not deliver ${marker}`, gate: answerGate.promise };
      return { content: `B completed ${marker}` };
    });
    cleanup.push(() => fixture.close());
    const { runtime, resume } = await openTestRuntime(fixture, "emit-collab-member-removal-");
    cleanup.push(() => answerGate.resolve());
    await runtime.storeCustomProviders([
      {
        ...providerConfig(fixture.baseUrl),
        models: [...providerConfig(fixture.baseUrl).models, gatedModel],
      },
    ]);
    const employees = await setupFixtureWorkspace(runtime, resume, ["A", "B", "C"]);
    const a = employeeNamed(employees, "A");
    const b = employeeNamed(employees, "B");
    const c = employeeNamed(employees, "C");
    const gatedSelection: ChatSelectionDTO = { model: { providerId: "fake", modelId: "fake-gated" }, effort: "off" };
    const updatedA = await updateEmployee(runtime, a.id, { executionModel: gatedSelection });
    await installEmployeeExtension(resume, updatedA);
    const context = await createWorkContextFixture(runtime, "Member removal work");
    const room = await createRoom(runtime, {
      kind: "channel",
      name: "Member removal channel",
      workContextId: context.id,
      memberIds: [a.id, b.id, c.id],
    });
    const sent = await sendChannelMessage(resume, room, marker, [a.id, b.id]);
    const aWork = (await Promise.all(sent.workIds.map((id) => findWork(runtime, id)))).find((work) => work?.employeeId === a.id);
    const bWork = (await Promise.all(sent.workIds.map((id) => findWork(runtime, id)))).find((work) => work?.employeeId === b.id);
    if (aWork === undefined || bWork === undefined) throw new Error("Missing addressed work");
    runtime.resume();
    await waitForFixture(
      async () => fixture.requests.some((request) => request.model === "fake-gated"),
      "the first employee to enter its gated response",
    );
    await waitForFixture(async () => (await findWork(runtime, bWork.id))?.status === "succeeded", "the remaining member to finish");

    const removed = await updateRoomMembers(runtime, room.id, [b.id, c.id], room.membershipVersion);
    expect(removed.removed).toEqual([a.id]);
    const activeRemovedWorks = (await listWorks(runtime)).filter(
      (work) => work.roomId === room.id && work.employeeId === a.id && !isTerminal(work.status),
    );
    for (const work of activeRemovedWorks) await stopWork(resume, work.id);
    answerGate.resolve();
    await waitForWorks(resume, [aWork.id, bWork.id]);

    const messages: MessageDTO[] = await readFixtureRoomMessages(runtime, room);
    expect((await findWork(runtime, aWork.id))?.status).toBe("stopped");
    expect((await findWork(runtime, bWork.id))?.status).toBe("succeeded");
    expect(messages.some((message) => message.workId === aWork.id && message.author.id === a.id)).toBe(false);
    expect(messages.some((message) => message.workId === bWork.id && message.author.id === b.id)).toBe(true);
    expect(messages.some((message) => message.body.includes(marker) && message.author.id === a.id)).toBe(false);
  }, 60_000);
});
