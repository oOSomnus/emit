import { afterEach, describe, expect, it } from "vitest";
import type { MailboxItemDTO, MessageDTO, RoomDTO, ServerEvent, WorkDTO } from "../../src/shared/contracts.ts";
import { openEventStream } from "../helpers/sse-client.ts";
import { type Fixture, type FixtureRequest, type HttpRuntimeFixture } from "../helpers/emit-fixture.ts";
import {
  injectRequest as call,
  parseInject as json,
  startRawApiFixture,
  type ApiFixtureCleanups,
} from "../helpers/api-fixture.ts";
import { seedTestWorkspace } from "../helpers/workspace-fixture.ts";

const cleanups: ApiFixtureCleanups = [];
const reviewerAnswer = JSON.stringify({
  outcome: "allow",
  risk: "low",
  rationale: "Local API fixture",
  readOnly: true,
  userAuthorization: "unknown",
});

function answer(request: FixtureRequest) {
  if (request.model === "fake-reviewer") return { content: reviewerAnswer };
  if (request.prompt.includes("localpart")) return { content: '{"localpart":"api-user"}' };
  return { content: "Communication API fixture answer" };
}

async function startApi() {
  return startRawApiFixture({
    prefix: "emit-api-communication-",
    keyValue: "api-communication-fixture-key",
    cleanups,
    decide: answer,
  });
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});


async function seed(http: HttpRuntimeFixture, provider: Fixture, root: string) {
  const workspace = await seedTestWorkspace({ url: http.url, providerBaseUrl: provider.baseUrl, root });
  http.runtime.resume();
  return workspace;
}
type EventStream = {
  next(predicate: (event: ServerEvent) => boolean, timeoutMs?: number): Promise<ServerEvent>;
  close(): Promise<void>;
};

async function waitForWorks(http: HttpRuntimeFixture, events: EventStream, ids: readonly string[]): Promise<WorkDTO[]> {
  await Promise.all(ids.map((id) => events.next(
    (event) =>
      event.type === "work" &&
      event.work.id === id &&
      (event.work.status === "succeeded" || event.work.status === "failed" || event.work.status === "stopped"),
    30_000,
  )));
  const response = await call(http.server, "GET", "/api/works");
  if (response.statusCode !== 200) throw new Error(`GET /api/works returned ${response.statusCode}`);
  return json<WorkDTO[]>(response);
}


