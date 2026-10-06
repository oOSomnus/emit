import { createServer, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { FastifyInstance } from "fastify";
import { EmitRuntime } from "../../src/server/runtime.ts";
import { McpManager } from "../../src/server/mcp.ts";
import { buildMailExtension, buildMailTasks, type MailTasks } from "../../src/server/mail.ts";
import { buildWorkDispatchExtension, buildWorkDispatchTask } from "../../src/server/work-dispatch.ts";
import { installEmployeeExtension, type Resume } from "../../src/server/work.ts";
import { attachProgress } from "../../src/server/progress.ts";
import { buildServer } from "../../src/server/api.ts";
import { createWorkContext } from "../../src/server/work-contexts.ts";
import { RoomMessageEntry, type EmployeeRecord, type WorkContextRecord, type RoomRecord } from "../../src/server/documents.ts";
import { createEmployee, listEmployees, setupWorkspace } from "../../src/server/workspace.ts";
import { toMessageDTO } from "../../src/server/rooms.ts";
import type { ChatSelectionDTO, DirectoryDraftDTO, EmployeeDraftDTO, MessageDTO } from "../../src/shared/contracts.ts";
/** Configure an isolated workspace and install its employees before resume. */
export async function setupFixtureWorkspace(
  runtime: EmitRuntime,
  resume: Resume,
  names: readonly string[],
  options: { userName?: string; executionModel?: ChatSelectionDTO } = {},
): Promise<EmployeeRecord[]> {
  const executionModel = options.executionModel ?? {
    model: { providerId: "fake", modelId: "fake-chat" },
    effort: "off",
  };
  await setupWorkspace(runtime, {
    userName: options.userName ?? "Test User",
    defaultExecutionModel: executionModel,
    approval: {
      kind: "llm",
      model: { providerId: "fake", modelId: "fake-reviewer" },
      effort: "off",
      criteriaVersion: 3,
    },
  });
  for (const name of names) {
    await createEmployee(runtime, {
      name,
      role: "Research",
      executionModel,
      generateAddress: false,
    } satisfies EmployeeDraftDTO);
  }
  const employees = await listEmployees(runtime);
  for (const employee of employees) await installEmployeeExtension(resume, employee);
  return employees;
}

/** Poll an observable durable state until it reaches the expected condition. */
export async function waitForFixture(
  check: () => Promise<boolean>,
  description: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 50);
    await promise;
  }
  throw new Error(`Timed out waiting for ${description}`);
}

/** Read every room message entry as its public DTO, oldest first. */
export async function readFixtureRoomMessages(runtime: EmitRuntime, room: RoomRecord): Promise<MessageDTO[]> {
  const conversation = await runtime.harness.conversation(room.conversationId as ConversationId, runtime.ctx);
  if (conversation === undefined) return [];
  const page = await conversation.entries({}, 1000, undefined, runtime.ctx);
  return page.items.flatMap((entry) => {
    if (!RoomMessageEntry.is(entry)) return [];
    const dto = toMessageDTO(entry);
    if (dto === undefined) return [];
    dto.roomId = room.id;
    return [dto];
  });
}

export const FAKE_KEY_ENV = "EMIT_MAIL_TEST_KEY";

export type FixtureRequest = { model: string | undefined; system: string; prompt: string };
export type FixtureAnswer = {
  content?: string;
  toolCall?: { name: string; args: unknown };
  /** Hold the response until this settles: a deterministic model-side latch. */
  gate?: Promise<void>;
  httpStatus?: number;
  contentType?: string;
  /** Send these response bytes verbatim instead of generating an OpenAI stream. */
  chunks?: readonly Uint8Array[];
  /** Destroy the response after writing this zero-based chunk index. */
  disconnectAfterChunk?: number;
  /** Omit the generated OpenAI [DONE] marker without changing the generated finish reason. */
  omitDone?: boolean;
};

