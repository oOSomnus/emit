#!/usr/bin/env node
/**
 * Native single-binary smoke test (`make smoke`).
 *
 * Runs the built executable as a user would: a copied binary in an empty
 * directory, no Node, npm, checkout, or node_modules reachable from the child
 * PATH or cwd. Every child gets a fresh environment object with only HOME,
 * TMPDIR, PATH, and LANG (plus EMIT_PORT where the scenario tests it), its own
 * data directory, and loopback-only HTTP. Nothing touches the real ~/.emit.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const binaryName = process.platform === "win32" ? "emit.exe" : "emit";
const binarySource = path.join(repoRoot, "dist", binaryName);
if (!existsSync(binarySource)) throw new Error(`缺少发布物 ${binarySource}，先运行 make binary`);

const startupTimeoutMs = 20_000;
const requestTimeoutMs = 10_000;
const scratch = mkdtempSync(path.join(tmpdir(), "emit-native-smoke-"));
const binDir = path.join(scratch, "bin");
const emptyPathDir = path.join(scratch, "empty-path");
const homeDir = path.join(scratch, "home");
const tempDir = path.join(scratch, "tmp");
for (const dir of [binDir, emptyPathDir, homeDir, tempDir]) mkdirSync(dir, { recursive: true });
const binaryPath = path.join(binDir, binaryName);
copyFileSync(binarySource, binaryPath);

const liveProcesses = new Set();
const liveServers = new Set();

/** The isolated child environment; one fresh object per process. */
function childEnv(extra = {}) {
  return { HOME: homeDir, TMPDIR: tempDir, PATH: emptyPathDir, LANG: "C.UTF-8", ...extra };
}

/** Start the binary and resolve its printed URL; the output stays readable for failures. */
function startEmit(label, { args = [], env = {}, dataDir } = {}) {
  const proc = spawn(binaryPath, [...(dataDir === undefined ? [] : ["--data-dir", dataDir]), ...args], {
    cwd: scratch,
    env: childEnv(env),
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  liveProcesses.add(proc);
  proc.once("exit", () => liveProcesses.delete(proc));
  let output = "";
  proc.stdout.on("data", (chunk) => {
    output += chunk;
  });
  proc.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const url = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}: ${startupTimeoutMs}ms 内未启动\n${output}`)), startupTimeoutMs);
    const scan = () => {
      const match = /Emit 已启动：(\S+)/.exec(output);
      if (match !== null) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    };
    proc.stdout.on("data", scan);
    proc.stderr.on("data", scan);
    proc.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`${label}: 进程提前退出 code=${String(code)}\n${output}`));
    });
  });
  url.catch(() => {});
  return { proc, url, output: () => output };
}

/** SIGTERM with a bounded wait; SIGKILL is the fallback so cleanup never hangs. */
async function stopEmit(proc, timeoutMs = 10_000) {
  if (proc.exitCode !== null || proc.signalCode !== null) return proc.exitCode;
  const exited = new Promise((resolve) => proc.once("exit", (code) => resolve(code)));
  signalOwned(proc, "SIGTERM");
  const killer = setTimeout(() => signalOwned(proc, "SIGKILL"), timeoutMs);
  const code = await exited;
  clearTimeout(killer);
  return code;
}

function signalOwned(proc, signal) {
  if (proc.pid === undefined || proc.exitCode !== null || proc.signalCode !== null) return;
  try {
    if (process.platform === "win32") proc.kill(signal);
    else process.kill(-proc.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

async function withTimeout(promise, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}: timeout after ${milliseconds}ms`)), milliseconds);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

async function expectStartupFailure(label, options) {
  const instance = startEmit(label, options);
  try {
    const exit = new Promise((resolve) => {
      if (instance.proc.exitCode !== null) resolve({ code: instance.proc.exitCode });
      else instance.proc.once("exit", code => resolve({ code }));
    });
    const startup = instance.url.then(url => ({ url }), () => new Promise(() => {}));
    const outcome = await withTimeout(Promise.race([exit, startup]), 45_000, label);
    assert.ok(!("url" in outcome), `${label}: unexpectedly started at ${outcome.url}\n${instance.output()}`);
    assert.ok(typeof outcome.code === "number" && outcome.code !== 0, `${label}: expected nonzero exit, got ${outcome.code}\n${instance.output()}`);
  } finally {
    await stopEmit(instance.proc, 5_000);
  }
}

