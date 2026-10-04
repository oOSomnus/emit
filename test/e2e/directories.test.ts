import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ApprovalDTO, EmployeeDTO, RoomDTO, WorkContextDTO, WorkDTO, WorkExecutionDTO } from "../../src/shared/contracts.ts";
import { createE2eFixture, type E2eFixture } from "../helpers/e2e-fixture.ts";
import { waitForFixture } from "../helpers/emit-fixture.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
type Scope = { context: WorkContextDTO; room: RoomDTO };
async function call<T>(fixture: E2eFixture, path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fixture.request<T>(path, method, body);
  expect(response.status, `${method} ${path}: ${JSON.stringify(response.body)}`).toBeGreaterThanOrEqual(200);
  expect(response.status).toBeLessThan(300);
  return response.body;
}
async function open() {
  const fixture = await createE2eFixture();
  cleanups.push(() => fixture.close());
  for (const name of ["A", "B", "C", "E"]) {
    mkdirSync(join(fixture.workRoot, name));
    writeFileSync(join(fixture.workRoot, name, "notes.txt"), `SMOKE-DIRECTORY-${name}\n`);
  }
  writeFileSync(join(fixture.outsideRoot, "outside-secret.txt"), "SMOKE-OUTSIDE-SECRET\n");
  symlinkSync(join(fixture.outsideRoot, "outside-secret.txt"), join(fixture.workRoot, "C", "escape.txt"));
  return fixture;
}
async function employee(fixture: E2eFixture, name: string, instructions = "", tools = ["read_file", "write_file", "run_shell", "delegate_task"]) {
  return call<EmployeeDTO>(fixture, "/api/employees", "POST", {
    name, role: "目录协作", instructions, generateAddress: true,
    executionModel: { model: { providerId: "fake", modelId: "fake-chat" }, effort: "off" },
    toolPolicy: { allowedTools: tools, trustedReadOnlyTools: [] },
  });
}
async function scope(fixture: E2eFixture, name: string, employeeIds: string[], paths: string[], defaultPath = paths[0] ?? "", kind: "channel" | "dm" = "channel"): Promise<Scope> {
  const context = await call<WorkContextDTO>(fixture, "/api/work-contexts", "POST", { name, directories: { paths, defaultPath } });
  const room = await call<RoomDTO>(fixture, "/api/rooms", "POST", {
    kind, name, workContextId: context.id,
    ...(kind === "dm" ? { employeeId: employeeIds[0] } : { memberIds: employeeIds }),
  });
  return { context, room };
}
async function start(fixture: E2eFixture, scoped: Scope, body: string, employeeId: string) {
  const receipt = await call<{ workIds: string[] }>(fixture, `/api/rooms/${scoped.room.id}/messages`, "POST", {
    body, ...(scoped.room.kind === "dm" ? {} : { recipientIds: [employeeId] }),
  });
  expect(receipt.workIds).toHaveLength(1);
  return receipt.workIds[0]!;
}
async function finish(fixture: E2eFixture, workId: string) {
  let work: WorkDTO | undefined;
  await waitForFixture(async () => {
    work = (await call<WorkDTO[]>(fixture, "/api/works")).find((item) => item.id === workId);
    return work !== undefined && ["succeeded", "failed", "stopped"].includes(work.status);
  }, `${workId}: terminal directory work`);
  return work!;
}
async function approval(fixture: E2eFixture, workId: string, status: ApprovalDTO["status"]) {
  let record: ApprovalDTO | undefined;
  await waitForFixture(async () => {
    record = (await call<{ approvals: ApprovalDTO[] }>(fixture, "/api/approvals")).approvals.find((item) => item.workId === workId && item.status === status);
    return record !== undefined;
  }, `${workId}: ${status}`);
  return record!;
}
function assertScope(record: ApprovalDTO, scoped: Scope, cwd: string, targetPaths: string[] = []) {
  expect(record).toMatchObject({ directoryWorkContextId: scoped.context.id, directoryVersion: scoped.context.directories.version,
    directoryRoomId: scoped.room.id, directoryPaths: scoped.context.directories.paths, cwd, targetPaths });
}
async function run(fixture: E2eFixture, scoped: Scope, body: string, employeeId: string, cwd: string, targets: string[] = []) {
  const workId = await start(fixture, scoped, body, employeeId);
  expect((await finish(fixture, workId)).status).toBe("succeeded");
  const record = await approval(fixture, workId, "approved");
  expect(record.execution.state).toBe("succeeded");
  assertScope(record, scoped, cwd, targets);
  return record;
}
async function proof(fixture: E2eFixture, scoped: Scope, employeeId: string, cwd: string, explicitB = false) {
  await run(fixture, scoped, `请使用 run_shell 执行 cwd-proof.txt 实际目录证明${explicitB ? "，显式切换到 B" : ""}`, employeeId, cwd);
  expect(readFileSync(join(cwd, "cwd-proof.txt"), "utf8")).toBe(`${cwd}\n`);
}

