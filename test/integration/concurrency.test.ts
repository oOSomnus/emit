import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sendQueuedMessage } from "../../src/server/channel-messages.ts";
import type { EmployeeRecord, RoomRecord } from "../../src/server/documents.ts";
import { createRoom, ensureEmployeeDm, findRoom, listRooms, updateRoomMembers } from "../../src/server/rooms.ts";
import { stopWork, type Resume } from "../../src/server/work.ts";
import { findWork } from "../../src/server/work-queue.ts";
import { createWorkNote, findWorkContext, resolveUserNoteSource, updateWorkContext } from "../../src/server/work-contexts.ts";
import type { EmitRuntime } from "../../src/server/runtime.ts";
import { updateEmployee } from "../../src/server/workspace.ts";
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
  type FixtureAnswer,
  type FixtureRequest,
} from "../helpers/emit-fixture.ts";
import { useSuiteCleanup } from "../helpers/suite-hooks.ts";

const cleanups = useSuiteCleanup({ key: { env: FAKE_KEY_ENV, value: "local-fixture-key" }, errorMode: "ignore" });

const userAuthor = { type: "user" as const, id: "user", name: "Test User", address: "" };

type IntegrationWorkspace = {
  runtime: EmitRuntime;
  resume: Resume;
  fixture: Fixture;
  dataDir: string;
  employees: EmployeeRecord[];
};

async function openWorkspace(
  answer: (request: FixtureRequest) => FixtureAnswer,
  prefix: string,
  names: readonly string[],
): Promise<IntegrationWorkspace> {
  const fixture = await startFixture(answer);
  cleanups.push(() => fixture.close());
  const dataDir = mkdtempDataDir(prefix);
  cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const opened = await openRuntime(dataDir);
  cleanups.push(() => opened.runtime.close());
  await opened.runtime.storeCustomProviders([providerConfig(fixture.baseUrl)]);
  const employees = await setupFixtureWorkspace(opened.runtime, opened.resume, names);
  return { ...opened, fixture, dataDir, employees };
}

function employeeNamed(employees: readonly EmployeeRecord[], name: string): EmployeeRecord {
  const employee = employees.find((candidate) => candidate.name === name);
  if (employee === undefined) throw new Error(`Missing employee ${name}`);
  return employee;
}

function requireOneSuccessOneConflict<T>(results: PromiseSettledResult<T>[]): T {
  const fulfilled = results.find((result): result is PromiseFulfilledResult<T> => result.status === "fulfilled");
  const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  if (fulfilled === undefined || rejected === undefined) throw new Error("Expected one committed change and one conflict");
  expect(rejected.reason).toMatchObject({ status: 409 });
  return fulfilled.value;
}

async function waitForTerminal(runtime: EmitRuntime, workIds: readonly string[]): Promise<void> {
  await waitForFixture(async () => {
    const works = await Promise.all(workIds.map((id) => findWork(runtime, id)));
    return works.every((work) => work !== undefined && ["succeeded", "failed", "stopped"].includes(work.status));
  }, `works ${workIds.join(", ")} to finish`);
}

function simpleAnswer(request: FixtureRequest): FixtureAnswer {
  if (request.model === "fake-reviewer") {
    return {
      content: JSON.stringify({
        outcome: "allow",
        risk: "low",
        rationale: "Local test action.",
        readOnly: true,
        userAuthorization: "unknown",
      }),
    };
  }
  return { content: "The fixture completed this request." };
}

