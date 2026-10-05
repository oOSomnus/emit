/**
 * Process entry point.
 *
 * One process owns the data directory, the SQLite storage, and the harness.
 * Startup order matters: the runtime takes the lock and resumes interrupted
 * runs first, then work left behind by an unclean shutdown is reconciled
 * against what actually resumed, and only then does the HTTP server accept
 * requests.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { EmitRuntime } from "./runtime.ts";
import { McpManager } from "./mcp.ts";
import { buildMailExtension, buildMailTasks, type MailTasks } from "./mail.ts";
import { buildWorkDispatchExtension, buildWorkDispatchTask, type WorkDispatchTask } from "./work-dispatch.ts";
import { installAllExtensions, reconcileWorks, type Resume } from "./work.ts";
import { buildServer } from "./api.ts";
import { invalidateStaleGrants } from "./approval/state.ts";
import { attachProgress } from "./progress.ts";
import { readApp } from "./workspace.ts";
import { resolveWebRoot } from "./web-root.ts";
import { registerEmbeddedPiModules } from "./pi-modules.ts";
import { appText } from "./app-text.ts";
import { noticeOf } from "./messages/work.ts";

type Options = {
  dataDir: string;
  host: string;
  port: number;
  webRoot: string | undefined;
};

function parseOptions(argv: readonly string[]): Options {
  let dataDir = process.env.EMIT_DATA_DIR ?? join(homedir(), ".emit");
  let host = process.env.EMIT_HOST ?? "127.0.0.1";
  let port = Number(process.env.EMIT_PORT ?? 0);
  let webRoot: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--data-dir" && next !== undefined) {
      dataDir = next;
      index += 1;
    } else if (arg === "--host" && next !== undefined) {
      host = next;
      index += 1;
    } else if (arg === "--port" && next !== undefined) {
      port = Number(next);
      index += 1;
    } else if (arg === "--web-root" && next !== undefined) {
      webRoot = resolve(next);
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        [
          "emit · local digital-employee collaboration workspace",
          "",
          "Usage: emit [options]",
          "  --data-dir <dir>   Data directory (default ~/.emit)",
          "  --host <address>   Listen address (default 127.0.0.1)",
          "  --port <port>      Listen port (default auto-assigned; 0 means auto)",
          "  --web-root <dir>   Web assets directory (default dist/web; the binary embeds the frontend)",
          "",
        ].join("\n"),
      );
      process.exit(0);
    }
  }
  if (!Number.isFinite(port) || port < 0) port = 0;
  return { dataDir, host, port, webRoot };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  await registerEmbeddedPiModules();
  const runtime = await EmitRuntime.open({
    dataDir: options.dataDir,
  });

  const app = await readApp(runtime);
  await invalidateStaleGrants(runtime, app.policyVersion);

  // Order matters: the employee extensions have to be installed before
  // scheduling resumes, because a resumed run resolves its tools immediately,
  // and MCP tools only exist once their servers are connected.
  const mcp = new McpManager(runtime);
  await mcp.connectEnabled().catch((error: unknown) => {
    process.stdout.write(`MCP connection failed: ${error instanceof Error ? error.message : String(error)}\n`);
  });
  const resume: Resume = {
    runtime,
    mcp,
    dispatch: undefined as unknown as WorkDispatchTask,
    mail: undefined as unknown as MailTasks,
  };
  resume.dispatch = buildWorkDispatchTask(() => resume);
  resume.mail = buildMailTasks(() => resume);
  const installed = await installAllExtensions(resume);
  process.stdout.write(`Loaded ${installed} digital employees.\n`);
  runtime.registry.install(buildWorkDispatchExtension(resume.dispatch));
  runtime.registry.install(buildMailExtension(resume.mail));

  runtime.emit(noticeOf(appText({ en: "Resuming unfinished work…", "zh-CN": "正在恢复上次未完成的工作…" })));
  runtime.resume();
  const interrupted = await reconcileWorks(resume);
  if (interrupted > 0) {
    process.stdout.write(`Marked ${interrupted} unrecoverable works as failed.\n`);
  }

  const detachProgress = attachProgress(runtime);

  const webRoot = resolveWebRoot(runtime.dataDir, options.webRoot);
  const server = await buildServer({ resume, webRoot });
  const address = await server.listen({ host: options.host, port: options.port });
  process.stdout.write(`Emit started: ${address}\nData directory: ${runtime.dataDir}\n`);

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    process.stdout.write(`Received ${signal}; shutting down…\n`);
    try {
      detachProgress();
      await server.close();
      await mcp.closeAll();
      await runtime.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void main().catch((error: unknown) => {
  process.stderr.write(`Startup failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});
