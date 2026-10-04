import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type EmitProcessFixture = {
  readonly url: string;
  stop(): Promise<void>;
  kill(): Promise<void>;
  restart(): Promise<void>;
  output(): string;
  /** Resident set size of the owned server process when Linux exposes it. */
  rssBytes(): number | undefined;
};

export type StartEmitProcessOptions = {
  root: string;
  dataDir: string;
  webRoot?: string;
  imports?: readonly string[];
  env?: Readonly<Record<string, string>>;
  entrypoint?: string;
};

type RunningProcess = {
  child: ChildProcess;
  pid: number | undefined;
  closed: Promise<void>;
  output: string;
  url: string;
  stopPromise: Promise<void> | undefined;
};

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const LOOPBACK_PRELOAD = resolve(REPO_ROOT, "test/fixtures/loopback-only-fetch.mjs");
const STARTUP_TIMEOUT_MS = 30_000;
const RESTART_TIMEOUT_MS = 45_000;
const STOP_TIMEOUT_MS = 10_000;
const KILL_TIMEOUT_MS = 5_000;
const OUTPUT_LIMIT = 1_048_576;
const LOOPBACK_HOSTS: Record<string, true> = { localhost: true, "localhost.": true, "127.0.0.1": true, "::1": true };

/** Start a real source server in a private environment and own its process group. */
export async function startEmitProcess(options: StartEmitProcessOptions): Promise<EmitProcessFixture> {
  const root = resolve(options.root);
  const dataDir = resolve(root, options.dataDir);
  assertInsideRoot(root, dataDir, "dataDir");

  const homeDir = resolve(root, "home");
  const tempDir = resolve(root, "tmp");
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(tempDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  for (const key of ["HOME", "TMPDIR", "NODE_OPTIONS", "NODE_PATH"] as const) {
    if (options.env?.[key] !== undefined) {
      throw new Error(`startEmitProcess env must not override ${key}`);
    }
  }
  const sensitiveEnvValues = Object.entries(options.env ?? {})
    .filter(([key, value]) => /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)/i.test(key) && value.length > 0)
    .map(([, value]) => value);

  const baseEnv: NodeJS.ProcessEnv = {
    HOME: homeDir,
    TMPDIR: tempDir,
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    LANG: process.env.LANG ?? "C.UTF-8",
  };
  const entrypoint = resolve(REPO_ROOT, options.entrypoint ?? "src/server/main.ts");
  const args = ["--import", "tsx", "--import", pathToFileURL(LOOPBACK_PRELOAD).href];
  // Additional preload modules wrap the guard, so any URL rewrite must still pass through it.
  for (const specifier of options.imports ?? []) {
    args.push("--import", normalizeImportSpecifier(specifier));
  }
  args.push(entrypoint, "--data-dir", dataDir, "--host", "127.0.0.1", "--port", "0");
  if (options.webRoot !== undefined) args.push("--web-root", resolve(REPO_ROOT, options.webRoot));

  let processOutput = "";
  let current: RunningProcess | undefined;
  let lastUrl: string | undefined;
  let launchCount = 0;
  let lifecycle = Promise.resolve();

  const appendOutput = (instance: RunningProcess, chunk: string): void => {
    instance.output = boundedAppend(instance.output, chunk);
    processOutput = boundedAppend(processOutput, chunk);
  };

  const launch = async (startupTimeoutMs: number): Promise<RunningProcess> => {
    if (launchCount > 0) processOutput = boundedAppend(processOutput, "\n--- Emit process restart ---\n");
    launchCount += 1;
    const child = spawn(process.execPath, args, {
      cwd: REPO_ROOT,
      env: { ...baseEnv, ...options.env, HOME: homeDir, TMPDIR: tempDir },
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const closeWatcher = Promise.withResolvers<void>();
    const instance: RunningProcess = {
      child,
      pid: child.pid,
      closed: closeWatcher.promise,
      output: "",
      url: "",
      stopPromise: undefined,
    };
    child.once("close", () => closeWatcher.resolve());
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => appendOutput(instance, chunk));
    child.stderr?.on("data", (chunk: string) => appendOutput(instance, chunk));

    try {
      instance.url = await waitForReady(instance, startupTimeoutMs);
      return instance;
    } catch (error) {
      try {
        await stopInstance(instance);
      } catch (cleanupError) {
        throw new Error(
          `Emit process failed to start and cleanup failed: ${errorMessage(cleanupError)}\n${redactOutput(instance.output, sensitiveEnvValues)}`,
          { cause: error },
        );
      }
      throw new Error(
        `Emit process failed to start: ${errorMessage(error)}\n${redactOutput(instance.output, sensitiveEnvValues)}`,
        { cause: error },
      );
    }
  };

  current = await launch(STARTUP_TIMEOUT_MS);
  lastUrl = current.url;

  const serialize = <T>(action: () => Promise<T>): Promise<T> => {
    const result = lifecycle.then(action);
    lifecycle = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  return {
    get url(): string {
      const url = current?.url ?? lastUrl;
      if (url === undefined) throw new Error("Emit process has not reported a listening URL");
      return url;
    },
    stop: () =>
      serialize(async () => {
        if (current !== undefined) await stopInstance(current);
      }),
    kill: () =>
      serialize(async () => {
        if (current !== undefined) await killInstance(current);
      }),
    restart: () =>
      serialize(async () => {
        if (current !== undefined) await stopInstance(current);
        current = await launch(RESTART_TIMEOUT_MS);
        lastUrl = current.url;
      }),
    rssBytes: () => ownedProcessRssBytes(current?.pid),
    output: () => redactOutput(processOutput, sensitiveEnvValues),
  };
}

function normalizeImportSpecifier(specifier: string): string {
  if (specifier.startsWith("node:") || specifier.startsWith("file:")) return specifier;
  if (isAbsolute(specifier)) return pathToFileURL(specifier).href;
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    return pathToFileURL(resolve(REPO_ROOT, specifier)).href;
  }
  const rootRelative = resolve(REPO_ROOT, specifier);
  return existsSync(rootRelative) ? pathToFileURL(rootRelative).href : specifier;
}

function assertInsideRoot(root: string, candidate: string, label: string): void {
  const pathFromRoot = relative(root, candidate);
  if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
    throw new Error(`${label} must be inside the private process root`);
  }
}

