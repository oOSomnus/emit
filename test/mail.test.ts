/**
 * Mail delivery is durable before it is fast.
 *
 * Sending a mail writes the entry, every recipient's queued work, and one
 * `emit.mail-dispatch` task in a single commit; a process that dies before its
 * scheduler resumes must not lose a recipient, and a process that restarts
 * must not wake one twice. These tests run the real EmitRuntime over SQLite
 * and a local OpenAI-completions fixture, so the restart is a real close and
 * reopen of the same data directory rather than a mocked scheduler.
 */

import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ConversationId, TaskId } from "@earendil-works/pi-durable";
import { EmitRuntime } from "../src/server/runtime.ts";
import { McpManager } from "../src/server/mcp.ts";
import { buildMailExtension, buildMailTasks, sendQueuedMail, type MailTasks } from "../src/server/mail.ts";
import { installEmployeeExtension, listWorks, reconcileWorks, stopWork, type Resume } from "../src/server/work.ts";
import { createEmployee, listEmployees, setupWorkspace, updateEmployee } from "../src/server/workspace.ts";
import {
  RoomDirectoryError,
  appendRoomMessage,
  createRoom,
  findRoom,
  mailEnvelope,
  messageData,
  toMessageDTO,
} from "../src/server/rooms.ts";
import { RoomMessageEntry, type EmployeeRecord, type RoomRecord } from "../src/server/documents.ts";
import { WorkExecutionCursorError, readWorkExecution } from "../src/server/work-execution.ts";
import type { EmployeeDraftDTO, MessageDTO } from "../src/shared/contracts.ts";
import { toWorkDTO } from "../src/server/dto.ts";

/** The employee with this name, or a test failure. */
function employeeNamed(employees: EmployeeRecord[], name: string): EmployeeRecord {
  const found = employees.find((employee) => employee.name === name);
  if (found === undefined) throw new Error(`missing employee ${name}`);
  return found;
}

const FAKE_KEY_ENV = "EMIT_MAIL_TEST_KEY";

type FixtureRequest = { model: string | undefined; system: string; prompt: string };
type FixtureAnswer = {
  content?: string;
  toolCall?: { name: string; args: unknown };
  /** Hold the response until this settles: a deterministic model-side latch. */
  gate?: Promise<void>;
};
type Fixture = { baseUrl: string; requests: FixtureRequest[]; close: () => Promise<void> };

/** Write one OpenAI-completions SSE answer, with or without a tool call. */
function writeAnswer(response: ServerResponse, model: string | undefined, answer: FixtureAnswer): void {
  if (response.writableEnded || response.destroyed) return;
  const base = { id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 0, model: model ?? "fake-chat" };
  const chunk = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  response.write(chunk({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }));
  if (answer.content !== undefined) {
    response.write(chunk({ ...base, choices: [{ index: 0, delta: { content: answer.content }, finish_reason: null }] }));
  }
  if (answer.toolCall !== undefined) {
    response.write(
      chunk({
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: `call_${answer.toolCall.name}`,
                  type: "function",
                  function: { name: answer.toolCall.name, arguments: JSON.stringify(answer.toolCall.args) },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
    );
  }
  response.write(
    chunk({
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: answer.toolCall !== undefined ? "tool_calls" : "stop" }],
    }),
  );
  response.write("data: [DONE]\n\n");
  response.end();
}

async function startFixture(
  decide: (request: FixtureRequest) => FixtureAnswer = (request) =>
    request.prompt.includes("localpart") ? { content: '{"localpart": "tester"}' } : { content: "已完成：我看过邮件了。" },
): Promise<Fixture> {
  const requests: FixtureRequest[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let model: string | undefined;
      let messages: { role?: string; content?: unknown }[] = [];
      try {
        const body = JSON.parse(raw) as { model?: string; messages?: { role?: string; content?: unknown }[] };
        model = body.model;
        messages = body.messages ?? [];
      } catch {
        // Leave the parsed values empty: an unparsable body still answers.
      }
      const systemMessage = messages.find((message) => message.role === "system");
      const entry: FixtureRequest = {
        model,
        system: typeof systemMessage?.content === "string" ? systemMessage.content : "",
        prompt: JSON.stringify(messages),
      };
      requests.push(entry);
      const answer = decide(entry);
      if (answer.gate === undefined) writeAnswer(response, model, answer);
      else void answer.gate.then(() => writeAnswer(response, model, answer));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture failed to bind");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  const pending = cleanups.splice(0).reverse();
  for (const cleanup of pending) {
    try {
      await cleanup();
    } catch {
      // Best effort: a failed cleanup must not mask the test result.
    }
  }
}, 30_000);

const providerConfig = (baseUrl: string) => ({
  id: "fake",
  name: "Fake Provider",
  baseUrl,
  api: "openai-completions" as const,
  apiKeyEnv: FAKE_KEY_ENV,
  models: [
    { id: "fake-chat", name: "Fake Chat", contextWindow: 32768, maxTokens: 4096, reasoning: false, input: ["text" as const] },
    { id: "fake-reviewer", name: "Fake Reviewer", contextWindow: 32768, maxTokens: 4096, reasoning: false, input: ["text" as const] },
  ],
});