describe("runtime concurrency and competing state changes", () => {
  it("commits one writer for each simultaneous note, directory, and membership version", async () => {
    const workspace = await openWorkspace(simpleAnswer, "emit-concurrent-versions-", ["One", "Two", "Three"]);
    const [one, two, three] = workspace.employees;
    if (one === undefined || two === undefined || three === undefined) throw new Error("Missing seeded employees");

    const noteContext = await createWorkContextFixture(workspace.runtime, "Concurrent notes");
    const noteVersion = noteContext.version;
    const noteSource = await resolveUserNoteSource(workspace.runtime, noteContext.id, undefined);
    const noteWinner = requireOneSuccessOneConflict(
      await Promise.allSettled([
        createWorkNote(workspace.runtime, noteContext.id, {
          title: "First writer",
          body: "First body",
          expectedVersion: noteVersion,
          ...noteSource,
        }),
        createWorkNote(workspace.runtime, noteContext.id, {
          title: "Second writer",
          body: "Second body",
          expectedVersion: noteVersion,
          ...noteSource,
        }),
      ]),
    );
    const noteAfter = await findWorkContext(workspace.runtime, noteContext.id);
    expect(noteAfter?.version).toBe(noteVersion + 1);
    expect(noteAfter?.notes).toHaveLength(1);
    expect(noteAfter?.notes[0]?.id).toBe(noteWinner.note.id);
    expect(["First writer", "Second writer"]).toContain(noteAfter?.notes[0]?.title);

    const directoryContext = await createWorkContextFixture(workspace.runtime, "Concurrent directories");
    const directoryA = join(workspace.dataDir, "directory-a");
    const directoryB = join(workspace.dataDir, "directory-b");
    mkdirSync(directoryA, { recursive: true });
    mkdirSync(directoryB, { recursive: true });
    const directoryBase = await findWorkContext(workspace.runtime, directoryContext.id);
    if (directoryBase === undefined) throw new Error("Missing directory work context");
    const directoryWinner = requireOneSuccessOneConflict(
      await Promise.allSettled([
        updateWorkContext(workspace.runtime, directoryContext.id, {
          expectedVersion: directoryBase.version,
          directories: { paths: [directoryA], defaultPath: directoryA },
        }),
        updateWorkContext(workspace.runtime, directoryContext.id, {
          expectedVersion: directoryBase.version,
          directories: { paths: [directoryB], defaultPath: directoryB },
        }),
      ]),
    );
    const directoryAfter = await findWorkContext(workspace.runtime, directoryContext.id);
    expect(directoryAfter?.version).toBe(directoryBase.version + 1);
    expect(directoryAfter?.directories.version).toBe(directoryBase.directories.version + 1);
    expect(directoryAfter?.directories.paths).toEqual(directoryWinner.directories.paths);

    const membersContext = await createWorkContextFixture(workspace.runtime, "Concurrent members");
    const room = await createRoom(workspace.runtime, {
      kind: "channel",
      name: "Competing membership edits",
      workContextId: membersContext.id,
      memberIds: [one.id],
    });
    const membershipBase = room.membershipVersion;
    const membershipWinner = requireOneSuccessOneConflict(
      await Promise.allSettled([
        updateRoomMembers(workspace.runtime, room.id, [one.id, two.id], membershipBase),
        updateRoomMembers(workspace.runtime, room.id, [one.id, three.id], membershipBase),
      ]),
    );
    const roomAfter = await findRoom(workspace.runtime, room.id);
    expect(roomAfter?.membershipVersion).toBe(membershipBase + 1);
    expect(roomAfter?.memberIds).toEqual(membershipWinner.room.memberIds);
    expect(roomAfter?.memberIds).toContain(one.id);
  }, 60_000);

  it("deduplicates simultaneous direct-message creation within one work but not across works", async () => {
    const workspace = await openWorkspace(simpleAnswer, "emit-concurrent-dm-", ["One", "Two"]);
    const [one, two] = workspace.employees;
    if (one === undefined || two === undefined) throw new Error("Missing seeded employees");
    const workX = await createWorkContextFixture(workspace.runtime, "DM work X");
    const workY = await createWorkContextFixture(workspace.runtime, "DM work Y");

    const [first, second] = await Promise.all([
      ensureEmployeeDm(workspace.runtime, {
        workContextId: workX.id,
        participantIds: [one.id, two.id],
        name: "One and Two",
        topic: "Same pair",
      }),
      ensureEmployeeDm(workspace.runtime, {
        workContextId: workX.id,
        participantIds: [two.id, one.id],
        name: "Two and One",
        topic: "Same pair, reversed input",
      }),
    ]);
    expect(first.room.id).toBe(second.room.id);
    expect([first.created, second.created].filter(Boolean)).toHaveLength(1);
    expect([first.created, second.created].filter((created) => !created)).toHaveLength(1);

    const otherWork = await ensureEmployeeDm(workspace.runtime, {
      workContextId: workY.id,
      participantIds: [one.id, two.id],
      name: "One and Two in another work",
      topic: "Independent pair thread",
    });
    expect(otherWork.created).toBe(true);
    expect(otherWork.room.id).not.toBe(first.room.id);
    const directMessages = (await listRooms(workspace.runtime)).filter((room) => room.kind === "dm");
    expect(directMessages.filter((room) => room.workContextId === workX.id)).toHaveLength(1);
    expect(directMessages.filter((room) => room.workContextId === workY.id)).toHaveLength(1);
  }, 60_000);

  it("stops queued work before dispatch and stops active work when its room or employee permission is revoked", async () => {
    const membershipGate = Promise.withResolvers<void>();
    const disabledGate = Promise.withResolvers<void>();
    const started = new Set<string>();
    const workspace = await openWorkspace((request) => {
      if (request.prompt.includes("ACTIVE_MEMBERSHIP_REVOKED") && !request.prompt.includes("ACTIVE_EMPLOYEE_DISABLED")) {
        started.add("ACTIVE_MEMBERSHIP_REVOKED");
        return { content: "Late answer after room removal.", gate: membershipGate.promise };
      }
      if (request.prompt.includes("ACTIVE_EMPLOYEE_DISABLED")) {
        started.add("ACTIVE_EMPLOYEE_DISABLED");
        return { content: "Late answer after employee disable.", gate: disabledGate.promise };
      }
      return simpleAnswer(request);
    }, "emit-active-permissions-", ["Member", "Disabled"]);
    cleanups.push(() => {
      membershipGate.resolve();
      disabledGate.resolve();
    });
    const member = employeeNamed(workspace.employees, "Member");
    const disabled = employeeNamed(workspace.employees, "Disabled");
    const workContext = await createWorkContextFixture(workspace.runtime, "Permission changes", {
      paths: [join(workspace.dataDir, "work")],
      defaultPath: join(workspace.dataDir, "work"),
    });
    const room: RoomRecord = await createRoom(workspace.runtime, {
      kind: "channel",
      name: "Permission changes channel",
      workContextId: workContext.id,
      memberIds: [member.id, disabled.id],
    });

    const queuedMessage = await sendQueuedMessage(workspace.resume, {
      roomId: room.id,
      author: userAuthor,
      body: "QUEUED_STOP",
      recipientIds: [member.id],
    });
    const queuedWorkId = queuedMessage.workIds[0];
    if (queuedWorkId === undefined) throw new Error("Missing queued work");
    expect((await findWork(workspace.runtime, queuedWorkId))?.status).toBe("queued");
    const queuedStop = await stopWork(workspace.resume, queuedWorkId);
    expect(queuedStop?.status).toBe("stopped");
    workspace.runtime.resume();
    await waitForFixture(async () => (await findWork(workspace.runtime, queuedWorkId))?.status === "stopped", "queued work to stay stopped");

    const memberSend = await sendQueuedMessage(workspace.resume, {
      roomId: room.id,
      author: userAuthor,
      body: "ACTIVE_MEMBERSHIP_REVOKED",
      recipientIds: [member.id],
    });
    const disabledSend = await sendQueuedMessage(workspace.resume, {
      roomId: room.id,
      author: userAuthor,
      body: "ACTIVE_EMPLOYEE_DISABLED",
      recipientIds: [disabled.id],
    });
    const memberWorkId = memberSend.workIds[0];
    const disabledWorkId = disabledSend.workIds[0];
    if (memberWorkId === undefined || disabledWorkId === undefined) throw new Error("Missing permission test work");
    await waitForFixture(
      () => Promise.resolve(started.has("ACTIVE_MEMBERSHIP_REVOKED") && started.has("ACTIVE_EMPLOYEE_DISABLED")),
      "both works to reach their gated model response",
    );
    expect((await findWork(workspace.runtime, memberWorkId))?.status).toBe("running");
    expect((await findWork(workspace.runtime, disabledWorkId))?.status).toBe("running");

    const currentRoom = await findRoom(workspace.runtime, room.id);
    if (currentRoom === undefined) throw new Error("Missing permission test room");
    await updateRoomMembers(workspace.runtime, room.id, [disabled.id], currentRoom.membershipVersion);
    await updateEmployee(workspace.runtime, disabled.id, { enabled: false });
    membershipGate.resolve();
    disabledGate.resolve();
    await waitForTerminal(workspace.runtime, [memberWorkId, disabledWorkId]);

    expect((await findWork(workspace.runtime, memberWorkId))?.status).toBe("stopped");
    expect((await findWork(workspace.runtime, disabledWorkId))?.status).toBe("stopped");
    const messages = await readFixtureRoomMessages(workspace.runtime, room);
    expect(messages.some((message) => message.workId === queuedWorkId && message.author.type === "employee")).toBe(false);
    expect((await stopWork(workspace.resume, queuedWorkId))?.status).toBe("stopped");
    expect(messages.some((message) => message.workId === memberWorkId && message.author.type === "employee")).toBe(false);
    expect(messages.some((message) => message.workId === disabledWorkId && message.author.type === "employee")).toBe(false);
  }, 60_000);
});