function boundedAppend(current: string, chunk: string): string {
  const updated = current + chunk;
  return updated.length <= OUTPUT_LIMIT ? updated : updated.slice(-OUTPUT_LIMIT);
}
function redactOutput(output: string, secretValues: readonly string[]): string {
  let redacted = output;
  for (const secret of secretValues) redacted = redacted.replaceAll(secret, "[REDACTED]");
  return redacted;
}

async function waitForReady(instance: RunningProcess, timeoutMs: number): Promise<string> {
  const { child } = instance;
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  let settled = false;
  const timer = setTimeout(() => fail(new Error(`Timed out after ${timeoutMs}ms waiting for Emit startup`)), timeoutMs);
  timer.unref();

  const cleanup = (): void => {
    clearTimeout(timer);
    child.stdout?.off("data", scan);
    child.stderr?.off("data", scan);
    child.off("close", closed);
    child.off("error", errored);
  };
  const succeed = (url: string): void => {
    if (settled) return;
    settled = true;
    cleanup();
    resolve(url);
  };
  const fail = (error: Error): void => {
    if (settled) return;
    settled = true;
    cleanup();
    reject(error);
  };
  const scan = (): void => {
    const match = /Emit 已启动：([^\s]+)/.exec(instance.output);
    if (match?.[1] === undefined) return;
    try {
      succeed(validateReadyUrl(match[1]));
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  };
  const closed = (code: number | null, signal: NodeJS.Signals | null): void => {
    fail(new Error(`Emit exited before startup (code=${String(code)}, signal=${String(signal)})`));
  };
  const errored = (error: Error): void => fail(error);

  child.stdout?.on("data", scan);
  child.stderr?.on("data", scan);
  child.once("close", closed);
  child.once("error", errored);
  scan();
  return promise;
}

function validateReadyUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Emit startup line did not contain a valid URL");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (url.protocol !== "http:" || LOOPBACK_HOSTS[hostname] !== true || Number(url.port) < 1) {
    throw new Error("Emit startup URL must be an HTTP loopback address with an assigned port");
  }
  return url.origin;
}