/** Use the same local approval response while keeping each fixture's completion explicit. */
export function answerFixtureRequest(request: FixtureRequest, completion: () => string): FixtureAnswer {
  if (request.model === "fake-reviewer") {
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
  return { content: completion() };
}

/** A reasoning-only completion with no visible final answer. */
export function emptyThinkingAnswer(canary: string, model = "fake-chat"): FixtureAnswer {
  const base = { id: "empty-thinking", object: "chat.completion.chunk", created: 0, model };
  return {
    chunks: [
      new TextEncoder().encode(
        [
          `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { reasoning_content: canary }, finish_reason: null }] })}\n\n`,
          `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
          "data: [DONE]\n\n",
        ].join(""),
      ),
    ],
  };
}
export type Fixture = { baseUrl: string; requests: FixtureRequest[]; close: () => Promise<void> };
export type HttpRuntimeFixture = {
  runtime: EmitRuntime;
  resume: Resume;
  server: FastifyInstance;
  url: string;
  close(): Promise<void>;
};

/** Write one OpenAI-completions SSE answer, with or without a tool call. */
export function writeAnswer(response: ServerResponse, model: string | undefined, answer: FixtureAnswer): void {
  if (response.writableEnded || response.destroyed) return;
  const base = { id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 0, model: model ?? "fake-chat" };
  const chunk = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
  response.writeHead(answer.httpStatus ?? 200, {
    "content-type": answer.contentType ?? "text/event-stream",
    "cache-control": "no-cache",
  });
  if (answer.chunks !== undefined) {
    for (let index = 0; index < answer.chunks.length; index += 1) {
      const bytes = answer.chunks[index];
      if (bytes === undefined) continue;
      if (answer.disconnectAfterChunk === index) {
        response.write(bytes, () => response.destroy());
        return;
      }
      response.write(bytes);
    }
    response.end();
    return;
  }
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
  if (answer.omitDone !== true) response.write("data: [DONE]\n\n");
  response.end();
}

export async function startFixture(
  decide: (request: FixtureRequest) => FixtureAnswer = (request) =>
    request.prompt.includes("localpart") ? { content: '{"localpart": "tester"}' } : { content: "已完成：我看过邮件了。" },
): Promise<Fixture> {
  const requests: FixtureRequest[] = [];
  const sockets = new Set<Socket>();
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
      else {
        void answer.gate.then(
          () => writeAnswer(response, model, answer),
          () => response.destroy(),
        );
      }
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
  } catch (error) {
    for (const socket of sockets) socket.destroy();
    try {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    } catch {
      // A failed bind has no active server handle to preserve.
    }
    throw error;
  }
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture failed to bind");
  let closePromise: Promise<void> | undefined;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => {
      closePromise ??= new Promise<void>((resolve, reject) => {
        for (const socket of sockets) socket.destroy();
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
      return closePromise;
    },
  };
}


export function providerConfig(baseUrl: string) {
  return {
    id: "fake",
    name: "Fake Provider",
    baseUrl,
    api: "openai-completions" as const,
    apiKeyEnv: FAKE_KEY_ENV,
    models: [
      { id: "fake-chat", name: "Fake Chat", contextWindow: 32768, maxTokens: 4096, reasoning: false, input: ["text" as const] },
      {
        id: "fake-reviewer",
        name: "Fake Reviewer",
        contextWindow: 32768,
        maxTokens: 4096,
        reasoning: false,
        input: ["text" as const],
      },
    ],
  };
}

/** Open one isolated temporary directory for a durable runtime or scratch data. */
export function mkdtempDataDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Build the process-wide task handles and register their extensions before resume. */
export function buildResume(runtime: EmitRuntime, mcp: McpManager): Resume {
  const dispatch = buildWorkDispatchTask(() => resume);
  const mail: MailTasks = buildMailTasks(() => resume);
  const resume: Resume = { runtime, mcp, dispatch, mail };
  runtime.registry.install(buildWorkDispatchExtension(dispatch));
  runtime.registry.install(buildMailExtension(mail));
  return resume;
}

export async function openRuntime(dir: string): Promise<{ runtime: EmitRuntime; resume: Resume }> {
  const runtime = await EmitRuntime.open({ dataDir: dir });
  const resume = buildResume(runtime, new McpManager(runtime));
  return { runtime, resume };
}

/** Open a fixture-backed runtime and register its resources with suite cleanup. */
export async function openFixtureRuntime(
  fixture: Fixture,
  cleanup: Array<() => Promise<void> | void>,
  prefix: string,
): Promise<{ runtime: EmitRuntime; resume: Resume; dataDir: string }> {
  const dataDir = mkdtempDataDir(prefix);
  cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const opened = await openRuntime(dataDir);
  cleanup.push(() => opened.runtime.close());
  await opened.runtime.storeCustomProviders([providerConfig(fixture.baseUrl)]);
  return { ...opened, dataDir };
}

/** Start the real HTTP API around an open fixture runtime; setup and resume remain caller-owned. */
export async function startHttpRuntime(
  dir: string,
  options: { webRoot?: string } = {},
): Promise<HttpRuntimeFixture> {
  const { runtime, resume } = await openRuntime(dir);
  let detachProgress: (() => void) | undefined;
  let server: FastifyInstance | undefined;
  try {
    detachProgress = attachProgress(runtime);
    const httpServer = await buildServer({ resume, webRoot: options.webRoot });
    server = httpServer;
    const url = await httpServer.listen({ host: "127.0.0.1", port: 0 });
    let closePromise: Promise<void> | undefined;
    return {
      runtime,
      resume,
      server: httpServer,
      url,
      close: () => {
        closePromise ??= (async () => {
          let failed = false;
          let failure: unknown;
          try {
            detachProgress?.();
          } catch (error) {
            failed = true;
            failure = error;
          }
          try {
            await httpServer.close();
          } catch (error) {
            if (!failed) failure = error;
            failed = true;
          }
          try {
            await resume.mcp.closeAll();
          } catch (error) {
            if (!failed) failure = error;
            failed = true;
          }
          try {
            await runtime.close();
          } catch (error) {
            if (!failed) failure = error;
            failed = true;
          }
          if (failed) throw failure;
        })();
        return closePromise;
      },
    };
  } catch (error) {
    try {
      detachProgress?.();
    } catch {
      // Preserve the startup error while still attempting every owned cleanup.
    }
    if (server !== undefined) {
      try {
        await server.close();
      } catch {
        // A server that failed before listen has no live socket to preserve.
      }
    }
    try {
      await resume.mcp.closeAll();
    } catch {
      // Preserve the startup error while still releasing the runtime.
    }
    try {
      await runtime.close();
    } catch {
      // Preserve the startup error.
    }
    throw error;
  }
}


/** Create the work owning a fixture room; supplied directory roots are real directories. */
export async function createWorkContextFixture(
  runtime: EmitRuntime,
  name: string,
  dirs?: DirectoryDraftDTO,
): Promise<WorkContextRecord> {
  for (const path of dirs?.paths ?? []) mkdirSync(path, { recursive: true });
  return createWorkContext(runtime, { name, ...(dirs === undefined ? {} : { directories: dirs }) });
}
