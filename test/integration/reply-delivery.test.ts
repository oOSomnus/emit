/**
 * Reply delivery across a restart.
 *
 * An employee that already sent its ordinary reply into the conversation its
 * work started from must not post the work's final summary as a second
 * message, and the durable reply receipt has to survive a crash between the
 * send and the final answer.
 */

import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { sendQueuedMessage } from "../../src/server/channel-messages.ts";
import { createRoom } from "../../src/server/rooms.ts";
import { installEmployeeExtension, reconcileWorks } from "../../src/server/work.ts";
import { findWork } from "../../src/server/work-queue.ts";
import { listEmployees } from "../../src/server/workspace.ts";
import type { EmployeeRecord } from "../../src/server/documents.ts";
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
} from "../helpers/emit-fixture.ts";

const cleanups: Array<() => Promise<void> | void> = [];
let previousApiKey: string | undefined;

beforeEach(() => {
  previousApiKey = process.env[FAKE_KEY_ENV];
  process.env[FAKE_KEY_ENV] = "local-fixture-key";
});

afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) {
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

function allowAnswer() {
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

function countToolResults(request: FixtureRequest): number {
  return request.prompt.match(/"role":"tool"/g)?.length ?? 0;
}

function employeeNamed(employees: readonly EmployeeRecord[], name: string): EmployeeRecord {
  const employee = employees.find((candidate) => candidate.name === name);
  if (employee === undefined) throw new Error(`Missing employee ${name}`);
  return employee;
}

async function openReopenedRuntime(dir: string) {
  const opened = await openRuntime(dir);
  cleanups.push(async () => {
    await opened.runtime.close();
  });
  for (const employee of await listEmployees(opened.runtime)) {
    await installEmployeeExtension(opened.resume, employee);
  }
  return opened;
}

async function sendChannelMessage(resume: Parameters<typeof sendQueuedMessage>[0], roomId: string, body: string, recipientIds: string[]) {
  return sendQueuedMessage(resume, {
    roomId,
    author: userAuthor,
    body,
    recipientIds,
  });
}

it("keeps one ordinary reply and records the final answer after a restart", async () => {
  const rootMarker = `restart-root-${randomUUID()}`;
  const replyBody = "RESTART_REPLY_BODY";
  const finalText = "RESTART_REPLY_FINAL";
  const gate = Promise.withResolvers<void>();
  let channelId = "";
  let firstFinalAttempt = false;
  let finalAttempts = 0;
  const fixture: Fixture = await startFixture((request) => {
    if (request.model === "fake-reviewer") return allowAnswer();
    if (countToolResults(request) === 0) {
      return { toolCall: { name: "send_message", args: { roomId: channelId, body: replyBody } } };
    }
    finalAttempts += 1;
    if (finalAttempts === 1) {
      firstFinalAttempt = true;
      return { content: finalText, gate: gate.promise };
    }
    return { content: finalText };
  });
  cleanups.push(() => gate.resolve());
  cleanups.push(() => fixture.close());
  const dir = mkdtempDataDir("emit-reply-delivery-");
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

  const first = await openRuntime(dir);
  cleanups.push(async () => {
    await first.runtime.close();
  });
  await first.runtime.storeCustomProviders([providerConfig(fixture.baseUrl)]);
  const employees = await setupFixtureWorkspace(first.runtime, first.resume, ["Alpha"]);
  const alpha = employeeNamed(employees, "Alpha");
  const context = await createWorkContextFixture(first.runtime, "Restart reply work");
  const room = await createRoom(first.runtime, {
    kind: "channel",
    name: "Restart reply channel",
    workContextId: context.id,
    memberIds: [alpha.id],
  });
  channelId = room.id;
  first.runtime.resume();

  const root = await sendChannelMessage(first.resume, room.id, rootMarker, [alpha.id]);
  const rootWorkId = root.workIds[0]!;
  await waitForFixture(async () => firstFinalAttempt, "the gated final request", 45_000);

  // The reply is already durable and owned by its work while the generation
  // that will produce the final summary is still in flight.
  const before = await readFixtureRoomMessages(first.runtime, room);
  const replies = before.filter((message) => message.body === replyBody);
  expect(replies).toHaveLength(1);
  expect(replies[0]?.workId).toBe(rootWorkId);
  const replyEntryId = replies[0]!.id;
  expect(before.some((message) => message.body === finalText)).toBe(false);
  expect((await findWork(first.runtime, rootWorkId))?.status).toBe("running");

  // The process goes away with the final request unanswered.
  await first.runtime.close();

  const reopened = await openReopenedRuntime(dir);
  const requestsBeforeResume = fixture.requests.length;
  reopened.runtime.resume();
  await reconcileWorks(reopened.resume);
  await waitForFixture(
    async () => (await findWork(reopened.runtime, rootWorkId))?.status === "succeeded",
    "the resumed work to finish",
    45_000,
  );

  const work = await findWork(reopened.runtime, rootWorkId);
  expect(work?.answer).toBe(finalText);
  const after = await readFixtureRoomMessages(reopened.runtime, room);
  const afterReplies = after.filter((message) => message.body === replyBody);
  expect(afterReplies).toHaveLength(1);
  expect(afterReplies[0]?.id).toBe(replyEntryId);
  expect(after.some((message) => message.body === finalText)).toBe(false);
  // The resumed run re-asks for the answer; it never re-runs the sent tool.
  const resumedRequests = fixture.requests
    .slice(requestsBeforeResume)
    .filter((request) => request.model !== "fake-reviewer");
  expect(resumedRequests.length).toBeGreaterThan(0);
  expect(resumedRequests.every((request) => countToolResults(request) > 0)).toBe(true);

  // A second restart still finds exactly the one reply.
  await reopened.runtime.close();
  const second = await openReopenedRuntime(dir);
  second.runtime.resume();
  await reconcileWorks(second.resume);
  const reloaded = await readFixtureRoomMessages(second.runtime, room);
  expect(reloaded.filter((message) => message.body === replyBody)).toHaveLength(1);
  expect(reloaded.some((message) => message.body === finalText)).toBe(false);
  expect((await findWork(second.runtime, rootWorkId))?.status).toBe("succeeded");
}, 90_000);
