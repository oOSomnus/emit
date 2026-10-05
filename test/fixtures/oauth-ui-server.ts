import { resolve } from "node:path";
import { startHttpRuntime, type HttpRuntimeFixture } from "../helpers/emit-fixture.ts";
import { createFixtureOAuthProvider } from "../helpers/oauth-fixture.ts";
import { registerEmbeddedPiModules } from "../../src/server/pi-modules.ts";
import { installAllExtensions, reconcileWorks } from "../../src/server/work.ts";
import { invalidateStaleGrants } from "../../src/server/approval/state.ts";
import { readApp } from "../../src/server/workspace.ts";

function options() {
  let dataDir: string | undefined;
  let webRoot: string | undefined;
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (value === undefined) throw new Error(`Missing value for ${key}`);
    if (key === "--data-dir") dataDir = resolve(value);
    else if (key === "--web-root") webRoot = resolve(value);
    else if (key === "--host" && value === "127.0.0.1") continue;
    else if (key === "--port" && value === "0") continue;
    else throw new Error(`Unsupported test-server option: ${key}`);
  }
  if (dataDir === undefined) throw new Error("Test server requires --data-dir");
  return { dataDir, ...(webRoot === undefined ? {} : { webRoot }) };
}

async function main() {
  const configured = options();
  const tokenOrigin = process.env.EMIT_TEST_OAUTH_URL;
  if (tokenOrigin === undefined) throw new Error("EMIT_TEST_OAUTH_URL is required");
  const provider = createFixtureOAuthProvider(tokenOrigin);
  await registerEmbeddedPiModules();
  let http: HttpRuntimeFixture | undefined;
  try {
    http = await startHttpRuntime(configured.dataDir, configured);
    http.runtime.catalog.models.setProvider(provider);
    const app = await readApp(http.runtime);
    await invalidateStaleGrants(http.runtime, app.policyVersion);
    await http.resume.mcp.connectEnabled().catch((error: unknown) => {
      process.stderr.write(`MCP connection failed: ${error instanceof Error ? error.message : String(error)}\n`);
    });
    await installAllExtensions(http.resume);
    http.runtime.resume();
    await reconcileWorks(http.resume);
    process.stdout.write(`Emit started: ${http.url}\nData directory: ${http.runtime.dataDir}\n`);
    const instance = http;
    let closing = false;
    const shutdown = async () => {
      if (closing) return;
      closing = true;
      try { await instance.close(); process.exit(0); }
      catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exit(1); }
    };
    process.on("SIGTERM", () => void shutdown());
    process.on("SIGINT", () => void shutdown());
  } catch (error) {
    await http?.close();
    throw error;
  }
}
void main().catch((error: unknown) => { process.stderr.write(`Startup failed: ${error instanceof Error ? error.message : String(error)}\n`); process.exit(1); });
