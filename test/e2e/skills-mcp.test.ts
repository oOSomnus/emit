import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { McpClient, StdioTransport } from "@earendil-works/pi-mcp";
import { afterEach, describe, expect, it } from "vitest";
import type { ApprovalDTO, EmployeeDTO, MessageDTO, McpServerDTO, RoomDTO, SkillDTO, WorkContextDTO, WorkDTO, WorkExecutionDTO } from "../../src/shared/contracts.ts";
import { createE2eFixture, type E2eFixture } from "../helpers/e2e-fixture.ts";
import { waitForFixture } from "../helpers/emit-fixture.ts";

const cleanups: Array<() => Promise<void>> = [];
const model = { model: { providerId: "fake", modelId: "fake-chat" }, effort: "off" };
const mcpScript = resolve("test/fixtures/fake-mcp.mjs");

async function open() {
  const fixture = await createE2eFixture();
  cleanups.push(() => fixture.close());
  return fixture;
}
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

async function call<T>(fixture: E2eFixture, path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fixture.request<T>(path, method, body);
  expect(response.status, `${method} ${path}: ${JSON.stringify(response.body)}`).toBe(200);
  return response.body;
}
async function employee(fixture: E2eFixture, name: string, options: Record<string, unknown>) {
  return call<EmployeeDTO>(fixture, "/api/employees", "POST", {
    name, role: "资料助手", instructions: "使用绑定的工具完成任务。", executionModel: model, generateAddress: true, ...options,
  });
}
async function room(fixture: E2eFixture, employeeId: string, workContextId = fixture.workspace.workContextId) {
  return call<RoomDTO>(fixture, "/api/rooms", "POST", { kind: "dm", name: "协议测试", employeeId, workContextId });
}
async function send(fixture: E2eFixture, roomId: string, body: string, recipientIds?: string[]) {
  const started = await call<{ workIds: string[] }>(fixture, `/api/rooms/${roomId}/messages`, "POST", { body, ...(recipientIds ? { recipientIds } : {}) });
  expect(started.workIds).toHaveLength(1);
  return started.workIds[0]!;
}
async function finished(fixture: E2eFixture, workId: string) {
  await waitForFixture(async () => {
    const works = await call<WorkDTO[]>(fixture, "/api/works");
    return works.some((work) => work.id === workId && ["succeeded", "failed", "stopped"].includes(work.status));
  }, `terminal work ${workId}`);
  const work = (await call<WorkDTO[]>(fixture, "/api/works")).find((entry) => entry.id === workId)!;
  expect(work, JSON.stringify(work)).toMatchObject({ status: "succeeded" });
  const messages = await call<{ messages: MessageDTO[] }>(fixture, `/api/rooms/${work.roomId}/messages`);
  const answers = messages.messages.filter((message) => message.workId === workId && message.author.type === "employee");
  expect(answers).toHaveLength(1);
  expect(answers[0]!.body).toBe(work.answer);
  return call<WorkExecutionDTO>(fixture, `/api/works/${workId}/execution`);
}
async function approvals(fixture: E2eFixture, workId: string) {
  return (await call<{ approvals: ApprovalDTO[] }>(fixture, "/api/approvals")).approvals.filter((entry) => entry.workId === workId);
}
async function approval(fixture: E2eFixture, workId: string, status: ApprovalDTO["status"]) {
  await waitForFixture(async () => (await approvals(fixture, workId)).some((entry) => entry.status === status), `${status} approval for ${workId}`);
  const entry = (await approvals(fixture, workId)).find((entry) => entry.status === status)!;
  expect(entry.toolName).toBe("mcp__fixture__echo_notes");
  return entry;
}
function results(execution: WorkExecutionDTO) { return execution.steps.filter((step) => step.kind === "tool-result"); }
async function connect(fixture: E2eFixture) {
  const server = await call<McpServerDTO>(fixture, "/api/mcp", "POST", {
    name: "fixture", transport: "stdio", command: process.execPath, args: [mcpScript], cwd: fixture.workRoot, enabled: true,
  });
  const response = await call<{ ok: boolean; tools: string[] }>(fixture, `/api/mcp/${server.id}/connect`, "POST", {});
  expect(response.ok).toBe(true);
  expect(response.tools.sort()).toEqual(["echo_notes", "shout"]);
  const saved = (await call<{ servers: McpServerDTO[] }>(fixture, "/api/mcp")).servers.find((entry) => entry.id === server.id)!;
  expect(saved.connection.state).toBe("connected");
  expect(saved.tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: "echo_notes", readOnly: true }), expect.objectContaining({ name: "shout", readOnly: false })]));
  return saved;
}

