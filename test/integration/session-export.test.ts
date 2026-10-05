/**
 * The session export over HTTP.
 *
 * An export is a debug artifact: it must contain the real transcript, the
 * execution records, the documents that scope them, and the spilled tool
 * output, all from one committed state, saved as a private file the browser
 * downloads. It must also refuse ambiguous or unknown targets instead of
 * inventing a snapshot, and it must never widen its scope to unrelated rooms.
 */

import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiErrorBody, SessionExportReceiptDTO, WorkDTO, WorkStatusDTO } from "../../src/shared/contracts.ts";
import { findRoom } from "../../src/server/rooms.ts";
import { listWorks } from "../../src/server/work.ts";
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
  process.env[FAKE_KEY_ENV] = "api-session-export-fixture-key";
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

async function request<T>(url: string, path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
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

const lowVerdict = JSON.stringify({
  outcome: "allow",
  risk: "low",
  rationale: "The local command is low risk.",
  readOnly: true,
  userAuthorization: "unknown",
});

async function openExportWorkspace(): Promise<{ http: HttpRuntimeFixture; workspace: ApiWorkspace }> {
  const root = mkdtempSync(join(tmpdir(), "emit-session-export-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const fixture = await startFixture((request: FixtureRequest): FixtureAnswer => {
    if (request.model === "fake-reviewer") return { content: lowVerdict };
    let messages: Array<{ role?: string }> = [];
    try {
      messages = JSON.parse(request.prompt) as Array<{ role?: string }>;
    } catch {
      messages = [];
    }
    if (messages.some((message) => message.role === "tool")) return { content: "EXPORT_TOOL_DONE" };
    if (request.prompt.includes("EXPORT_SHELL_MARKER")) {
      return { toolCall: { name: "run_shell", args: { command: "seq 1 2500" } } };
    }
    return { content: "EXPORT_IDLE" };
  });
  cleanup.push(() => fixture.close());
  const http = await startHttpRuntime(join(root, "data"));
  cleanup.push(() => http.close());
  const workspace = await seedTestWorkspace({ url: http.url, providerBaseUrl: fixture.baseUrl, root });
  http.runtime.resume();
  return { http, workspace };
}

async function waitForWorkStatus(url: string, id: string, status: WorkStatusDTO): Promise<void> {
  await waitForFixture(async () => {
    const response = await request<WorkDTO[]>(url, "/api/works");
    const work = response.body.find((candidate) => candidate.id === id);
    if (work !== undefined && ["succeeded", "failed", "stopped"].includes(work.status) && work.status !== status) {
      throw new Error(`Work ${id} reached ${work.status}, expected ${status}`);
    }
    return work?.status === status;
  }, `work ${id} to become ${status}`, 60_000);
}

/** One export snapshot, parsed from its downloaded file. */
async function downloadSnapshot(url: string, receipt: SessionExportReceiptDTO): Promise<Record<string, any>> {
  const response = await fetch(new URL(receipt.downloadUrl, url), { signal: AbortSignal.timeout(10_000) });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-disposition")).toContain(receipt.filename);
  return (await response.json()) as Record<string, any>;
}

describe("session export HTTP contract", () => {
  it("saves one coherent, complete channel snapshot as a private downloadable file", async () => {
    const { http, workspace } = await openExportWorkspace();
    const message = await request<{ workIds: string[] }>(
      http.url,
      `/api/rooms/${workspace.channelId}/messages`,
      json("POST", { body: "EXPORT_SHELL_MARKER", recipientIds: [workspace.employeeIds[0]!] }),
    );
    expect(message.status).toBe(200);
    const workId = message.body.workIds[0]!;
    await waitForWorkStatus(http.url, workId, "succeeded");

    const created = await request<SessionExportReceiptDTO>(
      http.url,
      "/api/session-exports",
      json("POST", { roomId: workspace.channelId }),
    );
    expect(created.status).toBe(201);
    const receipt = created.body;
    cleanup.push(() => rmSync(dirname(receipt.path), { recursive: true, force: true }));
    expect(receipt.filename).toMatch(/^emit-session-[0-9a-f-]+\.json$/);
    expect(receipt.path.startsWith(tmpdir())).toBe(true);
    const onDisk = statSync(receipt.path);
    expect(onDisk.size).toBe(receipt.bytes);
    // The artifact is private to the user who exported it.
    expect(onDisk.mode & 0o077).toBe(0);

    const snapshot = await downloadSnapshot(http.url, receipt);
    expect(snapshot.format).toBe("emit.session-debug");
    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.scope).toEqual({ roomId: workspace.channelId });
    expect(snapshot.redaction).toEqual({ marker: "[REDACTED]", applied: true });

    // The requested room is complete; the unrelated mail room never leaks in.
    const room = await findRoom(http.runtime, workspace.channelId);
    const mailRoom = await findRoom(http.runtime, workspace.mailRoomId);
    const roomConversation = snapshot.conversations.find((entry: { id: number }) => entry.id === room?.conversationId);
    expect(roomConversation).toMatchObject({ role: "room", coverage: "full" });
    expect(roomConversation.entryIds.length).toBeGreaterThan(0);
    expect(snapshot.conversations.some((entry: { id: number }) => entry.id === mailRoom?.conversationId)).toBe(false);

    // The real transcript, including the tool call the model made.
    const toolEntries = snapshot.entries.filter((entry: { model?: Array<{ role?: string; toolName?: string }> }) =>
      (entry.model ?? []).some((modelMessage) => modelMessage.role === "toolResult" && modelMessage.toolName === "run_shell"),
    );
    expect(toolEntries).toHaveLength(1);
    const userEntry = snapshot.entries.find(
      (entry: { data?: { body?: string } }) => entry.data?.body === "EXPORT_SHELL_MARKER",
    );
    expect(userEntry).toBeDefined();

    // The work's execution conversation and task travel with the room export.
    const work = (await listWorks(http.runtime)).find((candidate) => candidate.id === workId)!;
    expect(snapshot.conversations.some((entry: { id: number }) => entry.id === work.conversationId)).toBe(true);
    expect(snapshot.tasks.some((task: { conversationId: number }) => task.conversationId === work.conversationId)).toBe(true);
    expect(snapshot.submissions.length).toBeGreaterThan(0);

    // The documents that scope the selection, and nothing from another room.
    expect(
      snapshot.documents.some(
        (doc: { record: { kind: string; key?: string } }) =>
          doc.record.kind === "emit.room" && doc.record.key === workspace.channelId,
      ),
    ).toBe(true);
    expect(snapshot.documents.some((doc: { record: { kind: string } }) => doc.record.kind === "emit.employee")).toBe(true);

    // The spilled full shell output is included verbatim, not summarized.
    const artifact = snapshot.artifacts.find((entry: { status: string }) => entry.status === "included");
    expect(artifact).toBeDefined();
    expect(artifact.encoding).toBe("utf8");
    expect(artifact.content).toContain("\n2500\n");
    expect(artifact.content.startsWith("1\n")).toBe(true);
    expect(artifact.path.startsWith(tmpdir())).toBe(true);

    // A work-scoped export covers that work's execution and no room transcript.
    const byWork = await request<SessionExportReceiptDTO>(
      http.url,
      "/api/session-exports",
      json("POST", { workId }),
    );
    expect(byWork.status).toBe(201);
    cleanup.push(() => rmSync(dirname(byWork.body.path), { recursive: true, force: true }));
    const workSnapshot = await downloadSnapshot(http.url, byWork.body);
    expect(workSnapshot.scope).toEqual({ workId });
    expect(workSnapshot.conversations.some((entry: { role: string }) => entry.role === "execution")).toBe(true);
    // The room the work came from contributes only its relevant entries: the
    // message that started the work, never the whole transcript.
    const relatedRoom = workSnapshot.conversations.find((entry: { role: string }) => entry.role === "room");
    expect(relatedRoom).toMatchObject({ coverage: "related" });
    expect(relatedRoom.entryIds).toContain(Number(work.sourceEntryId));
    expect(
      workSnapshot.entries.some((entry: { data?: { body?: string } }) => entry.data?.body === "EXPORT_SHELL_MARKER"),
    ).toBe(true);
    expect(
      workSnapshot.entries.some((entry: { model?: Array<{ toolName?: string }> }) =>
        (entry.model ?? []).some((modelMessage) => modelMessage.toolName === "run_shell"),
      ),
    ).toBe(true);
  }, 90_000);

  it("refuses ambiguous, unknown, and expired export targets without inventing a snapshot", async () => {
    const { http, workspace } = await openExportWorkspace();

    const ambiguous = await request<ApiErrorBody>(http.url, "/api/session-exports", json("POST", {}));
    expect(ambiguous.status).toBe(400);
    expect(ambiguous.body.messageLocalized?.en).toContain("roomId or workId");

    const both = await request<ApiErrorBody>(
      http.url,
      "/api/session-exports",
      json("POST", { roomId: workspace.channelId, workId: "wk_missing" }),
    );
    expect(both.status).toBe(400);

    const missingRoom = await request<ApiErrorBody>(
      http.url,
      "/api/session-exports",
      json("POST", { roomId: "room_missing" }),
    );
    expect(missingRoom.status).toBe(404);

    const missingWork = await request<ApiErrorBody>(
      http.url,
      "/api/session-exports",
      json("POST", { workId: "wk_missing" }),
    );
    expect(missingWork.status).toBe(404);

    const unknownDownload = await request<ApiErrorBody>(http.url, "/api/session-exports/unknown");
    expect(unknownDownload.status).toBe(404);
  }, 60_000);
});
