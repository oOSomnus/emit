import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkDTO, WorkExecutionDTO, WorkStatusDTO } from "../../src/shared/contracts.ts";
import {
  FAKE_KEY_ENV,
  emptyThinkingAnswer,
  waitForFixture,
  type FixtureAnswer,
  type FixtureRequest,
} from "../helpers/emit-fixture.ts";
import {
  jsonInit as json,
  openSeededApiFixture,
  requestJson as request,
} from "../helpers/api-fixture.ts";

const cleanup: Array<() => Promise<void> | void> = [];
let previousApiKey: string | undefined;

beforeEach(() => {
  previousApiKey = process.env[FAKE_KEY_ENV];
  process.env[FAKE_KEY_ENV] = "api-execution-fixture-key";
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


function answerFor(root: string, request: FixtureRequest): FixtureAnswer {
  if (request.model === "fake-reviewer") {
    return {
      content: JSON.stringify({
        outcome: "allow",
        risk: "low",
        rationale: "Local execution API fixture",
        readOnly: true,
        userAuthorization: "unknown",
      }),
    };
  }
  const marker = [...request.prompt.matchAll(/API_(?:PAGINATION_START|READ_CANARY)/g)].at(-1)?.[0];
  if (marker === "API_PAGINATION_START") {
    const messages = JSON.parse(request.prompt) as Array<{ role?: string }>;
    const completedReads = messages.filter(message => message.role === "tool").length;
    if (completedReads < 60) return { toolCall: { name: "read_file", args: { path: join(root, "work", `page-${String(completedReads).padStart(3, "0")}.txt`) } } };
    return { content: "PAGE_TIMELINE_COMPLETE" };
  }
  if (marker === "API_READ_CANARY") {
    if (!request.prompt.includes('"role":"tool"')) {
      return { toolCall: { name: "read_file", args: { path: join(root, "work", "canary.txt") } } };
    }
    return {
      chunks: [
        completionFrames([
          { reasoning_content: "PRIVATE_THINKING_CANARY" },
          { content: "Visible answer after reading the file." },
        ]),
      ],
    };
  }
  return { content: "Execution fixture ready." };
}



function completionFrames(deltas: readonly Record<string, unknown>[]): Uint8Array {
  const base = { id: "execution-redaction", object: "chat.completion.chunk", created: 0, model: "fake-chat" };
  const frames = deltas.map((delta) => `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  frames.push(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
  frames.push("data: [DONE]\n\n");
  return new TextEncoder().encode(frames.join(""));
}

async function waitForWorkStatus(url: string, id: string, status: WorkStatusDTO): Promise<void> {
  await waitForFixture(async () => {
    const response = await request<WorkDTO[]>(url, "/api/works");
    const work = response.body.find(work => work.id === id);
    if (work !== undefined && ["succeeded", "failed", "stopped"].includes(work.status) && work.status !== status) {
      throw new Error(`Work ${id} reached ${work.status}, expected ${status}`);
    }
    return work?.status === status;
  }, `work ${id} to become ${status}`, 30_000);
}

async function sendToAlice(url: string, roomId: string, employeeId: string, body: string): Promise<string> {
  const response = await request<{ workIds: string[] }>(url, `/api/rooms/${roomId}/messages`, {
    ...json("POST", { body, recipientIds: [employeeId] }),
  });
  expect(response.status).toBe(200);
  const id = response.body.workIds[0];
  if (id === undefined) throw new Error(`Message ${body} did not create a work`);
  return id;
}


describe("execution HTTP contract", () => {
  it("pages a real transcript with an opaque cursor and keeps every step once, oldest first", async () => {
    const { root, http, workspace } = await openSeededApiFixture({
      prefix: "emit-api-execution-pages-",
      cleanups: cleanup,
      decide: (root, request) => answerFor(root, request),
    });
    const redactionContent = `token: API_EXECUTION_SECRET_CANARY\nVISIBLE_FILE_DATA\n${"界".repeat(3_000)}`;
    writeFileSync(join(root, "work", "canary.txt"), redactionContent, "utf8");
    const redactionWorkId = await sendToAlice(http.url, workspace.channelId, workspace.employeeIds[0]!, "API_READ_CANARY");
    await waitForWorkStatus(http.url, redactionWorkId, "succeeded");
    const redactionResponse = await request<WorkExecutionDTO>(http.url, `/api/works/${redactionWorkId}/execution`);
    expect(redactionResponse.status).toBe(200);
    const redaction = redactionResponse.body;
    const toolOutput = redaction.steps.filter((step) => step.kind === "tool-result").map((step) => step.text ?? "").join("\n");
    expect(redaction.steps.some((step) => step.kind === "tool-result" && step.truncated === true)).toBe(true);
    expect(Buffer.byteLength(toolOutput, "utf8")).toBeLessThanOrEqual(8_000);
    expect(toolOutput).toContain("VISIBLE_FILE_DATA");
    expect(JSON.stringify(redaction)).not.toContain("API_EXECUTION_SECRET_CANARY");
    expect(JSON.stringify(redaction)).not.toContain("PRIVATE_THINKING_CANARY");
    expect(redaction.steps.some((step) => step.kind === "assistant" && step.text?.includes("Visible answer after reading the file."))).toBe(true);

    const markers = Array.from({ length: 60 }, (_, index) => `PAGE_OUTPUT_${String(index).padStart(3, "0")}`);
    for (const [index, marker] of markers.entries()) {
      writeFileSync(join(root, "work", `page-${String(index).padStart(3, "0")}.txt`), marker);
    }
    expect((await request(http.url, "/api/app", json("PATCH", {
      collaboration: { maxDepth: 3, maxCrossEmployeeWakes: 12, maxModelTurns: 80 },
    }))).status).toBe(200);
    const pageWorkId = await sendToAlice(http.url, workspace.channelId, workspace.employeeIds[0]!, "API_PAGINATION_START");
    await waitForWorkStatus(http.url, pageWorkId, "succeeded");

    const collected: WorkExecutionDTO["steps"] = [];
    const allIds = new Set<string>();
    let cursor: string | undefined;
    let pageCount = 0;
    do {
      const query = cursor === undefined ? "" : `?${new URLSearchParams({ cursor }).toString()}`;
      const page = await request<WorkExecutionDTO>(http.url, `/api/works/${pageWorkId}/execution${query}`);
      expect(page.status).toBe(200);
      if (cursor === undefined) expect(page.body.nextCursor).toEqual(expect.any(String));
      for (const step of page.body.steps) {
        expect(allIds.has(step.id), `duplicate execution step ${step.id}`).toBe(false);
        allIds.add(step.id);
      }
      const entryIds = page.body.steps.map(step => Number(step.entryId));
      expect(entryIds).toEqual([...entryIds].sort((left, right) => left - right));
      collected.unshift(...page.body.steps);
      cursor = page.body.nextCursor;
      pageCount += 1;
      expect(pageCount).toBeLessThan(10);
    } while (cursor !== undefined);

    expect(pageCount).toBeGreaterThan(1);
    const observedResults = collected.filter(step => step.kind === "tool-result").map(step => step.text);
    expect(observedResults).toHaveLength(60);
    for (const [index, marker] of markers.entries()) expect(observedResults[index]).toContain(marker);
    expect(collected.filter(step => step.kind === "tool-call")).toHaveLength(60);
    expect(collected.filter(step => step.kind === "assistant").map(step => step.text)).toEqual(["PAGE_TIMELINE_COMPLETE"]);
    expect(new Set(collected.map((step) => step.entryId)).size).toBeGreaterThan(100);
    expect(new Set(collected.map((step) => step.id)).size).toBe(collected.length);

    const invalidCursor = await request<{ message: string }>(http.url, `/api/works/${pageWorkId}/execution?cursor=${encodeURIComponent("not-json")}`);
    const missingWork = await request<{ message: string }>(http.url, "/api/works/not-a-real-work/execution");
    expect(invalidCursor.status).toBe(400);
    for (const cursor of ["[]", "null", "42"]) {
      expect((await request(http.url, `/api/works/${pageWorkId}/execution?cursor=${encodeURIComponent(cursor)}`)).status).toBe(400);
    }
    expect(missingWork.status).toBe(404);
  }, 120_000);

  it("returns an empty execution timeline for accepted queued work before its conversation starts", async () => {
    const { http, workspace } = await openSeededApiFixture({
      prefix: "emit-empty-execution-",
      cleanups: cleanup,
      resume: false,
    });
    const id = await sendToAlice(http.url, workspace.channelId, workspace.employeeIds[0]!, "Queued request");
    const result = await request<WorkExecutionDTO>(http.url, `/api/works/${id}/execution`);
    expect(result.status).toBe(200);
    expect(result.body.work.status).toBe("queued");
    expect(result.body.steps).toEqual([]);
  });

  it.each(["400", "401", "429", "500", "EMPTY_THINKING"] as const)("keeps provider %s failures visible without inventing an answer", async (code) => {
    const fixtureForFault = (request: FixtureRequest): FixtureAnswer => {
      if (request.model === "fake-reviewer") {
        return {
          content: JSON.stringify({
            outcome: "allow",
            risk: "low",
            rationale: "Local fault fixture",
            readOnly: true,
            userAuthorization: "unknown",
          }),
        };
      }
      const marker = [...request.prompt.matchAll(/API_FAULT_(?:400|401|429|500|EMPTY_THINKING)-[A-Z]+/g)].at(-1)?.[0];
      if (marker?.includes("EMPTY_THINKING")) return emptyThinkingAnswer("PRIVATE_EMPTY_REPLY_THINKING");
      const status = marker === undefined ? undefined : Number(marker.match(/400|401|429|500/)?.[0]);
      return status === undefined ? { content: "Unexpected fixture request" } : { httpStatus: status };
    };
    const { http, workspace } = await openSeededApiFixture({
      prefix: "emit-api-provider-faults-",
      cleanups: cleanup,
      decide: (_root, request) => fixtureForFault(request),
    });
    const id = await sendToAlice(http.url, workspace.channelId, workspace.employeeIds[0]!, `API_FAULT_${code}-CASE`);
    await waitForWorkStatus(http.url, id, "failed");
    const execution = await request<WorkExecutionDTO>(http.url, `/api/works/${id}/execution`);
    expect(execution.status).toBe(200);
    expect(execution.body.work.status).toBe("failed");
    expect(execution.body.steps.some((step) => step.kind === "assistant" && step.text?.length)).toBe(false);
    expect(JSON.stringify(execution.body)).not.toContain("PRIVATE_EMPTY_REPLY_THINKING");
    const room = await request<{ messages: Array<{ author: { type: string }; body: string }> }>(http.url, `/api/rooms/${workspace.channelId}/messages`);
    expect(room.body.messages.filter(message => message.author.type === "employee")).toEqual([]);
  }, 60_000);

  it("records an errored tool result without converting it into a successful tool result", async () => {
    const faultFixture = (request: FixtureRequest): FixtureAnswer => {
      if (request.model === "fake-reviewer") {
        return {
          content: JSON.stringify({
            outcome: "allow",
            risk: "low",
            rationale: "Local tool failure fixture",
            readOnly: true,
            userAuthorization: "unknown",
          }),
        };
      }
      if (request.prompt.includes("API_TOOL_ERROR")) {
        if (!request.prompt.includes('"role":"tool"')) {
          return { toolCall: { name: "read_file", args: { path: "missing-api-tool-file.txt" } } };
        }
        return { content: "The file tool returned an error." };
      }
      return { content: "Unexpected fixture request" };
    };
    const { http, workspace } = await openSeededApiFixture({
      prefix: "emit-api-tool-error-",
      cleanups: cleanup,
      decide: (_root, request) => faultFixture(request),
    });
    const workId = await sendToAlice(http.url, workspace.channelId, workspace.employeeIds[0]!, "API_TOOL_ERROR");
    await waitForWorkStatus(http.url, workId, "succeeded");
    const execution = await request<WorkExecutionDTO>(http.url, `/api/works/${workId}/execution`);
    const errorResult = execution.body.steps.find((step) => step.kind === "tool-result");
    expect(errorResult).toMatchObject({ kind: "tool-result", isError: true });
    expect(errorResult?.text).toBeTruthy();
    expect(execution.body.steps.some((step) => step.kind === "assistant" && step.text === "The file tool returned an error.")).toBe(true);
  }, 60_000);
});