describe("real-process work-owned directory boundaries", () => {
  it("executes shared A/B defaults and explicit B while keeping the same employee's private C separate", async () => {
    const fixture = await open();
    const aliceId = fixture.workspace.employeeIds[0]!;
    const coworker = await employee(fixture, "频道同事");
    const a = join(fixture.workRoot, "A");
    const b = join(fixture.workRoot, "B");
    const c = join(fixture.workRoot, "C");
    execFileSync("git", ["init", "--quiet", a]);
    execFileSync("git", ["-C", a, "-c", "user.name=Smoke Test", "-c", "user.email=smoke@example.test", "commit", "--quiet", "--allow-empty", "-m", "smoke fixture"]);
    const shared = await scope(fixture, "共享目录测试", [aliceId, coworker.id], [a, b], a);
    const privateScope = await scope(fixture, "频道同事私信", [coworker.id], [fixture.workRoot], fixture.workRoot, "dm");
    privateScope.context = await call<WorkContextDTO>(fixture, `/api/work-contexts/${privateScope.context.id}`, "PATCH", {
      expectedVersion: privateScope.context.version, directories: { paths: [c], defaultPath: c },
    });
    expect(privateScope.context.directories).toMatchObject({ version: 2, defaultPath: c, paths: [c] });
    for (const command of ["pwd", "cat notes.txt", "ls", "ls -la", "git status --short", "git diff --stat", "git log --oneline"]) {
      const record = await run(fixture, shared, `请使用 run_shell 执行 ${command}`, aliceId, a);
      expect(record.evidence).toMatchObject({ outcome: "allow", risk: "low", readOnly: true });
    }
    await proof(fixture, shared, aliceId, a);
    const written = await run(fixture, shared, "请写一个 channel-marker.txt", aliceId, a, [join(a, "channel-marker.txt")]);
    expect(written.evidence).toMatchObject({ outcome: "allow", risk: "medium" });
    expect(readFileSync(join(a, "channel-marker.txt"), "utf8")).toBe("SMOKE-WRITTEN:channel-marker.txt\n");
    expect(existsSync(join(b, "channel-marker.txt"))).toBe(false);
    await run(fixture, shared, "请使用 run_shell 显式切换到 B 执行 pwd", aliceId, b);
    await proof(fixture, shared, aliceId, b, true);
    await run(fixture, shared, "请使用 run_shell 执行 pwd", coworker.id, a);
    await proof(fixture, privateScope, coworker.id, c);
    const readId = await start(fixture, privateScope, "请用 read_file 读取已读目录标记", coworker.id);
    expect((await finish(fixture, readId)).status).toBe("succeeded");
    const execution = await call<WorkExecutionDTO>(fixture, `/api/works/${readId}/execution`);
    expect(execution.steps.some((step) => step.kind === "tool-result" && step.text?.includes("SMOKE-DIRECTORY-C"))).toBe(true);
    expect(execution.approvals).toEqual([]);
    await run(fixture, privateScope, "请写一个 dm-marker.txt", coworker.id, c, [join(c, "dm-marker.txt")]);
    expect(readFileSync(join(c, "dm-marker.txt"), "utf8")).toBe("SMOKE-WRITTEN:dm-marker.txt\n");
    expect(existsSync(join(a, "dm-marker.txt"))).toBe(false);
  });

  it("inherits the parent's A/B scope for delegation rather than the child employee's private C", async () => {
    const fixture = await open();
    const a = join(fixture.workRoot, "A");
    const b = join(fixture.workRoot, "B");
    const c = join(fixture.workRoot, "C");
    const child = await employee(fixture, "目录隔离子任务", "你是目录隔离子任务，请用 run_shell 执行 pwd。", ["run_shell"]);
    await scope(fixture, "目录子任务私信", [child.id], [c], c, "dm");
    const parent = await employee(fixture, "目录交办员工", "把任务交办->目录隔离子任务", ["delegate_task"]);
    const shared = await scope(fixture, "交办继承目录", [parent.id], [a, b], a);
    const parentId = await start(fixture, shared, "开始目录继承交办", parent.id);
    expect((await finish(fixture, parentId)).status).toBe("succeeded");
    const children = (await call<WorkDTO[]>(fixture, "/api/works")).filter((work) => work.parentWorkId === parentId && work.kind === "delegation");
    expect(children).toHaveLength(1);
    expect(await finish(fixture, children[0]!.id)).toMatchObject({ employeeId: child.id, status: "succeeded", workContextId: shared.context.id });
    const record = await approval(fixture, children[0]!.id, "approved");
    assertScope(record, shared, a);
    expect(record.directoryPaths).not.toContain(c);
    expect(readFileSync(join(a, "cwd-proof.txt"), "utf8")).toBe(`${a}\n`);
    expect(existsSync(join(c, "cwd-proof.txt"))).toBe(false);
  });

  it("blocks absolute, relative and symlink escapes and empty-root shell calls before approval", async () => {
    const fixture = await open();
    const employeeId = fixture.workspace.employeeIds[0]!;
    const c = join(fixture.workRoot, "C");
    const privateScope = await scope(fixture, "目录逃逸隔离", [employeeId], [c], c, "dm");
    for (const marker of ["绝对越权路径", "相对越权路径", "符号链接逃逸"]) {
      const workId = await start(fixture, privateScope, `请用 read_file 验证${marker}`, employeeId);
      expect((await finish(fixture, workId)).status).toBe("succeeded");
      const execution = await call<WorkExecutionDTO>(fixture, `/api/works/${workId}/execution`);
      expect(execution.approvals).toEqual([]);
      expect(execution.steps.some((step) => step.kind === "tool-result" && step.isError === true)).toBe(true);
      expect(JSON.stringify(execution)).not.toContain("SMOKE-OUTSIDE-SECRET");
    }
    expect(readFileSync(join(fixture.outsideRoot, "outside-secret.txt"), "utf8")).toBe("SMOKE-OUTSIDE-SECRET\n");
    const empty = await scope(fixture, "无目录会话", [employeeId], []);
    const emptyId = await start(fixture, empty, "请使用 run_shell 执行 pwd", employeeId);
    expect((await finish(fixture, emptyId)).status).toBe("succeeded");
    const execution = await call<WorkExecutionDTO>(fixture, `/api/works/${emptyId}/execution`);
    expect(execution.approvals).toEqual([]);
    const results = execution.steps.filter((step) => step.kind === "tool-result");
    expect(results.some((step) => step.isError === true)).toBe(true);
    expect(results.map((step) => step.text).join("\n")).not.toContain(process.cwd());
  });

  it("increments only changed directory versions and invalidates only the affected work's pending grant", async () => {
    const fixture = await open();
    const employeeId = fixture.workspace.employeeIds[0]!;
    const a = join(fixture.workRoot, "A");
    const b = join(fixture.workRoot, "B");
    const e = join(fixture.workRoot, "E");
    const changedScope = await scope(fixture, "版本变更目录", [employeeId], [a, b], a);
    const unrelated = await scope(fixture, "独立目录审批", [employeeId], [e]);
    const staleId = await start(fixture, changedScope, "请写一个 critical-settings.json", employeeId);
    const stale = await approval(fixture, staleId, "pending-human");
    const otherId = await start(fixture, unrelated, "请写一个 critical-settings.json", employeeId);
    const other = await approval(fixture, otherId, "pending-human");
    const updated = await call<WorkContextDTO>(fixture, `/api/work-contexts/${changedScope.context.id}`, "PATCH", {
      expectedVersion: changedScope.context.version, directories: { paths: [a, b, e], defaultPath: a },
    });
    expect(updated.directories.version).toBe(changedScope.context.directories.version + 1);
    expect((await approval(fixture, staleId, "invalidated")).execution.state).toBe("not-started");
    expect((await approval(fixture, otherId, "pending-human")).id).toBe(other.id);
    const conflict = await fixture.request(`/api/work-contexts/${updated.id}`, "PATCH", {
      expectedVersion: changedScope.context.version, directories: { paths: [a, b], defaultPath: a },
    });
    expect(conflict.status).toBe(409);
    const noOp = await call<WorkContextDTO>(fixture, `/api/work-contexts/${updated.id}`, "PATCH", {
      expectedVersion: updated.version, directories: { paths: [a, b, e], defaultPath: a },
    });
    expect(noOp.directories.version).toBe(updated.directories.version);
    expect((await call<WorkContextDTO>(fixture, `/api/work-contexts/${updated.id}`)).directories).toEqual(noOp.directories);
    expect((await fixture.request(`/api/approvals/${stale.id}/decision`, "POST", { decision: "approved" })).status).toBe(409);
    await call(fixture, `/api/works/${otherId}/stop`, "POST", {});
    expect((await approval(fixture, otherId, "cancelled")).execution.state).toBe("not-started");
    await finish(fixture, staleId);
    expect((await finish(fixture, otherId)).status).toBe("stopped");
    expect(existsSync(join(a, "critical-settings.json"))).toBe(false);
    expect(existsSync(join(e, "critical-settings.json"))).toBe(false);
  });
});
