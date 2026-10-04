/**
 * `make mock`: rebuild a disposable test workspace from the real workspace's
 * committed configuration and start the real server on it.
 *
 * The real data directory is only ever read: a read-only SQLite connection
 * plus `backup()` produce a consistent snapshot (WAL included), and the
 * snapshot is opened just to read the committed app configuration. The source
 * runtime is never opened, so no task is resumed, no lock is taken, and no
 * credential is rotated. The generated workspace lives in a fresh private
 * directory under the system temp directory; the source keeps its lock, its
 * credentials, and its history.
 *
 * Seed data is created through the same domain functions the HTTP API uses
 * (`setupWorkspace`, `createEmployee`, `createWorkContext`, `createRoom`), so
 * address allocation, membership validation, and directory canonicalization
 * behave exactly like a hand-built workspace. No model call is made while
 * seeding.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { readCredentials, writeCredentials, type CredentialsFile } from "../src/server/credentials.ts";
import type { EmployeeRecord } from "../src/server/documents.ts";
import { registerEmbeddedPiModules } from "../src/server/pi-modules.ts";
import { createRoom } from "../src/server/rooms.ts";
import { EmitRuntime } from "../src/server/runtime.ts";
import { createWorkContext } from "../src/server/work-contexts.ts";
import { createEmployee, readApp, setupWorkspace, toAppDTO, updateAppConfig } from "../src/server/workspace.ts";
import type { AppConfigDTO, ApprovalEvaluatorConfigDTO, ChatSelectionDTO } from "../src/shared/contracts.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const MOCK_EMPLOYEES = [
  { name: "Alice", role: "产品经理", instructions: "负责需求澄清与验收标准。" },
  { name: "Bob", role: "开发工程师", instructions: "负责实现方案与代码开发。" },
  { name: "Carol", role: "测试工程师", instructions: "负责测试设计与问题复现。" },
] as const;

const HELP = [
  "emit mock · 用真实模型凭据启动隔离测试工作区",
  "",
  "用法: node --import tsx scripts/mock.ts [选项]",
  "  --source-data-dir <目录>  读取模型与凭据的真实数据目录（默认 $EMIT_DATA_DIR 或 ~/.emit）",
  "  --host <地址>             监听地址（默认 $EMIT_HOST 或 127.0.0.1）",
  "  --port <端口>             监听端口（默认 $EMIT_PORT 或 0，自动分配）",
  "  --help, -h                显示本说明；不创建目录、不读取源工作区",
  "",
  "每次运行都新建私有临时工作区，启动前输出其路径，退出时删除。",
  "发送消息会调用真实模型并可能产生费用。",
  "",
].join("\n");

type CliOptions = { sourceDataDir: string; host: string; port: number };
type MockWorkspace = { rootDir: string; dataDir: string; workDir: string };
type SourceSelection = {
  app: AppConfigDTO;
  executionModel: ChatSelectionDTO;
  approval: ApprovalEvaluatorConfigDTO;
};
type SourceProviderIds = { executionProviderId: string; approvalProviderId: string };

/** Initialization was stopped by a signal; `signalName` picks the exit code. */
class CancelledError extends Error {
  constructor(readonly signalName: "SIGINT" | "SIGTERM") {
    super(`已取消（收到 ${signalName}）`);
    this.name = "CancelledError";
  }
}

function fail(message: string): never {
  // Usage errors must reach the terminal even though exit does not wait for
  // pipe writes; this one is small and written synchronously.
  writeSync(2, `${message}\n`);
  process.exit(1);
}

/**
 * Exit without truncating buffered stdout/stderr.
 *
 * `process.exit` does not wait for pipe writes, so the cancellation and
 * failure messages would be lost when the output is piped. Empty writes are
 * queued behind the real ones; their callbacks fire once those have been
 * handled.
 */
function exitAfterFlush(code: number): void {
  let remaining = 2;
  const finish = (): void => {
    remaining -= 1;
    if (remaining <= 0) process.exit(code);
  };
  // A destroyed stream may never call back; the unref'd timer cannot keep the
  // loop alive by itself.
  const guard = setTimeout(() => process.exit(code), 500);
  guard.unref();
  process.stdout.write("", finish);
  process.stderr.write("", finish);
}