async function stopInstance(instance: RunningProcess): Promise<void> {
  if (instance.stopPromise !== undefined) return instance.stopPromise;
  instance.stopPromise = (async () => {
    if (groupExists(instance)) {
      signalOwnedGroup(instance, "SIGTERM");
      if (!(await waitForGroupExit(instance, STOP_TIMEOUT_MS))) {
        signalOwnedGroup(instance, "SIGKILL");
        if (!(await waitForGroupExit(instance, KILL_TIMEOUT_MS))) {
          throw new Error(`Owned Emit process group ${String(instance.pid)} did not exit after SIGKILL`);
        }
      }
    }
    await waitForChildClose(instance, KILL_TIMEOUT_MS);
  })();
  return instance.stopPromise;
}

async function killInstance(instance: RunningProcess): Promise<void> {
  if (instance.stopPromise !== undefined) return instance.stopPromise;
  instance.stopPromise = (async () => {
    if (groupExists(instance)) signalOwnedGroup(instance, "SIGKILL");
    if (!(await waitForGroupExit(instance, KILL_TIMEOUT_MS))) {
      throw new Error(`Owned Emit process group ${String(instance.pid)} did not exit after SIGKILL`);
    }
    await waitForChildClose(instance, KILL_TIMEOUT_MS);
  })();
  return instance.stopPromise;
}

function signalOwnedGroup(instance: RunningProcess, signal: NodeJS.Signals): void {
  if (instance.pid === undefined) return;
  try {
    if (process.platform === "linux" || process.platform === "darwin") {
      process.kill(-instance.pid, signal);
    } else {
      instance.child.kill(signal);
    }
  } catch (error) {
    if (errorCode(error) !== "ESRCH") throw error;
  }
}

function groupExists(instance: RunningProcess): boolean {
  if (instance.pid === undefined) return false;
  if (process.platform !== "linux" && process.platform !== "darwin") {
    return instance.child.exitCode === null && instance.child.signalCode === null;
  }
  try {
    process.kill(-instance.pid, 0);
    return true;
  } catch (error) {
    if (errorCode(error) === "ESRCH") return false;
    if (errorCode(error) === "EPERM") return true;
    throw error;
  }
}

async function waitForGroupExit(instance: RunningProcess, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (groupExists(instance)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, Math.min(25, remaining));
    await promise;
  }
  return true;
}

async function waitForChildClose(instance: RunningProcess, timeoutMs: number): Promise<void> {
  const { promise, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(() => reject(new Error(`Emit process did not close within ${timeoutMs}ms`)), timeoutMs);
  timer.unref();
  try {
    await Promise.race([instance.closed, promise]);
  } finally {
    clearTimeout(timer);
  }
}


function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function ownedProcessRssBytes(pid: number | undefined): number | undefined {
  if (process.platform !== "linux" || pid === undefined) return undefined;
  try {
    const residentKilobytes = /^VmRSS:\s+(\d+)\s+kB$/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1];
    if (residentKilobytes === undefined) return undefined;
    const residentBytes = Number(residentKilobytes) * 1024;
    return Number.isSafeInteger(residentBytes) ? residentBytes : undefined;
  } catch {
    return undefined;
  }
}