describe("real-process skills and MCP protocols", () => {
  it("imports a private Chinese skill, binds it, and reads its body only on demand", async () => {
    const fixture = await open();
    const skillDir = join(fixture.workRoot, "skills", "smoke-skill");
    mkdirSync(skillDir, { recursive: true });
    const skillFile = join(skillDir, "SKILL.md");
    const header = "---\nname: smoke-review\ndescription: 冒烟用的评审技能\n---\n\n# 冒烟技能\n\n";
    writeFileSync(skillFile, `${header}导入时的旧正文。\n`);
    const imported = await call<{ imported: SkillDTO[] }>(fixture, "/api/skills/import", "POST", { directory: join(fixture.workRoot, "skills") });
    expect(imported.imported).toHaveLength(1);
    const skill = imported.imported[0]!;
    expect(skill).toMatchObject({ name: "smoke-review", description: "冒烟用的评审技能", filePath: skillFile });
    expect((await call<{ skills: SkillDTO[] }>(fixture, "/api/skills")).skills).toEqual(imported.imported);
    const worker = await employee(fixture, "技能员工", { skillIds: [skill.id], toolPolicy: { allowedTools: ["read_file", "load_skill"], trustedReadOnlyTools: ["load_skill"] } });
    expect(worker.skillIds).toEqual([skill.id]);
    // The body changes after import and binding: only a real load can see this marker.
    writeFileSync(skillFile, `${header}正文里有一句只能通过 load_skill 读到的话：SMOKE-SKILL-BODY。\n`);
    const dm = await room(fixture, worker.id);
    const workId = await send(fixture, dm.id, "用你的技能（skill）看看");
    const execution = await finished(fixture, workId);
    const load = execution.steps.find((step) => step.kind === "tool-call" && step.toolName === "load_skill");
    expect(JSON.parse(load!.arguments!)).toMatchObject({ name: "smoke-review" });
    expect(results(execution)).toEqual(expect.arrayContaining([expect.objectContaining({ isError: false, text: expect.stringContaining("SMOKE-SKILL-BODY") })]));
    expect(execution.work.answer).toBe("已按技能完成：SMOKE-SKILL-BODY");
  }, 90_000);

  it("calls a trusted MCP tool with and without local roots while keeping the server independent", async () => {
    const fixture = await open();
    const server = await connect(fixture);
    const worker = await employee(fixture, "MCP 员工", { mcpServerIds: [server.id], toolPolicy: { allowedTools: ["mcp__fixture__echo_notes"], trustedReadOnlyTools: ["fixture/echo_notes"] } });
    expect(worker.mcpServerIds).toEqual([server.id]);
    const dm = await room(fixture, worker.id);
    const withRoots = await send(fixture, dm.id, "用 MCP 工具看看笔记");
    const first = await finished(fixture, withRoots);
    expect(results(first)).toEqual(expect.arrayContaining([expect.objectContaining({ isError: false, text: "来自 MCP fixture 的笔记：notes.txt" })]));
    expect(await approvals(fixture, withRoots)).toEqual([]);
    const empty = await call<WorkContextDTO>(fixture, "/api/work-contexts", "POST", { name: "无本地目录的 MCP", directories: { paths: [], defaultPath: "" } });
    expect(empty.directories.paths).toEqual([]);
    const channel = await call<RoomDTO>(fixture, "/api/rooms", "POST", { kind: "channel", name: "无本地目录的 MCP", workContextId: empty.id, memberIds: [worker.id] });
    const withoutRoots = await send(fixture, channel.id, "用 MCP 工具看看笔记", [worker.id]);
    const second = await finished(fixture, withoutRoots);
    expect(results(second)).toEqual(expect.arrayContaining([expect.objectContaining({ isError: false, text: "来自 MCP fixture 的笔记：notes.txt" })]));
    expect(await approvals(fixture, withoutRoots)).toEqual([]);
    const after = (await call<{ servers: McpServerDTO[] }>(fixture, "/api/mcp")).servers.find((entry) => entry.id === server.id)!;
    expect(after.target).toBe(server.target);
    expect(after.connection.state).toBe("connected");
    expect(after.tools).toEqual(server.tools);
  }, 90_000);

  it("reviews untrusted hinted reads as low, gates high until approved, and blocks unknown", async () => {
    const fixture = await open();
    const server = await connect(fixture);
    const worker = await employee(fixture, "MCP 未信任员工", { mcpServerIds: [server.id], toolPolicy: { allowedTools: ["mcp__fixture__echo_notes"], trustedReadOnlyTools: [] } });
    const dm = await room(fixture, worker.id);
    const lowId = await send(fixture, dm.id, "用 MCP 工具看看笔记");
    const lowExecution = await finished(fixture, lowId);
    const low = await approval(fixture, lowId, "approved");
    expect(low.evidence).toMatchObject({ kind: "llm", outcome: "allow", risk: "low" });
    expect(low.execution.state).toBe("succeeded");
    expect(results(lowExecution)).toEqual(expect.arrayContaining([expect.objectContaining({ isError: false, text: "来自 MCP fixture 的笔记：notes.txt" })]));

    const highId = await send(fixture, dm.id, "用 MCP 工具触发受控高风险审查");
    const high = await approval(fixture, highId, "pending-human");
    expect(JSON.parse(high.argumentsPreview)).toEqual({ path: "SMOKE-CONTROLLED-HIGH" });
    expect(high.evidence).toMatchObject({ kind: "llm", outcome: "allow", risk: "high" });
    expect(high.execution.state).toBe("not-started");
    expect((await call<WorkDTO[]>(fixture, "/api/works")).find((work) => work.id === highId)?.status).toBe("waiting-approval");
    expect(results(await call<WorkExecutionDTO>(fixture, `/api/works/${highId}/execution`)).some((step) => step.text?.includes("来自 MCP fixture"))).toBe(false);
    expect((await call<{ messages: MessageDTO[] }>(fixture, `/api/rooms/${dm.id}/messages`)).messages.some((message) => message.workId === highId && message.author.type === "employee")).toBe(false);
    await call(fixture, `/api/approvals/${high.id}/decision`, "POST", { decision: "approved" });
    const highExecution = await finished(fixture, highId);
    expect(results(highExecution)).toEqual(expect.arrayContaining([expect.objectContaining({ isError: false, text: "来自 MCP fixture 的笔记：SMOKE-CONTROLLED-HIGH" })]));
    expect((await approval(fixture, highId, "approved")).execution.state).toBe("succeeded");

    // The echo server reports the requested path; it does not read real credentials.
    const canary = "PRIVATE-MCP-CREDENTIAL-CANARY";
    const envFile = join(fixture.workRoot, ".env");
    writeFileSync(envFile, `API_KEY=${canary}\n`);
    const secretId = await send(fixture, dm.id, "用 MCP 工具读取密钥");
    const secretExecution = await finished(fixture, secretId);
    const secret = await approval(fixture, secretId, "approved");
    expect(secret.evidence).toMatchObject({ outcome: "allow", risk: "low" });
    expect(secret.execution.state).toBe("succeeded");
    expect(JSON.parse(secret.argumentsPreview)).toEqual({ path: ".env" });
    expect(results(secretExecution)).toEqual(expect.arrayContaining([expect.objectContaining({ isError: false, text: "来自 MCP fixture 的笔记：.env" })]));
    expect(JSON.stringify(secretExecution)).not.toContain(canary);
    expect(readFileSync(envFile, "utf8")).toBe(`API_KEY=${canary}\n`);

    const unknownId = await send(fixture, dm.id, "用 MCP 工具读取不确定内容");
    const unknown = await approval(fixture, unknownId, "blocked");
    expect(unknown.evidence).toMatchObject({ risk: "unknown" });
    expect(unknown.execution.state).toBe("not-started");
    expect((await approvals(fixture, unknownId)).some((entry) => entry.status === "pending-human")).toBe(false);
    const unknownExecution = await finished(fixture, unknownId);
    expect(results(unknownExecution).some((step) => step.text?.includes("来自 MCP fixture"))).toBe(false);
    expect(results(unknownExecution).some((step) => step.isError)).toBe(true);
  }, 90_000);

  it("reports a missing MCP executable with its cause and preserves both tool results and unknown-tool errors", async () => {
    const fixture = await open();
    const missingCommand = join(fixture.root, "does-not-exist.mjs");
    const broken = await call<McpServerDTO>(fixture, "/api/mcp", "POST", { name: "broken", transport: "stdio", command: missingCommand, enabled: true });
    const failed = await call<{ ok: boolean; message: string }>(fixture, `/api/mcp/${broken.id}/connect`, "POST", {});
    expect(failed.ok).toBe(false);
    expect(failed.message).toMatch(/ENOENT|no such file|not found/i);
    const record = (await call<{ servers: McpServerDTO[] }>(fixture, "/api/mcp")).servers.find((entry) => entry.id === broken.id)!;
    expect(record.connection.state).toBe("error");
    expect(record.connection.message).toMatch(/ENOENT|no such file|not found/i);
    const missing = await call<{ ok: boolean }>(fixture, "/api/mcp/no-such-server/connect", "POST", {});
    expect(missing.ok).toBe(false);

    // The independent stdio boundary checks protocol results, not HTTP success.
    // Emit's approved shout work and trust-change behavior are also covered by the API suite.
    const client = new McpClient({ name: "emit-e2e", version: "1.0.0", requestTimeoutMs: 10_000 });
    const transport = new StdioTransport({ command: process.execPath, args: [mcpScript], cwd: fixture.workRoot, inheritEnv: false, env: { HOME: fixture.root, TMPDIR: fixture.root } });
    try {
      await client.connect(transport);
      expect((await client.listTools()).map((tool) => tool.name).sort()).toEqual(["echo_notes", "shout"]);
      expect(await client.callTool("echo_notes", { path: "私有笔记.txt" })).toMatchObject({ isError: false, content: [{ type: "text", text: "来自 MCP fixture 的笔记：私有笔记.txt" }] });
      expect(await client.callTool("shout", { message: "Chinese marker 中文 / smoke" })).toMatchObject({ isError: false, content: [{ type: "text", text: "CHINESE MARKER 中文 / SMOKE" }] });
      expect(await client.callTool("unknown", {})).toMatchObject({ isError: true, content: [{ type: "text", text: "未知工具 unknown" }] });
    } finally {
      try { await client.close(); } finally { await transport.close(); }
    }
  }, 90_000);
});
