import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationId } from "@earendil-works/pi-durable";
import { EmitRuntime } from "../../src/server/runtime.ts";
import { McpManager } from "../../src/server/mcp.ts";
import { buildMailExtension, buildMailTasks, type MailTasks } from "../../src/server/mail.ts";
import { buildWorkDispatchExtension, buildWorkDispatchTask } from "../../src/server/work-dispatch.ts";
import { installEmployeeExtension, type Resume } from "../../src/server/work.ts";
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
  options: { workspaceName?: string; userName?: string; executionModel?: ChatSelectionDTO } = {},
): Promise<EmployeeRecord[]> {
  const executionModel = options.executionModel ?? {
    model: { providerId: "fake", modelId: "fake-chat" },
    effort: "off",
  };
  await setupWorkspace(runtime, {
    workspaceName: options.workspaceName ?? "Integration fixture",
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
};
export type Fixture = { baseUrl: string; requests: FixtureRequest[]; close: () => Promise<void> };

/** Write one OpenAI-completions SSE answer, with or without a tool call. */
export function writeAnswer(response: ServerResponse, model: string | undefined, answer: FixtureAnswer): void {
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

export async function startFixture(
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
  let resume: Resume;
  const dispatch = buildWorkDispatchTask(() => resume);
  const mail: MailTasks = buildMailTasks(() => resume);
  resume = { runtime, mcp, dispatch, mail };
  runtime.registry.install(buildWorkDispatchExtension(dispatch));
  runtime.registry.install(buildMailExtension(mail));
  return resume;
}

export async function openRuntime(dir: string): Promise<{ runtime: EmitRuntime; resume: Resume }> {
  const runtime = await EmitRuntime.open({ dataDir: dir });
  const resume = buildResume(runtime, new McpManager(runtime));
  return { runtime, resume };
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
