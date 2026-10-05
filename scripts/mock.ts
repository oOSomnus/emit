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
  { name: "Alice", role: "Product manager", instructions: "Clarifies requirements and acceptance criteria." },
  { name: "Bob", role: "Developer", instructions: "Designs implementation approaches and writes code." },
  { name: "Carol", role: "Test engineer", instructions: "Designs tests and reproduces issues." },
] as const;

const HELP = [
  "emit mock · start an isolated test workspace using real model credentials",
  "",
  "Usage: node --import tsx scripts/mock.ts [options]",
  "  --source-data-dir <dir>  Read model and credential settings from the real data directory (default $EMIT_DATA_DIR or ~/.emit)",
  "  --host <address>         Listen address (default $EMIT_HOST or 127.0.0.1)",
  "  --port <port>            Listen port (default $EMIT_PORT or 0, assigned automatically)",
  "  --help, -h               Show this help; does not create directories or read the source workspace",
  "",
  "Each run creates a new private temporary workspace, prints its path before startup, and removes it on exit.",
  "Sending messages calls real models and may incur costs.",
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
    super(`Cancelled (received ${signalName})`);
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
    if (arg !== "--source-data-dir" && arg !== "--host" && arg !== "--port") fail(`Unknown option: ${arg}`);
    const next = argv[index + 1];
    if (next === undefined) fail(`Missing value for option: ${arg}`);
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
      `Unable to open source database read-only ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`,
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
      `Source data directory ${sourceDataDir} has not been initialized (not onboarded): finish setup in that workspace (for example, run make dev) and try again.`,
    );
  }
  if (app.defaultExecutionModel === null) {
    throw new Error(`Source data directory ${sourceDataDir} is missing a default execution model: configure it in the real workspace and try again.`);
  }
  if (app.approval === null) {
    throw new Error(`Source data directory ${sourceDataDir} is missing an approval model: configure it in the real workspace and try again.`);
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
        `Provider ${providerId} in source data directory ${sourceDataDir} uses saved OAuth credentials; ` +
          "the mock workspace does not copy OAuth credentials (copying a refresh token could invalidate the real login). " +
          "In the real workspace, switch to a provider with a configured API key, or export the provider's credentials in the environment and try again.",
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
  if (employee === undefined) throw new Error(`Internal error: employee ${name} was not created`);
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
    throw new Error(`Source execution model is unavailable in the new workspace: ${selectionProblem.text} (from ${sourceDataDir})`);
  }
  const approval = {
    kind: source.approval.kind,
    providerId: source.approval.model.providerId,
    modelId: source.approval.model.modelId,
    effort: source.approval.kind === "llm" ? source.approval.effort : "off",
  };
  const approvalProblem = runtime.catalog.approvalProblem(approval);
  if (approvalProblem !== undefined) {
    throw new Error(`Source approval configuration is unavailable in the new workspace: ${approvalProblem.text} (from ${sourceDataDir})`);
  }
  const statuses = await runtime.catalog.providerStatuses();
  for (const providerId of new Set([execution.providerId, approval.providerId])) {
    const status = statuses.find((candidate) => candidate.providerId === providerId);
    if (status === undefined || !status.configured) {
      throw new Error(
        `Provider ${providerId} is not authenticated in the new workspace: sign in in the real workspace, ` +
          `or export the provider's required environment variables and try again. (from ${sourceDataDir})`,
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
    name: "Mock project",
    goal: "Validate collaboration among employees in group chat",
    directories: { paths: [workDir], defaultPath: workDir },
  });
  const alice = employeeNamed(employees, "Alice");
  const bob = employeeNamed(employees, "Bob");
  const carol = employeeNamed(employees, "Carol");
  await createRoom(runtime, {
    kind: "channel",
    name: "Team lobby",
    topic: "Team collaboration test",
    workContextId: workContext.id,
    memberIds: [alice.id, bob.id, carol.id],
  });
  await createRoom(runtime, {
    kind: "channel",
    name: "Development discussion",
    topic: "Development and testing collaboration",
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
      `Source data directory ${sourceDataDir} does not contain emit.sqlite: finish setup in that workspace (for example, run make dev) and try again.`,
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
      `Source data directory: ${options.sourceDataDir}`,
      `Isolated directory: ${workspace.rootDir}`,
      `Data directory: ${workspace.dataDir}`,
      `Work directory: ${workspace.workDir}`,
      "Employees: Alice (Product manager), Bob (Developer), Carol (Test engineer)",
      "Channels: Team lobby (Alice/Bob/Carol), Development discussion (Bob/Carol)",
      "Note: Sending messages calls real models and may incur costs; press Ctrl-C to exit and remove this temporary directory.",
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
      process.stderr.write(`${error.message}; the temporary directory for this run has been removed.\n`);
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
    process.stderr.write("Received an exit signal before startup; the temporary directory for this run has been removed.\n");
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
    process.stderr.write(`Unable to start app: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  });

  // The service has exited (or never started); it no longer holds the
  // database, so the private root can go.
  rmSync(workspace.rootDir, { recursive: true, force: true });
  exitAfterFlush(exitCode);
}

void main().catch((error: unknown) => {
  process.stderr.write(`mock startup failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  exitAfterFlush(1);
});