/** Occupy a loopback port (0 picks a free one) so a child cannot bind it. */
function holdPort(port) {
  return new Promise((resolve, reject) => {
    const server = createTcpServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      liveServers.add(server);
      resolve({
        port: server.address().port,
        close: () =>
          new Promise((done) => {
            liveServers.delete(server);
            server.close(() => done());
          }),
      });
    });
  });
}

async function freePort() {
  const held = await holdPort(0);
  const port = held.port;
  await held.close();
  return port;
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(requestTimeoutMs) });
  const text = await response.text();
  return { status: response.status, contentType: response.headers.get("content-type") ?? "", body: text.length > 0 ? JSON.parse(text) : undefined };
}

async function textRequest(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(requestTimeoutMs) });
  return { status: response.status, contentType: response.headers.get("content-type") ?? "", text: await response.text() };
}

const results = [];
function reportPass(name, detail) {
  results.push({ name, status: "passed" });
  console.log(detail);
}

try {
  // 1. --help from an empty directory, with no source tree anywhere near it.
  {
    const help = spawnSync(binaryPath, ["--help"], { cwd: scratch, env: childEnv(), encoding: "utf8", timeout: requestTimeoutMs });
    assert.equal(help.status, 0, `--help 退出码 ${String(help.status)}：${help.stderr}`);
    assert.match(help.stdout, /--port <端口>\s+监听端口（默认自动分配，0 表示自动）/);
    assert.deepEqual(readdirSync(binDir), [binaryName]);
    assert.ok(!existsSync(path.join(scratch, "package.json")), "scratch 不应有 package.json");
    assert.ok(!existsSync(path.join(scratch, "node_modules")), "scratch 不应有 node_modules");
    assert.ok(!existsSync(path.join(scratch, "dist")), "scratch 不应有 dist");
    reportPass("isolated help", "1. 隔离目录中的 --help 正常");
  }

  // 2. With 8787 taken, two default-port children pick distinct real ports.
  const occupied8787 = await holdPort(8787).catch((error) => {
    throw new Error(`无法占用 127.0.0.1:8787（隔离 network namespace 未生效？）：${error.message}`);
  });
  const childA = startEmit("A", { dataDir: path.join(scratch, "data-a") });
  const childB = startEmit("B", { dataDir: path.join(scratch, "data-b") });
  const urlA = await childA.url;
  const urlB = await childB.url;
  {
    const portA = Number(new URL(urlA).port);
    const portB = Number(new URL(urlB).port);
    assert.ok(portA > 0 && portA !== 8787, `A 端口 ${String(portA)}`);
    assert.ok(portB > 0 && portB !== 8787, `B 端口 ${String(portB)}`);
    assert.notEqual(portA, portB);
    assert.equal(childA.proc.exitCode, null);
    assert.equal(childB.proc.exitCode, null);
    for (const url of [urlA, urlB]) assert.equal((await jsonRequest(`${url}/api/app`)).status, 200);
    reportPass("default port allocation", `2. 默认端口自动分配：${String(portA)} / ${String(portB)}（8787 被占用）`);
  }

  // 3. Port semantics: 0 means auto, an explicit busy port fails, CLI wins over env.
  {
    const zeroCli = startEmit("port0-cli", { dataDir: path.join(scratch, "data-port0"), args: ["--port", "0"] });
    assert.notEqual(Number(new URL(await zeroCli.url).port), 0);
    await stopEmit(zeroCli.proc);

    const zeroEnv = startEmit("port0-env", { dataDir: path.join(scratch, "data-port0-env"), env: { EMIT_PORT: "0" } });
    assert.notEqual(Number(new URL(await zeroEnv.url).port), 0);
    await stopEmit(zeroEnv.proc);

    const busy = await holdPort(0);
    const busyChild = startEmit("busy", { dataDir: path.join(scratch, "data-busy"), args: ["--port", String(busy.port)] });
    const busyCode = await new Promise((resolve) => busyChild.proc.once("exit", resolve));
    assert.ok(typeof busyCode === "number" && busyCode !== 0, `占用端口应导致非零退出，实际 ${String(busyCode)}`);
    assert.match(busyChild.output(), /EADDRINUSE/);
    await busy.close();

    const fixed = startEmit("fixed", { dataDir: path.join(scratch, "data-fixed"), args: ["--port", String(busy.port)] });
    assert.equal(Number(new URL(await fixed.url).port), busy.port);
    await stopEmit(fixed.proc);

    const envPort = await freePort();
    const envChild = startEmit("env-port", { dataDir: path.join(scratch, "data-env"), env: { EMIT_PORT: String(envPort) } });
    assert.equal(Number(new URL(await envChild.url).port), envPort);
    await stopEmit(envChild.proc);

    const cliPort = await freePort();
    const precedence = startEmit("precedence", {
      dataDir: path.join(scratch, "data-precedence"),
      env: { EMIT_PORT: String(await freePort()) },
      args: ["--port", String(cliPort)],
    });
    assert.equal(Number(new URL(await precedence.url).port), cliPort);
    await stopEmit(precedence.proc);
    reportPass("port precedence and occupied port", "3. 端口：0 自动、显式占用失败、CLI 优先于环境变量");
  }

  // 4. The embedded frontend is served as real static assets with SPA fallback.
  let indexHtml = "";
  {
    const index = await textRequest(`${urlA}/`);
    assert.equal(index.status, 200);
    assert.match(index.contentType, /text\/html/);
    assert.match(index.text, /<script/);
    indexHtml = index.text;

    const script = /src="(\/assets\/[^"]+\.js)"/.exec(indexHtml);
    const style = /href="(\/assets\/[^"]+\.css)"/.exec(indexHtml);
    assert.ok(script !== null, "index.html 应引用打包脚本");
    assert.ok(style !== null, "index.html 应引用打包样式");
    const scriptFile = await textRequest(`${urlA}${script[1]}`);
    assert.equal(scriptFile.status, 200);
    assert.match(scriptFile.contentType, /javascript/);
    const styleFile = await textRequest(`${urlA}${style[1]}`);
    assert.equal(styleFile.status, 200);
    assert.match(styleFile.contentType, /text\/css/);

    const deep = await textRequest(`${urlA}/a/client/route`);
    assert.equal(deep.status, 200);
    assert.equal(deep.text, indexHtml);
    const missing = await jsonRequest(`${urlA}/api/nope`);
    assert.equal(missing.status, 404);
    assert.match(missing.contentType, /application\/json/);
    assert.ok(!existsSync(path.join(scratch, "dist")), "运行期不应出现源码前端目录");
    reportPass("embedded frontend and SPA fallback", "4. 内嵌前端：资源 200、SPA 回退、API 404 为 JSON");
  }

  // 5. Persistence across restarts, plus cache repair after corruption.
  {
    const patch = await jsonRequest(`${urlA}/api/app`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceName: "native-smoke" }),
    });
    assert.equal(patch.status, 200);
    assert.equal(patch.body.workspace.name, "native-smoke");
    assert.equal(await stopEmit(childA.proc), 0);
    assert.ok(existsSync(path.join(scratch, "data-a", "emit.sqlite")), "应创建 emit.sqlite");

    const restarted = startEmit("A2", { dataDir: path.join(scratch, "data-a") });
    const restartedUrl = await restarted.url;
    assert.equal((await jsonRequest(`${restartedUrl}/api/app`)).body.workspace.name, "native-smoke");
    assert.equal(await stopEmit(restarted.proc), 0);

    const cachedIndex = path.join(scratch, "data-a", ".emit-web", "index.html");
    writeFileSync(cachedIndex, "<!doctype html><title>corrupt</title>");
    const repaired = startEmit("A3", { dataDir: path.join(scratch, "data-a") });
    const repairedUrl = await repaired.url;
    const repairedIndex = await textRequest(`${repairedUrl}/`);
    assert.equal(repairedIndex.text, indexHtml);
    assert.ok(!repairedIndex.text.includes("corrupt"));
    reportPass("persistence and cache repair", "5. 持久化重启保持数据，损坏的前端缓存被重新恢复");
    childA.proc = repaired.proc;
    childA.url = repaired.url;
  }

  // 6. The bundled Pi skill loader imports a real SKILL.md.
  {
    const fixtureDir = path.join(scratch, "native-smoke");
    mkdirSync(fixtureDir);
    writeFileSync(
      path.join(fixtureDir, "SKILL.md"),
      "---\nname: native-smoke\ndescription: Native binary smoke fixture\n---\n\n# Native smoke\n",
    );
    const urlA3 = await childA.url;
    const imported = await jsonRequest(`${urlA3}/api/skills/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ directory: fixtureDir }),
    });
    assert.equal(imported.status, 200);
    const skill = imported.body.imported.find((entry) => entry.name === "native-smoke");
    assert.ok(skill !== undefined, `导入结果缺少 native-smoke：${JSON.stringify(imported.body)}`);
    assert.equal(skill.description, "Native binary smoke fixture");
    reportPass("bundled skill loader", "6. 打包的 Pi skill loader 可导入 SKILL.md");
  }

  // 7. An open SSE stream closes and the process exits promptly on SIGTERM.
  {
    const urlA3 = await childA.url;
    const response = await fetch(`${urlA3}/api/events`, { headers: { accept: "text/event-stream" } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    let streamClosed = false;
    const connected = Promise.withResolvers();
    let comment = "";
    const decoder = new TextDecoder();
    const streamEnd = (async () => {
      try {
        for await (const chunk of response.body) {
          comment = (comment + decoder.decode(chunk, { stream: true })).slice(-1024);
          if (comment.includes(": connected")) connected.resolve();
        }
      } catch {
        // A connection reset by the exiting process still counts as closed.
      }
      streamClosed = true;
      connected.reject(new Error("SSE closed before connected"));
    })();
    await withTimeout(connected.promise, 5_000, "SSE connected");

    const started = Date.now();
    const code = await stopEmit(childA.proc, 5_000);
    const elapsed = Date.now() - started;
    assert.equal(code, 0);
    assert.ok(elapsed < 5_000, `SIGTERM 后退出耗时 ${String(elapsed)}ms`);
    await withTimeout(streamEnd, 5_000, "SSE shutdown");
    assert.ok(streamClosed);

    const afterSse = startEmit("A4", { dataDir: path.join(scratch, "data-a") });
    assert.equal((await jsonRequest(`${await afterSse.url}/api/app`)).status, 200);
    assert.equal(await stopEmit(afterSse.proc), 0);
    reportPass("SSE shutdown and restart", `7. SSE 连接随关闭断开，进程 ${String(elapsed)}ms 内退出并可立即重启`);
  }

  // 8. An explicit --web-root overrides the embedded UI without being modified.
  {
    const overrideDir = path.join(scratch, "custom-web");
    mkdirSync(overrideDir);
    const overrideIndex = "<!doctype html><html><head><title>custom-override</title></head><body>override</body></html>";
    writeFileSync(path.join(overrideDir, "index.html"), overrideIndex);
    const override = startEmit("override", { dataDir: path.join(scratch, "data-override"), args: ["--web-root", overrideDir] });
    const overrideUrl = await override.url;
    const index = await textRequest(`${overrideUrl}/`);
    assert.equal(index.status, 200);
    assert.match(index.text, /custom-override/);
    assert.equal((await jsonRequest(`${overrideUrl}/api/app`)).status, 200);
    assert.deepEqual(readdirSync(overrideDir), ["index.html"]);
    assert.equal(readFileSync(path.join(overrideDir, "index.html"), "utf8"), overrideIndex);
    assert.equal(await stopEmit(override.proc), 0);
    reportPass("explicit web root override", "8. --web-root 覆盖内嵌前端且文件未被改动");
  }

  // Startup failures are independent regressions; exercise every reachable case.
  const failures = [];
  const checkFailure = async (label, action) => {
    try {
      await action();
      reportPass(label, `9. ${label}: startup failure verified`);
    } catch (error) {
      failures.push(error);
      results.push({ name: label, status: "failed", error: error instanceof Error ? error.message : String(error) });
      console.error(`FAIL ${label}: ${error.message}`);
    }
  };
  await checkFailure("data directory is a file", async () => {
    const dataDir = path.join(scratch, "unavailable-data");
    writeFileSync(dataDir, "private sentinel");
    await expectStartupFailure("unavailable-data", { dataDir });
    assert.equal(readFileSync(dataDir, "utf8"), "private sentinel");
  });
  await checkFailure("corrupt SQLite data", async () => {
    const dataDir = path.join(scratch, "corrupt-sqlite");
    mkdirSync(dataDir);
    writeFileSync(path.join(dataDir, "emit.sqlite"), "not a SQLite database");
    await expectStartupFailure("corrupt-sqlite", { dataDir });
  });
  await checkFailure("corrupt credential configuration", async () => {
    const dataDir = path.join(scratch, "corrupt-credentials");
    mkdirSync(dataDir);
    writeFileSync(path.join(dataDir, "credentials.json"), "{invalid-json");
    await expectStartupFailure("corrupt-credentials", { dataDir });
  });
  await checkFailure("missing explicit web root", async () => {
    await expectStartupFailure("missing-web-root", { dataDir: path.join(scratch, "data-missing-web"), args: ["--web-root", path.join(scratch, "missing-web")] });
  });
  await checkFailure("explicit web root is a file", async () => {
    const webRoot = path.join(scratch, "web-root-file");
    writeFileSync(webRoot, "not a web directory");
    await expectStartupFailure("web-root-file", { dataDir: path.join(scratch, "data-file-web"), args: ["--web-root", webRoot] });
  });
  await checkFailure("data owner excludes a second process and releases on shutdown", async () => {
    await expectStartupFailure("competing-owner", { dataDir: path.join(scratch, "data-b") });
    assert.equal((await jsonRequest(`${urlB}/api/app`)).status, 200);
    const changed = await jsonRequest(`${urlB}/api/app`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceName: "surviving-owner" }),
    });
    assert.equal(changed.body.workspace.name, "surviving-owner");
    await stopEmit(childB.proc);
    const replacement = startEmit("replacement-owner", { dataDir: path.join(scratch, "data-b") });
    assert.equal((await jsonRequest(`${await replacement.url}/api/app`)).body.workspace.name, "surviving-owner");
    await stopEmit(replacement.proc);
  });
  if (failures.length > 0) throw new AggregateError(failures, `${failures.length} native startup regressions failed`);

  await occupied8787.close();
  console.log("native binary smoke 全部通过");
} catch (error) {
  if (!results.some((result) => result.status === "failed")) {
    results.push({ name: "native smoke prerequisite or scenario", status: "failed", error: error instanceof Error ? error.message : String(error) });
  }
  throw error;
} finally {
  try {
    await Promise.all([...liveProcesses].map(proc => stopEmit(proc, 5_000)));
    for (const server of liveServers) server.close();
    rmSync(scratch, { recursive: true, force: true });
  } finally {
    const reportDirectory = path.join(repoRoot, "test-results", "native");
    mkdirSync(reportDirectory, { recursive: true });
    writeFileSync(path.join(reportDirectory, "summary.json"), `${JSON.stringify({
      completedAt: new Date().toISOString(), expectedScenarios: 14,
      passed: results.filter((result) => result.status === "passed").length,
      failed: results.filter((result) => result.status === "failed").length,
      unexercised: Math.max(0, 14 - results.length), scenarios: results,
    }, null, 2)}\n`);
  }
}
