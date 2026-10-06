import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineDoc, type ConversationId, type Cursor } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { MessageDTO, WorkContextDTO } from "../../src/shared/contracts.ts";
import { sendQueuedMessage } from "../../src/server/channel-messages.ts";
import { EmployeeDoc, MailFlagDoc, RoomMessageEntry, type EmployeeRecord, type RoomRecord } from "../../src/server/documents.ts";
import { sendQueuedMail } from "../../src/server/mail.ts";
import {
  appendRoomMessage,
  countMailUnread,
  createRoom,
  findRoom,
  mailEnvelope,
  messageData,
  setMailFlag,
} from "../../src/server/rooms.ts";
import { EmitRuntime } from "../../src/server/runtime.ts";
import { createWorkContext } from "../../src/server/work-contexts.ts";
import { installAllExtensions, listWorks } from "../../src/server/work.ts";
import { listEmployees, readApp } from "../../src/server/workspace.ts";
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

/**
 * The retired app document: the format the one-time address migration exists
 * for. Written through its own token so the stored record is a real version 1
 * document, not a hand-edited copy of the current shape.
 */
type LegacyAppRecord = {
  onboarded: boolean;
  workspaceName: string;
  workspaceSlug: string;
  userName: string;
  userAddress: string;
  defaultExecutionModel: { providerId: string; modelId: string; effort: string } | null;
  approval: { kind: "llm"; providerId: string; modelId: string; effort: string; criteriaVersion: number };
  collaboration: { maxDepth: number; maxCrossEmployeeWakes: number; maxModelTurns: number };
  policyVersion: number;
};

const LegacyAppDoc = defineDoc<LegacyAppRecord>({
  kind: "emit.app",
  version: 1,
  scope: "session",
  initial: () => ({
    onboarded: false,
    workspaceName: "",
    workspaceSlug: "",
    userName: "",
    userAddress: "",
    defaultExecutionModel: null,
    approval: { kind: "llm", providerId: "", modelId: "", effort: "off", criteriaVersion: 3 },
    collaboration: { maxDepth: 3, maxCrossEmployeeWakes: 12, maxModelTurns: 40 },
    policyVersion: 1,
  }),
});

async function seedLegacyApp(runtime: EmitRuntime, input: { slug: string; userName: string; userAddress: string }): Promise<void> {
  await runtime.harness.commit(async (tx) => {
    const doc = await tx.doc(LegacyAppDoc);
    doc.onboarded = true;
    doc.workspaceName = input.slug;
    doc.workspaceSlug = input.slug;
    doc.userName = input.userName;
    doc.userAddress = input.userAddress;
    doc.defaultExecutionModel = { providerId: "fake", modelId: "fake-chat", effort: "off" };
    doc.approval = { kind: "llm", providerId: "fake", modelId: "fake-reviewer", effort: "off", criteriaVersion: 3 };
    doc.collaboration = { maxDepth: 3, maxCrossEmployeeWakes: 12, maxModelTurns: 40 };
    doc.policyVersion = 1;
  }, runtime.ctx);
}

async function seedLegacyEmployee(
  runtime: EmitRuntime,
  employee: { id: string; name: string; address: string; createdAt: number; enabled: boolean },
): Promise<void> {
  await runtime.updateFamily(EmployeeDoc, employee.id, { id: employee.id }, (doc) => {
    doc.name = employee.name;
    doc.address = employee.address;
    doc.addressSource = "manual";
    doc.role = "Legacy role";
    doc.executionModel = { providerId: "fake", modelId: "fake-chat", effort: "off" };
    doc.allowedTools = ["read_file"];
    doc.enabled = employee.enabled;
    doc.configVersion = 1;
    doc.createdAt = employee.createdAt;
  });
}