describe("communication HTTP API", () => {
  it("creates channels and DMs, changes channel members, and wakes only explicit recipients or explicit broadcasts", async () => {
    const fixture = await startApi();
    const { http, provider, root } = fixture;
    const workspace = await seed(http, provider, root);
    const [alice, bob] = workspace.employeeIds;
    if (alice === undefined || bob === undefined) throw new Error("Workspace seed did not create both employees");
    const events = await openEventStream(`${http.url}/api/events`);
    cleanups.push(() => events.close());

    const initialRooms = json<RoomDTO[]>(await call(http.server, "GET", "/api/rooms"));
    const initialChannel = initialRooms.find(({ id }) => id === workspace.channelId);
    if (initialChannel === undefined) throw new Error("Seeded channel was absent from the room list");
    expect(initialChannel.memberIds).toEqual([alice, bob]);
    expect(initialChannel.membershipVersion).toBe(1);

    const removedBob = await call(http.server, "PATCH", `/api/rooms/${workspace.channelId}/members`, {
      memberIds: [alice],
      expectedVersion: initialChannel.membershipVersion,
    });
    expect(removedBob.statusCode).toBe(200);
    const oneMemberChannel = json<RoomDTO>(removedBob);
    expect(oneMemberChannel.memberIds).toEqual([alice]);
    expect(oneMemberChannel.membershipVersion).toBe(2);
    const staleMembership = await call(http.server, "PATCH", `/api/rooms/${workspace.channelId}/members`, {
      memberIds: [alice, bob],
      expectedVersion: 1,
    });
    expect(json<RoomDTO[]>(await call(http.server, "GET", "/api/rooms")).find(({ id }) => id === workspace.channelId)).toMatchObject({
      memberIds: [alice],
      membershipVersion: 2,
    });
    expect(staleMembership.statusCode).toBe(409);

    const messagesBeforeRejectedAddress = json<{ messages: MessageDTO[] }>(
      await call(http.server, "GET", `/api/rooms/${workspace.channelId}/messages`),
    ).messages;
    const worksBeforeRejectedAddress = json<WorkDTO[]>(await call(http.server, "GET", "/api/works"));
    const removedMemberSend = await call(http.server, "POST", `/api/rooms/${workspace.channelId}/messages`, {
      body: "This must not be accepted for a removed member",
      recipientIds: [bob],
    });
    expect(json<{ messages: MessageDTO[] }>(await call(http.server, "GET", `/api/rooms/${workspace.channelId}/messages`)).messages).toEqual(messagesBeforeRejectedAddress);
    expect(json<WorkDTO[]>(await call(http.server, "GET", "/api/works"))).toEqual(worksBeforeRejectedAddress);
    expect(removedMemberSend.statusCode).toBe(400);

    const restored = await call(http.server, "PATCH", `/api/rooms/${workspace.channelId}/members`, {
      memberIds: [alice, bob],
      expectedVersion: oneMemberChannel.membershipVersion,
    });
    expect(restored.statusCode).toBe(200);
    expect(json<RoomDTO>(restored).memberIds).toEqual([alice, bob]);

    const explicit = await call(http.server, "POST", `/api/rooms/${workspace.channelId}/messages`, {
      body: "Handle this explicit address",
      recipientIds: [alice],
    });
    expect(explicit.statusCode).toBe(200);
    const explicitResult = json<{ message: MessageDTO; workIds: string[] }>(explicit);
    expect(explicitResult.message.addressing).toEqual({ recipientIds: [alice], mentionAll: false });
    expect(explicitResult.workIds).toHaveLength(1);
    const explicitWorks = await waitForWorks(http, events, explicitResult.workIds);
    expect(explicitWorks.find(({ id }) => id === explicitResult.workIds[0])).toMatchObject({ status: "succeeded", employeeId: alice, roomId: workspace.channelId, sourceEntryId: explicitResult.message.id });

    const bodyAddress = await call(http.server, "POST", `/api/rooms/${workspace.channelId}/messages`, {
      body: "Please @Bob handle the request",
    });
    expect(bodyAddress.statusCode).toBe(200);
    const bodyResult = json<{ message: MessageDTO; workIds: string[] }>(bodyAddress);
    expect(bodyResult.message.body).toBe("Please @Bob handle the request");
    expect(bodyResult.message.addressing).toEqual({ recipientIds: [], mentionAll: false });
    expect(bodyResult.workIds).toEqual([]);
    expect(json<WorkDTO[]>(await call(http.server, "GET", "/api/works")).some((work) => work.sourceEntryId === bodyResult.message.id)).toBe(false);

    const broadcastLikeText = "@all @全体 @Nobody";
    const broadcastLike = await call(http.server, "POST", `/api/rooms/${workspace.channelId}/messages`, {
      body: broadcastLikeText,
      recipientIds: [],
      mentionAll: false,
    });
    expect(broadcastLike.statusCode).toBe(200);
    const broadcastLikeResult = json<{ message: MessageDTO; workIds: string[] }>(broadcastLike);
    expect(broadcastLikeResult.message.body).toBe(broadcastLikeText);
    expect(broadcastLikeResult.message.addressing).toEqual({ recipientIds: [], mentionAll: false });
    expect(broadcastLikeResult.workIds).toEqual([]);

    const mixed = await call(http.server, "POST", `/api/rooms/${workspace.channelId}/messages`, {
      body: "@all only the explicit recipient",
      recipientIds: [alice],
    });
    expect(mixed.statusCode).toBe(200);
    const mixedResult = json<{ message: MessageDTO; workIds: string[] }>(mixed);
    expect(mixedResult.message.addressing).toEqual({ recipientIds: [alice], mentionAll: false });
    expect(mixedResult.workIds).toHaveLength(1);
    await waitForWorks(http, events, mixedResult.workIds);

    const allAddress = await call(http.server, "POST", `/api/rooms/${workspace.channelId}/messages`, {
      body: "Please handle this as a group",
      mentionAll: true,
    });
    expect(allAddress.statusCode).toBe(200);
    const allResult = json<{ message: MessageDTO; workIds: string[] }>(allAddress);
    expect(allResult.message.addressing).toEqual({ recipientIds: [alice, bob], mentionAll: true });
    expect(allResult.workIds).toHaveLength(2);
    const allWorks = await waitForWorks(http, events, allResult.workIds);
    expect(allWorks.filter(({ id }) => allResult.workIds.includes(id)).map(({ employeeId, status }) => ({ employeeId, status })).sort((left, right) => left.employeeId.localeCompare(right.employeeId))).toEqual(
      [alice, bob].sort().map((employeeId) => ({ employeeId, status: "succeeded" })),
    );
    const persistedChannelMessages = json<{ messages: MessageDTO[] }>(
      await call(http.server, "GET", `/api/rooms/${workspace.channelId}/messages`),
    ).messages;
    expect(persistedChannelMessages).toContainEqual(explicitResult.message);
    expect(persistedChannelMessages).toContainEqual(bodyResult.message);
    expect(persistedChannelMessages).toContainEqual(allResult.message);

    const dmResponse = await call(http.server, "POST", "/api/rooms", {
      kind: "dm",
      name: "Alice private",
      topic: "Private conversation",
      workContextId: workspace.workContextId,
      employeeId: alice,
    });
    expect(dmResponse.statusCode).toBe(200);
    const dm = json<RoomDTO>(dmResponse);
    expect(dm).toMatchObject({ kind: "dm", workContextId: workspace.workContextId, employeeId: alice });
    expect(dm.dmParticipantIds).toEqual(["user", alice].sort());
    const duplicateDm = await call(http.server, "POST", "/api/rooms", {
      kind: "dm",
      name: "A second label for Alice",
      workContextId: workspace.workContextId,
      employeeId: alice,
    });
    expect(duplicateDm.statusCode).toBe(200);
    expect(json<RoomDTO>(duplicateDm).id).toBe(dm.id);
    expect(json<RoomDTO[]>(await call(http.server, "GET", "/api/rooms")).some(({ id }) => id === dm.id)).toBe(true);

    const dmBefore = json<{ messages: MessageDTO[] }>(await call(http.server, "GET", `/api/rooms/${dm.id}/messages`)).messages;
    const addressingInDm = await call(http.server, "POST", `/api/rooms/${dm.id}/messages`, {
      body: "A DM cannot target a third employee",
      recipientIds: [bob],
    });
    expect(json<{ messages: MessageDTO[] }>(await call(http.server, "GET", `/api/rooms/${dm.id}/messages`)).messages).toEqual(dmBefore);
    expect(addressingInDm.statusCode).toBe(400);
    const dmMessage = await call(http.server, "POST", `/api/rooms/${dm.id}/messages`, { body: "A private request for Alice" });
    expect(dmMessage.statusCode).toBe(200);
    const dmResult = json<{ message: MessageDTO; workIds: string[] }>(dmMessage);
    expect(dmResult.message.addressing).toEqual({ recipientIds: [alice], mentionAll: false });
    expect(dmResult.workIds).toHaveLength(1);
    const dmWorks = await waitForWorks(http, events, dmResult.workIds);
    expect(dmWorks.find(({ id }) => id === dmResult.workIds[0])).toMatchObject({ status: "succeeded", employeeId: alice, roomId: dm.id, sourceEntryId: dmResult.message.id });
    expect(dmWorks.filter(({ sourceEntryId }) => sourceEntryId === dmResult.message.id)).toHaveLength(1);
    expect(json<{ messages: MessageDTO[] }>(await call(http.server, "GET", `/api/rooms/${dm.id}/messages`)).messages).toContainEqual(dmResult.message);
  }, 30_000);

  it("stores mail drafts without waking employees, sends only To recipients, exposes mailbox flags, and rejects repeat sends", async () => {
    const fixture = await startApi();
    const { http, provider, root } = fixture;
    const workspace = await seed(http, provider, root);
    const [alice, bob] = workspace.employeeIds;
    if (alice === undefined || bob === undefined) throw new Error("Workspace seed did not create both employees");
    const events = await openEventStream(`${http.url}/api/events`);
    cleanups.push(() => events.close());

    const draftResponse = await call(http.server, "POST", `/api/rooms/${workspace.mailRoomId}/messages`, {
      body: "Review this draft",
      subject: "API draft delivery",
      to: [alice],
      cc: [bob],
      draft: true,
    });
    expect(draftResponse.statusCode).toBe(200);
    const draftResult = json<{ message: MessageDTO; workIds: string[] }>(draftResponse);
    expect(draftResult.workIds).toEqual([]);
    expect(draftResult.message.mail).toMatchObject({
      subject: "API draft delivery",
      recipients: [alice],
      copies: [bob],
      sent: false,
      draft: true,
    });
    const mailboxWithDraft = json<{ items: MailboxItemDTO[] }>(await call(http.server, "GET", "/api/mail"));
    expect(mailboxWithDraft.items.some(({ message }) => message.id === draftResult.message.id && message.mail?.draft)).toBe(true);
    expect(json<WorkDTO[]>(await call(http.server, "GET", "/api/works")).filter(({ sourceEntryId }) => sourceEntryId === draftResult.message.id)).toEqual([]);

    const sentResponse = await call(http.server, "POST", `/api/rooms/${workspace.mailRoomId}/mail-send`, {
      entryId: draftResult.message.id,
    });
    expect(sentResponse.statusCode).toBe(200);
    const sentResult = json<{ message: MessageDTO; workIds: string[] }>(sentResponse);
    expect(sentResult.message.mail).toMatchObject({
      subject: "API draft delivery",
      recipients: [alice],
      copies: [bob],
      sent: true,
      draft: false,
    });
    expect(sentResult.workIds).toHaveLength(1);
    const sentWorks = await waitForWorks(http, events, sentResult.workIds);
    expect(sentWorks.find(({ id }) => id === sentResult.workIds[0])).toMatchObject({
      status: "succeeded",
      kind: "mail",
      roomId: workspace.mailRoomId,
      sourceEntryId: sentResult.message.id,
    });

    const mailbox = json<{ items: MailboxItemDTO[] }>(await call(http.server, "GET", "/api/mail"));
    const mailboxSent = mailbox.items.find(({ message }) => message.id === sentResult.message.id);
    expect(mailboxSent?.message.mail).toMatchObject({ sent: true, draft: false, recipients: [alice], copies: [bob] });
    expect(mailbox.items.some(({ message }) => message.id === draftResult.message.id)).toBe(false);

    const markFlags = await call(http.server, "POST", `/api/rooms/${workspace.mailRoomId}/mail-flag`, {
      entryId: sentResult.message.id,
      read: true,
      archived: true,
    });
    expect(markFlags.statusCode).toBe(200);
    const flaggedMessages = json<{ messages: MessageDTO[] }>(markFlags).messages;
    expect(flaggedMessages.find(({ id }) => id === sentResult.message.id)?.mail).toMatchObject({ read: true, archived: true });
    const flaggedMailbox = json<{ items: MailboxItemDTO[] }>(await call(http.server, "GET", "/api/mail"));
    expect(flaggedMailbox.items.find(({ message }) => message.id === sentResult.message.id)?.message.mail).toMatchObject({ read: true, archived: true });

    const clearFlags = await call(http.server, "POST", `/api/rooms/${workspace.mailRoomId}/mail-flag`, {
      entryId: sentResult.message.id,
      read: false,
      archived: false,
    });
    expect(clearFlags.statusCode).toBe(200);
    expect(json<{ items: MailboxItemDTO[] }>(await call(http.server, "GET", "/api/mail")).items.find(({ message }) => message.id === sentResult.message.id)?.message.mail).toMatchObject({ read: false, archived: false });

    const messagesBeforeDuplicate = json<{ messages: MessageDTO[] }>(await call(http.server, "GET", `/api/rooms/${workspace.mailRoomId}/messages`)).messages;
    const worksBeforeDuplicate = json<WorkDTO[]>(await call(http.server, "GET", "/api/works"));
    const duplicate = await call(http.server, "POST", `/api/rooms/${workspace.mailRoomId}/mail-send`, {
      entryId: draftResult.message.id,
    });
    expect(json<{ messages: MessageDTO[] }>(await call(http.server, "GET", `/api/rooms/${workspace.mailRoomId}/messages`)).messages).toEqual(messagesBeforeDuplicate);
    expect(json<WorkDTO[]>(await call(http.server, "GET", "/api/works"))).toEqual(worksBeforeDuplicate);
    expect(duplicate.statusCode).toBeGreaterThanOrEqual(400);
    expect(duplicate.statusCode).toBeLessThan(500);
    const resend = await call(http.server, "POST", `/api/rooms/${workspace.mailRoomId}/mail-send`, {
      entryId: sentResult.message.id,
    });
    expect(resend.statusCode).toBe(409);
    expect(json<{ messages: MessageDTO[] }>(await call(http.server, "GET", `/api/rooms/${workspace.mailRoomId}/messages`)).messages).toEqual(messagesBeforeDuplicate);
    expect(json<WorkDTO[]>(await call(http.server, "GET", "/api/works"))).toEqual(worksBeforeDuplicate);
  }, 30_000);
});
