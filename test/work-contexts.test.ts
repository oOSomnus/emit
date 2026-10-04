import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkContextDoc, type EmployeeRecord, type RoomRecord } from "../src/server/documents.ts";
import { sendQueuedMail } from "../src/server/mail.ts";
import { buildMessageTools, sendQueuedMessage } from "../src/server/channel-messages.ts";
import { buildFileTools } from "../src/server/tools.ts";
import {
  createWorkContext,
  createWorkNote,
  findWorkContext,
  listWorkContexts,
  resolveUserNoteSource,
  toWorkContextDTO,
  updateWorkContext,
  updateWorkNote,
  type WorkNoteSource,
} from "../src/server/work-contexts.ts";
import {
  appendRoomMessage,
  createRoom,
  ensureEmployeeDm,
  findRoom,
  mailEnvelope,
  messageData,
  setMailFlag,
  updateRoomMembers,
} from "../src/server/rooms.ts";
import type { ConversationId, TaskId, ToolExecutionApi } from "@earendil-works/pi-durable";
import { ensureWorkConversation, findWork, installEmployeeExtension, listWorks, type Resume } from "../src/server/work.ts";
import {
  gateToolCall,
  findApproval,
  invalidateWorkContextDirectoryGrants,
  verifyGrant,
  type ApprovalRequest,
  type GateDecision,
} from "../src/server/approval/state.ts";
import { readApp } from "../src/server/workspace.ts";
import type { ApprovalRecord } from "../src/server/documents.ts";
import type { EmitRuntime } from "../src/server/runtime.ts";
import type { ChatSelectionDTO, MessageDTO, WorkContextDraftDTO } from "../src/shared/contracts.ts";
import {
  FAKE_KEY_ENV,
  createWorkContextFixture,
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

function fakeAnswer(request: FixtureRequest) {
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
  return { content: "The fixture completed this request." };
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

async function awaitWorks(runtime: EmitRuntime, workIds: readonly string[]): Promise<void> {
  await waitForFixture(async () => {
    const works = await Promise.all(workIds.map((id) => findWork(runtime, id)));
    return works.every((work) => work !== undefined && ["succeeded", "failed", "stopped"].includes(work.status));
  }, `works ${workIds.join(", ")} to finish`);
}

async function sendRoomMessage(resume: Resume, room: RoomRecord, body: string, recipientIds: string[]) {
  return sendQueuedMessage(resume, { roomId: room.id, author: userAuthor, body, recipientIds });
}

function mailData(employee: EmployeeRecord, body: string) {
  return messageData({
    author: userAuthor,
    body,
    mail: mailEnvelope({
      subject: `Subject ${body}`,
      to: [{ name: employee.name, address: employee.address }],
      recipients: [employee.id],
    }),
  });
}

function toolText(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  return content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
}

async function executeMessageTool(
  resume: Resume,
  employee: EmployeeRecord,
  workId: string,
  toolName: string,
  args: unknown,
  taskId: number,
) {
  const work = await findWork(resume.runtime, workId);
  if (work === undefined) throw new Error(`Missing work ${workId}`);
  const conversation = await ensureWorkConversation(resume, workId);
  const tool = buildMessageTools(resume, employee).find((candidate) => candidate.name === toolName);
  if (tool === undefined) throw new Error(`Missing collaboration tool ${toolName}`);
  const api = {
    taskId: taskId as TaskId,
    conversationId: conversation.id as ConversationId,
  } as unknown as ToolExecutionApi;
  return tool.execute(args as never, api, resume.runtime.ctx);
}
async function executeLocalTool(
  resume: Resume,
  employee: EmployeeRecord,
  workId: string,
  toolName: string,
  args: unknown,
  taskId: number,
) {
  const conversation = await ensureWorkConversation(resume, workId);
  const tool = buildFileTools({ runtime: resume.runtime, employee, skills: [] }).find((candidate) => candidate.name === toolName);
  if (tool === undefined) throw new Error(`Missing local tool ${toolName}`);
  const api = {
    taskId: taskId as TaskId,
    conversationId: conversation.id as ConversationId,
    env: new NodeExecutionEnv({ cwd: process.cwd() }),
  } as unknown as ToolExecutionApi;
  return tool.execute(args as never, api, resume.runtime.ctx);
}

function expectStatus(error: unknown, status: number): void {
  expect(error).toMatchObject({ status });
}

function historyPrompt(request: FixtureRequest, marker: string): boolean {
  return request.prompt.includes(marker);
}

async function createApprovalGrant(resume: Resume, workId: string, taskId: string): Promise<GateDecision> {
  const work = await findWork(resume.runtime, workId);
  if (work === undefined) throw new Error(`Missing work ${workId}`);
  const conversation = await ensureWorkConversation(resume, workId);
  // The approval evaluator reads the run's real transcript, so the probe needs
  // one admitted request; the fixture answers it, which leaves the transcript
  // (and the grant's evidence) in place.
  await conversation.submit({ type: "input", content: `GRANT_PROBE ${taskId}`, requestId: `grant:${taskId}` }, resume.runtime.ctx);
  await waitForFixture(
    async () => ((await conversation.context(resume.runtime.ctx))?.entries.length ?? 0) > 0,
    `grant probe context ${taskId}`,
  );
  return gateToolCall({
    runtime: resume.runtime,
    toolDescription: "Run a local command in the authorized work directory.",
    toolTaskId: taskId,
    conversationId: Number(conversation.id),
    toolName: "run_shell",
    toolKind: "shell",
    arguments: { command: "pwd" },
    signal: undefined,
  });
}

function requestForGrant(record: ApprovalRecord): ApprovalRequest {
  return {
    toolTaskId: record.toolTaskId,
    employeeId: record.employeeId,
    employeeName: record.employeeName,
    toolName: record.toolName,
    toolKind: "shell",
    arguments: { command: "pwd" },
    cwd: record.cwd,
    directoryWorkContextId: record.directoryWorkContextId,
    directoryRoomId: record.directoryRoomId,
    directoryVersion: record.directoryVersion,
    directoryPaths: [...record.directoryPaths],
    targetPaths: [...record.targetPaths],
  };
}

describe("work context persistence and model input", () => {
  it("keeps each room on its work, isolates transcript history, shares notes explicitly, and survives restarts", async () => {
    const fixture = await startFixture(fakeAnswer);
    cleanup.push(() => fixture.close());
    const { runtime, resume, dataDir } = await openTestRuntime(fixture, "emit-context-isolation-");
    const employees = await setupFixtureWorkspace(runtime, resume, ["Alpha", "Beta", "Gamma"]);
    const alpha = employeeNamed(employees, "Alpha");
    const beta = employeeNamed(employees, "Beta");
    const gamma = employeeNamed(employees, "Gamma");

    const roots = mkdtempDataDir("emit-context-roots-");
    cleanup.push(() => rmSync(roots, { recursive: true, force: true }));
    const x1 = join(roots, "x1");
    const x2 = join(roots, "x2");
    const x1Alias = join(roots, "x1-alias");
    const yRoot = join(roots, "y");
    for (const path of [x1, x2, yRoot]) mkdirSync(path, { recursive: true });
    symlinkSync(x1, x1Alias, "dir");
    const resourcePath = join(x1, "brief.txt");
    const resourceContents = `resource-${randomUUID()}`;
    writeFileSync(resourcePath, resourceContents);
    const xGoal = `Goal-X-${randomUUID()}`;
    const yGoal = `Goal-Y-${randomUUID()}`;
    const referenceUrl = new URL("/work-reference", fixture.baseUrl).toString();
    const x = await createWorkContext(runtime, {
      name: "Work X",
      goal: xGoal,
      instructions: "Use only the specifically shared notes and references.",
      directories: { paths: [x1, x1Alias, x2], defaultPath: x2 },
      resources: [
        { kind: "file", name: "Brief", location: resourcePath },
        { kind: "url", name: "Reference", location: referenceUrl },
      ],
    });
    const y = await createWorkContext(runtime, {
      name: "Work Y",
      goal: yGoal,
      directories: { paths: [yRoot, x1], defaultPath: yRoot },
    });
    expect(x.directories.paths).toEqual([resolve(x1), resolve(x2)]);
    expect(x.directories.defaultPath).toBe(resolve(x2));

    const xChannel = await createRoom(runtime, {
      kind: "channel",
      name: "X channel",
      workContextId: x.id,
      memberIds: [alpha.id, beta.id, gamma.id],
    });
    const yChannel = await createRoom(runtime, {
      kind: "channel",
      name: "Y channel",
      workContextId: y.id,
      memberIds: [alpha.id, beta.id, gamma.id],
    });
    const xMail = await createRoom(runtime, { kind: "mail", name: "X mail", workContextId: x.id });
    const yMail = await createRoom(runtime, { kind: "mail", name: "Y mail", workContextId: y.id });
    const xUserDm = await ensureEmployeeDm(runtime, {
      workContextId: x.id,
      participantIds: ["user", beta.id],
      name: "User ↔ Beta",
      topic: "Direct conversation",
      employeeId: beta.id,
    });
    const xUserDmAgain = await ensureEmployeeDm(runtime, {
      workContextId: x.id,
      participantIds: [beta.id, "user"],
      name: "Duplicate user ↔ Beta",
      topic: "Direct conversation",
      employeeId: beta.id,
    });
    const xAlphaBeta = await ensureEmployeeDm(runtime, {
      workContextId: x.id,
      participantIds: [alpha.id, beta.id],
      name: "Alpha ↔ Beta",
      topic: "Employee DM",
    });
    const xAlphaBetaAgain = await ensureEmployeeDm(runtime, {
      workContextId: x.id,
      participantIds: [beta.id, alpha.id],
      name: "Duplicate Alpha ↔ Beta",
      topic: "Employee DM",
    });
    const xGammaBeta = await ensureEmployeeDm(runtime, {
      workContextId: x.id,
      participantIds: [gamma.id, beta.id],
      name: "Gamma ↔ Beta",
      topic: "Employee DM",
    });
    const yUserDm = await ensureEmployeeDm(runtime, {
      workContextId: y.id,
      participantIds: ["user", beta.id],
      name: "User ↔ Beta in Y",
      topic: "Direct conversation",
      employeeId: beta.id,
    });
    expect(xUserDm.room.id).toBe(xUserDmAgain.room.id);
    expect(xAlphaBeta.room.id).toBe(xAlphaBetaAgain.room.id);
    expect(xAlphaBeta.room.id).not.toBe(xGammaBeta.room.id);
    expect(xUserDm.room.id).not.toBe(xAlphaBeta.room.id);
    expect(xUserDm.room.id).not.toBe(yUserDm.room.id);
    expect((await findRoom(runtime, xAlphaBeta.room.id))?.dmParticipantIds).toEqual([alpha.id, beta.id].sort());

    const xChannelHistory = `X-CHANNEL-HISTORY-${randomUUID()}`;
    const privateX = `PRIVATE-X-${randomUUID()}`;
    await appendRoomMessage(runtime, xChannel, messageData({ author: userAuthor, body: xChannelHistory }));
    const requestsBeforeRuns = fixture.requests.length;
    const dmSend = await sendRoomMessage(resume, xUserDm.room, privateX, []);
    const xChannelSend = await sendRoomMessage(resume, xChannel, `X-CHANNEL-TRIGGER-${randomUUID()}`, [beta.id]);
    const yChannelSend = await sendRoomMessage(resume, yChannel, `Y-CHANNEL-TRIGGER-${randomUUID()}`, [beta.id]);
    const xMailSend = await sendQueuedMail(resume, { room: { id: xMail.id }, data: mailData(beta, `X-MAIL-${randomUUID()}`) });
    const yMailSend = await sendQueuedMail(resume, { room: { id: yMail.id }, data: mailData(beta, `Y-MAIL-${randomUUID()}`) });
    const sharedFileRead = await executeLocalTool(
      resume,
      beta,
      yChannelSend.workIds[0]!,
      "read_file",
      { path: resourcePath },
      8098,
    );
    expect(toolText(sharedFileRead)).toContain(resourceContents);
    rmSync(resourcePath);
    expect((await findWorkContext(runtime, x.id))?.resources[0]?.location).toBe(resourcePath);
    const missingResourceRead = await executeLocalTool(
      resume,
      beta,
      xChannelSend.workIds[0]!,
      "read_file",
      { path: resourcePath },
      8099,
    );
    expect(missingResourceRead.isError).toBe(true);

    // Create live, work-bound tool contexts before scheduling. The tools below
    // are the same registrations the employee model receives in its run.
    const noteSourceBody = `SAVE-NOTE-SOURCE-${randomUUID()}`;
    const noteRun = await sendRoomMessage(resume, xChannel, noteSourceBody, [beta.id]);
    const yReadBody = `Y-READ-PRIVATE-NOTE-${randomUUID()}`;
    const yReadRun = await sendRoomMessage(resume, yChannel, yReadBody, [beta.id]);
    await ensureWorkConversation(resume, noteRun.workIds[0]!);
    await ensureWorkConversation(resume, yReadRun.workIds[0]!);
    const currentX = (await findWorkContext(runtime, x.id))!;
    const sharedNoteTitle = `SHARED-X-NOTE-TITLE-${randomUUID()}`;
    const sharedNoteBody = `SHARED-X-NOTE-${randomUUID()}`;
    const saveResult = await executeMessageTool(
      resume,
      beta,
      noteRun.workIds[0]!,
      "save_work_note",
      { title: sharedNoteTitle, body: sharedNoteBody, expectedVersion: currentX.version },
      8101,
    );
    expect(saveResult.isError).not.toBe(true);
    const savedContext = (await findWorkContext(runtime, x.id))!;
    const savedNote = savedContext.notes[0]!;
    const listed = await executeMessageTool(resume, beta, noteRun.workIds[0]!, "list_work_notes", {}, 8102);
    expect(toolText(listed)).toContain(savedNote.id);
    expect(toolText(listed)).toContain(savedNote.title);
    expect(toolText(listed)).not.toContain(savedNote.body);
    const read = await executeMessageTool(
      resume,
      beta,
      noteRun.workIds[0]!,
      "read_work_note",
      { noteId: savedNote.id },
      8103,
    );
    expect(toolText(read)).toContain(savedNote.body);
    const privateRead = await executeMessageTool(
      resume,
      beta,
      yReadRun.workIds[0]!,
      "read_work_note",
      { noteId: savedNote.id },
      8104,
    );
    expect(privateRead.isError).toBe(true);
    expect(toolText(privateRead)).not.toContain(savedNote.body);
    expect(toWorkContextDTO(savedContext).notes[0]).not.toHaveProperty("body");

    runtime.resume();
    const allWorkIds = [
      ...dmSend.workIds,
      ...xChannelSend.workIds,
      ...yChannelSend.workIds,
      ...xMailSend.workIds,
      ...yMailSend.workIds,
      ...noteRun.workIds,
      ...yReadRun.workIds,
    ];
    await awaitWorks(runtime, allWorkIds);

    const xDmRequest = fixture.requests.find((request) => historyPrompt(request, privateX));
    const xChannelRequest = fixture.requests.find((request) => historyPrompt(request, xChannelSend.message.body));
    const yChannelRequest = fixture.requests.find((request) => historyPrompt(request, yChannelSend.message.body));
    const xMailRequest = fixture.requests.find((request) => historyPrompt(request, xMailSend.message.body));
    const yMailRequest = fixture.requests.find((request) => historyPrompt(request, yMailSend.message.body));
    expect(xDmRequest).toBeDefined();
    expect(xChannelRequest).toBeDefined();
    expect(yChannelRequest).toBeDefined();
    expect(xMailRequest).toBeDefined();
    expect(yMailRequest).toBeDefined();
    for (const request of [xDmRequest!, xChannelRequest!, xMailRequest!]) {
      expect(request.system).toContain(x.id);
      expect(request.system).toContain(xGoal);
      expect(request.system).toContain(resolve(x1));
      expect(request.system).toContain(resolve(x2));
      expect(request.system).toContain(resourcePath);
      expect(request.system).toContain(referenceUrl);
    }
    for (const request of [yChannelRequest!, yMailRequest!]) {
      expect(request.system).toContain(y.id);
      expect(request.system).toContain(yGoal);
      expect(request.system).toContain(resolve(yRoot));
      expect(request.system).toContain(resolve(x1));
      expect(request.system).not.toContain(referenceUrl);
      expect(request.system).not.toContain(x.id);
    }
    expect(xDmRequest!.prompt).toContain(privateX);
    expect(xDmRequest!.prompt).not.toContain(xChannelHistory);
    expect(xMailRequest!.prompt).not.toContain(xChannelHistory);
    expect(xChannelRequest!.prompt).toContain(xChannelHistory);
    expect(xChannelRequest!.prompt).not.toContain(privateX);
    expect(yChannelRequest!.prompt).not.toContain(privateX);
    expect(xChannelRequest!.system).toContain(savedNote.title);
    expect(yChannelRequest!.system).not.toContain(savedNote.title);
    expect(xChannelRequest!.prompt).not.toContain(savedNote.body);
    expect(yChannelRequest!.prompt).not.toContain(savedNote.body);
    expect(yMailRequest!.prompt).not.toContain(privateX);
    expect(fixture.requests.length).toBeGreaterThan(requestsBeforeRuns);
    expect(fixture.requests.filter((request) => request.model === undefined)).toHaveLength(0);

    const policyVersion = (await readApp(runtime)).policyVersion;
    const xPersisted = await findWorkContext(runtime, x.id);
    expect(xPersisted?.resources[0]?.location).toBe(resourcePath);
    expect(xPersisted?.notes[0]?.body).toBe(savedNote.body);
    expect((await findRoom(runtime, xChannel.id))?.workContextId).toBe(x.id);
    const noteWorkBeforeRestart = await findWork(runtime, noteRun.workIds[0]!);
    const noteWorkDirectoryScope = noteWorkBeforeRestart?.directoryScope;
    const roomMessagesBeforeRestart = await readFixtureRoomMessages(runtime, xChannel);
    expect(noteWorkBeforeRestart?.workContextId).toBe(x.id);
    const countBeforeRestart = (await listWorkContexts(runtime)).length;
    await runtime.close();

    const reopened = await openRuntime(dataDir);
    cleanup.push(() => reopened.runtime.close());
    for (const employee of employees) await installEmployeeExtension(reopened.resume, employee);
    const contextAfterRestart = await findWorkContext(reopened.runtime, x.id);
    expect(contextAfterRestart).toMatchObject({ id: x.id, goal: xGoal, version: savedContext.version });
    expect(contextAfterRestart?.notes[0]?.body).toBe(savedNote.body);
    expect(contextAfterRestart?.resources).toEqual(xPersisted?.resources);
    expect((await findRoom(reopened.runtime, xChannel.id))?.workContextId).toBe(x.id);
    expect((await findRoom(reopened.runtime, xUserDm.room.id))?.dmParticipantIds).toEqual(xUserDm.room.dmParticipantIds);
    expect((await findWork(reopened.runtime, noteRun.workIds[0]!))?.directoryScope).toEqual(noteWorkDirectoryScope);
    const rawWorkContexts = await reopened.runtime.listFamily(WorkContextDoc, (id) => ({ id }));
    expect(rawWorkContexts.find((member) => member.value.id === x.id)?.value).toEqual(contextAfterRestart);
    expect((await readApp(reopened.runtime)).policyVersion).toBe(policyVersion);
    expect((await listWorkContexts(reopened.runtime))).toHaveLength(countBeforeRestart);
    await reopened.runtime.close();

    const reopenedAgain = await openRuntime(dataDir);
    cleanup.push(() => reopenedAgain.runtime.close());
    expect((await listWorkContexts(reopenedAgain.runtime))).toHaveLength(countBeforeRestart);
    expect((await readApp(reopenedAgain.runtime)).policyVersion).toBe(policyVersion);
    const roomAfterRepeatedRestart = await findRoom(reopenedAgain.runtime, xChannel.id);
    expect(roomAfterRepeatedRestart).toBeDefined();
    expect(await readFixtureRoomMessages(reopenedAgain.runtime, roomAfterRepeatedRestart!)).toEqual(roomMessagesBeforeRestart);
  }, 60_000);

  it("enforces optimistic versions, real directory/resource boundaries, and verifiable note sources", async () => {
    const fixture = await startFixture(fakeAnswer);
    cleanup.push(() => fixture.close());
    const { runtime, resume } = await openTestRuntime(fixture, "emit-context-versions-");
    const employees = await setupFixtureWorkspace(runtime, resume, ["Owner", "Other"]);
    const owner = employeeNamed(employees, "Owner");
    const other = employeeNamed(employees, "Other");
    const roots = mkdtempSync(join(tmpdir(), "emit-context-boundaries-"));
    cleanup.push(() => rmSync(roots, { recursive: true, force: true }));
    const inside = join(roots, "inside");
    const alias = join(roots, "inside-link");
    const second = join(roots, "second");
    const outside = join(roots, "outside");
    for (const path of [inside, second, outside]) mkdirSync(path, { recursive: true });
    symlinkSync(inside, alias, "dir");
    const validFile = join(inside, "data.txt");
    const outsideFile = join(outside, "secret.txt");
    writeFileSync(validFile, "inside data");
    writeFileSync(outsideFile, "outside data");
    const x = await createWorkContext(runtime, {
      name: "Scoped X",
      directories: { paths: [inside, alias, second], defaultPath: second },
      resources: [{ kind: "file", name: "In scope", location: validFile }],
    });
    const y = await createWorkContextFixture(runtime, "Scoped Y");
    const beforeInvalidDrafts = await listWorkContexts(runtime);
    const invalidDrafts: WorkContextDraftDTO[] = [
      { name: "n".repeat(121) },
      { name: "Goal bound", goal: "g".repeat(2_001) },
      { name: "Instruction bound", instructions: "i".repeat(4_001) },
      {
        name: "Resource count bound",
        resources: Array.from({ length: 41 }, (_, index) => ({
          kind: "url" as const,
          name: "Reference",
          location: `https://example.invalid/${index}`,
        })),
      },
      {
        name: "Resource name bound",
        resources: [{ kind: "url", name: "r".repeat(121), location: "https://example.invalid/ref" }],
      },
      {
        name: "Resource location bound",
        resources: [{ kind: "url", name: "Reference", location: `https://example.invalid/${"x".repeat(2_048)}` }],
      },
      { name: "Unsupported URL scheme", resources: [{ kind: "url", name: "FTP", location: "ftp://example.invalid/ref" }] },
      { name: "Directory is not a file", resources: [{ kind: "file", name: "Directory", location: inside }] },
    ];
    for (const draft of invalidDrafts) {
      let error: unknown;
      try {
        await createWorkContext(runtime, draft);
      } catch (caught) {
        error = caught;
      }
      expectStatus(error, 400);
    }
    expect(await listWorkContexts(runtime)).toEqual(beforeInvalidDrafts);
    expect(x.directories.paths).toEqual([resolve(inside), resolve(second)]);
    const xRoom = await createRoom(runtime, {
      kind: "channel",
      name: "Scoped X channel",
      workContextId: x.id,
      memberIds: [owner.id],
    });
    const yRoom = await createRoom(runtime, {
      kind: "channel",
      name: "Scoped Y channel",
      workContextId: y.id,
      memberIds: [owner.id],
    });
    const xEntry = await appendRoomMessage(runtime, xRoom, messageData({ author: userAuthor, body: `X-source-${randomUUID()}` }));
    const yEntry = await appendRoomMessage(runtime, yRoom, messageData({ author: userAuthor, body: `Y-source-${randomUUID()}` }));
    const zeroDirectoryChat = await sendRoomMessage(resume, yRoom, `EMPTY-DIRECTORY-CHAT-${randomUUID()}`, [owner.id]);
    const zeroDirectoryWorkId = zeroDirectoryChat.workIds[0]!;
    await ensureWorkConversation(resume, zeroDirectoryWorkId);
    const zeroDirectorySource = await resolveUserNoteSource(runtime, y.id, {
      roomId: yRoom.id,
      entryId: yEntry.id,
    });
    const zeroDirectoryNote = await createWorkNote(runtime, y.id, {
      title: `EMPTY-DIRECTORY-NOTE-${randomUUID()}`,
      body: `Empty-directory notes work ${randomUUID()}`,
      expectedVersion: y.version,
      ...zeroDirectorySource,
    });
    expect(zeroDirectoryNote.workContext.version).toBe(y.version + 1);
    const relativeRead = await executeLocalTool(resume, owner, zeroDirectoryWorkId, "read_file", { path: "relative.txt" }, 7401);
    const shell = await executeLocalTool(resume, owner, zeroDirectoryWorkId, "run_shell", { command: "pwd" }, 7402);
    expect(relativeRead.isError).toBe(true);
    expect(shell.isError).toBe(true);
    runtime.resume();
    await awaitWorks(runtime, zeroDirectoryChat.workIds);
    expect((await findWork(runtime, zeroDirectoryWorkId))?.status).toBe("succeeded");

    const changedGoal = await updateWorkContext(runtime, x.id, {
      expectedVersion: x.version,
      goal: `Updated goal ${randomUUID()}`,
    });
    expect(changedGoal.version).toBe(x.version + 1);
    expect(changedGoal.directories.version).toBe(x.directories.version);
    const beforeStaleWorkPatch = await findWorkContext(runtime, x.id);
    let staleWorkError: unknown;
    try {
      await updateWorkContext(runtime, x.id, { expectedVersion: x.version, goal: "stale write" });
    } catch (error) {
      staleWorkError = error;
    }
    expectStatus(staleWorkError, 409);
    expect(await findWorkContext(runtime, x.id)).toEqual(beforeStaleWorkPatch);

    const source = await resolveUserNoteSource(runtime, x.id, { roomId: xRoom.id, entryId: xEntry.id });
    const created = await createWorkNote(runtime, x.id, {
      title: "Source-bound note",
      body: "A note from a real source entry.",
      expectedVersion: changedGoal.version,
      ...source,
    });
    const afterNote = await findWorkContext(runtime, x.id);
    const note = created.note;
    expect(note.sourceRoomId).toBe(xRoom.id);
    expect(note.sourceEntryId).toBe(xEntry.id);
    expect(note.sourceWorkId).toBe("");
    const sourceForPatch: WorkNoteSource = {
      authorId: "user",
      sourceRoomId: note.sourceRoomId,
      sourceEntryId: note.sourceEntryId,
      sourceWorkId: note.sourceWorkId,
    };
    const invalidNoteDrafts = [
      { title: "", body: "Body required" },
      { title: "Title required", body: "" },
      { title: "t".repeat(121), body: "Within bounds" },
      { title: "Body bound", body: "b".repeat(16_001) },
    ];
    for (const draft of invalidNoteDrafts) {
      let error: unknown;
      try {
        await createWorkNote(runtime, x.id, {
          ...draft,
          expectedVersion: afterNote!.version,
          ...sourceForPatch,
        });
      } catch (caught) {
        error = caught;
      }
      expectStatus(error, 400);
    }
    expect(await findWorkContext(runtime, x.id)).toEqual(afterNote);
    let staleNoteError: unknown;
    try {
      await updateWorkNote(runtime, x.id, note.id, {
        title: "Stale note title",
        body: "Stale note content",
        expectedVersion: changedGoal.version,
        ...sourceForPatch,
      });
    } catch (error) {
      staleNoteError = error;
    }
    expectStatus(staleNoteError, 409);
    expect(await findWorkContext(runtime, x.id)).toEqual(afterNote);

    let crossWorkSourceError: unknown;
    try {
      await resolveUserNoteSource(runtime, x.id, { roomId: yRoom.id, entryId: yEntry.id });
    } catch (error) {
      crossWorkSourceError = error;
    }
    expectStatus(crossWorkSourceError, 400);

    let outsideFileError: unknown;
    try {
      await updateWorkContext(runtime, x.id, {
        expectedVersion: afterNote!.version,
        resources: [{ kind: "file", name: "Out of scope", location: outsideFile }],
      });
    } catch (error) {
      outsideFileError = error;
    }
    expectStatus(outsideFileError, 400);
    expect(await findWorkContext(runtime, x.id)).toEqual(afterNote);

    let invalidDefaultError: unknown;
    try {
      await updateWorkContext(runtime, x.id, {
        expectedVersion: afterNote!.version,
        directories: { paths: [inside], defaultPath: second },
      });
    } catch (error) {
      invalidDefaultError = error;
    }
    expectStatus(invalidDefaultError, 400);
    expect(await findWorkContext(runtime, x.id)).toEqual(afterNote);

    const roomAfterAdd = await updateRoomMembers(runtime, xRoom.id, [owner.id, other.id], xRoom.membershipVersion);
    expect(roomAfterAdd.room.memberIds).toEqual([owner.id, other.id]);
    const beforeStaleMembers = await findRoom(runtime, xRoom.id);
    let staleMembershipError: unknown;
    try {
      await updateRoomMembers(runtime, xRoom.id, [owner.id], xRoom.membershipVersion);
    } catch (error) {
      staleMembershipError = error;
    }
    expectStatus(staleMembershipError, 409);
    expect(await findRoom(runtime, xRoom.id)).toEqual(beforeStaleMembers);
  }, 60_000);

  it("invalidates only changed work directories while note and goal changes preserve grants", async () => {
    const fixture = await startFixture(fakeAnswer);
    cleanup.push(() => fixture.close());
    const { runtime, resume } = await openTestRuntime(fixture, "emit-context-grants-");
    const employees = await setupFixtureWorkspace(runtime, resume, ["Worker"]);
    const worker = employeeNamed(employees, "Worker");
    const roots = mkdtempSync(join(tmpdir(), "emit-context-grants-roots-"));
    cleanup.push(() => rmSync(roots, { recursive: true, force: true }));
    const x1 = join(roots, "x1");
    const x2 = join(roots, "x2");
    const yPath = join(roots, "y");
    for (const path of [x1, x2, yPath]) mkdirSync(path, { recursive: true });
    const x = await createWorkContext(runtime, {
      name: "Grant X",
      directories: { paths: [x1, x2], defaultPath: x2 },
    });
    const y = await createWorkContext(runtime, {
      name: "Grant Y",
      directories: { paths: [yPath], defaultPath: yPath },
    });
    const xRoom = await createRoom(runtime, { kind: "channel", name: "Grant X", workContextId: x.id, memberIds: [worker.id] });
    const xSecondRoom = await createRoom(runtime, {
      kind: "channel",
      name: "Grant X second channel",
      workContextId: x.id,
      memberIds: [worker.id],
    });
    const yRoom = await createRoom(runtime, { kind: "channel", name: "Grant Y", workContextId: y.id, memberIds: [worker.id] });
    const xWork = await sendRoomMessage(resume, xRoom, `grant-x-${randomUUID()}`, [worker.id]);
    const xSecondWork = await sendRoomMessage(resume, xSecondRoom, `grant-x-second-${randomUUID()}`, [worker.id]);
    const yWork = await sendRoomMessage(resume, yRoom, `grant-y-${randomUUID()}`, [worker.id]);

    const goalGrantResult = await createApprovalGrant(resume, xWork.workIds[0]!, "tool-grant-x-goal");
    const directoryGrantResult = await createApprovalGrant(resume, xWork.workIds[0]!, "tool-grant-x-directory");
    const secondDirectoryGrantResult = await createApprovalGrant(
      resume,
      xSecondWork.workIds[0]!,
      "tool-grant-x-directory-second-room",
    );
    const yGrantResult = await createApprovalGrant(resume, yWork.workIds[0]!, "tool-grant-y-directory");
    expect(goalGrantResult.allow).toBe(true);
    expect(directoryGrantResult.allow).toBe(true);
    expect(secondDirectoryGrantResult.allow).toBe(true);
    expect(yGrantResult.allow).toBe(true);
    if (!goalGrantResult.allow || !directoryGrantResult.allow || !secondDirectoryGrantResult.allow || !yGrantResult.allow)
      return;

    const goalChanged = await updateWorkContext(runtime, x.id, {
      expectedVersion: x.version,
      goal: `Changed without changing authorization ${randomUUID()}`,
    });
    const userNoteSource: WorkNoteSource = { authorId: "user", sourceRoomId: "", sourceEntryId: "", sourceWorkId: "" };
    await createWorkNote(runtime, x.id, {
      title: "Grant-independent note",
      body: "Notes do not change directory authorization.",
      expectedVersion: goalChanged.version,
      ...userNoteSource,
    });
    const goalGrant = await findApproval(runtime, goalGrantResult.record.id);
    if (goalGrant === undefined) throw new Error("Missing X goal grant");
    const goalVerification = await verifyGrant(runtime, worker, await readApp(runtime), requestForGrant(goalGrant));
    expect(goalVerification.allow).toBe(true);

    const currentX = (await findWorkContext(runtime, x.id))!;
    const changedDirectories = await updateWorkContext(runtime, x.id, {
      expectedVersion: currentX.version,
      directories: { paths: [x1], defaultPath: x1 },
    });
    await invalidateWorkContextDirectoryGrants(runtime, x.id, changedDirectories.directories.version);
    for (const grantResult of [directoryGrantResult, secondDirectoryGrantResult]) {
      const invalidated = await findApproval(runtime, grantResult.record.id);
      expect(invalidated?.status).toBe("invalidated");
      const xVerification = await verifyGrant(runtime, worker, await readApp(runtime), requestForGrant(invalidated!));
      expect(xVerification.allow).toBe(false);
    }

    const yGrant = await findApproval(runtime, yGrantResult.record.id);
    if (yGrant === undefined) throw new Error("Missing Y grant");
    const yVerification = await verifyGrant(runtime, worker, await readApp(runtime), requestForGrant(yGrant));
    expect(yVerification.allow).toBe(true);
    expect((await findApproval(runtime, yGrant.id))?.status).toBe("approved");
  }, 60_000);

  it("replays employee note saves once and rejects conflicting or cross-work writes", async () => {
    const fixture = await startFixture(fakeAnswer);
    cleanup.push(() => fixture.close());
    const { runtime, resume } = await openTestRuntime(fixture, "emit-context-note-replay-");
    const employees = await setupFixtureWorkspace(runtime, resume, ["Writer"]);
    const writer = employeeNamed(employees, "Writer");
    const workContext = await createWorkContextFixture(runtime, "Note replay context");
    const otherContext = await createWorkContextFixture(runtime, "Other context");
    const room = await createRoom(runtime, {
      kind: "channel",
      name: "Note room",
      workContextId: workContext.id,
      memberIds: [writer.id],
    });
    const otherRoom = await createRoom(runtime, {
      kind: "channel",
      name: "Other room",
      workContextId: otherContext.id,
      memberIds: [writer.id],
    });
    const sent = await sendRoomMessage(resume, room, `note-source-${randomUUID()}`, [writer.id]);
    const otherSent = await sendRoomMessage(resume, otherRoom, `other-source-${randomUUID()}`, [writer.id]);
    const workId = sent.workIds[0]!;
    await ensureWorkConversation(resume, workId);
    const expectedVersion = (await findWorkContext(runtime, workContext.id))!.version;
    const body = `Replay body ${randomUUID()}`;
    const first = await executeMessageTool(
      resume,
      writer,
      workId,
      "save_work_note",
      { title: "Replay note", body, expectedVersion },
      9201,
    );
    const firstContext = (await findWorkContext(runtime, workContext.id))!;
    expect(first.isError).not.toBe(true);
    expect(firstContext.notes).toHaveLength(1);
    const note = firstContext.notes[0]!;
    const replay = await executeMessageTool(
      resume,
      writer,
      workId,
      "save_work_note",
      { title: "Different title on retry", body: "Must not overwrite", expectedVersion },
      9201,
    );
    expect(replay.isError).not.toBe(true);
    expect(toolText(replay)).toBe(toolText(first));
    expect((await findWorkContext(runtime, workContext.id))?.notes).toEqual(firstContext.notes);
    expect((await findWorkContext(runtime, workContext.id))?.version).toBe(firstContext.version);

    const conflict = await executeMessageTool(
      resume,
      writer,
      workId,
      "save_work_note",
      {
        title: "Conflict must not win",
        body: "Stale expected version",
        noteId: note.id,
        expectedVersion,
      },
      9202,
    );
    expect(conflict.isError).toBe(true);
    expect((await findWorkContext(runtime, workContext.id))?.notes).toEqual(firstContext.notes);

    let sourceError: unknown;
    try {
      await resolveUserNoteSource(runtime, workContext.id, {
        roomId: otherRoom.id,
        entryId: otherSent.message.id,
      });
    } catch (error) {
      sourceError = error;
    }
    expectStatus(sourceError, 400);
    expect((await findWorkContext(runtime, workContext.id))?.notes).toHaveLength(1);
    expect(firstContext.notes[0]?.body).toBe(body);
    expect(sent.workIds).toHaveLength(1);
    expect(otherSent.workIds).toHaveLength(1);
    expect(await readFixtureRoomMessages(runtime, room)).toHaveLength(1);
  }, 60_000);

  it("filters mail history by visibility and never reads beyond the triggering entry", async () => {
    const fixture = await startFixture(fakeAnswer);
    cleanup.push(() => fixture.close());
    const { runtime, resume } = await openTestRuntime(fixture, "emit-context-history-");
    const employees = await setupFixtureWorkspace(runtime, resume, ["ToEmployee", "CcEmployee"]);
    const recipient = employeeNamed(employees, "ToEmployee");
    const ccOnly = employeeNamed(employees, "CcEmployee");
    const context = await createWorkContextFixture(runtime, "History context");
    const room = await createRoom(runtime, { kind: "mail", name: "History mail", workContextId: context.id });

    const retiredDraft = await appendRoomMessage(
      runtime,
      room,
      messageData({
        author: userAuthor,
        body: `RETIRED-DRAFT-${randomUUID()}`,
        mail: mailEnvelope({
          subject: "Retired draft",
          to: [{ name: ccOnly.name, address: ccOnly.address }],
          recipients: [ccOnly.id],
          draft: true,
          sent: false,
        }),
      }),
    );
    await setMailFlag(runtime, room.id, retiredDraft.id, { active: false });
    const draft = await appendRoomMessage(
      runtime,
      room,
      messageData({
        author: userAuthor,
        body: `DRAFT-${randomUUID()}`,
        mail: mailEnvelope({
          subject: "Draft",
          to: [{ name: ccOnly.name, address: ccOnly.address }],
          recipients: [ccOnly.id],
          draft: true,
          sent: false,
        }),
      }),
    );
    const toOther = `TO-OTHER-PRIVATE-${randomUUID()}`;
    await appendRoomMessage(
      runtime,
      room,
      messageData({
        author: userAuthor,
        body: toOther,
        mail: mailEnvelope({
          subject: "For a different employee",
          to: [{ name: recipient.name, address: recipient.address }],
          recipients: [recipient.id],
          sent: true,
        }),
      }),
    );
    const ccVisible = `CC-VISIBLE-${randomUUID()}`;
    await appendRoomMessage(
      runtime,
      room,
      messageData({
        author: userAuthor,
        body: ccVisible,
        mail: mailEnvelope({
          subject: "Visible CC",
          to: [{ name: recipient.name, address: recipient.address }],
          cc: [{ name: ccOnly.name, address: ccOnly.address }],
          recipients: [recipient.id],
          copies: [ccOnly.id],
          sent: true,
        }),
      }),
    );
    const ownVisible = `OWN-VISIBLE-${randomUUID()}`;
    await appendRoomMessage(
      runtime,
      room,
      messageData({
        author: { type: "employee", id: ccOnly.id, name: ccOnly.name, address: ccOnly.address },
        body: ownVisible,
        mail: mailEnvelope({
          subject: "Employee-authored history",
          to: [{ name: "Test User", address: "" }],
          sent: true,
        }),
      }),
    );
    const trigger = `MAIL-TRIGGER-${randomUUID()}`;
    const mail = mailEnvelope({
      subject: "Trigger",
      to: [{ name: ccOnly.name, address: ccOnly.address }],
      recipients: [ccOnly.id],
      sent: true,
    });
    const sent = await sendQueuedMail(resume, {
      room: { id: room.id },
      data: messageData({ author: userAuthor, body: trigger, mail }),
    });
    const afterSource = `FUTURE-AFTER-SOURCE-${randomUUID()}`;
    await appendRoomMessage(runtime, room, messageData({ author: userAuthor, body: afterSource }));
    runtime.resume();
    await awaitWorks(runtime, sent.workIds);
    const request = fixture.requests.find((candidate) => historyPrompt(candidate, trigger));
    expect((await findWork(runtime, sent.workIds[0]!))?.employeeId).toBe(ccOnly.id);
    expect(request).toBeDefined();
    expect(request!.prompt).toContain(ccVisible);
    expect(request!.prompt).toContain(ownVisible);
    expect(request!.prompt).not.toContain(toOther);
    expect(request!.prompt).not.toContain(draft.body);
    expect(request!.prompt).not.toContain(retiredDraft.body);
    expect(request!.prompt).not.toContain(afterSource);
    expect(sent.workIds).toHaveLength(1);
    const entries: MessageDTO[] = await readFixtureRoomMessages(runtime, room);
    expect(entries.some((entry) => entry.body === draft.body)).toBe(true);
  }, 60_000);

  it("keeps mail and private conversation bindings distinct inside each work", async () => {
    const fixture = await startFixture(fakeAnswer);
    cleanup.push(() => fixture.close());
    const { runtime, resume } = await openTestRuntime(fixture, "emit-context-dm-pairs-");
    const employees = await setupFixtureWorkspace(runtime, resume, ["A", "B", "C"]);
    const [a, b, c] = employees;
    const workX = await createWorkContextFixture(runtime, "Pair X");
    const workY = await createWorkContextFixture(runtime, "Pair Y");
    const abX = await ensureEmployeeDm(runtime, {
      workContextId: workX.id,
      participantIds: [a!.id, b!.id],
      name: "A ↔ B X",
      topic: "private",
    });
    const abXAgain = await ensureEmployeeDm(runtime, {
      workContextId: workX.id,
      participantIds: [b!.id, a!.id],
      name: "A ↔ B X duplicate",
      topic: "private",
    });
    const cbX = await ensureEmployeeDm(runtime, {
      workContextId: workX.id,
      participantIds: [c!.id, b!.id],
      name: "C ↔ B X",
      topic: "private",
    });
    const abY = await ensureEmployeeDm(runtime, {
      workContextId: workY.id,
      participantIds: [a!.id, b!.id],
      name: "A ↔ B Y",
      topic: "private",
    });
    expect(abX.room.id).toBe(abXAgain.room.id);
    expect(abX.room.id).not.toBe(cbX.room.id);
    expect(abX.room.id).not.toBe(abY.room.id);
    expect(abX.room.workContextId).toBe(workX.id);
    expect(abY.room.workContextId).toBe(workY.id);
    const userB = await ensureEmployeeDm(runtime, {
      workContextId: workX.id,
      participantIds: ["user", b!.id],
      name: "User ↔ B X",
      topic: "private",
      employeeId: b!.id,
    });
    const userPrivateBody = `USER-B-PRIVATE-${randomUUID()}`;
    const userPrivateWork = await sendRoomMessage(resume, userB.room, userPrivateBody, []);
    const alphaRoom = await createRoom(runtime, {
      kind: "channel",
      name: "Alpha source channel",
      workContextId: workX.id,
      memberIds: [a!.id],
    });
    const alphaParent = await sendRoomMessage(resume, alphaRoom, `ALPHA-DM-PARENT-${randomUUID()}`, [a!.id]);
    const alphaParentWorkId = alphaParent.workIds[0]!;
    await ensureWorkConversation(resume, alphaParentWorkId);
    const employeeDmBody = `ALPHA-TO-B-ONLY-${randomUUID()}`;
    const employeeSend = await executeMessageTool(
      resume,
      a!,
      alphaParentWorkId,
      "send_message",
      { to: b!.id, body: employeeDmBody },
      9301,
    );
    expect(employeeSend.isError).not.toBe(true);

    const employeeThreadMessages = await readFixtureRoomMessages(runtime, abX.room);
    const employeeThreadEntry = employeeThreadMessages.find((message) => message.body === employeeDmBody);
    expect(employeeThreadEntry?.author.id).toBe(a!.id);
    expect(employeeThreadEntry?.roomId).toBe(abX.room.id);
    const employeeDmWork = (await listWorks(runtime)).find((work) => work.sourceEntryId === employeeThreadEntry?.id);
    expect(employeeDmWork).toMatchObject({ employeeId: b!.id, roomId: abX.room.id, workContextId: workX.id });
    if (employeeDmWork === undefined) throw new Error("Missing employee-to-employee DM work");
    expect((await readFixtureRoomMessages(runtime, userB.room)).some((message) => message.body === employeeDmBody)).toBe(false);
    expect((await readFixtureRoomMessages(runtime, abX.room)).some((message) => message.body === userPrivateBody)).toBe(false);

    runtime.resume();
    await awaitWorks(runtime, [...userPrivateWork.workIds, ...alphaParent.workIds, employeeDmWork.id]);
    const userPrompt = fixture.requests.find((request) => historyPrompt(request, userPrivateBody));
    const employeePrompt = fixture.requests.find((request) => historyPrompt(request, employeeDmBody));
    expect(userPrompt).toBeDefined();
    expect(employeePrompt).toBeDefined();
    expect(userPrompt!.prompt).not.toContain(employeeDmBody);
    expect(employeePrompt!.prompt).not.toContain(userPrivateBody);
    expect((await readFixtureRoomMessages(runtime, userB.room)).some((message) => message.body === employeeDmBody)).toBe(false);
    expect((await readFixtureRoomMessages(runtime, abX.room)).some((message) => message.body === userPrivateBody)).toBe(false);
  }, 60_000);
});
