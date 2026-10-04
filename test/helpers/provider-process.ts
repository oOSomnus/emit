import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../..", import.meta.url));

export type ProviderProcessFixture = {
  readonly url: string;
  readonly baseUrl: string;
  output(): string;
  close(): Promise<void>;
};

/** One owned fake protocol process, random port and no inherited credentials. */
export async function startProviderProcess(root: string): Promise<ProviderProcessFixture> {
  const privateRoot = resolve(root);
  for (const part of ["provider-home", "provider-tmp", "work", "outside"]) mkdirSync(join(privateRoot, part), { recursive: true });
  const child = spawn(process.execPath, ["test/fixtures/fake-provider.mjs"], {
    cwd: repository,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8", HOME: join(privateRoot, "provider-home"),
      TMPDIR: join(privateRoot, "provider-tmp"), FAKE_WORK_ROOT: join(privateRoot, "work"), FAKE_PORT: "0" },
    detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const exited = Promise.withResolvers<void>();
  child.once("close", () => exited.resolve());
  const ready = Promise.withResolvers<string>();
  void ready.promise.catch(() => {});
  const append = (chunk: Buffer) => {
    output = (output + chunk.toString("utf8")).slice(-65_536);
    const match = /Fake provider ready: (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
    if (match?.[1] !== undefined) ready.resolve(match[1]);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  child.once("error", error => ready.reject(error));
  child.once("exit", code => ready.reject(new Error(`Fake provider exited (${code})\n${output}`)));
  let closing: Promise<void> | undefined;
  const signal = (value: NodeJS.Signals) => {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (process.platform === "win32") child.kill(value);
      else process.kill(-child.pid, value);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  };
  const close = () => closing ??= (async () => {
    signal("SIGTERM");
    const killTimer = setTimeout(() => signal("SIGKILL"), 5000);
    try { await exited.promise; } finally { clearTimeout(killTimer); }
  })();
  const startupTimer = setTimeout(() => ready.reject(new Error(`Fake provider startup timed out\n${output}`)), 10_000);
  try {
    const url = await ready.promise;
    return { url, baseUrl: `${url}/v1`, output: () => output, close };
  } catch (error) {
    await close();
    throw error;
  } finally { clearTimeout(startupTimer); }
}
