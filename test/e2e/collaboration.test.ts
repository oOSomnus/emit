import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ApprovalDTO, BootstrapDTO, EmployeeDTO, MessageDTO, RoomDTO, WorkContextDTO, WorkDTO, WorkExecutionDTO } from "../../src/shared/contracts.ts";
import { createE2eFixture, type E2eFixture } from "../helpers/e2e-fixture.ts";
import { waitForFixture } from "../helpers/emit-fixture.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function call<T>(fixture: E2eFixture, path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fixture.request<T>(path, method, body);
  expect(response.status, `${method} ${path}: ${JSON.stringify(response.body)}`).toBeGreaterThanOrEqual(200);
  expect(response.status).toBeLessThan(300);
  return response.body;
}
async function open() {
  const fixture = await createE2eFixture();
  cleanups.push(() => fixture.close());
  return fixture;
}
async function employee(fixture: E2eFixture, name: string, instructions: string, allowedTools: string[]) {
  return call<EmployeeDTO>(fixture, "/api/employees", "POST", {
    name, role: "协作", instructions, generateAddress: true,
    executionModel: { model: { providerId: "fake", modelId: "fake-chat" }, effort: "off" },
    toolPolicy: { allowedTools, trustedReadOnlyTools: [] },
  });
}
async function dm(fixture: E2eFixture, worker: EmployeeDTO, directory: string) {
  const context = await call<WorkContextDTO>(fixture, "/api/work-contexts", "POST", {
    name: worker.name, directories: { paths: [directory], defaultPath: directory },
  });
  return call<RoomDTO>(fixture, "/api/rooms", "POST", { kind: "dm", name: worker.name, employeeId: worker.id, workContextId: context.id });
}
async function start(fixture: E2eFixture, room: RoomDTO, body: string) {
  const receipt = await call<{ workIds: string[] }>(fixture, `/api/rooms/${room.id}/messages`, "POST", { body });
  expect(receipt.workIds).toHaveLength(1);
  return receipt.workIds[0]!;
}
async function finish(fixture: E2eFixture, workId: string) {
  let work: WorkDTO | undefined;
  await waitForFixture(async () => {
    work = (await call<WorkDTO[]>(fixture, "/api/works")).find((item) => item.id === workId);
    return work !== undefined && ["succeeded", "failed", "stopped"].includes(work.status);
  }, `${workId}: collaboration terminal`);
  return work!;
}