/** Open one runtime over `dir`, install the mail extension, and return its resume. */
async function openRuntime(dir: string, baseUrl: string): Promise<{ runtime: EmitRuntime; resume: Resume }> {
  const runtime = await EmitRuntime.open({ dataDir: dir, host: "127.0.0.1", port: 0 });
  const resume: Resume = { runtime, mcp: new McpManager(runtime), mail: undefined as unknown as MailTasks };
  resume.mail = buildMailTasks(() => resume);
  runtime.registry.install(buildMailExtension(resume.mail));
  return { runtime, resume };
}

/** Open a runtime with the workspace, employees, and a mail room ready to run. */
async function openWorkspaceForRun(
  dir: string,
  baseUrl: string,
  names: string[],
): Promise<{ runtime: EmitRuntime; resume: Resume; room: RoomRecord }> {
  const { runtime, resume } = await openRuntime(dir, baseUrl);
  await runtime.storeCustomProviders([providerConfig(baseUrl)]);
  await setupWorkspace(runtime, {
    workspaceName: "邮件测试",
    userName: "测试者",
    defaultExecutionModel: { model: { providerId: "fake", modelId: "fake-chat" }, effort: "off" },
    approval: { kind: "llm", model: { providerId: "fake", modelId: "fake-reviewer" }, effort: "off", criteriaVersion: 3 },
  });
  for (const name of names) {
    await createEmployee(runtime, {
      name,
      role: "研究",
      executionModel: { model: { providerId: "fake", modelId: "fake-chat" }, effort: "off" },
    } satisfies EmployeeDraftDTO);
  }
  for (const employee of await listEmployees(runtime)) await installEmployeeExtension(resume, employee);
  const room = await createRoom(runtime, { kind: "mail", name: "邮件测试" });
  return { runtime, resume, room };
}

const userAuthor = { type: "user" as const, id: "user", name: "测试者", address: "" };

/** A sent mail from the user: To 甲/乙, CC 丙. */
function mailInput(room: RoomRecord, to: EmployeeRecord[], cc: EmployeeRecord[] = []) {
  return {
    room: { id: room.id },
    data: messageData({
      author: userAuthor,
      body: "请读一下 notes.txt 并总结",
      mail: mailEnvelope({
        subject: "读一下 notes.txt",
        to: to.map((employee) => ({ name: employee.name, address: employee.address })),
        cc: cc.map((employee) => ({ name: employee.name, address: employee.address })),
        recipients: to.map((employee) => employee.id),
        copies: cc.map((employee) => employee.id),
        sent: true,
      }),
    }),
  };
}