/** Every stored message of one room, raw, keyed by entry id. */
async function rawRoomEntries(runtime: EmitRuntime, room: RoomRecord): Promise<Map<string, string>> {
  const conversation = await runtime.harness.conversation(room.conversationId as ConversationId, runtime.ctx);
  const entries = new Map<string, string>();
  if (conversation === undefined) return entries;
  let cursor: Cursor | undefined;
  for (;;) {
    const page = await conversation.entries({}, 500, cursor, runtime.ctx);
    for (const entry of page.items) {
      if (entry.kind === "emit.message") entries.set(String(entry.id), JSON.stringify(entry.data));
    }
    if (page.next === undefined) break;
    cursor = page.next;
  }
  return entries;
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

  it("migrates a pre-domain workspace onto @emit while every stored message stays intact", async () => {
    const fake = await startFixture((request) =>
      request.prompt.includes("localpart")
        ? { content: '{"localpart":"fixture-user"}' }
        : { content: "Migration regression answered." },
    );
    cleanups.push(() => fake.close());
    const root = mkdtempDataDir("emit-legacy-address-migration-");
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));

    // Seed a workspace exactly as the retired format stored it. The app record
    // is a real version 1 document, so the runtime's migration is what runs.
    const seeded = await openRuntime(root);
    cleanups.push(() => seeded.runtime.close());
    await seeded.runtime.storeCustomProviders([providerConfig(fake.baseUrl)]);
    await seedLegacyApp(seeded.runtime, { slug: "legacy", userName: "Alice Owner", userAddress: "alice@legacy.test" });
    await seedLegacyEmployee(seeded.runtime, {
      id: "alice",
      name: "Alice",
      address: "alice@new.test",
      createdAt: 10,
      enabled: true,
    });
    await seedLegacyEmployee(seeded.runtime, {
      id: "bob",
      name: "Bob",
      address: "bob@new.test",
      createdAt: 20,
      enabled: true,
    });
    await seedLegacyEmployee(seeded.runtime, {
      id: "bobtwo",
      name: "Bob Two",
      address: "bob@legacy.test",
      createdAt: 30,
      enabled: false,
    });
    const workContext = await createWorkContextFixture(seeded.runtime, "Legacy mail work");
    const room = await createRoom(seeded.runtime, {
      kind: "mail",
      name: "Legacy inbox",
      workContextId: workContext.id,
    });
    const legacyAuthor = { type: "employee" as const, id: "alice", name: "Alice", address: "alice@new.test" };

    // More than one entry page of history, so the migration must not stop at
    // the newest page the views happen to show.
    const oldestFiller = await appendRoomMessage(
      seeded.runtime,
      room,
      messageData({ author: legacyAuthor, body: "HISTORY-1" }),
    );
    for (let index = 2; index <= 205; index += 1) {
      await appendRoomMessage(seeded.runtime, room, messageData({ author: legacyAuthor, body: `HISTORY-${index}` }));
    }

    const toUser = await appendRoomMessage(
      seeded.runtime,
      room,
      messageData({
        author: legacyAuthor,
        body: "External note: someone@external.test is not an employee.",
        mail: mailEnvelope({
          subject: "Legacy to user",
          to: [{ name: "Alice Owner", address: "alice@legacy.test" }],
          cc: [{ name: "Bob", address: "bob@new.test" }],
          copies: ["bob"],
          sent: true,
        }),
      }),
    );
    const ccUser = await appendRoomMessage(
      seeded.runtime,
      room,
      messageData({
        author: legacyAuthor,
        body: "Copied to the owner.",
        mail: mailEnvelope({
          subject: "Legacy cc user",
          to: [{ name: "Bob", address: "bob@new.test" }],
          cc: [{ name: "Alice Owner", address: "alice@legacy.test" }],
          recipients: ["bob"],
          copies: ["user"],
          sent: true,
        }),
      }),
    );
    await setMailFlag(seeded.runtime, room.id, ccUser.id, { read: true });
    const archived = await appendRoomMessage(
      seeded.runtime,
      room,
      messageData({
        author: legacyAuthor,
        body: "Archived legacy mail.",
        mail: mailEnvelope({
          subject: "Legacy archived",
          to: [{ name: "Alice Owner", address: "alice@legacy.test" }],
          sent: true,
        }),
      }),
    );
    await setMailFlag(seeded.runtime, room.id, archived.id, { archived: true });
    // An empty name is a typed external address by convention: it stays as
    // written even though it equals a real employee's retired address, and a
    // named destination with no known identity keeps its snapshot too.
    const typedExternal = await appendRoomMessage(
      seeded.runtime,
      room,
      messageData({
        author: legacyAuthor,
        body: "Typed external destination.",
        mail: mailEnvelope({
          subject: "Typed external",
          to: [{ name: "", address: "alice@new.test" }],
          recipients: ["alice"],
          sent: true,
        }),
      }),
    );
    const unknownTarget = await appendRoomMessage(
      seeded.runtime,
      room,
      messageData({
        author: legacyAuthor,
        body: "Unknown legacy address.",
        mail: mailEnvelope({
          subject: "Unknown target",
          to: [{ name: "Ghost", address: "ghost@legacy.test" }],
          sent: true,
        }),
      }),
    );
    const draft = await appendRoomMessage(
      seeded.runtime,
      room,
      messageData({
        author: { type: "user", id: "user", name: "Alice Owner", address: "alice@legacy.test" },
        body: "Draft body that must survive.",
        mail: mailEnvelope({
          subject: "Legacy draft",
          to: [{ name: "Alice", address: "alice@new.test" }],
          cc: [{ name: "Bob", address: "bob@new.test" }],
          recipients: ["alice"],
          copies: ["bob"],
          sent: false,
          draft: true,
        }),
      }),
    );

    const rawBefore = await rawRoomEntries(seeded.runtime, room);
    const unreadBefore = await countMailUnread(seeded.runtime, room, "user", "alice@legacy.test");
    expect(unreadBefore).toBe(1);
    await seeded.runtime.close();

    // Reopening migrates: the user keeps its local part, employees follow in
    // creation order, and a shared local part takes the deterministic suffix.
    const http = await startHttpRuntime(root);
    cleanups.push(() => http.close());
    const app = await readApp(http.runtime);
    expect(app.userAddress).toBe("alice@emit");
    const migrated = new Map((await listEmployees(http.runtime)).map((employee) => [employee.id, employee]));
    expect(migrated.get("alice")?.address).toBe("alice2@emit");
    expect(migrated.get("bob")?.address).toBe("bob@emit");
    expect(migrated.get("bobtwo")?.address).toBe("bob2@emit");
    expect(migrated.get("bobtwo")?.enabled).toBe(false);

    // Raw history is untouched; the rewrites live in address-override documents,
    // including on the oldest filler the message views never reach.
    const rawAfterMigration = await rawRoomEntries(http.runtime, room);
    expect(rawAfterMigration).toEqual(rawBefore);
    const oldestFlag = await http.runtime.readFamily(MailFlagDoc, `${room.id}|${oldestFiller.id}`, {
      key: `${room.id}|${oldestFiller.id}`,
    });
    expect(oldestFlag?.addresses?.address).toBe("alice2@emit");

    const roomState = async (server: HttpRuntimeFixture["server"]) => {
      const roomsResponse = await server.inject({ method: "GET", url: "/api/rooms" });
      expect(roomsResponse.statusCode).toBe(200);
      const rooms = roomsResponse.json<Array<{ id: string; unread: number }>>();
      const unread = rooms.find((entry) => entry.id === room.id)?.unread;
      const mailResponse = await server.inject({ method: "GET", url: "/api/mail" });
      expect(mailResponse.statusCode).toBe(200);
      const mailbox = mailResponse
        .json<{ items: Array<{ roomId: string; message: MessageDTO }> }>()
        .items.filter((item) => item.roomId === room.id);
      return { unread, mailbox };
    };

    // The old mailbox and its unread count survive, with the new addresses.
    const afterMigration = await roomState(http.server);
    expect(afterMigration.unread).toBe(unreadBefore);
    expect(new Set(afterMigration.mailbox.map((item) => item.message.id))).toEqual(
      new Set([toUser.id, ccUser.id, archived.id, draft.id]),
    );
    const projectedToUser = afterMigration.mailbox.find((item) => item.message.id === toUser.id)?.message.mail;
    expect(projectedToUser?.to[0]).toEqual({ name: "Alice Owner", address: "alice@emit" });
    expect(projectedToUser?.cc[0]).toEqual({ name: "Bob", address: "bob@emit" });
    const projectedCcUser = afterMigration.mailbox.find((item) => item.message.id === ccUser.id)?.message.mail;
    expect(projectedCcUser?.cc[0]).toEqual({ name: "Alice Owner", address: "alice@emit" });

    const listed = await http.server.inject({ method: "GET", url: `/api/rooms/${room.id}/messages` });
    expect(listed.statusCode).toBe(200);
    const listedMessages = listed.json<{ messages: MessageDTO[] }>().messages;
    const keptTypedExternal = listedMessages.find((message) => message.id === typedExternal.id);
    expect(keptTypedExternal?.mail?.to[0]).toEqual({ name: "", address: "alice@new.test" });
    const keptUnknown = listedMessages.find((message) => message.id === unknownTarget.id);
    expect(keptUnknown?.mail?.to[0]).toEqual({ name: "Ghost", address: "ghost@legacy.test" });
    expect(listedMessages.find((message) => message.id === toUser.id)?.body).toBe(
      "External note: someone@external.test is not an employee.",
    );

    // The stored draft sends with its projected headers and wakes only its To
    // recipients; the answer comes back to the new user address with no
    // retired-domain copy.
    await installAllExtensions(http.resume);
    http.runtime.resume();
    const sendDraft = await http.server.inject({
      method: "POST",
      url: `/api/rooms/${room.id}/mail-send`,
      payload: { entryId: draft.id },
    });
    expect(sendDraft.statusCode).toBe(200);
    const sentDraft = sendDraft.json<{ message: MessageDTO; workIds: string[] }>();
    expect(sentDraft.message.mail?.to[0]?.address).toBe("alice2@emit");
    expect(sentDraft.message.mail?.cc.map((entry) => entry.address)).toEqual(["bob@emit"]);
    expect(sentDraft.workIds).toHaveLength(1);
    await waitForFixture(async () => {
      const works = await listWorks(http.runtime);
      return works.length === 1 && works[0]?.status === "succeeded";
    }, "the migrated draft to be answered once");
    const works = await listWorks(http.runtime);
    expect(works.map((work) => work.employeeId)).toEqual(["alice"]);
    const conversation = await http.runtime.harness.conversation(room.conversationId as ConversationId, http.runtime.ctx);
    const answerPage = await conversation!.entries({}, 40, undefined, http.runtime.ctx);
    const answers = answerPage.items.flatMap((entry) =>
      RoomMessageEntry.is(entry) && entry.data.mail !== null && entry.data.mail.subject.startsWith("Re: ")
        ? [entry.data]
        : [],
    );
    expect(answers).toHaveLength(1);
    expect(answers[0]?.address).toBe("alice2@emit");
    expect(answers[0]?.mail?.to[0]).toEqual({ name: "Alice Owner", address: "alice@emit" });
    expect(answers[0]?.mail?.cc).toEqual([{ name: "Bob", address: "bob@emit" }]);
    expect(JSON.stringify(answers[0]?.mail)).not.toContain(".test");

    // A second open must not allocate again or touch any stored entry.
    const rawAfterSend = await rawRoomEntries(http.runtime, room);
    await http.close();
    const restarted = await startHttpRuntime(root);
    cleanups.push(() => restarted.close());
    expect((await readApp(restarted.runtime)).userAddress).toBe("alice@emit");
    expect(new Map((await listEmployees(restarted.runtime)).map((employee) => [employee.id, employee.address]))).toEqual(
      new Map([
        ["alice", "alice2@emit"],
        ["bob", "bob@emit"],
        ["bobtwo", "bob2@emit"],
      ]),
    );
    expect(await rawRoomEntries(restarted.runtime, room)).toEqual(rawAfterSend);
    expect((await roomState(restarted.server)).unread).toBe(2);
  }, 120_000);

  it("refuses to start when a retired address cannot be attributed unambiguously", async () => {
    const root = mkdtempDataDir("emit-legacy-address-ambiguous-");
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const seeded = await openRuntime(root);
    cleanups.push(() => seeded.runtime.close());
    await seedLegacyApp(seeded.runtime, { slug: "legacy", userName: "Alice Owner", userAddress: "alice@legacy.test" });
    await seedLegacyEmployee(seeded.runtime, {
      id: "former",
      name: "Former",
      address: "former@legacy.test",
      createdAt: 10,
      enabled: true,
    });
    const workContext = await createWorkContextFixture(seeded.runtime, "Ambiguous work");
    const room = await createRoom(seeded.runtime, { kind: "mail", name: "Ambiguous inbox", workContextId: workContext.id });
    // "Former" once wrote under the owner's address, so that string belongs to
    // two identities and the envelope names both of them.
    await appendRoomMessage(
      seeded.runtime,
      room,
      messageData({
        author: { type: "employee", id: "former", name: "Former", address: "alice@legacy.test" },
        body: "Historical author under a reused address.",
      }),
    );
    await appendRoomMessage(
      seeded.runtime,
      room,
      messageData({
        author: { type: "employee", id: "former", name: "Former", address: "former@legacy.test" },
        body: "Ambiguous destination.",
        mail: mailEnvelope({
          subject: "Ambiguous",
          to: [{ name: "Former", address: "alice@legacy.test" }],
          recipients: ["former"],
          sent: true,
        }),
      }),
    );
    await seeded.runtime.close();

    await expect(EmitRuntime.open({ dataDir: root })).rejects.toThrow(
      /Internal address migration is ambiguous for mail entry \d+\./,
    );

    // The refused startup must not have switched anything: the app record and
    // the employee directory are still the stored version 1 documents.
    const storage = await openNodeSqliteStorage(join(root, "emit.sqlite"));
    try {
      const record = await storage.findDocument(
        { kind: "emit.app", scope: { kind: "session" } },
        "current",
        BACKGROUND_CONTEXT,
      );
      expect(record).toBeDefined();
      const appDocument = await storage.document(record!.id, "current", BACKGROUND_CONTEXT);
      expect(appDocument?.version).toBe(1);
      expect(appDocument?.value.userAddress).toBe("alice@legacy.test");
      expect(appDocument?.value.addressFormatVersion).toBeUndefined();
      const employees = await storage.scanDocuments(
        { scope: { kind: "session" }, at: "current", kind: "emit.employee" },
        50,
        undefined,
        BACKGROUND_CONTEXT,
      );
      const addresses: string[] = [];
      for (const employee of employees.items) {
        const document = await storage.document(employee.id, "current", BACKGROUND_CONTEXT);
        addresses.push(String(document?.value.address));
      }
      expect(addresses).toEqual(["former@legacy.test"]);
    } finally {
      await storage.close(BACKGROUND_CONTEXT);
    }
  }, 60_000);
});
