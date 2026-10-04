import { afterEach, describe, expect, it } from "vitest";
import type { AppConfigDTO, ServerEvent } from "../../src/shared/contracts.ts";
import { createE2eFixture, type E2eFixture } from "../helpers/e2e-fixture.ts";
import { openEventStream } from "../helpers/sse-client.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  const failures: unknown[] = [];
  for (const close of cleanup.splice(0).reverse()) {
    try { await close(); } catch (error) { failures.push(error); }
  }
  if (failures.length > 0) throw new AggregateError(failures, "SSE fixture cleanup failed");
});

async function open(): Promise<E2eFixture> {
  const fixture = await createE2eFixture();
  cleanup.push(() => fixture.close());
  return fixture;
}

async function patchUserName(fixture: E2eFixture, userName: string): Promise<AppConfigDTO> {
  const response = await fixture.request<AppConfigDTO>("/api/app", "PATCH", { userName });
  expect(response.status).toBe(200);
  expect(response.body.user.name).toBe(userName);
  return response.body;
}

function isAppEvent(event: ServerEvent): event is Extract<ServerEvent, { type: "app" }> {
  return event.type === "app";
}

async function readHeartbeat(url: string): Promise<string> {
  const controller = new AbortController();
  // This intentionally waits on the live server's 20-second keep-alive; fake time cannot emit a socket comment.
  const deadline = setTimeout(() => controller.abort(new Error("SSE heartbeat did not arrive within 25 seconds")), 25_000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let received = "";
  try {
    const response = await fetch(`${url}/api/events`, {
      headers: { accept: "text/event-stream" },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    if (response.body === null) throw new Error("SSE heartbeat stream has no body");
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    while (!received.includes(": ping\n\n")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("SSE stream ended before its heartbeat");
      received += decoder.decode(chunk.value, { stream: true });
    }
    return received;
  } finally {
    clearTimeout(deadline);
    controller.abort();
    if (reader !== undefined) {
      try {
        await reader.cancel();
      } catch {
        // Aborting an already-closed stream is an expected cleanup race.
      }
      reader.releaseLock();
    }
  }
}

describe("real-process SSE connection faults", () => {
  it("fans each public state change to connected clients across disconnect and reconnect", async () => {
    const fixture = await open();
    const first = await openEventStream(`${fixture.emit.url}/api/events`);
    const second = await openEventStream(`${fixture.emit.url}/api/events`);
    cleanup.push(async () => { await second.close(); await first.close(); });

    const initialConfig = await patchUserName(fixture, "FAULT_SSE_FANOUT_INITIAL");
    const [firstInitial, secondInitial] = await Promise.all([
      first.next(isAppEvent),
      second.next(isAppEvent),
    ]);
    expect(firstInitial).toEqual({ type: "app", app: initialConfig });
    expect(secondInitial).toEqual(firstInitial);

    await first.close();
    const whileDisconnected = await patchUserName(fixture, "FAULT_SSE_DISCONNECTED_CLIENT");
    expect(await second.next(isAppEvent)).toEqual({ type: "app", app: whileDisconnected });

    const reconnected = await openEventStream(`${fixture.emit.url}/api/events`);
    cleanup.push(() => reconnected.close());
    const afterReconnect = await patchUserName(fixture, "FAULT_SSE_RECONNECTED_CLIENT");
    const [secondAfterReconnect, firstAfterReconnect] = await Promise.all([
      second.next(isAppEvent),
      reconnected.next(isAppEvent),
    ]);
    expect(secondAfterReconnect).toEqual({ type: "app", app: afterReconnect });
    expect(firstAfterReconnect).toEqual(secondAfterReconnect);
    expect((await fixture.request<AppConfigDTO>("/api/app")).body).toEqual(afterReconnect);
  }, 60_000);

  it("keeps the event connection alive with a protocol heartbeat comment", async () => {
    const fixture = await open();
    const stream = await readHeartbeat(fixture.emit.url);
    expect(stream).toContain(": connected\n\n");
    expect(stream).toContain(": ping\n\n");
    const app = await fixture.request<AppConfigDTO>("/api/app");
    expect(app.status).toBe(200);
  }, 60_000);
});