describe("durable mail delivery", () => {
  beforeAll(() => {
    process.env[FAKE_KEY_ENV] = "test-key";
  });
  afterAll(() => {
    delete process.env[FAKE_KEY_ENV];
  });

  it("persists entry, works, and dispatch tasks before any model call, then finishes them after a restart", async () => {
    const fixture = await startFixture();
    cleanups.push(() => fixture.close());
    const dir = mkdtempSync(join(tmpdir(), "emit-mail-restart-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const first = await openRuntime(dir, fixture.baseUrl);
    cleanups.push(async () => {
      await first.runtime.close();
    });
    await first.runtime.storeCustomProviders([providerConfig(fixture.baseUrl)]);
    await setupWorkspace(first.runtime, {
      workspaceName: "邮件测试",
      userName: "测试者",
      defaultExecutionModel: { model: { providerId: "fake", modelId: "fake-chat" }, effort: "off" },
      approval: { kind: "llm", model: { providerId: "fake", modelId: "fake-reviewer" }, effort: "off", criteriaVersion: 3 },
    });
    for (const name of ["甲", "乙", "丙"]) {
      await createEmployee(first.runtime, {
        name,
        role: "研究",
        executionModel: { model: { providerId: "fake", modelId: "fake-chat" }, effort: "off" },
      } satisfies EmployeeDraftDTO);
    }
    for (const employee of await listEmployees(first.runtime)) await installEmployeeExtension(first.resume, employee);
    const room = await createRoom(first.runtime, { kind: "mail", name: "邮件测试" });
    const employees = await listEmployees(first.runtime);
    const a = employeeNamed(employees, "甲");
    const b = employeeNamed(employees, "乙");
    const c = employeeNamed(employees, "丙");

    const requestsBeforeSend = fixture.requests.length;
    const sent = await sendQueuedMail(first.resume, mailInput(room, [a, b], [c]));

    // The receive is complete and the scheduler has not run: nothing reached a
    // model, and every wake-up is already durable.
    expect(sent.workIds).toHaveLength(2);
    expect(fixture.requests.length).toBe(requestsBeforeSend);
    const queued = await listWorks(first.runtime);
    expect(queued.map((work) => work.employeeId).sort()).toEqual([a.id, b.id].sort());
    expect(queued.every((work) => work.status === "queued")).toBe(true);
    expect(queued.every((work) => work.mailDispatchTaskId.length > 0)).toBe(true);
    for (const work of queued) {
      const task = await first.runtime.harness.getTask(Number(work.mailDispatchTaskId) as TaskId, first.runtime.ctx);
      expect(task?.state.status).not.toBe("terminal");
    }
    expect((await roomMessages(first.runtime, room)).length).toBe(1);

    await first.runtime.close();

    // Restart the same data directory, install the extensions a resumed run
    // resolves, then enable scheduling — the order `main.ts` uses.
    const reopened = await openRuntime(dir, fixture.baseUrl);
    cleanups.push(async () => {
      await reopened.runtime.close();
    });
    const roomAfter = await findRoom(reopened.runtime, room.id);
    expect(roomAfter).toBeDefined();
    for (const employee of await listEmployees(reopened.runtime)) {
      await installEmployeeExtension(reopened.resume, employee);
    }
    const requestsBeforeResume = fixture.requests.length;
    reopened.runtime.resume();
    await reconcileWorks(reopened.resume);
    expect(fixture.requests.length).toBe(requestsBeforeResume);

    await waitFor(async () => {
      const works = await listWorks(reopened.runtime);
      return works.length === 2 && works.every((work) => work.status === "succeeded");
    }, "两封收件工作完成");

    // Exactly one generation per recipient: the restart re-scheduled the
    // persisted tasks without starting anything twice.
    const generations = fixture.requests.slice(requestsBeforeResume);
    expect(generations).toHaveLength(2);
    expect(generations.every((request) => request.prompt.includes("notes.txt"))).toBe(true);

    const entries = await roomMessages(reopened.runtime, roomAfter!);
    const sentEntry = entries.find((entry) => entry.author.type === "user");
    expect(sentEntry?.mail?.sent).toBe(true);
    const replies = entries.filter((entry) => entry.author.type === "employee");
    expect(replies.map((entry) => entry.author.name).sort()).toEqual(["乙", "甲"]);
    for (const reply of replies) {
      expect(reply.mail?.sent).toBe(true);
      expect(reply.mail?.draft).toBe(false);
      expect(reply.mail?.inReplyTo).toBe(sentEntry!.id);
      expect((reply.workId ?? "").length).toBeGreaterThan(0);
    }
    // CC is a copy, not a wake-up: 丙 never works and never replies.
    expect((await listWorks(reopened.runtime)).some((work) => work.employeeId === c.id)).toBe(false);
    expect(entries.some((entry) => entry.author.name === "丙")).toBe(false);
  }, 60_000);

  it("pauses a work that awaits a reply, continues it with the real reply, and delivers one answer", async () => {
    let releaseReply: (() => void) | undefined;
    const replyGate = new Promise<void>((resolve) => {
      releaseReply = resolve;
    });
    cleanups.push(() => releaseReply?.());
    const PREMATURE = "我还在等回信前的答复。";
    const FINAL = "最终答复：回信结果是 42。";
    const fixture = await startFixture((request) => {
      if (request.prompt.includes("localpart")) return { content: '{"localpart": "tester"}' };
      // 乙 cannot answer until the latch opens: the awaiting state is observed
      // while the child is genuinely still working.
      if (request.system.includes("乙")) return { content: "回信：结果是 42。", gate: replyGate };
      // 甲: ask, try to answer early, then answer for real once the reply is read.
      if (request.prompt.includes("收到与本任务相关的邮件回信")) return { content: FINAL };
      if (request.prompt.includes("已发送邮件给")) return { content: PREMATURE };
      return {
        toolCall: {
          name: "send_mail",
          args: { to: "乙", subject: "求助", body: "读一下 notes.txt 并告诉我结果", awaitReply: true },
        },
      };
    });
    cleanups.push(() => fixture.close());
    const dir = mkdtempSync(join(tmpdir(), "emit-mail-draft-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const { runtime, resume } = await openRuntime(dir, fixture.baseUrl);
    cleanups.push(async () => {
      await runtime.close();
    });
    await runtime.storeCustomProviders([providerConfig(fixture.baseUrl)]);
    await setupWorkspace(runtime, {
      workspaceName: "邮件测试",
      userName: "测试者",
      defaultExecutionModel: { model: { providerId: "fake", modelId: "fake-chat" }, effort: "off" },
      approval: { kind: "llm", model: { providerId: "fake", modelId: "fake-reviewer" }, effort: "off", criteriaVersion: 3 },
    });
    for (const name of ["甲", "乙"]) {
      await createEmployee(runtime, {
        name,
        role: "研究",
        executionModel: { model: { providerId: "fake", modelId: "fake-chat" }, effort: "off" },
      } satisfies EmployeeDraftDTO);
    }
    for (const employee of await listEmployees(runtime)) await installEmployeeExtension(resume, employee);
    const room = await createRoom(runtime, { kind: "mail", name: "邮件测试" });
    const employees = await listEmployees(runtime);
    const a = employeeNamed(employees, "甲");
    const b = employeeNamed(employees, "乙");
    runtime.resume();

    const sent = await sendQueuedMail(resume, mailInput(room, [a]));
    expect(sent.workIds).toHaveLength(1);

    // 甲 asks 乙 and then tries to answer on its own: the answer is held, not
    // delivered, and the work waits instead of finishing.
    await waitFor(async () => {
      const works = await listWorks(runtime);
      return works.some((work) => work.employeeId === a.id && work.status === "waiting-mail");
    }, "甲 的工作进入等待回信");
    const waiting = (await listWorks(runtime)).find((work) => work.employeeId === a.id)!;
    expect(waiting.answer).toBe(PREMATURE);
    expect(waiting.awaitedMailWorkIds).toHaveLength(1);
    const beforeReply = await roomMessages(runtime, room);
    // 甲's own mail is in the thread; what must not be there is the answer it
    // tried to write before reading the reply.
    expect(beforeReply.some((message) => message.body === PREMATURE)).toBe(false);
    expect(beforeReply.some((message) => message.author.name === "甲" && message.mail?.subject === "求助")).toBe(true);
    // The request for 乙 is a real work that the reply will come from.
    const childWork = (await listWorks(runtime)).find((work) => work.employeeId === b.id);
    expect(childWork?.status).not.toBe("succeeded");

    releaseReply!();
    await waitFor(async () => {
      const works = await listWorks(runtime);
      const parent = works.find((work) => work.employeeId === a.id);
      return parent?.status === "succeeded" && works.find((work) => work.employeeId === b.id)?.status === "succeeded";
    }, "甲 使用回信完成");

    // One answer, delivered once, written after the reply was read; and no
    // "thanks for the reply" mail back to 乙.
    const after = await roomMessages(runtime, room);
    const answers = after.filter((message) => message.body === FINAL);
    expect(answers).toHaveLength(1);
    expect(answers[0]?.author.name).toBe("甲");
    expect(after.some((message) => message.body === PREMATURE)).toBe(false);
    expect((await listWorks(runtime)).filter((work) => work.employeeId === b.id)).toHaveLength(1);
    const finalWork = (await listWorks(runtime)).find((work) => work.employeeId === a.id)!;
    expect(finalWork.awaitedMailWorkIds).toHaveLength(0);
    // The final turn really did receive the reply, not just a notification.
    const finalRequest = fixture.requests.at(-1)!;
    expect(finalRequest.prompt).toContain("结果是 42");
  }, 60_000);

  it("continues one work with two different replies and answers once", async () => {
    let releaseReplies: (() => void) | undefined;
    const repliesGate = new Promise<void>((resolve) => {
      releaseReplies = resolve;
    });
    cleanups.push(() => releaseReplies?.());
    const fixture = await startFixture((request) => {
      if (request.prompt.includes("localpart")) return { content: '{"localpart": "tester"}' };
      if (request.system.includes("乙")) return { content: "回信乙：结果是 B。", gate: repliesGate };
      if (request.system.includes("丙")) return { content: "回信丙：结果是 C。", gate: repliesGate };
      if (request.prompt.includes("收到与本任务相关的邮件回信")) return { content: "最终答复：B 和 C 都收到了。" };
      // First ask 乙, then 丙 once that send came back, then try to answer.
      if (request.prompt.includes("已发送邮件给 丙")) return { content: "等两位回信。" };
      if (request.prompt.includes("已发送邮件给 乙")) {
        return { toolCall: { name: "send_mail", args: { to: "丙", subject: "求助", body: "读一下 notes.txt", awaitReply: true } } };
      }
      return {
        toolCall: {
          name: "send_mail",
          args: { to: "乙", subject: "求助", body: "读一下 notes.txt", awaitReply: true },
        },
      };
    });
    cleanups.push(() => fixture.close());
    const dir = mkdtempSync(join(tmpdir(), "emit-mail-await-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const { runtime, resume, room } = await openWorkspaceForRun(dir, fixture.baseUrl, ["甲", "乙", "丙"]);
    const a = employeeNamed(await listEmployees(runtime), "甲");
    runtime.resume();
    await sendQueuedMail(resume, mailInput(room, [a]));

    await waitFor(async () => {
      const works = await listWorks(runtime);
      const parent = works.find((work) => work.employeeId === a.id);
      return parent?.status === "waiting-mail" && parent.awaitedMailWorkIds.length === 2;
    }, "甲 在等两位回信");

    releaseReplies!();
    await waitFor(async () => {
      const works = await listWorks(runtime);
      return works.find((work) => work.employeeId === a.id)?.status === "succeeded" && works.length === 3;
    }, "甲 用两份回信完成");

    const works = await listWorks(runtime);
    expect(works.map((work) => work.status).sort()).toEqual(["succeeded", "succeeded", "succeeded"]);
    const parent = works.find((work) => work.employeeId === a.id)!;
    expect(parent.awaitedMailWorkIds).toHaveLength(0);
    const messages = await roomMessages(runtime, room);
    expect(messages.filter((message) => message.body === "最终答复：B 和 C 都收到了。")).toHaveLength(1);
    // The last turn saw both results, not just the last one to arrive.
    const finalRequest = fixture.requests.at(-1)!;
    expect(finalRequest.prompt).toContain("结果是 B");
    expect(finalRequest.prompt).toContain("结果是 C");
  }, 60_000);

  it("hands a failing child to the parent as a failure instead of waiting forever", async () => {
    const fixture = await startFixture((request) => {
      if (request.prompt.includes("localpart")) return { content: '{"localpart": "tester"}' };
      if (request.prompt.includes("对方员工未能完成该请求")) return { content: "最终答复：对方失败了。" };
      if (request.prompt.includes("已发送邮件给")) return { content: "等回信时想先答。" };
      return {
        toolCall: {
          name: "send_mail",
          args: { to: "乙", subject: "求助", body: "读一下 notes.txt", awaitReply: true },
        },
      };
    });
    cleanups.push(() => fixture.close());
    const dir = mkdtempSync(join(tmpdir(), "emit-mail-failchild-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const { runtime, resume, room } = await openWorkspaceForRun(dir, fixture.baseUrl, ["甲", "乙"]);
    const a = employeeNamed(await listEmployees(runtime), "甲");
    const b = employeeNamed(await listEmployees(runtime), "乙");
    // 乙 is disabled before the ask: its dispatch start fails for real, which
    // is exactly the "recipient cannot work" failure the parent must hear.
    await updateEmployee(runtime, b.id, { enabled: false });
    runtime.resume();
    await sendQueuedMail(resume, mailInput(room, [a]));

    await waitFor(async () => {
      const works = await listWorks(runtime);
      const parent = works.find((work) => work.employeeId === a.id);
      const child = works.find((work) => work.employeeId === b.id);
      return parent?.status === "succeeded" && child?.status === "failed";
    }, "甲 收到失败结果");
    const child = (await listWorks(runtime)).find((work) => work.employeeId === b.id)!;
    expect(child.error).toContain("已停用");
    const finalRequest = fixture.requests.at(-1)!;
    expect(finalRequest.prompt).toContain("对方员工未能完成该请求");
    // The failure text is the real reason the child ended, not an invented one.
    expect(finalRequest.prompt).toContain("失败说明：员工 乙 已停用");
    const messages = await roomMessages(runtime, room);
    expect(messages.filter((message) => message.body === "最终答复：对方失败了。")).toHaveLength(1);
    // The parent is not left waiting on a child that will never answer.
    const parent = (await listWorks(runtime)).find((work) => work.employeeId === a.id)!;
    expect(parent.awaitedMailWorkIds).toHaveLength(0);
  }, 60_000);

  it("hands a stopped child to the parent so a stopped reply never strands the wait", async () => {
    let releaseReply: (() => void) | undefined;
    const replyGate = new Promise<void>((resolve) => {
      releaseReply = resolve;
    });
    cleanups.push(() => releaseReply?.());
    const fixture = await startFixture((request) => {
      if (request.prompt.includes("localpart")) return { content: '{"localpart": "tester"}' };
      if (request.system.includes("乙")) return { content: "回信（永远不会被读到）。", gate: replyGate };
      if (request.prompt.includes("对方员工的工作已被停止")) return { content: "最终答复：对方被停止了。" };
      if (request.prompt.includes("已发送邮件给")) return { content: "等回信时想先答。" };
      return {
        toolCall: {
          name: "send_mail",
          args: { to: "乙", subject: "求助", body: "读一下 notes.txt", awaitReply: true },
        },
      };
    });
    cleanups.push(() => fixture.close());
    const dir = mkdtempSync(join(tmpdir(), "emit-mail-stopchild-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const { runtime, resume, room } = await openWorkspaceForRun(dir, fixture.baseUrl, ["甲", "乙"]);
    const a = employeeNamed(await listEmployees(runtime), "甲");
    const b = employeeNamed(await listEmployees(runtime), "乙");
    runtime.resume();
    await sendQueuedMail(resume, mailInput(room, [a]));

    await waitFor(async () => {
      const works = await listWorks(runtime);
      return works.some((work) => work.employeeId === a.id && work.status === "waiting-mail") &&
        works.some((work) => work.employeeId === b.id);
    }, "甲 在等待且乙已开始");
    const child = (await listWorks(runtime)).find((work) => work.employeeId === b.id)!;
    await stopWork(resume, child.id);
    releaseReply!();

    await waitFor(async () => {
      const works = await listWorks(runtime);
      const parent = works.find((work) => work.employeeId === a.id);
      return parent?.status === "succeeded" && works.find((work) => work.employeeId === b.id)?.status === "stopped";
    }, "甲 收到停止结果");
    expect(fixture.requests.at(-1)!.prompt).toContain("对方员工的工作已被停止");
    const messages = await roomMessages(runtime, room);
    expect(messages.filter((message) => message.body === "最终答复：对方被停止了。")).toHaveLength(1);
  }, 60_000);

  it("clears the wait when a work awaiting a reply is stopped and never delivers a late reply as its answer", async () => {
    let releaseReply: (() => void) | undefined;
    const replyGate = new Promise<void>((resolve) => {
      releaseReply = resolve;
    });
    cleanups.push(() => releaseReply?.());
    const PREMATURE = "停止前的提前答复。";
    const fixture = await startFixture((request) => {
      if (request.prompt.includes("localpart")) return { content: '{"localpart": "tester"}' };
      if (request.system.includes("乙")) return { content: "回信：晚到的结果。", gate: replyGate };
      if (request.prompt.includes("收到与本任务相关的邮件回信")) return { content: "最终答复：不该出现。" };
      if (request.prompt.includes("已发送邮件给")) return { content: PREMATURE };
      return {
        toolCall: {
          name: "send_mail",
          args: { to: "乙", subject: "求助", body: "读一下 notes.txt", awaitReply: true },
        },
      };
    });
    cleanups.push(() => fixture.close());
    const dir = mkdtempSync(join(tmpdir(), "emit-mail-stopwait-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const { runtime, resume, room } = await openWorkspaceForRun(dir, fixture.baseUrl, ["甲", "乙"]);
    const a = employeeNamed(await listEmployees(runtime), "甲");
    const b = employeeNamed(await listEmployees(runtime), "乙");
    runtime.resume();
    await sendQueuedMail(resume, mailInput(room, [a]));

    await waitFor(async () => {
      const works = await listWorks(runtime);
      return works.some((work) => work.employeeId === a.id && work.status === "waiting-mail") &&
        works.some((work) => work.employeeId === b.id);
    }, "甲 在等待回信");
    const waiting = (await listWorks(runtime)).find((work) => work.employeeId === a.id)!;
    expect(waiting.awaitedMailWorkIds).toHaveLength(1);
    await stopWork(resume, waiting.id);
    releaseReply!();

    await waitFor(async () => {
      const works = await listWorks(runtime);
      return works.find((work) => work.employeeId === b.id)?.status === "succeeded";
    }, "乙 的回信已发出");
    const stopped = (await listWorks(runtime)).find((work) => work.employeeId === a.id)!;
    expect(stopped.status).toBe("stopped");
    // A stopped work is not still advertising a wait it can never resume from.
    expect(stopped.awaitedMailWorkIds).toHaveLength(0);
    const messages = await roomMessages(runtime, room);
    expect(messages.some((message) => message.body === PREMATURE)).toBe(false);
    expect(messages.some((message) => message.body === "最终答复：不该出现。")).toBe(false);
    // The late reply is still a mail the asker receives, just not its answer.
    expect(messages.some((message) => message.body === "回信：晚到的结果。")).toBe(true);
  }, 60_000);

  it("records a real tool call and its failure, keeps the record across a restart, and never leaks the system prompt", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "emit-work-"));
    cleanups.push(() => rmSync(workDir, { recursive: true, force: true }));
    const SECRET = "sk-live-secret-value";
    const fixture = await startFixture((request) => {
      if (request.prompt.includes("localpart")) return { content: '{"localpart": "tester"}' };
      if (request.system.includes("approval reviewer")) {
        return {
          content: JSON.stringify({
            outcome: "allow",
            risk: "low",
            rationale: "local read",
            readOnly: true,
            userAuthorization: "unknown",
          }),
        };
      }
      // The second request carries the tool result: answer for real then.
      if (request.prompt.includes('"role":"tool"')) return { content: "已完成：读完了。" };
      return {
        toolCall: {
          name: "read_file",
          args: { path: "missing.txt", headers: { authorization: `Bearer ${SECRET}` } },
        },
      };
    });
    cleanups.push(() => fixture.close());
    const dir = mkdtempSync(join(tmpdir(), "emit-mail-exec-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const { runtime, resume } = await openRuntime(dir, fixture.baseUrl);
    cleanups.push(async () => {
      await runtime.close();
    });
    await runtime.storeCustomProviders([providerConfig(fixture.baseUrl)]);
    await setupWorkspace(runtime, {
      workspaceName: "邮件测试",
      userName: "测试者",
      defaultExecutionModel: { model: { providerId: "fake", modelId: "fake-chat" }, effort: "off" },
      approval: { kind: "llm", model: { providerId: "fake", modelId: "fake-reviewer" }, effort: "off", criteriaVersion: 3 },
    });
    await createEmployee(runtime, {
      name: "甲",
      role: "研究",
      executionModel: { model: { providerId: "fake", modelId: "fake-chat" }, effort: "off" },
    } satisfies EmployeeDraftDTO);
    const a = employeeNamed(await listEmployees(runtime), "甲");
    for (const employee of await listEmployees(runtime)) await installEmployeeExtension(resume, employee);
    const room = await createRoom(runtime, {
      kind: "mail",
      name: "邮件测试",
      directories: { paths: [workDir], defaultPath: workDir },
    });
    runtime.resume();

    const sent = await sendQueuedMail(resume, mailInput(room, [a]));
    const workId = sent.workIds[0]!;
    await waitFor(async () => {
      const works = await listWorks(runtime);
      return works.find((work) => work.id === workId)?.status === "succeeded";
    }, "甲 完成带工具的运行");

    const execution = await readWorkExecution(runtime, workId);
    expect(execution).toBeDefined();
    const steps = execution!.steps;
    // The order the model saw: input, the call, its failure, the answer.
    expect(steps.map((step) => step.kind)).toEqual(["input", "tool-call", "tool-result", "assistant"]);
    const call = steps[1]!;
    expect(call.toolName).toBe("read_file");
    expect(call.toolCallId).toBeDefined();
    // A credential-looking argument is redacted before it is displayed.
    expect(call.arguments).not.toContain(SECRET);
    expect(call.arguments).toContain("[已隐去]");
    const result = steps[2]!;
    expect(result.toolCallId).toBe(call.toolCallId);
    expect(result.isError).toBe(true);
    expect(result.text ?? "").not.toContain(SECRET);
    expect(steps[3]!.text).toBe("已完成：读完了。");
    // Task state comes from the durable task record: the generation's entries
    // and the tool task's result both name the task that really wrote them.
    expect(steps.filter((step) => step.kind !== "input").every((step) => step.taskStatus !== undefined)).toBe(true);
    // Nothing from the system prompt or private thinking is exposed.
    expect(JSON.stringify(steps)).not.toContain("approval reviewer");
    expect(JSON.stringify(steps)).not.toContain("<employee>");
    // An auto-approved read leaves no pending human decision behind.
    expect(Array.isArray(execution!.approvals)).toBe(true);
    // A malformed cursor is the caller's error, not an empty page.
    await expect(readWorkExecution(runtime, workId, "{oops")).rejects.toBeInstanceOf(WorkExecutionCursorError);

    // The record is durable: a restart reads the same steps, not a live buffer.
    await runtime.close();
    const reopened = await openRuntime(dir, fixture.baseUrl);
    cleanups.push(async () => {
      await reopened.runtime.close();
    });
    const again = await readWorkExecution(reopened.runtime, workId);
    expect(again?.steps.map((step) => step.id)).toEqual(steps.map((step) => step.id));
  }, 60_000);

  it("sends a draft once under concurrent sends and replays a tool send from its receipt", async () => {
    const fixture = await startFixture();
    cleanups.push(() => fixture.close());
    const dir = mkdtempSync(join(tmpdir(), "emit-mail-await-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const { runtime, resume } = await openRuntime(dir, fixture.baseUrl);
    cleanups.push(async () => {
      await runtime.close();
    });
    await runtime.storeCustomProviders([providerConfig(fixture.baseUrl)]);
    await setupWorkspace(runtime, {
      workspaceName: "邮件测试",
      userName: "测试者",
      defaultExecutionModel: { model: { providerId: "fake", modelId: "fake-chat" }, effort: "off" },
      approval: { kind: "llm", model: { providerId: "fake", modelId: "fake-reviewer" }, effort: "off", criteriaVersion: 3 },
    });
    await createEmployee(runtime, {
      name: "甲",
      role: "研究",
      executionModel: { model: { providerId: "fake", modelId: "fake-chat" }, effort: "off" },
    } satisfies EmployeeDraftDTO);
    const a = employeeNamed(await listEmployees(runtime), "甲");
    const room = await createRoom(runtime, { kind: "mail", name: "邮件测试" });

    const draft = await appendRoomMessage(
      runtime,
      room,
      messageData({
        author: userAuthor,
        body: "请读一下 notes.txt 并总结",
        mail: mailEnvelope({
          subject: "读一下 notes.txt",
          to: [{ name: a.name, address: a.address }],
          recipients: [a.id],
          sent: false,
          draft: true,
        }),
      }),
    );

    const attempts = await Promise.allSettled([
      sendQueuedMail(resume, { ...mailInput(room, [a]), retireDraftId: draft.id }),
      sendQueuedMail(resume, { ...mailInput(room, [a]), retireDraftId: draft.id }),
    ]);
    const fulfilled = attempts.filter((attempt) => attempt.status === "fulfilled");
    const rejected = attempts.filter((attempt) => attempt.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const reason = (rejected[0] as PromiseRejectedResult).reason;
    expect(reason).toBeInstanceOf(RoomDirectoryError);
    expect((reason as RoomDirectoryError).status).toBe(409);

    const afterSend = await roomMessages(runtime, room);
    expect(afterSend.filter((entry) => entry.mail?.sent && !entry.mail?.draft)).toHaveLength(1);
    expect(await listWorks(runtime)).toHaveLength(1);

    // A replay with the same tool task id returns the recorded outcome instead
    // of sending again.
    const first = await sendQueuedMail(resume, { ...mailInput(room, [a]), toolTaskId: "task-1" });
    const replay = await sendQueuedMail(resume, { ...mailInput(room, [a]), toolTaskId: "task-1" });
    expect(replay.message.id).toBe(first.message.id);
    expect(replay.workIds).toEqual(first.workIds);
    expect(await listWorks(runtime)).toHaveLength(2);
    expect(await roomMessages(runtime, room)).toHaveLength(afterSend.length + 1);

    // A retired draft cannot be sent again by its own id.
    const retired = await sendQueuedMail(resume, { ...mailInput(room, [a]), retireDraftId: draft.id }).catch(
      (error: unknown) => error,
    );
    expect(retired).toBeInstanceOf(RoomDirectoryError);
    expect((retired as RoomDirectoryError).status).toBe(409);
  }, 60_000);

  it("localized failure text survives a restart while model and user originals do not change", async () => {
    const fixture = await startFixture();
    cleanups.push(() => fixture.close());
    const dir = mkdtempSync(join(tmpdir(), "emit-mail-localized-failure-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const workDir = join(dir, "work");
    mkdirSync(workDir);

    const first = await openRuntime(dir, fixture.baseUrl);
    cleanups.push(async () => {
      await first.runtime.close();
    });
    await first.runtime.storeCustomProviders([providerConfig(fixture.baseUrl)]);
    await setupWorkspace(first.runtime, {
      workspaceName: "邮件测试",
      userName: "测试者",
      defaultExecutionModel: { model: { providerId: "fake", modelId: "fake-chat" }, effort: "off" },
      approval: { kind: "llm", model: { providerId: "fake", modelId: "fake-reviewer" }, effort: "off", criteriaVersion: 3 },
    });
    await createEmployee(first.runtime, {
      name: "乙",
      role: "研究",
      executionModel: { model: { providerId: "fake", modelId: "fake-chat" }, effort: "off" },
    } satisfies EmployeeDraftDTO);
    let employee = employeeNamed(await listEmployees(first.runtime), "乙");
    await updateEmployee(first.runtime, employee.id, { enabled: false });
    const employees = await listEmployees(first.runtime);
    employee = employeeNamed(employees, "乙");
    for (const current of employees) await installEmployeeExtension(first.resume, current);
    const room = await createRoom(first.runtime, {
      kind: "mail",
      name: "邮件测试",
      directories: { paths: [workDir], defaultPath: workDir },
    });

    first.runtime.resume();
    const queuedMail = mailInput(room, [employee]);
    const requestsBeforeDispatch = fixture.requests.length;
    const sent = await sendQueuedMail(first.resume, {
      ...queuedMail,
      data: { ...queuedMail.data, body: "原文 乙 中文" },
    });
    expect(sent.workIds).toHaveLength(1);
    const workId = sent.workIds[0]!;
    await waitFor(
      async () => (await listWorks(first.runtime)).some((work) => work.id === workId && work.status === "failed"),
      "乙 的邮件工作失败",
      15_000,
    );

    const works = await listWorks(first.runtime);
    expect(works).toHaveLength(1);
    const record = works.find((work) => work.id === workId);
    if (record === undefined) throw new Error(`Missing failed work ${workId}`);
    const rawError = record.error;
    const workDTO = toWorkDTO(record, "乙", room.name);
    expect(rawError).toContain("已停用");
    expect(workDTO.error).toBe(rawError);
    expect(workDTO.errorLocalized?.["zh-CN"]).toContain("乙");
    expect(workDTO.errorLocalized?.en).toContain("乙");
    expect(workDTO.errorLocalized?.en).toMatch(/\b(?:disabled|failed)\b/i);
    expect((workDTO.errorLocalized?.en ?? "").replaceAll("乙", "")).not.toMatch(/\p{Script=Han}/u);

    let entries = await roomMessages(first.runtime, room);
    const notices = entries.filter((message) => message.author.type === "system" && message.notice === true);
    expect(notices).toHaveLength(1);
    const notice = notices[0];
    if (notice === undefined) throw new Error("Missing failed system notice");
    expect(notice.body).toContain("乙");
    expect(notice.bodyLocalized?.["zh-CN"]).toBe(notice.body);
    expect(notice.bodyLocalized?.en).toContain("乙");
    expect(notice.bodyLocalized?.en).toMatch(/\b(?:disabled|failed)\b/i);
    expect((notice.bodyLocalized?.en ?? "").replaceAll("乙", "")).not.toMatch(/\p{Script=Han}/u);

    const userMessages = entries.filter((message) => message.author.type === "user");
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]?.body).toBe("原文 乙 中文");
    expect(userMessages[0]).not.toHaveProperty("bodyLocalized");
    expect(fixture.requests).toHaveLength(requestsBeforeDispatch);

    const oldBody = "旧系统消息原文：保留中文";
    await appendRoomMessage(
      first.runtime,
      room,
      messageData({
        author: { type: "system", id: "system", name: "系统", address: "" },
        body: oldBody,
      }),
    );
    entries = await roomMessages(first.runtime, room);
    const oldMessage = entries.find((message) => message.body === oldBody);
    expect(oldMessage?.body).toBe(oldBody);
    expect(oldMessage).not.toHaveProperty("bodyLocalized");

    await first.runtime.close();
    const reopened = await openRuntime(dir, fixture.baseUrl);
    cleanups.push(async () => {
      await reopened.runtime.close();
    });
    const persistedWorks = await listWorks(reopened.runtime);
    expect(persistedWorks).toHaveLength(1);
    const persistedRecord = persistedWorks.find((work) => work.id === workId);
    if (persistedRecord === undefined) throw new Error(`Missing reopened work ${workId}`);
    const persistedDTO = toWorkDTO(persistedRecord, "乙", room.name);
    expect(persistedDTO.error).toBe(rawError);
    expect(persistedDTO.errorLocalized).toEqual(workDTO.errorLocalized);

    const persistedEntries = await roomMessages(reopened.runtime, room);
    const persistedNotice = persistedEntries.find(
      (message) => message.author.type === "system" && message.notice === true,
    );
    expect(persistedNotice?.bodyLocalized).toEqual(notice.bodyLocalized);
    const persistedOldMessage = persistedEntries.find((message) => message.body === oldBody);
    expect(persistedOldMessage?.body).toBe(oldBody);
    expect(persistedOldMessage).not.toHaveProperty("bodyLocalized");
  }, 30_000);
});

/** Every message entry in a room, oldest first, as DTOs. */
async function roomMessages(runtime: EmitRuntime, room: RoomRecord): Promise<MessageDTO[]> {
  const conversation = await runtime.harness.conversation(room.conversationId as ConversationId, runtime.ctx);
  if (conversation === undefined) return [];
  const page = await conversation.entries({}, 200, undefined, runtime.ctx);
  return page.items.flatMap((entry) => {
    if (!RoomMessageEntry.is(entry)) return [];
    const dto = toMessageDTO(entry);
    return dto === undefined ? [] : [dto];
  });
}

async function waitFor(check: () => Promise<boolean>, message: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  throw new Error(`等待超时：${message}`);
}
