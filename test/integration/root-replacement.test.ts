import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { findWork } from "../../src/server/work.ts";
import type { MessageDTO } from "../../src/shared/contracts.ts";
import { FAKE_KEY_ENV, startFixture, startHttpRuntime, waitForFixture } from "../helpers/emit-fixture.ts";
import { seedTestWorkspace } from "../helpers/workspace-fixture.ts";

it("blocks a real file tool when its captured work root is replaced by an outside symlink", async () => {
  const root = mkdtempSync(join(tmpdir(), "emit-root-replacement-"));
  const canary = "private-outside-root-canary";
  let proposed = false;
  const gate = Promise.withResolvers<void>();
  const previousKey = process.env[FAKE_KEY_ENV];
  process.env[FAKE_KEY_ENV] = "local-fixture-key";
  const provider = await startFixture(request => {
    if (request.prompt.includes("localpart")) return { content: '{"localpart":"tester"}' };
    if (request.model === "fake-reviewer") return { content: JSON.stringify({ outcome: "allow", risk: "low", rationale: "Local read", readOnly: true, userAuthorization: "unknown" }) };
    if (request.prompt.includes('"role":"tool"')) return { content: request.prompt.includes(canary) ? "LEAKED" : "BLOCKED" };
    proposed = true;
    return { toolCall: { name: "read_file", args: { path: "sentinel.txt" } }, gate: gate.promise };
  });
  const http = await startHttpRuntime(join(root, "data"));
  try {
    const seed = await seedTestWorkspace({ url: http.url, providerBaseUrl: provider.baseUrl, root });
    writeFileSync(join(root, "work", "sentinel.txt"), "owned original content");
    mkdirSync(join(root, "outside"));
    const sentinel = join(root, "outside", "sentinel.txt");
    writeFileSync(sentinel, canary);
    http.runtime.resume();
    const response = await fetch(`${http.url}/api/rooms/${seed.channelId}/messages`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "Read sentinel.txt", recipientIds: [seed.employeeIds[0]] }), signal: AbortSignal.timeout(10_000),
    });
    expect(response.status).toBe(200);
    const sent = await response.json() as { workIds: string[] };
    const workId = sent.workIds[0];
    if (workId === undefined) throw new Error("Missing root-replacement work");
    await waitForFixture(() => Promise.resolve(proposed), "model tool proposal", 10_000);
    renameSync(join(root, "work"), join(root, "original-work"));
    symlinkSync(join(root, "outside"), join(root, "work"), "dir");
    gate.resolve();
    await waitForFixture(async () => {
      const work = await findWork(http.runtime, workId);
      return work !== undefined && ["succeeded", "failed", "stopped"].includes(work.status);
    }, "root-replacement tool to finish");
    const messages = await (await fetch(`${http.url}/api/rooms/${seed.channelId}/messages`)).json() as { messages: MessageDTO[] };
    const answers = messages.messages.filter(message => message.workId === workId && message.author.type === "employee");
    expect(answers.map(message => message.body)).toEqual(["BLOCKED"]);
    const execution = await (await fetch(`${http.url}/api/works/${workId}/execution`)).json();
    expect(JSON.stringify(execution)).not.toContain(canary);
    expect(readFileSync(sentinel, "utf8")).toBe(canary);
  } finally {
    gate.resolve();
    await http.close();
    await provider.close();
    if (previousKey === undefined) delete process.env[FAKE_KEY_ENV]; else process.env[FAKE_KEY_ENV] = previousKey;
    rmSync(root, { recursive: true, force: true });
  }
});
