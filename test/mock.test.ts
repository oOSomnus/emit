/**
 * `make mock` end-to-end behavior.
 *
 * Each test runs the real CLI subprocess and observes its public surface: the
 * startup log lines and the HTTP API of the started server. The source
 * workspace is a local fixture with a local provider; no request leaves the
 * machine. The child's TMPDIR is a per-test directory, so no assertion can
 * touch the user's real workspace.
 *
 * Waits are event-driven: readiness resolves on the child's stdout, and child
 * shutdown resolves on its `exit` event. The only timers are failure
 * deadlines that escalate to SIGKILL, because a hung subprocess has no event
 * that could ever arrive.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EmitRuntime } from "../src/server/runtime.ts";
import { createRoom, listRooms } from "../src/server/rooms.ts";
import { listEmployees, readApp, setupWorkspace, toAppDTO, updateAppConfig } from "../src/server/workspace.ts";
import type { AppConfigDTO, ChatSelectionDTO, EmployeeDTO, RoomDTO, WorkContextDTO } from "../src/shared/contracts.ts";
import {
  createWorkContextFixture,
  FAKE_KEY_ENV,
  mkdtempDataDir,
  openRuntime,
  providerConfig,
  setupFixtureWorkspace,
  startFixture,
  type Fixture,
} from "./helpers/emit-fixture.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const READY_TIMEOUT_MS = 20_000;
const TEST_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 10_000;

const sourceExecutionModel: ChatSelectionDTO = {
  model: { providerId: "fake", modelId: "fake-chat" },
  effort: "off",
};

type BootstrapPayload = {
  app: AppConfigDTO;
  employees: EmployeeDTO[];
  rooms: RoomDTO[];
  workContexts: WorkContextDTO[];
};

type MockInstance = {
  child: ChildProcess;
  stdout: string;
  stderr: string;
  url: string;
  rootDir: string;
  dataDir: string;
};

const running = new Set<MockInstance>();
const cleanups: Array<() => Promise<void> | void> = [];
let previousApiKey: string | undefined;

beforeEach(() => {
  previousApiKey = process.env[FAKE_KEY_ENV];
  process.env[FAKE_KEY_ENV] = "local-fixture-key";
});

afterEach(async () => {
  for (const instance of [...running]) await stopMock(instance).catch(() => undefined);
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch {
      // Cleanup is best effort and must not hide the assertion that failed.
    }
  }
  if (previousApiKey === undefined) delete process.env[FAKE_KEY_ENV];
  else process.env[FAKE_KEY_ENV] = previousApiKey;
});

/** One per-test child TMPDIR: only mock roots created by this test live there. */
function makeChildTmpDir(): string {
  const dir = mkdtempDataDir("emit-mock-tmp-");
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function mockRoots(tmpDir: string): string[] {
  return readdirSync(tmpDir).filter((name) => name.startsWith("emit-mock-"));
}

function spawnMock(args: readonly string[], tmpDir: string): MockInstance {
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/mock.ts", ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, TMPDIR: tmpDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const instance = { child, stdout: "", stderr: "", url: "", rootDir: "", dataDir: "" };
  child.stdout?.on("data", (chunk: Buffer) => {
    instance.stdout += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    instance.stderr += chunk.toString("utf8");
  });
  running.add(instance);
  return instance;
}

function exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function exitCodeOf(child: ChildProcess): number {
  if (child.exitCode !== null) return child.exitCode;
  if (child.signalCode === "SIGINT") return 130;
  if (child.signalCode === "SIGTERM") return 143;
  return 1;
}

function failureReport(instance: MockInstance): string {
  return (
    `stdout:\n${instance.stdout}\nstderr:\n${instance.stderr}\n` +
    `exitCode=${String(instance.child.exitCode)} signal=${String(instance.child.signalCode)}`
  );
}

/** Resolve once the wrapper's isolation paths and the server's ready URL exist. */
function waitForReady(instance: MockInstance): Promise<void> {
  const ready = Promise.withResolvers<void>();
  const check = (): boolean => {
    const url = /Emit 已启动：(http:\/\/\S+)/.exec(instance.stdout)?.[1];
    const rootDir = /^隔离目录：(.*)$/m.exec(instance.stdout)?.[1]?.trim();
    const dataDir = /^数据目录：(.*)$/m.exec(instance.stdout)?.[1]?.trim();
    if (url === undefined || rootDir === undefined || dataDir === undefined) return false;
    instance.url = url;
    instance.rootDir = rootDir;
    instance.dataDir = dataDir;
    return true;
  };
  const settle = (): void => {
    clearTimeout(deadline);
    instance.child.stdout?.off("data", onData);
    instance.child.off("exit", onExit);
  };
  const onData = (): void => {
    if (!check()) return;
    settle();
    ready.resolve();
  };
  const onExit = (): void => {
    settle();
    ready.reject(new Error(`mock 在就绪前退出\n${failureReport(instance)}`));
  };
  // A subprocess that never prints readiness produces no event; the deadline
  // is the only way to fail instead of hanging the suite.
  const deadline = setTimeout(() => {
    settle();
    ready.reject(new Error(`等待 mock 就绪超时\n${failureReport(instance)}`));
  }, READY_TIMEOUT_MS);
  if (check()) {
    settle();
    ready.resolve();
    return ready.promise;
  }
  instance.child.stdout?.on("data", onData);
  instance.child.on("exit", onExit);
  return ready.promise;
}

/** Await a process that is expected to exit on its own (help, argument errors). */
async function waitForExit(instance: MockInstance, timeoutMs = READY_TIMEOUT_MS): Promise<number> {
  if (exited(instance.child)) {
    running.delete(instance);
    return exitCodeOf(instance.child);
  }
  const done = Promise.withResolvers<number>();
  instance.child.once("exit", () => done.resolve(exitCodeOf(instance.child)));
  const escalation = setTimeout(() => instance.child.kill("SIGKILL"), timeoutMs);
  try {
    return await done.promise;
  } finally {
    clearTimeout(escalation);
    running.delete(instance);
  }
}

/** SIGTERM the wrapper; escalate to SIGKILL only for this test's own child. */
async function stopMock(instance: MockInstance, timeoutMs = STOP_TIMEOUT_MS): Promise<number> {
  if (exited(instance.child)) {
    running.delete(instance);
    return exitCodeOf(instance.child);
  }
  const done = Promise.withResolvers<number>();
  instance.child.once("exit", () => done.resolve(exitCodeOf(instance.child)));
  instance.child.kill("SIGTERM");
  const escalation = setTimeout(() => instance.child.kill("SIGKILL"), timeoutMs);
  try {
    return await done.promise;
  } finally {
    clearTimeout(escalation);
    running.delete(instance);
  }
}

async function getBootstrap(url: string): Promise<BootstrapPayload> {
  const response = await fetch(`${url}/api/bootstrap`);
  if (!response.ok) throw new Error(`GET /api/bootstrap -> ${response.status}`);
  return (await response.json()) as BootstrapPayload;
}

async function startSourceWorkspace(employeeName: string): Promise<{
  fixture: Fixture;
  runtime: EmitRuntime;
  dataDir: string;
}> {
  const fixture = await startFixture();
  cleanups.push(() => fixture.close());
  const dataDir = mkdtempDataDir("emit-mock-source-");
  cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const opened = await openRuntime(dataDir);
  cleanups.push(() => opened.runtime.close());
  await opened.runtime.storeCustomProviders([providerConfig(fixture.baseUrl)]);
  const employees = await setupFixtureWorkspace(opened.runtime, opened.resume, [employeeName], {
    workspaceName: "源工作区",
    userName: "源用户",
    executionModel: sourceExecutionModel,
  });
  const context = await createWorkContextFixture(opened.runtime, "源项目");
  await createRoom(opened.runtime, {
    kind: "channel",
    name: "源群聊",
    topic: "源",
    workContextId: context.id,
    memberIds: employees.map((employee) => employee.id),
  });
  return { fixture, runtime: opened.runtime, dataDir };
}

async function sourceSnapshot(runtime: EmitRuntime) {
  return {
    app: toAppDTO(await readApp(runtime)),
    employees: (await listEmployees(runtime)).map((employee) => ({
      name: employee.name,
      address: employee.address,
      executionModel: employee.executionModel,
    })),
    rooms: (await listRooms(runtime)).map((room) => ({
      kind: room.kind,
      name: room.name,
      workContextId: room.workContextId,
      memberIds: [...room.memberIds],
    })),
  };
}

describe("make mock", () => {
  it(
    "seeds an isolated workspace from the committed source configuration without model calls",
    async () => {
      const source = await startSourceWorkspace("源员工");
      const credentialsPath = join(source.dataDir, "credentials.json");
      const credentialsBefore = readFileSync(credentialsPath, "utf8");
      // A recent commit lands in the WAL: the snapshot must still see it.
      await updateAppConfig(source.runtime, {
        collaboration: { maxDepth: 7, maxCrossEmployeeWakes: 5, maxModelTurns: 23 },
      });
      const sourceBefore = await sourceSnapshot(source.runtime);
      const requestsBefore = source.fixture.requests.length;

      const instance = spawnMock(["--source-data-dir", source.dataDir, "--port", "0"], makeChildTmpDir());
      await waitForReady(instance);

      const bootstrap = await getBootstrap(instance.url);
      expect(bootstrap.app.workspace.name).toBe("Emit Mock");
      expect(bootstrap.app.user.name).toBe("源用户");
      expect(bootstrap.app.onboarded).toBe(true);
      expect(bootstrap.app.defaultExecutionModel).toEqual(sourceExecutionModel);
      expect(bootstrap.app.approval?.kind).toBe("llm");
      expect(bootstrap.app.approval?.model).toEqual({ providerId: "fake", modelId: "fake-reviewer" });
      expect(bootstrap.app.collaboration).toEqual({ maxDepth: 7, maxCrossEmployeeWakes: 5, maxModelTurns: 23 });

      const byId = new Map(bootstrap.employees.map((employee) => [employee.id, employee.name]));
      expect(bootstrap.employees.map((employee) => employee.name).sort()).toEqual(["Alice", "Bob", "Carol"]);
      expect(bootstrap.employees.map((employee) => employee.name)).not.toContain("源员工");
      expect(bootstrap.employees.every((employee) => employee.executionModel.model.modelId === "fake-chat")).toBe(true);

      const channels = bootstrap.rooms.filter((room) => room.kind === "channel");
      expect(channels.map((room) => room.name).sort()).toEqual(["团队大厅", "研发讨论"]);
      const lobby = channels.find((room) => room.name === "团队大厅");
      const lab = channels.find((room) => room.name === "研发讨论");
      expect(lobby?.memberIds.map((id) => byId.get(id))).toEqual(["Alice", "Bob", "Carol"]);
      expect(lab?.memberIds.map((id) => byId.get(id))).toEqual(["Bob", "Carol"]);
      expect(bootstrap.rooms.some((room) => room.name === "源群聊")).toBe(false);

      expect(bootstrap.workContexts.map((context) => context.name)).toEqual(["Mock 项目"]);
      const workDir = join(instance.rootDir, "work");
      expect(bootstrap.workContexts[0]?.directories.paths).toEqual([workDir]);
      expect(bootstrap.workContexts[0]?.directories.defaultPath).toBe(workDir);
      expect(existsSync(workDir)).toBe(true);
      expect(existsSync(instance.dataDir)).toBe(true);
      expect(instance.dataDir.startsWith(instance.rootDir)).toBe(true);

      // Initialization and bootstrap are local: no model request reached the provider.
      expect(source.fixture.requests.length).toBe(requestsBefore);

      // The source workspace is untouched by the whole run.
      expect(await sourceSnapshot(source.runtime)).toEqual(sourceBefore);
      expect(readFileSync(credentialsPath, "utf8")).toBe(credentialsBefore);

      expect(await stopMock(instance)).toBe(0);
      expect(existsSync(instance.rootDir)).toBe(false);
      expect(existsSync(source.dataDir)).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "gives each instance a private data directory and removes only its own on exit",
    async () => {
      const source = await startSourceWorkspace("源员工");
      const sourceBefore = await sourceSnapshot(source.runtime);
      const tmpDir = makeChildTmpDir();

      const first = spawnMock(["--source-data-dir", source.dataDir, "--port", "0"], tmpDir);
      await waitForReady(first);
      const created = await fetch(`${first.url}/api/employees`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Extra", role: "临时", executionModel: sourceExecutionModel, generateAddress: false }),
      });
      expect(created.ok).toBe(true);
      const firstBootstrap = await getBootstrap(first.url);
      expect(firstBootstrap.employees.map((employee) => employee.name)).toContain("Extra");

      const second = spawnMock(["--source-data-dir", source.dataDir, "--port", "0"], tmpDir);
      await waitForReady(second);
      expect(second.dataDir).not.toBe(first.dataDir);
      const secondBootstrap = await getBootstrap(second.url);
      expect(secondBootstrap.employees.map((employee) => employee.name).sort()).toEqual(["Alice", "Bob", "Carol"]);

      expect(await stopMock(first)).toBe(0);
      expect(existsSync(first.rootDir)).toBe(false);
      expect(existsSync(second.rootDir)).toBe(true);
      const secondAfterFirstExit = await getBootstrap(second.url);
      expect(secondAfterFirstExit.employees).toHaveLength(3);

      expect(await stopMock(second)).toBe(0);
      expect(existsSync(second.rootDir)).toBe(false);

      expect(await sourceSnapshot(source.runtime)).toEqual(sourceBefore);
      expect(existsSync(source.dataDir)).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "rejects bad sources and unknown options without leaving directories behind",
    async () => {
      const tmpDir = makeChildTmpDir();

      // `--help` explains itself and touches nothing.
      const help = spawnMock(["--help"], tmpDir);
      expect(await waitForExit(help)).toBe(0);
      expect(help.stdout).toContain("--source-data-dir");
      expect(mockRoots(tmpDir)).toEqual([]);

      // A source without a database fails before creating any directory.
      const missing = spawnMock(["--source-data-dir", join(tmpDir, "missing-source")], tmpDir);
      expect(await waitForExit(missing)).not.toBe(0);
      expect(missing.stderr).toContain(join(tmpDir, "missing-source"));
      expect(missing.stderr).toContain("emit.sqlite");
      expect(missing.stdout).not.toContain("Emit 已启动");
      expect(mockRoots(tmpDir)).toEqual([]);

      // An onboarded workspace without a default execution model names the gap.
      const fixture = await startFixture();
      cleanups.push(() => fixture.close());
      const sourceDir = mkdtempDataDir("emit-mock-nomodel-");
      cleanups.push(() => rmSync(sourceDir, { recursive: true, force: true }));
      const opened = await openRuntime(sourceDir);
      cleanups.push(() => opened.runtime.close());
      await opened.runtime.storeCustomProviders([providerConfig(fixture.baseUrl)]);
      await setupWorkspace(opened.runtime, {
        workspaceName: "无模型工作区",
        userName: "测试者",
        defaultExecutionModel: null,
        approval: {
          kind: "llm",
          model: { providerId: "fake", modelId: "fake-reviewer" },
          effort: "off",
          criteriaVersion: 3,
        },
      });
      const incomplete = spawnMock(["--source-data-dir", sourceDir], tmpDir);
      expect(await waitForExit(incomplete)).not.toBe(0);
      expect(incomplete.stderr).toContain(sourceDir);
      expect(incomplete.stderr).toContain("默认执行模型");
      expect(incomplete.stdout).not.toContain("Emit 已启动");
      expect(mockRoots(tmpDir)).toEqual([]);

      // Unknown and value-less options are refused rather than ignored.
      const unknown = spawnMock(["--source-data-dir", sourceDir, "--data-dir", join(tmpDir, "elsewhere")], tmpDir);
      expect(await waitForExit(unknown)).not.toBe(0);
      expect(unknown.stderr).toContain("未知选项: --data-dir");
      expect(existsSync(join(tmpDir, "elsewhere"))).toBe(false);

      const valueless = spawnMock(["--port"], tmpDir);
      expect(await waitForExit(valueless)).not.toBe(0);
      expect(valueless.stderr).toContain("缺少参数值: --port");
      expect(mockRoots(tmpDir)).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});
