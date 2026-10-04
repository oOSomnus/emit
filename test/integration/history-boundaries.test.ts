import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MessageDTO, WorkContextDTO } from "../../src/shared/contracts.ts";
import { sendQueuedMessage } from "../../src/server/channel-messages.ts";
import type { EmployeeRecord } from "../../src/server/documents.ts";
import { sendQueuedMail } from "../../src/server/mail.ts";
import { appendRoomMessage, createRoom, findRoom, mailEnvelope, messageData, setMailFlag } from "../../src/server/rooms.ts";
import { createWorkContext } from "../../src/server/work-contexts.ts";
import { listWorks } from "../../src/server/work.ts";
import { readApp } from "../../src/server/workspace.ts";
import {
  FAKE_KEY_ENV,
  createWorkContextFixture,
  mkdtempDataDir,
  openRuntime,
  providerConfig,
  setupFixtureWorkspace,
  startFixture,
  startHttpRuntime,
  waitForFixture,
  type HttpRuntimeFixture,
} from "../helpers/emit-fixture.ts";

const cleanups: Array<() => Promise<void> | void> = [];
let previousApiKey: string | undefined;

beforeEach(() => {
  previousApiKey = process.env[FAKE_KEY_ENV];
  process.env[FAKE_KEY_ENV] = "local-history-boundary-key";
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch {
      // Cleanup must not obscure the originating assertion.
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

async function getWorkContexts(server: HttpRuntimeFixture["server"]): Promise<WorkContextDTO[]> {
  const response = await server.inject({ method: "GET", url: "/api/work-contexts" });
  expect(response.statusCode).toBe(200);
  return response.json<{ workContexts: WorkContextDTO[] }>().workContexts;
}

describe("history and persistence boundaries", () => {
  it("lists every work context at counts 0, 1, 199, 200, 201, and 401", async () => {
    const root = mkdtempDataDir("emit-context-list-boundaries-");
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const http = await startHttpRuntime(root);
    cleanups.push(() => http.close());

    const created: WorkContextDTO[] = [];
    const assertList = async (expectedCount: number) => {
      const listed = await getWorkContexts(http.server);
      expect(listed).toHaveLength(expectedCount);
      expect(new Set(listed.map((context) => context.id))).toEqual(new Set(created.map((context) => context.id)));
    };
    const createThroughApi = async (index: number) => {
      const response = await http.server.inject({
        method: "POST",
        url: "/api/work-contexts",
        payload: { name: `List boundary ${index}` },
      });
      expect(response.statusCode).toBe(200);
      created.push(response.json<WorkContextDTO>());
    };

    await assertList(0);
    for (let index = 1; index <= 401; index += 1) {
      await createThroughApi(index);
      if ([1, 199, 200, 201, 401].includes(index)) await assertList(index);
    }
  }, 60_000);

  it("includes exactly the latest 39, 40, or 40-of-41 visible room messages and excludes later entries", async () => {
    const fake = await startFixture((request) => {
      if (request.model === "fake-reviewer") {
        return {
          content: JSON.stringify({
            outcome: "allow",
            risk: "low",
            rationale: "History boundary fixture",
            readOnly: true,
            userAuthorization: "unknown",
          }),
        };
      }
      if (request.prompt.includes("localpart")) return { content: '{"localpart":"fixture-user"}' };
      return { content: "History boundary answered." };
    });
    cleanups.push(() => fake.close());
    const root = mkdtempDataDir("emit-room-history-window-");
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const { runtime, resume } = await openRuntime(root);
    cleanups.push(() => runtime.close());
    await runtime.storeCustomProviders([providerConfig(fake.baseUrl)]);
    const employees = await setupFixtureWorkspace(runtime, resume, ["History Reader"]);
    const reader = employeeNamed(employees, "History Reader");
    const context = await createWorkContextFixture(runtime, "History window context");

    const cases = [39, 40, 41] as const;
    const runs: Array<{ trigger: string; future: string; expected: string[]; dropped?: string }> = [];
    for (const count of cases) {
      const room = await createRoom(runtime, {
        kind: "channel",
        name: `History window ${count}`,
        workContextId: context.id,
        memberIds: [reader.id],
      });
      const history = Array.from({ length: count }, (_, index) => `HISTORY-${count}-${index + 1}::END`);
      for (const body of history) {
        await appendRoomMessage(runtime, room, messageData({ author: userAuthor, body }));
      }
      const trigger = `TRIGGER-${count}`;
      const sent = await sendQueuedMessage(resume, {
        roomId: room.id,
        author: userAuthor,
        body: trigger,
        recipientIds: [reader.id],
      });
      const future = `AFTER-SOURCE-${count}`;
      await appendRoomMessage(runtime, room, messageData({ author: userAuthor, body: future }));
      runs.push({
        trigger,
        future,
        expected: history.slice(-40),
        ...(count === 41 ? { dropped: history[0] } : {}),
      });
      expect(sent.workIds).toHaveLength(1);
    }

    runtime.resume();
    await waitForFixture(
      async () => {
        const works = await listWorks(runtime);
        return works.length === 3 && works.every((work) => ["succeeded", "failed", "stopped"].includes(work.status));
      },
      "the three history-boundary runs to finish",
    );

    for (const run of runs) {
      const request = fake.requests.find((candidate) => candidate.prompt.includes(run.trigger));
      expect(request, `missing model input for ${run.trigger}`).toBeDefined();
      for (const marker of run.expected) expect(request!.prompt).toContain(marker);
      expect(request!.prompt).not.toContain(run.future);
      if (run.dropped !== undefined) expect(request!.prompt).not.toContain(run.dropped);
    }
  }, 60_000);

  it("accepts a reply to the earliest sent mail after more than 200 later sent entries", async () => {
    const root = mkdtempDataDir("emit-earliest-mail-reply-");
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const http = await startHttpRuntime(root);
    cleanups.push(() => http.close());
    const { runtime, resume } = http;
    const context = await createWorkContext(runtime, { name: "Long mail thread" });
    const room = await createRoom(runtime, { kind: "mail", name: "Long mail thread", workContextId: context.id });
    let earliest: MessageDTO | undefined;

    for (let index = 0; index < 205; index += 1) {
      const sent = await sendQueuedMail(resume, {
        room: { id: room.id },
        data: messageData({
          author: userAuthor,
          body: `Sent history entry ${index + 1}`,
          mail: mailEnvelope({ subject: `Sent history ${index + 1}` }),
        }),
      });
      if (index === 0) earliest = sent.message;
    }
    if (earliest === undefined) throw new Error("The earliest sent entry was not created");

    const reply = await http.server.inject({
      method: "POST",
      url: `/api/rooms/${room.id}/mail-send`,
      payload: { subject: "Reply to earliest", body: "This references the first sent entry.", inReplyTo: earliest.id },
    });
    expect(reply.statusCode).toBe(200);
    const sentReply = reply.json<{ message: MessageDTO; workIds: string[] }>();
    expect(sentReply.message.mail?.inReplyTo).toBe(earliest.id);
    expect(sentReply.workIds).toEqual([]);
  }, 60_000);

  it("filters unread mailbox flags and addressed visibility consistently across restart", async () => {
    const fake = await startFixture((request) =>
      request.prompt.includes("localpart") ? { content: '{"localpart":"fixture-user"}' } : { content: "Fixture response." },
    );
    cleanups.push(() => fake.close());
    const root = mkdtempDataDir("emit-mail-flags-restart-");
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    let http = await startHttpRuntime(root);
    cleanups.push(() => http.close());
    await http.runtime.storeCustomProviders([providerConfig(fake.baseUrl)]);
    const employees = await setupFixtureWorkspace(http.runtime, http.resume, ["Sender", "Other"]);
    const sender = employeeNamed(employees, "Sender");
    const other = employeeNamed(employees, "Other");
    const context = await createWorkContextFixture(http.runtime, "Mail flags context");
    const room = await createRoom(http.runtime, { kind: "mail", name: "Mail flags", workContextId: context.id });
    const app = await readApp(http.runtime);

    const appendInbound = async (body: string, mode: "to-user" | "cc-user" | "other") =>
      appendRoomMessage(
        http.runtime,
        room,
        messageData({
          author: { type: "employee", id: sender.id, name: sender.name, address: sender.address },
          body,
          mail: mailEnvelope({
            subject: body,
            to:
              mode === "other"
                ? [{ name: other.name, address: other.address }]
                : mode === "to-user"
                  ? [{ name: app.userName, address: app.userAddress }]
                  : [{ name: other.name, address: other.address }],
            cc: mode === "cc-user" ? [{ name: app.userName, address: app.userAddress }] : [],
            recipients: mode === "other" || mode === "cc-user" ? [other.id] : ["user"],
            copies: mode === "cc-user" ? ["user"] : [],
          }),
        }),
      );

    const unreadTo = await appendInbound("INBOUND-TO-USER", "to-user");
    const unreadCc = await appendInbound("INBOUND-CC-USER", "cc-user");
    const addressedElsewhere = await appendInbound("INBOUND-OTHER-ONLY", "other");
    const readMail = await appendInbound("INBOUND-READ", "to-user");
    const archivedMail = await appendInbound("INBOUND-ARCHIVED", "to-user");
    const userSent = await appendRoomMessage(
      http.runtime,
      room,
      messageData({
        author: { type: "user", id: "user", name: app.userName, address: app.userAddress },
        body: "USER-SENT-MAIL",
        mail: mailEnvelope({
          subject: "User sent",
          to: [{ name: other.name, address: other.address }],
          recipients: [other.id],
        }),
      }),
    );
    await setMailFlag(http.runtime, room.id, readMail.id, { read: true });
    await setMailFlag(http.runtime, room.id, archivedMail.id, { archived: true });

    const assertMailbox = async (server: HttpRuntimeFixture["server"]) => {
      const roomsResponse = await server.inject({ method: "GET", url: "/api/rooms" });
      expect(roomsResponse.statusCode).toBe(200);
      const rooms = roomsResponse.json<Array<{ id: string; unread: number }>>();
      expect(rooms.find((entry) => entry.id === room.id)?.unread).toBe(2);
      const mailResponse = await server.inject({ method: "GET", url: "/api/mail" });
      expect(mailResponse.statusCode).toBe(200);
      const mailbox = mailResponse.json<{ items: Array<{ roomId: string; message: MessageDTO }> }>();
      const visibleIds = new Set(mailbox.items.map((item) => item.message.id));
      expect(visibleIds).toEqual(new Set([unreadTo.id, unreadCc.id, readMail.id, archivedMail.id, userSent.id]));
      expect(visibleIds.has(addressedElsewhere.id)).toBe(false);
      const readFlags = new Map(mailbox.items.map((item) => [item.message.id, item.message.mail]));
      expect(readFlags.get(unreadTo.id)?.read).toBe(false);
      expect(readFlags.get(unreadCc.id)?.read).toBe(false);
      expect(readFlags.get(readMail.id)?.read).toBe(true);
      expect(readFlags.get(archivedMail.id)?.archived).toBe(true);
    };

    await assertMailbox(http.server);
    await http.close();
    http = await startHttpRuntime(root);
    const reopenedRoom = await findRoom(http.runtime, room.id);
    expect(reopenedRoom).toBeDefined();
    await assertMailbox(http.server);
    const messagesResponse = await http.server.inject({ method: "GET", url: `/api/rooms/${room.id}/messages` });
    expect(messagesResponse.statusCode).toBe(200);
    const messages = messagesResponse.json<{ messages: MessageDTO[] }>().messages;
    expect(messages.find((message) => message.id === readMail.id)?.mail?.read).toBe(true);
    expect(messages.find((message) => message.id === archivedMail.id)?.mail?.archived).toBe(true);
    expect(messages.find((message) => message.id === addressedElsewhere.id)?.mail?.read).toBe(false);
  }, 60_000);
});