describe("real-process collaboration authorization", () => {
  it("rejects unsupported execution effort before saving an employee", async () => {
    const fixture = await open();
    const before = await call<BootstrapDTO>(fixture, "/api/bootstrap");
    const response = await fixture.request<{ message: string }>("/api/employees", "POST", {
      name: "坏强度员工", role: "测试",
      executionModel: { model: { providerId: "fake", modelId: "fake-chat" }, effort: "xhigh" },
    });
    expect(response.status).toBe(400);
    expect(response.body.message).toBeTruthy();
    expect((await call<BootstrapDTO>(fixture, "/api/bootstrap")).employees).toEqual(before.employees);
  });

  it("blocks an out-of-whitelist tool without approval and fails a vanished model without a fabricated answer", async () => {
    const fixture = await open();
    const directory = join(fixture.workRoot, "readonly");
    mkdirSync(directory);
    const worker = await employee(fixture, "只读员工", "只读工作目录。", ["read_file"]);
    const room = await dm(fixture, worker, directory);
    const blockedId = await start(fixture, room, "请使用 run_shell 执行 ls");
    expect((await finish(fixture, blockedId)).status).toBe("succeeded");
    const execution = await call<WorkExecutionDTO>(fixture, `/api/works/${blockedId}/execution`);
    expect(execution.steps.some((step) => step.kind === "tool-result" && step.isError === true)).toBe(true);
    expect(execution.approvals).toEqual([]);
    const approvals = await call<{ approvals: ApprovalDTO[] }>(fixture, "/api/approvals");
    expect(approvals.approvals.filter((record) => record.workId === blockedId)).toEqual([]);
    const messages = await call<{ messages: MessageDTO[] }>(fixture, `/api/rooms/${room.id}/messages`);
    const blockedAnswers = messages.messages.filter((message) => message.author.type === "employee" && message.workId === blockedId);
    expect(blockedAnswers).toHaveLength(1);
    expect(blockedAnswers[0]?.body).toContain("被阻止");
    expect(existsSync(join(directory, "result.txt"))).toBe(false);

    await call(fixture, "/api/providers/custom", "PUT", { providers: [] });
    const vanishedId = await start(fixture, room, "模型还在吗");
    const vanished = await finish(fixture, vanishedId);
    expect(vanished.status).toBe("failed");
    expect(vanished.error).toBeTruthy();
    const after = await call<{ messages: MessageDTO[] }>(fixture, `/api/rooms/${room.id}/messages`);
    expect(after.messages.filter((message) => message.author.type === "employee")).toEqual(messages.messages.filter((message) => message.author.type === "employee"));
    expect(after.messages.filter((message) => message.workId === vanishedId && message.author.type === "employee")).toEqual([]);
    expect((await call<WorkDTO[]>(fixture, "/api/works")).filter((work) => work.rootWorkId === vanishedId && ["queued", "running"].includes(work.status))).toEqual([]);
  });

  it.each([
    { label: "cross-employee wake budget", names: ["链甲", "链乙", "链丙", "链丁"], maxDepth: 3, maxCrossEmployeeWakes: 1, depths: [1], reason: "跨员工唤醒上限", cycle: false },
    { label: "delegation depth budget", names: ["链甲", "链乙", "链丙", "链丁"], maxDepth: 2, maxCrossEmployeeWakes: 12, depths: [1, 2], reason: "交办层数", cycle: false },
    { label: "ancestor cycle", names: ["环甲", "环乙"], maxDepth: 3, maxCrossEmployeeWakes: 12, depths: [1], reason: "会形成循环", cycle: true },
  ])("converges a real delegation chain at the $label without creating a refused hop", async (scenario) => {
    const fixture = await open();
    await call(fixture, "/api/app", "PATCH", { collaboration: {
      maxDepth: scenario.maxDepth, maxCrossEmployeeWakes: scenario.maxCrossEmployeeWakes, maxModelTurns: 40,
    } });
    const workers: EmployeeDTO[] = [];
    for (const [index, name] of scenario.names.entries()) {
      const target = scenario.names[index + 1] ?? (scenario.cycle ? scenario.names[0] : undefined);
      workers.push(await employee(fixture, name, target === undefined ? "结束任务。" : `把任务交办->${target}`, ["delegate_task", "read_file"]));
    }
    const rootWorker = workers[0]!;
    const room = await dm(fixture, rootWorker, fixture.workRoot);
    const rootId = await start(fixture, room, "开始");
    expect((await finish(fixture, rootId)).status).toBe("succeeded");
    let graph: WorkDTO[] = [];
    await waitForFixture(async () => {
      graph = (await call<WorkDTO[]>(fixture, "/api/works")).filter((work) => work.rootWorkId === rootId);
      return graph.every((work) => ["succeeded", "failed", "stopped"].includes(work.status));
    }, `${rootId}: delegation graph converges`);
    const children = graph.filter((work) => work.kind === "delegation");
    expect(children.map((work) => work.depth).sort((a, b) => a - b)).toEqual(scenario.depths);
    expect(children.every((work) => work.status === "succeeded")).toBe(true);
    expect(children.some((work) => work.answer?.includes(scenario.reason))).toBe(true);
    expect(new Set(children.map((work) => work.employeeId)).size).toBe(children.length);
    expect(children.every((work) => work.employeeId !== rootWorker.id)).toBe(true);
    const messages = await call<{ messages: MessageDTO[] }>(fixture, `/api/rooms/${room.id}/messages`);
    const answers = messages.messages.filter((message) => message.author.type === "employee" && message.workId === rootId);
    expect(answers).toHaveLength(1);
    expect(answers[0]?.body).toContain("链上已完成");
  });
});
