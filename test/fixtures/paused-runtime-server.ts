import { resolve } from "node:path";
import { startHttpRuntime } from "../helpers/emit-fixture.ts";
import { installAllExtensions, reconcileWorks } from "../../src/server/work.ts";
import { invalidateStaleGrants } from "../../src/server/approval/state.ts";
import { readApp } from "../../src/server/workspace.ts";
import { registerEmbeddedPiModules } from "../../src/server/pi-modules.ts";

// Only admission is paused: the real API and durable scheduler are unchanged.
// The crash test then opens this exact data directory using the production main.
async function main(): Promise<void> {
  const gateValue = process.env.EMIT_TEST_RESUME_GATE;
  if (gateValue === undefined) throw new Error("EMIT_TEST_RESUME_GATE is required");
  const gate = new URL(gateValue);
  if (gate.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(gate.hostname) || gate.username || gate.password) {
    throw new Error("EMIT_TEST_RESUME_GATE must be an uncredentialed loopback HTTP URL");
  }
  const allowed: unknown = JSON.parse(process.env.EMIT_TEST_ALLOWED_ORIGINS ?? "[]");
  if (!Array.isArray(allowed) || !allowed.includes(gate.origin)) throw new Error("Resume gate origin must be explicitly allowlisted");
  const args = process.argv.slice(2);
  let dataDir: string | undefined;
  let webRoot: string | undefined;
  for (let index = 0; index < args.length; index += 2) {
    const value = args[index + 1];
    if (value === undefined) throw new Error(`Missing value for ${String(args[index])}`);
    switch (args[index]) {
      case "--data-dir": dataDir = resolve(value); break;
      case "--web-root": webRoot = resolve(value); break;
      case "--host": if (value !== "127.0.0.1") throw new Error("Only loopback host is allowed"); break;
      case "--port": if (value !== "0") throw new Error("Only random port is allowed"); break;
      default: throw new Error(`Unknown option ${String(args[index])}`);
    }
  }
  if (dataDir === undefined) throw new Error("--data-dir is required");
  await registerEmbeddedPiModules();
  const fixture = await startHttpRuntime(dataDir, { webRoot });
  const controller = new AbortController();
  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    controller.abort();
    await fixture.close();
  };
  const onSignal = (): void => {
    void shutdown().then(
      () => process.exit(0),
      error => { console.error(error); process.exit(1); },
    );
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    await fixture.resume.mcp.connectEnabled();
    await installAllExtensions(fixture.resume);
    const app = await readApp(fixture.runtime);
    await invalidateStaleGrants(fixture.runtime, app.policyVersion);
    process.stdout.write(`Emit started: ${fixture.url}\nData directory: ${dataDir}\n`);
    const response = await fetch(gate, { signal: controller.signal });
    if (!response.ok) throw new Error(`Resume gate returned ${response.status}`);
    await response.arrayBuffer();
    if (!closing) {
      fixture.runtime.resume();
      await reconcileWorks(fixture.resume);
    }
  } catch (error) {
    if (closing && controller.signal.aborted) return;
    await shutdown();
    throw error;
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