function parseArgs(argv: readonly string[]): CliOptions | "help" {
  let sourceDataDir = process.env.EMIT_DATA_DIR ?? join(homedir(), ".emit");
  let host = process.env.EMIT_HOST ?? "127.0.0.1";
  let port = Number(process.env.EMIT_PORT ?? 0);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") return "help";
    if (arg !== "--source-data-dir" && arg !== "--host" && arg !== "--port") fail(`未知选项: ${arg}`);
    const next = argv[index + 1];
    if (next === undefined) fail(`缺少参数值: ${arg}`);
    if (arg === "--source-data-dir") sourceDataDir = next;
    else if (arg === "--host") host = next;
    else port = Number(next);
    index += 1;
  }
  if (!Number.isFinite(port) || port < 0) port = 0;
  return { sourceDataDir: resolve(sourceDataDir), host, port };
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw new CancelledError(signal.reason === "SIGTERM" ? "SIGTERM" : "SIGINT");
}

/**
 * Copy the committed database through SQLite's backup API.
 *
 * A file copy would silently lose records that still live in the WAL; the
 * backup API reads through the same transaction view a normal client sees.
 * The source connection is always closed here.
 */
async function snapshotDatabase(sourcePath: string, targetPath: string, signal: AbortSignal): Promise<void> {
  let source: DatabaseSync;
  try {
    source = new DatabaseSync(sourcePath, { readOnly: true });
  } catch (error) {
    throw new Error(
      `无法以只读方式打开源数据库 ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    throwIfAborted(signal);
    await backup(source, targetPath);
    throwIfAborted(signal);
  } finally {
    source.close();
  }
}

/** The source app configuration is required whole; refuse to guess missing parts. */
function requireSourceApp(app: AppConfigDTO, sourceDataDir: string): SourceSelection {
  if (!app.onboarded) {
    throw new Error(
      `源数据目录 ${sourceDataDir} 尚未完成初始化（未 onboarding）：请先在该工作区完成设置（例如 make dev）后重试。`,
    );
  }
  if (app.defaultExecutionModel === null) {
    throw new Error(`源数据目录 ${sourceDataDir} 缺少默认执行模型：请在真实工作区设置后重试。`);
  }
  if (app.approval === null) {
    throw new Error(`源数据目录 ${sourceDataDir} 缺少审批模型：请在真实工作区设置后重试。`);
  }
  return { app, executionModel: app.defaultExecutionModel, approval: app.approval };
}

function providerIdsOf(source: SourceSelection): SourceProviderIds {
  return {
    executionProviderId: source.executionModel.model.providerId,
    approvalProviderId: source.approval.model.providerId,
  };
}

/**
 * Refuse to copy saved OAuth logins: a refresh token is single-use, so the
 * copy could invalidate the real session. API keys are copied as-is.
 */
function assertCopyableCredentials(
  credentials: CredentialsFile,
  source: SourceSelection,
  sourceDataDir: string,
): void {
  for (const providerId of new Set(Object.values(providerIdsOf(source)))) {
    if (credentials.auth[providerId]?.type === "oauth") {
      throw new Error(
        `源数据目录 ${sourceDataDir} 的 provider ${providerId} 使用保存的 OAuth 凭据；` +
          "mock 工作区不复制 OAuth 凭据（复制 refresh token 可能使真实登录失效）。" +
          "请在真实工作区改用已配置 API key 的 provider，或在环境中导出该 provider 的凭据后重试。",
      );
    }
  }
}

function stripOAuthCredentials(credentials: CredentialsFile): CredentialsFile {
  const auth: CredentialsFile["auth"] = {};
  for (const [providerId, credential] of Object.entries(credentials.auth)) {
    if (credential?.type !== "oauth") auth[providerId] = credential;
  }
  return { ...credentials, auth };
}

function employeeNamed(employees: ReadonlyMap<string, EmployeeRecord>, name: string): EmployeeRecord {
  const employee = employees.get(name);
  if (employee === undefined) throw new Error(`内部错误：员工 ${name} 未创建`);
  return employee;
}

/**
 * Create the demo workspace inside a freshly opened runtime.
 *
 * `setupWorkspace` is called with a null default model on purpose: it would
 * otherwise ask the model to propose the user's address, which is a real
 * request. `updateAppConfig` then restores the source model and collaboration
 * limits without another model call.
 */
async function seedMockWorkspace(
  runtime: EmitRuntime,
  workDir: string,
  source: SourceSelection,
  sourceDataDir: string,
): Promise<void> {
  const execution = {
    providerId: source.executionModel.model.providerId,
    modelId: source.executionModel.model.modelId,
    effort: source.executionModel.effort,
  };
  const selectionProblem = runtime.catalog.chatSelectionProblem(execution);
  if (selectionProblem !== undefined) {
    throw new Error(`源执行模型在新工作区不可用：${selectionProblem.text}（来自 ${sourceDataDir}）`);
  }
  const approval = {
    kind: source.approval.kind,
    providerId: source.approval.model.providerId,
    modelId: source.approval.model.modelId,
    effort: source.approval.kind === "llm" ? source.approval.effort : "off",
  };
  const approvalProblem = runtime.catalog.approvalProblem(approval);
  if (approvalProblem !== undefined) {
    throw new Error(`源审批配置在新工作区不可用：${approvalProblem.text}（来自 ${sourceDataDir}）`);
  }
  const statuses = await runtime.catalog.providerStatuses();
  for (const providerId of new Set([execution.providerId, approval.providerId])) {
    const status = statuses.find((candidate) => candidate.providerId === providerId);
    if (status === undefined || !status.configured) {
      throw new Error(
        `provider ${providerId} 在新工作区没有可用认证：请在真实工作区完成登录，` +
          `或导出该 provider 需要的环境变量后重试。（来自 ${sourceDataDir}）`,
      );
    }
  }

  await setupWorkspace(runtime, {
    workspaceName: "Emit Mock",
    userName: source.app.user.name.length > 0 ? source.app.user.name : "Tester",
    defaultExecutionModel: null,
    approval: source.approval,
  });
  await updateAppConfig(runtime, {
    defaultExecutionModel: source.executionModel,
    collaboration: source.app.collaboration,
  });

  const employees = new Map<string, EmployeeRecord>();
  for (const draft of MOCK_EMPLOYEES) {
    employees.set(
      draft.name,
      await createEmployee(runtime, {
        name: draft.name,
        role: draft.role,
        instructions: draft.instructions,
        executionModel: source.executionModel,
        generateAddress: false,
      }),
    );
  }

  const workContext = await createWorkContext(runtime, {
    name: "Mock 项目",
    goal: "用于人工验证员工与群聊协作",
    directories: { paths: [workDir], defaultPath: workDir },
  });
  const alice = employeeNamed(employees, "Alice");
  const bob = employeeNamed(employees, "Bob");
  const carol = employeeNamed(employees, "Carol");
  await createRoom(runtime, {
    kind: "channel",
    name: "团队大厅",
    topic: "团队协作测试",
    workContextId: workContext.id,
    memberIds: [alice.id, bob.id, carol.id],
  });
  await createRoom(runtime, {
    kind: "channel",
    name: "研发讨论",
    topic: "研发与测试协作",
    workContextId: workContext.id,
    memberIds: [bob.id, carol.id],
  });
}

/**
 * Read the source configuration, then build the isolated workspace.
 *
 * On any failure — including cancellation — the private root is removed and
 * the error propagates; a half-initialized workspace is never returned.
 */
async function prepareMockWorkspace(sourceInput: string, signal: AbortSignal): Promise<MockWorkspace> {
  const sourceDataDir = resolve(sourceInput);
  const sourceDbPath = join(sourceDataDir, "emit.sqlite");
  if (!existsSync(sourceDbPath)) {
    throw new Error(
      `源数据目录 ${sourceDataDir} 中没有 emit.sqlite：请先在该工作区完成初始化（例如 make dev）后重试。`,
    );
  }

  const rootDir = mkdtempSync(join(tmpdir(), "emit-mock-"));
  const configDir = join(rootDir, "config");
  const dataDir = join(rootDir, "data");
  const workDir = join(rootDir, "work");
  try {
    chmodSync(rootDir, 0o700);
    mkdirSync(configDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(workDir, { recursive: true });
    throwIfAborted(signal);

    await snapshotDatabase(sourceDbPath, join(configDir, "emit.sqlite"), signal);
    throwIfAborted(signal);

    await registerEmbeddedPiModules();
    let sourceApp: AppConfigDTO;
    const snapshotRuntime = await EmitRuntime.open({ dataDir: configDir });
    try {
      sourceApp = toAppDTO(await readApp(snapshotRuntime));
    } finally {
      await snapshotRuntime.close();
    }
    // The snapshot exists only to be read; its history must not reach the
    // workspace the app is about to resume.
    rmSync(configDir, { recursive: true, force: true });
    throwIfAborted(signal);

    const source = requireSourceApp(sourceApp, sourceDataDir);
    const credentials = readCredentials(sourceDataDir);
    assertCopyableCredentials(credentials, source, sourceDataDir);
    writeCredentials(dataDir, stripOAuthCredentials(credentials));
    throwIfAborted(signal);

    const runtime = await EmitRuntime.open({ dataDir });
    try {
      await seedMockWorkspace(runtime, workDir, source, sourceDataDir);
    } finally {
      await runtime.close();
    }
    return { rootDir, dataDir, workDir };
  } catch (error) {
    rmSync(rootDir, { recursive: true, force: true });
    throw error;
  }
}

function printReady(workspace: MockWorkspace, options: CliOptions): void {
  process.stdout.write(
    [
      `源数据目录：${options.sourceDataDir}`,
      `隔离目录：${workspace.rootDir}`,
      `数据目录：${workspace.dataDir}`,
      `工作目录：${workspace.workDir}`,
      "员工：Alice（产品经理）、Bob（开发工程师）、Carol（测试工程师）",
      "群聊：团队大厅（Alice/Bob/Carol）、研发讨论（Bob/Carol）",
      "提示：发送消息将调用真实模型并可能产生费用；按 Ctrl-C 退出并清理本次临时目录。",
      "",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options === "help") {
    process.stdout.write(HELP);
    return;
  }

  const abort = new AbortController();
  let child: ChildProcess | undefined;
  let shuttingDown = false;
  const handleSignal = (signalName: "SIGINT" | "SIGTERM"): void => {
    // Cleanup runs once: either the initializer aborts, or the running service
    // is asked to shut down and the exit path below cleans up.
    if (shuttingDown) return;
    shuttingDown = true;
    if (child !== undefined) {
      child.kill(signalName);
      return;
    }
    abort.abort(signalName);
  };
  process.on("SIGINT", () => handleSignal("SIGINT"));
  process.on("SIGTERM", () => handleSignal("SIGTERM"));

  let workspace: MockWorkspace;
  try {
    workspace = await prepareMockWorkspace(options.sourceDataDir, abort.signal);
  } catch (error) {
    if (error instanceof CancelledError) {
      process.stderr.write(`${error.message}；本次临时目录已清理。\n`);
      exitAfterFlush(error.signalName === "SIGTERM" ? 143 : 130);
      return;
    }
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    exitAfterFlush(1);
    return;
  }
  if (shuttingDown) {
    // A signal raced in after initialization finished but before the service
    // started; never spawn, just clean up.
    rmSync(workspace.rootDir, { recursive: true, force: true });
    process.stderr.write("启动前收到退出信号；本次临时目录已清理。\n");
    exitAfterFlush(2);
    return;
  }

  printReady(workspace, options);
  child = spawn(
    process.execPath,
    ["--import", "tsx", "src/server/main.ts", "--data-dir", workspace.dataDir, "--host", options.host, "--port", String(options.port)],
    { cwd: REPO_ROOT, stdio: "inherit", env: process.env },
  );

  const appExit = Promise.withResolvers<number>();
  child.once("error", appExit.reject);
  child.once("exit", (code, signal) => {
    if (signal === "SIGINT") appExit.resolve(130);
    else if (signal === "SIGTERM") appExit.resolve(143);
    else appExit.resolve(code ?? 1);
  });
  const exitCode = await appExit.promise.catch((error: unknown) => {
    process.stderr.write(`无法启动应用：${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  });

  // The service has exited (or never started); it no longer holds the
  // database, so the private root can go.
  rmSync(workspace.rootDir, { recursive: true, force: true });
  exitAfterFlush(exitCode);
}

void main().catch((error: unknown) => {
  process.stderr.write(`mock 启动失败: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  exitAfterFlush(1);
});
