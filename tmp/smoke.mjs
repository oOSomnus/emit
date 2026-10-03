/**
 * End-to-end smoke run against a fake provider.
 *
 * Verifies the durable path plus room-owned directory isolation, mail-session
 * graph continuity, complete-context risk review, blocked reviewer failures,
 * and recovery/decision paths against controlled fixtures.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const DATA = join(ROOT, "tmp", "smoke-data");
const WORKDIR = join(ROOT, "tmp", "smoke-work");
const SERVER_PORT = 8898;
const PROVIDER_PORT = 8899;
const BASE = `http://127.0.0.1:${SERVER_PORT}`;
const DIR_A = join(WORKDIR, "A");
const DIR_B = join(WORKDIR, "B");
const DIR_C = join(WORKDIR, "C");
const DIR_D = join(WORKDIR, "D");
const DIR_E = join(WORKDIR, "E");
const OUTSIDE_DIR = join(ROOT, "tmp", "smoke-outside");
const ROOT_CWD_PROOF = join(ROOT, "cwd-proof.txt");
const directories = (paths, defaultPath = paths[0] ?? "") => ({ paths, defaultPath });

async function createRoom(room, paths = [WORKDIR], defaultPath = paths[0] ?? "") {
  return call("/api/rooms", {
    method: "POST",
    body: JSON.stringify({ ...room, directories: directories(paths, defaultPath) }),
  });
}

async function patchDirectories(room, paths, defaultPath = paths[0] ?? "") {
  return call(`/api/rooms/${room.id}/directories`, {
    method: "PATCH",
    body: JSON.stringify({
      ...directories(paths, defaultPath),
      expectedVersion: room.directories.version,
    }),
  });
}

const log = (message) => process.stdout.write(`${message}\n`);
const rmdir = (path) => rmSync(path, { force: true });
const fail = (message) => {
  process.stderr.write(`FAIL ${message}\n`);
  process.exitCode = 1;
};

async function call(path, init) {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  const payload = text.length > 0 ? JSON.parse(text) : undefined;
  if (!response.ok) throw new Error(`${path} → ${response.status} ${text.slice(0, 300)}`);
  return payload;
}

/** OpenCode Go requests the fake provider has seen: `{ model, sessionId }`. */
async function goSessions() {
  const response = await fetch(`http://127.0.0.1:${PROVIDER_PORT}/_opencode_sessions`);
  return response.json();
}
async function approvalRequests() {
  const response = await fetch(`http://127.0.0.1:${PROVIDER_PORT}/_approval_requests`);
  return response.json();
}
async function staleMailReady() {
  const response = await fetch(`http://127.0.0.1:${PROVIDER_PORT}/_stale_mail_ready`);
  return response.json();
}
async function releaseStaleMail() {
  const response = await fetch(`http://127.0.0.1:${PROVIDER_PORT}/_release_stale_mail`, { method: "POST" });
  if (!response.ok) throw new Error(`释放 stale-mail fake 请求失败：${response.status}`);
}

async function waitFor(description, check, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check().catch(() => undefined);
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`超时: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}
async function startWorkMessage(roomId, body, employeeId) {
  const response = await call(`/api/rooms/${roomId}/messages`, {
    method: "POST",
    body: JSON.stringify({ body, ...(employeeId !== undefined ? { employeeId } : {}) }),
  });
  if (typeof response.workId !== "string") throw new Error(`会话 ${roomId} 没有启动工作：${JSON.stringify(response)}`);
  return response;
}

async function finishWork(workId, description) {
  return waitFor(description, async () =>
    (await call("/api/works")).find(
      (work) => work.id === workId && work.status !== "running" && work.status !== "queued",
    ),
  );
}

async function approvalForWork(workId, status, description) {
  return waitFor(description, async () =>
    (await call("/api/approvals")).approvals.find(
      (approval) => approval.workId === workId && approval.status === status,
    ),
  );
}
function assertDirectoryScope(approval, room, paths, cwd, targetPaths = []) {
  if (approval.directoryRoomId !== room.id) {
    throw new Error(`审批目录来源错误：${approval.directoryRoomId}，预期 ${room.id}`);
  }
  if (approval.directoryVersion !== room.directories.version) {
    throw new Error(`审批目录版本错误：${approval.directoryVersion}，预期 ${room.directories.version}`);
  }
  if (JSON.stringify(approval.directoryPaths) !== JSON.stringify(paths)) {
    throw new Error(`审批授权根不匹配：${JSON.stringify(approval.directoryPaths)}，预期 ${JSON.stringify(paths)}`);
  }
  if (approval.cwd !== cwd) throw new Error(`审批 cwd 错误：${approval.cwd}，预期 ${cwd}`);
  if (JSON.stringify(approval.targetPaths) !== JSON.stringify(targetPaths)) {
    throw new Error(`审批 targetPaths 错误：${JSON.stringify(approval.targetPaths)}，预期 ${JSON.stringify(targetPaths)}`);
  }
}

function toolOutput(events, workId) {
  return events
    .filter((event) => event.type === "work-progress" && event.workId === workId)
    .flatMap((event) => event.tools)
    .map((tool) => tool.output ?? "")
    .join("\n");
}
async function startMailWorkMessage(roomId, body, employeeId) {
  const response = await call(`/api/rooms/${roomId}/messages`, {
    method: "POST",
    body: JSON.stringify({ body, subject: "工作目录 cwd-proof", to: [employeeId] }),
  });
  if (response.workIds?.length !== 1) throw new Error(`邮件 session ${roomId} 没有启动唯一工作：${JSON.stringify(response)}`);
  return response.workIds[0];
}

async function assertShellCwdProof({ room, expectedCwd, startWork, description, explicitB = false }) {
  const shellWorkId = await startWork(
    `请使用 run_shell 执行 cwd-proof.txt 实际目录证明：${description}${explicitB ? "，显式切换到 B" : ""}`,
  );
  const approval = await approvalForWork(shellWorkId, "approved", `${description} cwd-proof 自动通过`);
  const shellWork = await finishWork(shellWorkId, `${description} cwd-proof 完成`);
  if (shellWork.status !== "succeeded") throw new Error(`${description} cwd-proof 执行失败：${shellWork.error}`);
  assertDirectoryScope(approval, room, room.directories.paths, expectedCwd);

  const proofFile = join(expectedCwd, "cwd-proof.txt");
  if (!existsSync(proofFile)) throw new Error(`${description} pwd side effect 没有写入预期目录 ${expectedCwd}`);
  const proof = readFileSync(proofFile, "utf8");
  if (proof !== `${expectedCwd}\n`) throw new Error(`${description} pwd 结果是 ${JSON.stringify(proof)}，预期 ${expectedCwd}`);
}

/**
 * Run the server as the direct child.
 *
 * `npx tsx` would wrap the server in another process, so a signal to the child
 * would not reach the server itself; the run has to kill and restart the real
 * process for the crash test to mean anything.
 */
function startServer() {
  const child = spawn(process.execPath, ["--import", "tsx", "--import", "./tmp/opencode-local-fetch.mjs", "src/server/main.ts", "--data-dir", DATA, "--port", String(SERVER_PORT)], {
    cwd: ROOT,
    env: { ...process.env, FAKE_API_KEY: "smoke", EMIT_DATA_DIR: DATA },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => process.stdout.write(`[server] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[server] ${chunk}`));
  return child;
}

function once(child, event) {
  const { promise, resolve } = Promise.withResolvers();
  child.once(event, resolve);
  return promise;
}

/** Collect events from one SSE subscription; reconnects are not needed before the restart point. */
async function collectEvents(sink) {
  const response = await fetch(`${BASE}/api/events`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const line = frame.split("\n").find((entry) => entry.startsWith("data: "));
        if (line === undefined) continue;
        try {
          sink.push(JSON.parse(line.slice(6)));
        } catch {
          // ignore a malformed frame
        }
      }
    }
  })().catch(() => undefined);
  return () => void reader.cancel().catch(() => undefined);
}

async function waitForServer() {
  await waitFor("服务器启动", async () => {
    const response = await fetch(`${BASE}/api/bootstrap`);
    return response.ok;
  }, 90_000);
}

async function main() {
  if (existsSync(ROOT_CWD_PROOF)) throw new Error(`拒绝覆盖已有 ${ROOT_CWD_PROOF}`);
  // The run asserts it starts from an empty directory, so it clears its own.
  rmSync(DATA, { recursive: true, force: true });
  rmSync(WORKDIR, { recursive: true, force: true });
  rmSync(OUTSIDE_DIR, { recursive: true, force: true });
  mkdirSync(DATA, { recursive: true });
  mkdirSync(WORKDIR, { recursive: true });
  mkdirSync(OUTSIDE_DIR, { recursive: true });
  writeFileSync(join(WORKDIR, "notes.txt"), "第一行\n第二行\n");
  writeFileSync(join(WORKDIR, "context-evidence.txt"), "SMOKE-CONTEXT-HIGH\n");
  for (const [name, directory] of [["A", DIR_A], ["B", DIR_B], ["C", DIR_C], ["D", DIR_D], ["E", DIR_E]]) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "notes.txt"), `SMOKE-DIRECTORY-${name}\n`);
  }
  writeFileSync(join(OUTSIDE_DIR, "outside-secret.txt"), "SMOKE-OUTSIDE-SECRET\n");
  symlinkSync(join(OUTSIDE_DIR, "outside-secret.txt"), join(DIR_C, "escape.txt"));
  execFileSync("git", ["init", "--quiet", DIR_A], { cwd: ROOT });
  execFileSync("git", [
    "-C", DIR_A,
    "-c", "user.name=Smoke Test",
    "-c", "user.email=smoke@example.test",
    "commit", "--quiet", "--allow-empty", "-m", "smoke fixture",
  ], { cwd: ROOT });

  const providerConfig = {
    id: "fake",
    name: "Fake Provider",
    baseUrl: `http://127.0.0.1:${PROVIDER_PORT}/v1`,
    api: "openai-completions",
    apiKeyEnv: "FAKE_API_KEY",
    models: [
      {
        id: "fake-chat",
        name: "Fake Chat",
        contextWindow: 32768,
        maxTokens: 4096,
        reasoning: false,
        input: ["text"],
      },
      {
        id: "fake-reviewer",
        name: "Fake Reviewer",
        contextWindow: 32768,
        maxTokens: 4096,
        reasoning: false,
        input: ["text"],
      },
    ],
  };

  const provider = spawn("node", ["tmp/fake-provider.mjs"], { cwd: ROOT, stdio: "inherit" });
  let server = startServer();

  try {
    await waitForServer();
    log("· 服务器已启动");

    const events = [];
    await collectEvents(events);


    const bootstrap = await call("/api/bootstrap");
    if (bootstrap.app.onboarded) throw new Error("数据目录不是全新的");

    // The custom endpoint is created through the product API and authenticated
    // through the native key wizard — not by pre-writing credentials.json — so
    // this run proves the visual configuration path end to end.
    const created = await call("/api/providers/custom", {
      method: "PUT",
      body: JSON.stringify({ providers: [providerConfig] }),
    });
    const fakeStatus = created.statuses.find((status) => status.providerId === "fake");
    if (fakeStatus === undefined || !fakeStatus.custom) throw new Error("自定义接口没有出现在 Provider 列表");
    if (fakeStatus.storedAuthType !== null) throw new Error("新接口不应带有已保存的凭据");

    const startedAuth = await call("/api/auth/sessions", {
      method: "POST",
      body: JSON.stringify({ providerId: "fake", type: "api_key" }),
    });
    if (startedAuth.status !== "waiting" || startedAuth.prompt?.type !== "secret") {
      throw new Error(`API Key 向导没有要求输入：${JSON.stringify(startedAuth)}`);
    }
    await call(`/api/auth/sessions/${startedAuth.id}/respond`, {
      method: "POST",
      body: JSON.stringify({ promptId: startedAuth.prompt.id, value: "smoke" }),
    });
    const finishedAuth = await waitFor("API Key 认证保存", async () => {
      const snapshot = await call(`/api/auth/sessions/${startedAuth.id}`);
      return snapshot.status === "succeeded" ? snapshot : undefined;
    });
    if (JSON.stringify(finishedAuth).includes("smoke")) throw new Error("认证快照泄露了密钥");
    if ((await call("/api/providers/custom")).providers.length !== 1) throw new Error("自定义接口没有被保存");

    const afterAuth = await call("/api/models");
    const configuredFake = afterAuth.providers.find((status) => status.providerId === "fake");
    if (!configuredFake?.configured) throw new Error("认证后自定义接口仍未配置");
    if (configuredFake.storedAuthType !== "api_key") throw new Error("认证没有保存为 API Key");
    const fakeModel = afterAuth.models.find((model) => model.providerId === "fake" && model.modelId === "fake-chat");
    if (!fakeModel?.configured) throw new Error("认证后模型仍不可用");

    const check = await call("/api/models/check", {
      method: "POST",
      body: JSON.stringify({ model: { providerId: "fake", modelId: "fake-chat" }, kind: "chat" }),
    });
    if (!check.ok || !check.message.includes("已应答")) throw new Error(`连接检查失败：${JSON.stringify(check)}`);
    log("· 通过 API 创建自定义接口、完成原生 API Key 向导并验证连接");

    // ---- OpenCode Go: a built-in provider that requires a session header ---
    const goAuth = await call("/api/auth/sessions", {
      method: "POST",
      body: JSON.stringify({ providerId: "opencode-go", type: "api_key" }),
    });
    if (goAuth.status !== "waiting" || goAuth.prompt?.type !== "secret") {
      throw new Error(`OpenCode Go 的 API Key 向导没有要求输入：${JSON.stringify(goAuth)}`);
    }
    await call(`/api/auth/sessions/${goAuth.id}/respond`, {
      method: "POST",
      body: JSON.stringify({ promptId: goAuth.prompt.id, value: "smoke-go" }),
    });
    const goAuthDone = await waitFor("OpenCode Go 认证保存", async () => {
      const snapshot = await call(`/api/auth/sessions/${goAuth.id}`);
      return snapshot.status === "succeeded" ? snapshot : undefined;
    });
    if (JSON.stringify(goAuthDone).includes("smoke-go")) throw new Error("OpenCode Go 认证快照泄露了密钥");

    const goCheck = await call("/api/models/check", {
      method: "POST",
      body: JSON.stringify({ model: { providerId: "opencode-go", modelId: "deepseek-v4.1-flash" }, kind: "chat" }),
    });
    if (!goCheck.ok || !goCheck.message.includes("已应答")) {
      throw new Error(`OpenCode Go 连接检查失败：${JSON.stringify(goCheck)}`);
    }
    const afterCheck = await goSessions();
    if (afterCheck.length !== 1) throw new Error(`连接检查应产生 1 次 Go 请求，实际 ${afterCheck.length}`);
    const checkSession = afterCheck[0].sessionId;
    if (typeof checkSession !== "string" || checkSession.length === 0) {
      throw new Error("连接检查没有携带会话 id");
    }
    log("· OpenCode Go 连接检查成功并携带会话 id");

    const missingReviewer = await fetch(`${BASE}/api/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceName: "冒烟工作区",
        userName: "测试者",
        defaultExecutionModel: { model: { providerId: "fake", modelId: "fake-chat" }, effort: "off" },
        approval: null,
      }),
    });
    if (missingReviewer.status !== 400) throw new Error(`未配置审批判断模型的初始化返回了 ${missingReviewer.status}`);
    if ((await call("/api/bootstrap")).app.onboarded) throw new Error("缺少审批模型的初始化已写入 onboarded");
    await call("/api/setup", {
      method: "POST",
      body: JSON.stringify({
        workspaceName: "冒烟工作区",
        userName: "测试者",
        defaultExecutionModel: { model: { providerId: "fake", modelId: "fake-chat" }, effort: "off" },
        approval: {
          kind: "llm",
          model: { providerId: "fake", modelId: "fake-reviewer" },
          effort: "off",
          criteriaVersion: 3,
        },
      }),
    });
    const missingPatchReviewer = await fetch(`${BASE}/api/app`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approval: null }),
    });
    if (missingPatchReviewer.status !== 400) throw new Error(`删除审批判断模型返回了 ${missingPatchReviewer.status}`);
    if (!(await missingPatchReviewer.text()).includes("审批判断模型不能为空")) {
      throw new Error("删除审批判断模型没有给出明确原因");
    }
    if (!(await call("/api/app")).approval?.model) throw new Error("拒绝空 reviewer 后有效配置丢失");
    log("· 首次设置必须选择审批判断模型，空模型配置被拒绝");
    log("· 已完成初始化");

    const employee = await call("/api/employees", {
      method: "POST",
      body: JSON.stringify({
        name: "小柯",
        role: "文档助手",
        instructions: "简洁回答。",
        executionModel: { model: { providerId: "fake", modelId: "fake-chat" }, effort: "off" },
        toolPolicy: {
          allowedTools: ["read_file", "write_file", "edit_file", "run_shell", "load_skill"],
          trustedReadOnlyTools: [],
        },
        generateAddress: true,
      }),
    });
    if (!employee.address.includes("@")) throw new Error("员工邮箱地址没有生成");
    if (employee.address.split("@")[0] === "employee") throw new Error("中文名没有进入邮箱地址");
    log(`· 已创建员工 ${employee.name} <${employee.address}>`);

    let room = await createRoom({ kind: "dm", name: "小柯", employeeId: employee.id });

    // ---- read-only path: model-reviewed shell commands auto-approve -------
    const catStarted = await call(`/api/rooms/${room.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ body: "请使用 run_shell 执行 cat notes.txt" }),
    });
    const catWork = await waitFor("run_shell cat 工作成功", async () =>
      (await call("/api/works")).find((work) => work.id === catStarted.workId && work.status === "succeeded"),
    );
    const catAnswer = await waitFor("cat 结果回到会话", async () =>
      (await call(`/api/rooms/${room.id}/messages`)).messages.find(
        (message) => message.author.type === "employee" && message.workId === catWork.id,
      ),
    );
    if (!catAnswer.body.includes("已完成")) throw new Error(`cat 回答内容不符合预期: ${catAnswer.body}`);
    const catApproval = await waitFor("cat 自动批准且执行完成", async () =>
      (await call("/api/approvals")).approvals.find(
        (approval) =>
          approval.workId === catWork.id &&
          approval.status === "approved" &&
          approval.execution.state === "succeeded",
      ),
    );
    if (
      catApproval.evidence?.kind !== "llm" ||
      catApproval.evidence.readOnly !== true ||
      catApproval.evidence.outcome !== "allow" ||
      catApproval.evidence.risk !== "low"
    ) {
      throw new Error(`cat 缺少 v3 low/allow 只读判断证据：${JSON.stringify(catApproval.evidence)}`);
    }
    if (catApproval.evidence.criteriaVersion !== 3) {
      throw new Error(`cat 自动判断使用了非当前标准：${catApproval.evidence.criteriaVersion}`);
    }
    if (catApproval.evidence.userAuthorization !== "unknown") {
      throw new Error(`cat 弱授权来源被错误升级：${JSON.stringify(catApproval.evidence)}`);
    }
    if (catApproval.decidedBy === "user") throw new Error("cat 自动批准意外使用了人工裁决");
    if (!events.some((event) => event.type === "approval" && event.approval.id === catApproval.id && event.approval.status === "approved")) {
      throw new Error("SSE 没有播送 cat 的自动批准结果");
    }
    if (
      !events.some(
        (event) =>
          event.type === "work-progress" &&
          event.tools.some((tool) => tool.status === "done" && tool.output?.includes("退出码 0")),
      )
    ) {
      throw new Error("SSE 没有收到 cat 的真实命令输出");
    }
    log(`· run_shell cat 自动批准并成功执行，授权依据 ${catApproval.evidence.userAuthorization}`);

    const lsStarted = await call(`/api/rooms/${room.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ body: "请使用 run_shell 执行 ls" }),
    });
    const lsWork = await waitFor("run_shell ls 工作成功", async () =>
      (await call("/api/works")).find((work) => work.id === lsStarted.workId && work.status === "succeeded"),
    );
    const lsApproval = await waitFor("ls 自动批准且执行完成", async () =>
      (await call("/api/approvals")).approvals.find(
        (approval) =>
          approval.workId === lsWork.id &&
          approval.status === "approved" &&
          approval.execution.state === "succeeded",
      ),
    );
    if (
      lsApproval.evidence?.kind !== "llm" ||
      lsApproval.evidence.readOnly !== true ||
      lsApproval.evidence.outcome !== "allow" ||
      lsApproval.evidence.risk !== "low"
    ) {
      throw new Error(`ls 缺少 v3 low/allow 只读判断证据：${JSON.stringify(lsApproval.evidence)}`);
    }
    if (
      !events.some(
        (event) =>
          event.type === "work-progress" &&
          event.tools.some((tool) => tool.status === "done" && tool.output?.includes("退出码 0")),
      )
    ) {
      throw new Error("SSE 没有收到 ls 的真实命令输出");
    }
    log("· run_shell ls 自动批准并成功执行，SSE 与持久化审批记录均可观察");

    if (!events.some((event) => event.type === "work-progress" && event.progressText.length > 0)) {
      throw new Error("没有收到流式进度事件");
    }
    log("· SSE 收到流式进度");

    // A model the catalog cannot run is refused where it is chosen, not later.
    const badModel = await fetch(`${BASE}/api/employees`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "坏模型员工",
        role: "测试",
        executionModel: { model: { providerId: "nope", modelId: "nope" }, effort: "off" },
      }),
    });
    if (badModel.status !== 400) throw new Error(`不存在的模型返回了 ${badModel.status}`);
    const badEffort = await fetch(`${BASE}/api/employees`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "坏强度员工",
        role: "测试",
        executionModel: { model: { providerId: "fake", modelId: "fake-chat" }, effort: "xhigh" },
      }),
    });
    if (badEffort.status !== 400) throw new Error(`不支持的推理强度返回了 ${badEffort.status}`);
    if (!(await badEffort.text()).includes("不支持")) throw new Error("推理强度错误信息不清楚");
    log("· 员工不能保存目录里没有的模型或不支持的推理强度");

    const works = await call("/api/works");
    const readWork = works.find((work) => work.id === catWork.id);
    if (readWork?.status !== "succeeded") throw new Error(`只读工作的状态是 ${readWork?.status}`);
    if ((readWork.usage?.input ?? 0) <= 0) throw new Error("没有记录 token 用量");
    log(`· 工作已完成，记录了用量 ${readWork.usage.input}/${readWork.usage.output}`);

    const safeApprovals = await call("/api/approvals");
    const shellWorkIds = new Set([catWork.id, lsWork.id]);
    const shellApprovals = safeApprovals.approvals.filter((approval) => shellWorkIds.has(approval.workId));
    if (
      shellApprovals.length !== 2 ||
      shellApprovals.some((approval) => approval.status !== "approved" || approval.decidedBy === "user")
    ) {
      throw new Error(`cat/ls 的持久化审批记录不符合自动批准预期：${JSON.stringify(shellApprovals)}`);
    }

    // ---- gated path: the write must wait for the human --------------------
    const highStart = await call(`/api/rooms/${room.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ body: "请写一个 critical-settings.json" }),
    });
    const pending = await waitFor("等待人工审批的高风险写调用", async () => {
      const payload = await call("/api/approvals");
      return payload.approvals.find(
        (approval) => approval.workId === highStart.workId && approval.status === "pending-human" && approval.toolName === "write_file",
      );
    });
    if (pending.evidence?.kind !== "llm" || pending.evidence.outcome !== "allow" || pending.evidence.risk !== "high") {
      throw new Error(`高风险调用没有按 v3 转人工: ${JSON.stringify(pending.evidence)}`);
    }
    if (!pending.autoDecision?.reason.includes("high")) throw new Error("没有记录高风险转人工的理由");
    log(`· 高风险文件写入转人工：${pending.autoDecision.reason}`);

    if (!events.some((event) => event.type === "approval" && event.approval.id === pending.id)) {
      throw new Error("没有收到审批事件");
    }
    log("· SSE 收到审批事件");

    const employeeMessagesBefore = (await call(`/api/rooms/${room.id}/messages`)).messages.filter(
      (message) => message.author.type === "employee",
    ).length;
    if (employeeMessagesBefore !== 2) {
      throw new Error(`等待审批期间员工消息数量变成了 ${employeeMessagesBefore}`);
    }

    // ---- crash during the wait, then resume -------------------------------
    const killed = server;
    const killedPid = killed.pid;
    killed.kill("SIGKILL");
    await once(killed, "exit");
    if (killed.exitCode === null && killed.signalCode === null) throw new Error("被强杀的进程没有退出");
    log(`· 服务进程 ${killedPid} 已被 SIGKILL 终止`);

    server = startServer();
    if (server.pid === killedPid) throw new Error("重启没有产生新的进程");
    await waitForServer();
    if (server.exitCode !== null) throw new Error("重启后的进程已经退出");
    await collectEvents(events);
    log("· 进程被强杀后已由新进程恢复");

    const afterRestart = await call("/api/approvals");
    const stillPending = afterRestart.approvals.find((approval) => approval.id === pending.id);
    if (stillPending?.status !== "pending-human") {
      throw new Error(`重启后审批状态变成了 ${stillPending?.status}`);
    }
    log("· 审批在重启后仍然等待同一个调用");

    await call(`/api/approvals/${pending.id}/decision`, {
      method: "POST",
      body: JSON.stringify({ decision: "approved", comment: "冒烟测试批准" }),
    });

    const written = await waitFor("批准后完成回答", async () => {
      const payload = await call(`/api/rooms/${room.id}/messages`);
      return payload.messages.filter((message) => message.author.type === "employee").length >= 3;
    });
    if (written === undefined) throw new Error("批准后没有收到回答");

    const contents = readFileSync(join(WORKDIR, "critical-settings.json"), "utf8");
    if (!contents.includes("SMOKE-CRITICAL-CONTENT")) throw new Error(`文件内容不符合预期: ${contents}`);
    log("· 批准后工具真的执行了，隔离 high fixture 文件已写入");

    const finalApprovals = await call("/api/approvals");
    const decided = finalApprovals.approvals.find((approval) => approval.id === pending.id);
    if (decided.status !== "approved") throw new Error(`最终审批状态是 ${decided.status}`);
    if (decided.execution.state !== "succeeded") throw new Error(`执行状态是 ${decided.execution.state}`);
    if (decided.timeline.length < 3) throw new Error("时间线不完整");
    log("· 审批记录含有完整的执行状态与时间线");

    const finalWorks = await call("/api/works");
    if (finalWorks.filter((work) => work.status === "succeeded").length < 3) {
      throw new Error(`成功的工作数量不足: ${JSON.stringify(finalWorks.map((work) => work.status))}`);
    }
    log("· shell 与人工批准的三项工作都已成功");

    // The restart must not have delivered anything twice: one answer per work.
    const delivered = (await call(`/api/rooms/${room.id}/messages`)).messages.filter(
      (message) => message.author.type === "employee",
    );
    const succeededHere = finalWorks.filter((work) => work.roomId === room.id && work.status === "succeeded");
    if (delivered.length !== succeededHere.length) {
      throw new Error(`投递次数与成功工作数不符：${delivered.length} 条回答 / ${succeededHere.length} 项工作`);
    }
    const answerWorkIds = delivered.map((message) => message.workId);
    if (new Set(answerWorkIds).size !== answerWorkIds.length) throw new Error("同一项工作被投递了多次");
    log("· 恢复后每项工作只投递一次回答");

    // ---- rejection: no grant may be consumed by default --------------------
    await rmdir(join(WORKDIR, "critical-settings.json"));
    const seen = new Set(finalApprovals.approvals.map((approval) => approval.id));
    await call(`/api/rooms/${room.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ body: "请写一个 critical-settings.json" }),
    });
    const rejected = await waitFor("等待裁决的第二个写调用", async () => {
      const payload = await call("/api/approvals");
      return payload.approvals.find(
        (approval) => approval.toolName === "write_file" && approval.status === "pending-human" && !seen.has(approval.id),
      );
    });

    const waitingWork = (await call("/api/works")).find((work) => work.id === rejected.workId);
    if (waitingWork?.status !== "waiting-approval") {
      throw new Error(`等待裁决的工作状态是 ${waitingWork?.status}`);
    }
    log("· 等待裁决时工作标为“等待审批”");

    await call(`/api/approvals/${rejected.id}/decision`, {
      method: "POST",
      body: JSON.stringify({ decision: "rejected", comment: "冒烟测试拒绝" }),
    });
    const rejectedAfter = await waitFor("拒绝后完成回答", async () => {
      const payload = await call("/api/approvals");
      const approval = payload.approvals.find((item) => item.id === rejected.id);
      return approval?.status === "rejected" ? approval : undefined;
    });
    if (rejectedAfter.execution.state !== "not-started") {
      throw new Error(`被拒绝的调用执行状态是 ${rejectedAfter.execution.state}`);
    }
    if (existsSync(join(WORKDIR, "critical-settings.json"))) throw new Error("被拒绝的调用仍然写了文件");
    await waitFor("被拒绝那次的回答", async () => {
      const payload = await call(`/api/rooms/${room.id}/messages`);
      return payload.messages.filter((message) => message.author.type === "employee").length >= 4;
    });
    log("· 拒绝后文件未写入，员工按被阻止的结果作答");

    // ---- stopping a work while its call waits for a decision ---------------
    const seenSecond = new Set((await call("/api/approvals")).approvals.map((approval) => approval.id));
    await call(`/api/rooms/${room.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ body: "请写一个 critical-settings.json" }),
    });
    const toStop = await waitFor("等待裁决的第三个写调用", async () => {
      const payload = await call("/api/approvals");
      return payload.approvals.find(
        (approval) => approval.toolName === "write_file" && approval.status === "pending-human" && !seenSecond.has(approval.id),
      );
    });
    await call(`/api/works/${toStop.workId}/stop`, { method: "POST", body: "{}" });
    const stopped = await waitFor("停止后审批被取消", async () => {
      const payload = await call("/api/approvals");
      const approval = payload.approvals.find((item) => item.id === toStop.id);
      return approval?.status === "cancelled" ? approval : undefined;
    });
    if (stopped.execution.state !== "not-started") throw new Error("被取消的调用竟然执行了");
    const stoppedWork = (await call("/api/works")).find((work) => work.id === toStop.workId);
    if (stoppedWork?.status !== "stopped") throw new Error(`停止后的工作状态是 ${stoppedWork?.status}`);
    if (existsSync(join(WORKDIR, "critical-settings.json"))) throw new Error("被停止的调用仍然写了文件");
    log("· 停止等待中的工作会取消审批且不执行工具");

    // ---- a second decision on the same approval is refused -----------------
    const again = await fetch(`${BASE}/api/approvals/${rejected.id}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approved", comment: "重复裁决" }),
    });
    if (again.status !== 409) throw new Error(`重复裁决返回了 ${again.status}`);
    const afterAgain = (await call("/api/approvals")).approvals.find((approval) => approval.id === rejected.id);
    if (afterAgain.status !== "rejected") throw new Error("重复裁决改写了已有判决");
    log("· 重复裁决被拒绝，已有判决不变");

    // ---- policy changes invalidate a pending call's old grant -------------
    const appBeforePolicyChange = await call("/api/app");
    const staleStart = await call(`/api/rooms/${room.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ body: "请写一个 critical-settings.json" }),
    });
    const stalePending = await waitFor("策略变更前等待人工的写调用", async () =>
      (await call("/api/approvals")).approvals.find(
        (approval) => approval.workId === staleStart.workId && approval.status === "pending-human",
      ),
    );
    const policyChanged = await call("/api/app", {
      method: "PATCH",
      body: JSON.stringify({
        approval: {
          ...appBeforePolicyChange.approval,
          model: { providerId: "fake", modelId: "fake-chat" },
        },
      }),
    });
    if (policyChanged.policyVersion !== appBeforePolicyChange.policyVersion + 1) {
      throw new Error("审批策略变更没有递增策略版本");
    }
    if (policyChanged.approval?.criteriaVersion !== 3) {
      throw new Error(`服务端没有使用实际标准版本 3：${policyChanged.approval?.criteriaVersion}`);
    }
    await call(`/api/approvals/${stalePending.id}/decision`, {
      method: "POST",
      body: JSON.stringify({ decision: "approved", comment: "策略版本已过期" }),
    });
    const invalidated = await waitFor("旧策略批准失效", async () =>
      (await call("/api/approvals")).approvals.find(
        (approval) => approval.id === stalePending.id && approval.status === "invalidated",
      ),
    );
    if (invalidated.execution.state !== "not-started") throw new Error("策略失效后的写调用竟然执行了");
    if (existsSync(join(WORKDIR, "critical-settings.json"))) throw new Error("旧策略审批越过了执行时授权验证");
    log("· 更换审批判断模型提升策略版本并使旧批准失效，criteriaVersion 固定为 3");
    // ---- room-owned directories: channel, DM, empty scope, delegation ----
    let channelRoom = await createRoom(
      { kind: "channel", name: "共享目录测试" },
      [DIR_A, DIR_B],
      DIR_A,
    );
    const channelPwdStart = await startWorkMessage(channelRoom.id, "请使用 run_shell 执行 pwd", employee.id);
    const channelPwdApproval = await approvalForWork(channelPwdStart.workId, "approved", "频道默认 cwd 自动通过");
    const channelPwdWork = await finishWork(channelPwdStart.workId, "频道默认 cwd 完成");
    if (channelPwdWork.status !== "succeeded") throw new Error("频道 pwd 命令没有成功执行");
    // run_shell returns only an exit-code summary; its canonical cwd is recorded in the approval.
    assertDirectoryScope(channelPwdApproval, channelRoom, [DIR_A, DIR_B], DIR_A);
    await assertShellCwdProof({
      room: channelRoom,
      expectedCwd: DIR_A,
      startWork: async (body) => (await startWorkMessage(channelRoom.id, body, employee.id)).workId,
      description: "频道 A 默认 cwd",
    });

    const channelReadStart = await startWorkMessage(channelRoom.id, "请使用 run_shell 执行 cat notes.txt", employee.id);
    const channelReadApproval = await approvalForWork(channelReadStart.workId, "approved", "频道 cat 自动通过");
    const channelReadWork = await finishWork(channelReadStart.workId, "频道 cat 完成");
    if (channelReadWork.status !== "succeeded") throw new Error("频道 cat 命令没有成功执行");
    assertDirectoryScope(channelReadApproval, channelRoom, [DIR_A, DIR_B], DIR_A);
    for (const command of ["ls", "ls -la", "git status --short", "git diff --stat", "git log --oneline"]) {
      const queryStart = await startWorkMessage(channelRoom.id, `请使用 run_shell 执行 ${command}`, employee.id);
      const queryApproval = await approvalForWork(queryStart.workId, "approved", `${command} 自动通过`);
      await finishWork(queryStart.workId, `${command} 工作完成`);
      if (
        queryApproval.evidence?.outcome !== "allow" ||
        queryApproval.evidence?.risk !== "low" ||
        queryApproval.evidence?.readOnly !== true
      ) {
        throw new Error(`${command} 没有按只读 low/allow 自动通过：${JSON.stringify(queryApproval.evidence)}`);
      }
      assertDirectoryScope(queryApproval, channelRoom, [DIR_A, DIR_B], DIR_A);
    }

    const channelWriteStart = await startWorkMessage(channelRoom.id, "请写一个 channel-marker.txt", employee.id);
    const channelWriteApproval = await approvalForWork(channelWriteStart.workId, "approved", "频道普通写入自动通过");
    await finishWork(channelWriteStart.workId, "频道普通写入完成");
    assertDirectoryScope(channelWriteApproval, channelRoom, [DIR_A, DIR_B], DIR_A, [join(DIR_A, "channel-marker.txt")]);
    if (channelWriteApproval.evidence?.outcome !== "allow" || channelWriteApproval.evidence?.risk !== "medium") {
      throw new Error(`普通小范围写入没有按 medium/allow 自动通过：${JSON.stringify(channelWriteApproval.evidence)}`);
    }
    if (readFileSync(join(DIR_A, "channel-marker.txt"), "utf8") !== "SMOKE-WRITTEN:channel-marker.txt\n") {
      throw new Error("频道默认写入没有落在 A");
    }
    if (existsSync(join(DIR_B, "channel-marker.txt"))) throw new Error("频道默认写入意外落在 B");

    const explicitBStart = await startWorkMessage(channelRoom.id, "请使用 run_shell 显式切换到 B 执行 pwd", employee.id);
    const explicitBApproval = await approvalForWork(explicitBStart.workId, "approved", "显式 cwd=B 自动通过");
    await finishWork(explicitBStart.workId, "显式 cwd=B 完成");
    assertDirectoryScope(explicitBApproval, channelRoom, [DIR_A, DIR_B], DIR_B);
    await assertShellCwdProof({
      room: channelRoom,
      expectedCwd: DIR_B,
      startWork: async (body) => (await startWorkMessage(channelRoom.id, body, employee.id)).workId,
      description: "频道显式 B cwd",
      explicitB: true,
    });

    const channelCoworker = await call("/api/employees", {
      method: "POST",
      body: JSON.stringify({
        name: "频道同事",
        role: "协作",
        instructions: "按会话配置执行本地查询。",
        executionModel: { model: { providerId: "fake", modelId: "fake-chat" }, effort: "off" },
        toolPolicy: { allowedTools: ["run_shell"], trustedReadOnlyTools: [] },
        generateAddress: true,
      }),
    });
    const coworkerDm = await createRoom(
      { kind: "dm", name: "频道同事私信", employeeId: channelCoworker.id },
      [DIR_C],
    );
    if (coworkerDm.directories.paths[0] !== DIR_C) throw new Error("频道同事 DM fixture 没有绑定 C 根");
    const coworkerStart = await startWorkMessage(channelRoom.id, "请使用 run_shell 执行 pwd", channelCoworker.id);
    const coworkerApproval = await approvalForWork(coworkerStart.workId, "approved", "另一频道员工查询通过");
    await finishWork(coworkerStart.workId, "另一频道员工查询完成");
    assertDirectoryScope(coworkerApproval, channelRoom, [DIR_A, DIR_B], DIR_A);
    if (coworkerApproval.directoryPaths.includes(DIR_C)) throw new Error("频道员工继承了同一员工私信的 C 根");

    const delegateChild = await call("/api/employees", {
      method: "POST",
      body: JSON.stringify({
        name: "目录隔离子任务",
        role: "协作",
        instructions: "你是目录隔离子任务，请用 run_shell 执行 pwd。",
        executionModel: { model: { providerId: "fake", modelId: "fake-chat" }, effort: "off" },
        toolPolicy: { allowedTools: ["run_shell"], trustedReadOnlyTools: [] },
        generateAddress: true,
      }),
    });
    const delegateChildDm = await createRoom(
      { kind: "dm", name: "目录子任务私信", employeeId: delegateChild.id },
      [DIR_C],
    );
    if (delegateChildDm.directories.paths[0] !== DIR_C) throw new Error("交办子员工 DM fixture 没有绑定 C 根");
    const delegateParent = await call("/api/employees", {
      method: "POST",
      body: JSON.stringify({
        name: "目录交办员工",
        role: "协作",
        instructions: "把任务交办->目录隔离子任务",
        executionModel: { model: { providerId: "fake", modelId: "fake-chat" }, effort: "off" },
        toolPolicy: { allowedTools: ["delegate_task"], trustedReadOnlyTools: [] },
        generateAddress: true,
      }),
    });
    const delegateRoom = await createRoom(
      { kind: "channel", name: "交办继承目录" },
      [DIR_A, DIR_B],
      DIR_A,
    );
    rmSync(join(DIR_A, "cwd-proof.txt"), { force: true });
    const delegateStart = await startWorkMessage(delegateRoom.id, "开始目录继承交办", delegateParent.id);
    const delegateChildWork = await waitFor("交办子工作使用父会话目录", async () =>
      (await call("/api/works")).find(
        (work) => work.parentWorkId === delegateStart.workId && work.kind === "delegation" && work.status === "succeeded",
      ),
    );
    const delegateApproval = await approvalForWork(delegateChildWork.id, "approved", "交办子工作 pwd 自动通过");
    await finishWork(delegateStart.workId, "交办父工作完成");
    assertDirectoryScope(delegateApproval, delegateRoom, [DIR_A, DIR_B], DIR_A);
    if (!delegateApproval.argumentsPreview.includes("pwd > cwd-proof.txt")) {
      throw new Error("交办子任务没有运行 cwd side-effect 命令");
    }
    if (delegateApproval.directoryPaths.includes(DIR_C)) throw new Error("交办子工作带入同一员工其他私信的 C 根");
    if (readFileSync(join(DIR_A, "cwd-proof.txt"), "utf8") !== `${DIR_A}\n`) {
      throw new Error("交办子任务的 pwd side effect 没有落在父频道的 A 根");
    }
    log("· 频道共享 A/B 默认目录、显式 B、同员工私信 C 隔离和交办目录继承均已验证");

    room = await patchDirectories(room, [DIR_C]);
    if (room.directories.version !== 2 || room.directories.defaultPath !== DIR_C) {
      throw new Error(`私信目录 PATCH 没有更新版本与默认目录：${JSON.stringify(room.directories)}`);
    }
    writeFileSync(join(DIR_C, "context-evidence.txt"), "SMOKE-CONTEXT-HIGH\n");
    await assertShellCwdProof({
      room,
      expectedCwd: DIR_C,
      startWork: async (body) => (await startWorkMessage(room.id, body, employee.id)).workId,
      description: "私信 C 默认 cwd",
    });
    const dmReadStart = await startWorkMessage(room.id, "请用 read_file 读取已读目录标记");
    const dmReadWork = await finishWork(dmReadStart.workId, "私信默认目录读取完成");
    if (!toolOutput(events, dmReadStart.workId).includes("SMOKE-DIRECTORY-C")) {
      throw new Error("同一员工私信没有读取 C 根目录");
    }
    if (dmReadWork.status !== "succeeded") throw new Error(`私信读取失败：${dmReadWork.error}`);
    if ((await call("/api/approvals")).approvals.some((approval) => approval.workId === dmReadStart.workId)) {
      throw new Error("内置 read_file 查询不应进入人工或模型审批");
    }
    const dmWriteStart = await startWorkMessage(room.id, "请写一个 dm-marker.txt");
    const dmWriteApproval = await approvalForWork(dmWriteStart.workId, "approved", "私信普通写入自动通过");
    await finishWork(dmWriteStart.workId, "私信普通写入完成");
    assertDirectoryScope(dmWriteApproval, room, [DIR_C], DIR_C, [join(DIR_C, "dm-marker.txt")]);
    if (!existsSync(join(DIR_C, "dm-marker.txt"))) throw new Error("私信写入没有落在 C");

    for (const [label, body] of [
      ["越权绝对路径", "请用 read_file 验证绝对越权路径"],
      ["越权相对路径", "请用 read_file 验证相对越权路径"],
      ["符号链接逃逸", "请用 read_file 验证符号链接逃逸"],
    ]) {
      const started = await startWorkMessage(room.id, body);
      const work = await finishWork(started.workId, `${label} 被本地目录边界拒绝`);
      if (!toolOutput(events, started.workId).includes("超出该会话允许的目录")) {
        throw new Error(`${label} 没有被会话目录校验拒绝`);
      }
      if ((await call("/api/approvals")).approvals.some((approval) => approval.workId === started.workId)) {
        throw new Error(`${label} 在路径校验失败后错误创建了审批`);
      }
      if (work.status !== "succeeded") throw new Error(`${label} 的工作没有收到工具拒绝结果`);
    }
    if (readFileSync(join(OUTSIDE_DIR, "outside-secret.txt"), "utf8") !== "SMOKE-OUTSIDE-SECRET\n") {
      throw new Error("外部文件 fixture 被意外改动");
    }

    const emptyRoom = await createRoom({ kind: "channel", name: "无目录会话" }, []);
    const emptyStart = await startWorkMessage(emptyRoom.id, "请使用 run_shell 执行 pwd", employee.id);
    const emptyWork = await finishWork(emptyStart.workId, "无目录会话禁止 shell");
    if ((await call("/api/approvals")).approvals.some((approval) => approval.workId === emptyStart.workId)) {
      throw new Error("没有目录的 shell 调用不应进入审批或执行");
    }
    if (toolOutput(events, emptyStart.workId).includes(ROOT)) {
      throw new Error("没有目录的 shell 调用了进程 cwd");
    }
    if (!toolOutput(events, emptyStart.workId).includes("没有默认工作目录")) {
      throw new Error("空目录 Shell 没有返回明确的缺少默认目录错误");
    }
    if (emptyWork.status !== "succeeded") throw new Error(`空目录工作没有收到明确阻止结果：${emptyWork.error}`);

    rmSync(join(DIR_A, "critical-settings.json"), { force: true });
    rmSync(join(DIR_E, "critical-settings.json"), { force: true });
    const unrelatedRoom = await createRoom({ kind: "channel", name: "独立目录审批" }, [DIR_E]);
    const invalidatedStart = await startWorkMessage(channelRoom.id, "请写一个 critical-settings.json", employee.id);
    const invalidatedPending = await approvalForWork(invalidatedStart.workId, "pending-human", "等待修改目录版本");
    const unaffectedStart = await startWorkMessage(unrelatedRoom.id, "请写一个 critical-settings.json", employee.id);
    const unaffectedPending = await approvalForWork(unaffectedStart.workId, "pending-human", "等待独立会话审批");
    const oldChannelVersion = channelRoom.directories.version;
    channelRoom = await patchDirectories(channelRoom, [DIR_A, DIR_B, DIR_E], DIR_A);
    if (channelRoom.directories.version !== oldChannelVersion + 1) throw new Error("实质目录变更没有递增版本");
    const changedApproval = await waitFor("变更目录后旧审批失效", async () =>
      (await call("/api/approvals")).approvals.find(
        (approval) => approval.id === invalidatedPending.id && approval.status === "invalidated",
      ),
    );
    if (changedApproval.execution.state !== "not-started") throw new Error("失效目录的 high 调用仍执行了");
    const stillUnrelated = (await call("/api/approvals")).approvals.find(
      (approval) => approval.id === unaffectedPending.id,
    );
    if (stillUnrelated?.status !== "pending-human") throw new Error("一个会话变更误使另一个会话的审批失效");
    const stalePatch = await fetch(`${BASE}/api/rooms/${channelRoom.id}/directories`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...directories([DIR_A, DIR_B], DIR_A),
        expectedVersion: oldChannelVersion,
      }),
    });
    if (stalePatch.status !== 409) throw new Error(`旧目录版本 PATCH 返回 ${stalePatch.status}，预期 409`);
    const noOpPatch = await patchDirectories(channelRoom, [DIR_A, DIR_B, DIR_E], DIR_A);
    if (noOpPatch.directories.version !== channelRoom.directories.version) throw new Error("无变化的目录 PATCH 递增了版本");
    channelRoom = noOpPatch;
    await call(`/api/works/${unaffectedStart.workId}/stop`, { method: "POST", body: "{}" });
    await waitFor("结束独立会话的 pending high 调用", async () =>
      (await call("/api/approvals")).approvals.find(
        (approval) => approval.id === unaffectedPending.id && approval.status === "cancelled",
      ),
    );
    await finishWork(invalidatedStart.workId, "目录版本失效工作结束");
    if (existsSync(join(DIR_A, "critical-settings.json")) || existsSync(join(DIR_E, "critical-settings.json"))) {
      throw new Error("目录版本失效或停止后的 high 调用产生了副作用");
    }
    log("· 目录版本冲突、无变化 PATCH、按 room 精确失效和高风险无副作用均已验证");

    // ---- complete arguments, active execution context, and blocked reviews ----
    const requestsBeforeTail = (await approvalRequests()).length;
    const tailStart = await startWorkMessage(room.id, "请做一次尾部风险审查");
    const tailPending = await approvalForWork(tailStart.workId, "pending-human", "完整命令后缀识别为 high");
    if (tailPending.evidence?.outcome !== "allow" || tailPending.evidence?.risk !== "high") {
      throw new Error(`完整命令的尾部风险没有送入人工队列：${JSON.stringify(tailPending.evidence)}`);
    }
    if (!tailPending.argumentsPreview.includes("SMOKE-TAIL-MUST-NOT-RUN")) {
      throw new Error("人工预览中缺少长命令危险后缀");
    }
    const tailRequest = (await approvalRequests()).slice(requestsBeforeTail).find(
      (entry) => entry.prompt.includes("SMOKE-TAIL-MUST-NOT-RUN"),
    );
    if (tailRequest === undefined || !tailRequest.prompt.includes("critical-settings.json")) {
      throw new Error("自动审查没有收到超过 400 字符的完整命令后缀");
    }
    const commandPrefix = tailRequest.prompt.indexOf("printf SAFE");
    const commandTail = tailRequest.prompt.indexOf("SMOKE-TAIL-MUST-NOT-RUN");
    if (commandPrefix < 0 || commandTail - commandPrefix < 400) {
      throw new Error("送入审查的完整命令被截掉了 400 字符以上的中间内容");
    }
    await call(`/api/approvals/${tailPending.id}/decision`, {
      method: "POST",
      body: JSON.stringify({ decision: "rejected", comment: "尾部副作用必须留在人工门后" }),
    });
    await waitFor("尾部风险审批拒绝", async () =>
      (await call("/api/approvals")).approvals.find(
        (approval) => approval.id === tailPending.id && approval.status === "rejected",
      ),
    );
    if (existsSync(join(DIR_C, "critical-settings.json"))) throw new Error("未批准的长命令尾部产生了文件副作用");

    const contextStart = await startWorkMessage(room.id, "请根据实际读取到的上下文事实决定写入");
    const contextPending = await approvalForWork(contextStart.workId, "pending-human", "实际工具结果使写入进入 high 人工审查");
    if (contextPending.evidence?.outcome !== "allow" || contextPending.evidence?.risk !== "high") {
      throw new Error(`上下文事实没有改变审查风险：${JSON.stringify(contextPending.evidence)}`);
    }
    const contextRequest = (await approvalRequests()).find(
      (entry) => entry.prompt.includes("context-target.json") && entry.prompt.includes("SMOKE-CONTEXT-HIGH"),
    );
    if (
      contextRequest === undefined ||
      !contextRequest.prompt.includes("execution-context") ||
      !/toolResult/i.test(contextRequest.prompt)
    ) {
      throw new Error("审查没有收到 active execution 中真实 read_file toolResult 的上下文");
    }
    await call(`/api/approvals/${contextPending.id}/decision`, {
      method: "POST",
      body: JSON.stringify({ decision: "rejected", comment: "实际上下文 high fixture 不执行" }),
    });
    await waitFor("上下文 high 审批拒绝", async () =>
      (await call("/api/approvals")).approvals.find(
        (approval) => approval.id === contextPending.id && approval.status === "rejected",
      ),
    );
    if (existsSync(join(DIR_C, "context-target.json"))) throw new Error("上下文触发的未批准写入产生了副作用");
    log("· 完整长参数与真实 read_file/toolResult 上下文都进入审查，危险尾部和上下文 high 均未执行");

    for (const [label, fileName] of [
      ["HTTP reviewer error", "reviewer-http-error.json"],
      ["invalid reviewer JSON", "reviewer-invalid-json.json"],
      ["missing reviewer field", "reviewer-missing-risk.json"],
      ["unknown reviewer risk", "reviewer-unknown.json"],
    ]) {
      const reviewerRequestsBefore = (await approvalRequests()).length;
      const started = await startWorkMessage(room.id, `请写一个 ${fileName}`);
      const blockedApproval = await approvalForWork(started.workId, "blocked", `${label} 被阻止`);
      if (blockedApproval.risk !== "unknown" || blockedApproval.execution.state !== "not-started") {
        throw new Error(`${label} 没有作为 unknown blocked 且保持未执行：${JSON.stringify(blockedApproval)}`);
      }
      if (!blockedApproval.autoDecision?.reason) throw new Error(`${label} 没有记录阻止原因`);
      if ((await call("/api/approvals")).approvals.some(
        (approval) => approval.workId === started.workId && approval.status === "pending-human",
      )) {
        throw new Error(`${label} 错误进入人工队列`);
      }
      await finishWork(started.workId, `${label} 结束工作`);
      if (existsSync(join(DIR_C, fileName))) throw new Error(`${label} 情况下工具仍写了文件`);
      const matchingReviewerCalls = (await approvalRequests())
        .slice(reviewerRequestsBefore)
        .filter((entry) => entry.prompt.includes(fileName));
      if (matchingReviewerCalls.length !== 1) {
        throw new Error(`${label} 应正好调用一次 reviewer，实际 ${matchingReviewerCalls.length}`);
      }
    }

    const reviewCountBeforeBudget = (await approvalRequests()).length;
    const overBudgetStart = await startWorkMessage(room.id, "请使用 run_shell 发起超预算审查");
    const overBudget = await approvalForWork(overBudgetStart.workId, "blocked", "超出 reviewer 输入预算");
    if (overBudget.risk !== "unknown" || overBudget.execution.state !== "not-started") {
      throw new Error("超预算工具参数被截短后误当成可执行调用");
    }
    if (!overBudget.autoDecision?.reason.includes("输入预算")) {
      throw new Error(`参数预算阻止没有呈现具体原因：${overBudget.autoDecision?.reason}`);
    }
    await finishWork(overBudgetStart.workId, "超预算工作结束");
    if (existsSync(join(DIR_C, "overbudget-side-effect.txt"))) throw new Error("超预算命令产生了副作用");
    if ((await approvalRequests()).length !== reviewCountBeforeBudget) {
      throw new Error("完整动作超出审查输入预算时仍调用了 reviewer");
    }

    const exfilStart = await startWorkMessage(room.id, "请使用 run_shell 外传敏感数据");
    const exfilApproval = await approvalForWork(exfilStart.workId, "rejected", "明确外传被自动拒绝");
    if (exfilApproval.evidence?.outcome !== "deny" || exfilApproval.evidence?.risk !== "critical") {
      throw new Error(`敏感数据外传没有按 deny/critical 拒绝：${JSON.stringify(exfilApproval.evidence)}`);
    }
    if (exfilApproval.execution.state !== "not-started") throw new Error("外传命令在自动拒绝前已执行");
    if ((await call("/api/approvals")).approvals.some(
      (approval) => approval.workId === exfilStart.workId && approval.status === "pending-human",
    )) {
      throw new Error("明确禁止的敏感数据外传错误进入人工队列");
    }
    log("· reviewer 失败、结构损坏、预算溢出和 unknown 均阻止；明确外传自动 deny/critical");


    // ---- mail: recipients, copies, and drafts ------------------------------
    const second = await call("/api/employees", {
      method: "POST",
      body: JSON.stringify({
        name: "小柯二",
        role: "文档助手",
        instructions: "简洁回答。",
        executionModel: { model: { providerId: "fake", modelId: "fake-chat" }, effort: "off" },
        toolPolicy: { allowedTools: ["read_file", "write_file"], trustedReadOnlyTools: [] },
        generateAddress: true,
      }),
    });

    const mailRoom = await createRoom({ kind: "mail", name: "冒烟邮件" }, [DIR_D]);

    // A draft is stored but addresses nobody and starts no work.
    const worksBeforeDraft = (await call("/api/works")).length;
    const draft = await call(`/api/rooms/${mailRoom.id}/messages`, {
      method: "POST",
      body: JSON.stringify({
        body: "帮我读一下 notes.txt 并总结",
        subject: "冒烟邮件",
        to: [employee.id],
        cc: [second.id],
        draft: true,
      }),
    });
    if (draft.workId !== undefined) throw new Error("草稿启动了工作");
    const stored = await call(`/api/rooms/${mailRoom.id}/messages`);
    if (stored.messages[0].mail?.draft !== true) throw new Error("草稿没有标记为草稿");
    if (stored.messages[0].mail?.sent === true) throw new Error("草稿不应是已发送");
    if ((await call("/api/works")).length !== worksBeforeDraft) throw new Error("草稿启动了工作");
    log("· 草稿已保存，未投递也未启动工作");

    // Editing a draft retires the old one and keeps exactly one draft.
    const edited = await call(`/api/rooms/${mailRoom.id}/messages`, {
      method: "POST",
      body: JSON.stringify({
        body: "帮我读一下 notes.txt 并总结（改）",
        subject: "冒烟邮件",
        to: [employee.id, second.id],
        cc: [],
        draft: true,
      }),
    });
    await call(`/api/rooms/${mailRoom.id}/mail-flag`, {
      method: "POST",
      body: JSON.stringify({ entryId: draft.message.id, active: false }),
    });
    const draftsLeft = (await call(`/api/rooms/${mailRoom.id}/messages`)).messages.filter(
      (message) => message.mail?.draft === true,
    );
    if (draftsLeft.length !== 1 || draftsLeft[0].id !== edited.message.id) {
      throw new Error(`编辑后草稿数量是 ${draftsLeft.length}`);
    }
    log("· 编辑草稿只留下最新一版");

    // Sending the draft delivers it and wakes every To recipient.
    const worksBeforeSend = (await call("/api/works")).length;
    const sentDraft = await call(`/api/rooms/${mailRoom.id}/mail-send`, {
      method: "POST",
      body: JSON.stringify({ entryId: edited.message.id }),
    });
    if (sentDraft.workIds.length !== 2) throw new Error(`To 里的两位员工应各起一份工作，实际 ${sentDraft.workIds.length}`);
    const afterSend = await call(`/api/rooms/${mailRoom.id}/messages`);
    if (afterSend.messages.some((message) => message.mail?.draft === true)) throw new Error("发送后草稿仍在");
    const sentMail = afterSend.messages.find((message) => message.mail?.sent === true && message.author.type === "user");
    if (sentMail.mail.to.length !== 2) throw new Error("收件人没有全部记录");
    if (sentMail.mail.recipients.length !== 2) throw new Error("收件人员工 id 没有记录");
    log("· 发送草稿后 To 的每位员工各起一份工作");

    const mailReplies = await waitFor("两位员工的邮件答复", async () => {
      const payload = await call(`/api/rooms/${mailRoom.id}/messages`);
      const answers = payload.messages.filter((message) => message.author.type === "employee");
      return answers.length >= 2 ? answers : undefined;
    });
    // Read the address now: the bootstrap snapshot was taken before setup.
    const userAddress = (await call("/api/app")).user.address;
    if (userAddress.length === 0) throw new Error("用户地址为空");
    const senders = new Set(mailReplies.map((message) => message.author.id));
    if (!senders.has(employee.id) || !senders.has(second.id)) throw new Error("答复不是分别来自两位收件人");
    for (const answer of mailReplies) {
      if (answer.mail?.to[0]?.address !== userAddress) throw new Error("答复没有写给原发件人");
      if (answer.mail?.inReplyTo !== sentMail.id) throw new Error("答复没有指向原邮件");
    }
    // Each answer keeps the other recipient in the loop, which is what the
    // client's "reply all" needs to reach everybody.
    for (const answer of mailReplies) {
      const other = answer.author.id === employee.id ? second.id : employee.id;
      if (!answer.mail?.copies.includes(other)) throw new Error("答复没有保留另一位收件人");
    }
    log("· 一封邮件的两位收件人分别答复同一线程，并保留其他收件人");
    for (const workId of sentDraft.workIds) {
      const mailWork = (await call("/api/works")).find((work) => work.id === workId);
      if (mailWork?.roomId !== mailRoom.id || mailWork.kind !== "mail" || mailWork.sourceEntryId !== sentMail.id) {
        throw new Error(`邮件 To 工作没有留在来源 session：${JSON.stringify(mailWork)}`);
      }
      if (!toolOutput(events, workId).includes("SMOKE-DIRECTORY-D")) {
        throw new Error(`邮件 To 工作没有使用该邮件 session 的 D 目录：${workId}`);
      }
    }
    await assertShellCwdProof({
      room: mailRoom,
      expectedCwd: DIR_D,
      startWork: (body) => startMailWorkMessage(mailRoom.id, body, employee.id),
      description: "邮件 D 默认 cwd",
    });

    const flagged = await call(`/api/rooms/${mailRoom.id}/mail-flag`, {
      method: "POST",
      body: JSON.stringify({ entryId: mailReplies[0].id, read: true, archived: true }),
    });
    const marked = flagged.messages.find((message) => message.id === mailReplies[0].id);
    if (marked.mail.read !== true || marked.mail.archived !== true) throw new Error("已读/归档没有保存");
    log("· 已读与归档状态已保存");

    // CC is a copy: it is recorded and never wakes anybody.
    const ccRoom = await createRoom({ kind: "mail", name: "抄送测试" });
    const worksBeforeCc = (await call("/api/works")).length;
    const ccSent = await call(`/api/rooms/${ccRoom.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ body: "帮我读一下 notes.txt", subject: "抄送测试", to: [employee.id], cc: [second.id] }),
    });
    if (ccSent.workIds.length !== 1) throw new Error(`抄送不应启动工作，实际起了 ${ccSent.workIds.length} 份`);
    const ccWorks = (await call("/api/works")).slice(0, (await call("/api/works")).length - worksBeforeCc);
    if (ccWorks.some((work) => work.employeeId === second.id)) throw new Error("抄送对象被唤醒了");
    const ccStored = (await call(`/api/rooms/${ccRoom.id}/messages`)).messages[0];
    if (ccStored.mail.copies.length !== 1 || ccStored.mail.cc.length !== 1) throw new Error("抄送没有被记录");
    log("· 抄送只记录副本，不唤醒员工");

    // Mail addressed to the user alone is delivery, not a task.
    const selfRoom = await createRoom({ kind: "mail", name: "只投递" });
    const worksBeforeSelf = (await call("/api/works")).length;
    await call(`/api/rooms/${selfRoom.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ body: "只记录这封邮件", subject: "只投递", to: ["user"] }),
    });
    await new Promise((resolve) => setTimeout(resolve, 600));
    if ((await call("/api/works")).length !== worksBeforeSelf) throw new Error("发给用户自己的邮件启动了工作");
    log("· 发给用户自己的邮件只投递");

    // ---- a typed address is recorded, never woken --------------------------
    const typedRoom = await createRoom({ kind: "mail", name: "外部地址" });
    const worksBeforeTyped = (await call("/api/works")).length;
    const typed = await call(`/api/rooms/${typedRoom.id}/messages`, {
      method: "POST",
      body: JSON.stringify({
        body: "发给一个目录之外的地址",
        subject: "外部地址",
        to: ["someone@elsewhere.test"],
        cc: ["watch@elsewhere.test"],
      }),
    });
    if ((typed.workIds ?? []).length !== 0) throw new Error("外部地址不应启动工作");
    await new Promise((resolve) => setTimeout(resolve, 400));
    if ((await call("/api/works")).length !== worksBeforeTyped) throw new Error("外部地址启动了工作");
    const typedStored = (await call(`/api/rooms/${typedRoom.id}/messages`)).messages[0];
    if (typedStored.mail.to[0].address !== "someone@elsewhere.test") throw new Error("外部收件人地址没有保存");
    if (typedStored.mail.cc[0].address !== "watch@elsewhere.test") throw new Error("外部抄送地址没有保存");
    if (typedStored.mail.recipients.length !== 0) throw new Error("外部地址被当成了员工");
    const refused = await fetch(`${BASE}/api/rooms/${typedRoom.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "无效收件人", subject: "无效", to: ["没有这个人"] }),
    });
    if (refused.status !== 400) throw new Error(`无效收件人返回了 ${refused.status}`);
    log("· 目录之外的地址按原样记录，无效收件人被拒绝");

    // ---- the mailbox lists exactly what belongs to the user ----------------
    // A mail session's branches keep one room scope; newSession and a newly-created room do not inherit it.
    const graphEmployee = await call("/api/employees", {
      method: "POST",
      body: JSON.stringify({
        name: "邮件图员工",
        role: "协作",
        instructions: "通过 send_mail 将当前邮件继续交给同事。",
        executionModel: { model: { providerId: "fake", modelId: "fake-chat" }, effort: "off" },
        toolPolicy: { allowedTools: ["send_mail"], trustedReadOnlyTools: [] },
        generateAddress: true,
      }),
    });
    const graphRoom = await createRoom({ kind: "mail", name: "员工邮件图" }, [DIR_D]);
    const graphStart = await call(`/api/rooms/${graphRoom.id}/messages`, {
      method: "POST",
      body: JSON.stringify({
        body: "员工续发邮件",
        subject: "员工邮件图起点",
        to: [graphEmployee.id],
      }),
    });
    if (graphStart.workIds.length !== 1) throw new Error("邮件图起点没有只启动 To 收件人工作");
    const graphRootWorkId = graphStart.workIds[0];
    const graphEntry = graphStart.message;
    const graphBranch = await waitFor("员工在同一邮件 session 续发", async () =>
      (await call(`/api/rooms/${graphRoom.id}/messages`)).messages.find(
        (message) =>
          message.author.id === graphEmployee.id &&
          message.author.type === "employee" &&
          message.mail?.subject === "员工续发邮件",
      ),
    );
    if (graphBranch.mail.inReplyTo !== graphEntry.id) throw new Error("邮件 graph 分支没有连接到当前 session 的父 entry");
    const graphBranchWork = await waitFor("邮件 graph 分支的收件人工作", async () =>
      (await call("/api/works")).find(
        (work) => work.sourceEntryId === graphBranch.id && work.kind === "mail" && work.roomId === graphRoom.id,
      ),
    );
    if (graphBranchWork.parentWorkId !== graphRootWorkId) throw new Error("邮件 graph 分支没有记录 caller parentWorkId");
    const graphWriteApproval = await approvalForWork(graphBranchWork.id, "approved", "同 session 收件人普通写入自动通过");
    await finishWork(graphRootWorkId, "邮件图父工作完成");
    await finishWork(graphBranchWork.id, "邮件图分支收件人工作完成");
    assertDirectoryScope(graphWriteApproval, graphRoom, [DIR_D], DIR_D, [join(DIR_D, "graph-marker.txt")]);
    if (!existsSync(join(DIR_D, "graph-marker.txt"))) throw new Error("邮件 graph 分支没有使用来源 session 的 D 根");
    const graphRecipientReply = await waitFor("邮件 graph 收件人同 session 自动回复", async () =>
      (await call(`/api/rooms/${graphRoom.id}/messages`)).messages.find(
        (message) => message.author.id === second.id && message.mail?.inReplyTo === graphBranch.id,
      ),
    );
    if (graphRecipientReply.mail.inReplyTo !== graphBranch.id) throw new Error("邮件 graph 自动回复没有引用分支父 entry");
    if (!(await call("/api/rooms")).some((entry) => entry.id === graphRoom.id && entry.kind === "mail")) {
      throw new Error("邮件 graph 消息离开了原 mail session");
    }
    const multiBranchStart = await call(`/api/rooms/${graphRoom.id}/messages`, {
      method: "POST",
      body: JSON.stringify({
        body: "MAIL_TWO_BRANCHES",
        subject: "双分支父邮件",
        to: [graphEmployee.id],
      }),
    });
    if (multiBranchStart.workIds?.length !== 1) throw new Error("双分支 parent 没有启动唯一 caller work");
    const branchSubjects = ["同 parent 分支一", "同 parent 分支二"];
    const multiBranchEntries = await waitFor("同一 parent 发出两个邮件分支", async () => {
      const messages = (await call(`/api/rooms/${graphRoom.id}/messages`)).messages;
      const found = branchSubjects.map((subject) =>
        messages.find(
          (message) =>
            message.author.id === graphEmployee.id &&
            message.author.type === "employee" &&
            message.mail?.subject === subject,
        ),
      );
      return found.every((message) => message !== undefined) ? found : undefined;
    });
    if (multiBranchEntries.some((entry) => entry.mail.inReplyTo !== multiBranchStart.message.id)) {
      throw new Error("同一 parent 的邮件分支没有引用同一个会话父节点");
    }
    const multiBranchEntryIds = new Set(multiBranchEntries.map((entry) => entry.id));
    const multiBranchWorks = await waitFor("两个 mail branch recipient work", async () => {
      const found = (await call("/api/works")).filter(
        (work) => work.roomId === graphRoom.id && work.kind === "mail" && multiBranchEntryIds.has(work.sourceEntryId),
      );
      return found.length === 2 ? found : undefined;
    });
    await finishWork(multiBranchStart.workIds[0], "双分支 caller 完成");
    for (let index = 0; index < multiBranchEntries.length; index += 1) {
      const entry = multiBranchEntries[index];
      const fileName = index === 0 ? "multi-branch-one.txt" : "multi-branch-two.txt";
      const targetWork = multiBranchWorks.find((work) => work.sourceEntryId === entry.id);
      if (targetWork === undefined || targetWork.parentWorkId !== multiBranchStart.workIds[0]) {
        throw new Error(`邮件分支 ${entry.mail.subject} 没有保留同一个 caller parentWorkId`);
      }
      const branchApproval = await approvalForWork(targetWork.id, "approved", `${entry.mail.subject} 写入自动通过`);
      await finishWork(targetWork.id, `${entry.mail.subject} 收件工作完成`);
      assertDirectoryScope(branchApproval, graphRoom, [DIR_D], DIR_D, [join(DIR_D, fileName)]);
      if (readFileSync(join(DIR_D, fileName), "utf8") !== `SMOKE-WRITTEN:${fileName}\n`) {
        throw new Error(`${entry.mail.subject} 没有共享 mail session 的 D 根`);
      }
    }

    // A work that asks for another employee's reply pauses instead of
    // answering early, and finishes once the real reply is in its context.
    const askBackAsker = await call("/api/employees", {
      method: "POST",
      body: JSON.stringify({
        name: "求助发起员工",
        role: "协作",
        instructions: "需要别人的结果时用 send_mail 求助并等待回信。",
        executionModel: { model: { providerId: "fake", modelId: "fake-chat" }, effort: "off" },
        toolPolicy: { allowedTools: ["send_mail"], trustedReadOnlyTools: [] },
        generateAddress: true,
      }),
    });
    const askBackAnswerer = await call("/api/employees", {
      method: "POST",
      body: JSON.stringify({
        name: "求助应答员工",
        role: "协作",
        instructions: "按请求回信。",
        executionModel: { model: { providerId: "fake", modelId: "fake-chat" }, effort: "off" },
        toolPolicy: { allowedTools: [], trustedReadOnlyTools: [] },
        generateAddress: true,
      }),
    });
    const askBackRoom = await call("/api/rooms", {
      method: "POST",
      body: JSON.stringify({ kind: "mail", name: "求助回信会话" }),
    });
    const askBackStart = await call(`/api/rooms/${askBackRoom.id}/messages`, {
      method: "POST",
      body: JSON.stringify({
        body: "ASK_BACK_START",
        subject: "求助回信",
        to: [askBackAsker.id],
      }),
    });
    if (askBackStart.workIds?.length !== 1) throw new Error("求助场景没有启动唯一发起工作");
    const askBackParent = await waitFor("求助发起工作进入等待回信", async () => {
      const work = (await call("/api/works")).find((entry) => entry.id === askBackStart.workIds[0]);
      return work !== undefined && work.status === "waiting-mail" ? work : undefined;
    });
    if (askBackParent.awaitedMailWorkIds.length !== 1) {
      throw new Error(`等待列表应有一封回信，实际 ${askBackParent.awaitedMailWorkIds.length}`);
    }
    const askBackChild = await waitFor("求助应答工作已持久", async () => {
      const work = (await call("/api/works")).find(
        (entry) => entry.kind === "mail" && entry.employeeId === askBackAnswerer.id && entry.roomId === askBackRoom.id,
      );
      return work !== undefined && work.status !== "succeeded" ? work : undefined;
    });
    if (askBackChild.parentWorkId !== askBackStart.workIds[0]) {
      throw new Error("求助工作没有记录 caller parentWorkId");
    }
    const askBackEarly = (await call(`/api/rooms/${askBackRoom.id}/messages`)).messages.filter(
      (message) => message.body === "提前给出的答复（不应投递）。",
    );
    if (askBackEarly.length !== 0) throw new Error("等待回信前就把提前答案投递了");

    // ---- crash while a work waits for a reply -----------------------------
    // The wait and its link must survive a hard kill: the answer is still owed,
    // the answer text written before the reply was read must still be held.
    const killedWaiting = server;
    const killedWaitingPid = killedWaiting.pid;
    killedWaiting.kill("SIGKILL");
    await once(killedWaiting, "exit");
    server = startServer();
    if (server.pid === killedWaitingPid) throw new Error("等待回信重启没有产生新的进程");
    await waitForServer();
    await collectEvents(events);
    const resumedWait = await waitFor("强杀重启后工作仍在等待同一封回信", async () => {
      const work = (await call("/api/works")).find((entry) => entry.id === askBackStart.workIds[0]);
      return work !== undefined && work.status === "waiting-mail" && work.awaitedMailWorkIds.length === 1 ? work : undefined;
    });
    if (resumedWait.answer !== "提前给出的答复（不应投递）。") {
      throw new Error(`重启后保留的答案变成了 ${resumedWait.answer}`);
    }
    const askBackAfterKill = (await call(`/api/rooms/${askBackRoom.id}/messages`)).messages.filter(
      (message) => message.body === "提前给出的答复（不应投递）。",
    );
    if (askBackAfterKill.length !== 0) throw new Error("重启后把提前答案投递了");
    log("· 强杀重启后仍保留等待中的回信与未投递的答案");

    await fetch(`http://127.0.0.1:${PROVIDER_PORT}/_release_ask_back`, { method: "POST" });
    const askBackDone = await waitFor("求助工作使用回信完成", async () => {
      const work = (await call("/api/works")).find((entry) => entry.id === askBackStart.workIds[0]);
      return work !== undefined && work.status === "succeeded" ? work : undefined;
    });
    if (askBackDone.awaitedMailWorkIds.length !== 0) throw new Error("完成后仍保留等待中的回信");
    const askBackReplies = (await call(`/api/rooms/${askBackRoom.id}/messages`)).messages.filter(
      (message) => message.author.id === askBackAsker.id && message.body === "最终答复：回信结果已使用。",
    );
    if (askBackReplies.length !== 1) {
      throw new Error(`求助发起工作应只投递一次最终答复，实际 ${askBackReplies.length}`);
    }
    const askBackChildReplies = (await call(`/api/rooms/${askBackRoom.id}/messages`)).messages.filter(
      (message) => message.author.id === askBackAnswerer.id && message.body.includes("ASK_BACK_RESULT"),
    );
    if (askBackChildReplies.length !== 1) throw new Error("求助应答员工应只回信一次");
    const askBackChildWorks = (await call("/api/works")).filter(
      (entry) => entry.kind === "mail" && entry.employeeId === askBackAnswerer.id && entry.roomId === askBackRoom.id,
    );
    if (askBackChildWorks.length !== 1) throw new Error("最终答复不应再唤醒一次应答员工");
    log("· 等待回信:提前答案被扣住,回信到达后只投递一次最终答复");

    const mailChainCaller = await call("/api/employees", {
      method: "POST",
      body: JSON.stringify({
        name: "邮件链起始员工",
        role: "协作",
        instructions: "通过 send_mail 开始邮件委托链。",
        executionModel: { model: { providerId: "fake", modelId: "fake-chat" }, effort: "off" },
        toolPolicy: { allowedTools: ["send_mail"], trustedReadOnlyTools: [] },
        generateAddress: true,
      }),
    });
    const mailChainForwarder = await call("/api/employees", {
      method: "POST",
      body: JSON.stringify({
        name: "邮件委托中转",
        role: "协作",
        instructions: "交办->邮件发信子员工\n",
        executionModel: { model: { providerId: "fake", modelId: "fake-chat" }, effort: "off" },
        toolPolicy: { allowedTools: ["delegate_task"], trustedReadOnlyTools: [] },
        generateAddress: true,
      }),
    });
    const mailChainSender = await call("/api/employees", {
      method: "POST",
      body: JSON.stringify({
        name: "邮件发信子员工",
        role: "协作",
        instructions: "使用 send_mail 完成委托邮件。",
        executionModel: { model: { providerId: "fake", modelId: "fake-chat" }, effort: "off" },
        toolPolicy: { allowedTools: ["send_mail"], trustedReadOnlyTools: [] },
        generateAddress: true,
      }),
    });
    const mailChainRoom = await createRoom({ kind: "mail", name: "邮件委托链 D session" }, [DIR_D]);
    const mailChainRoot = await call(`/api/rooms/${mailChainRoom.id}/messages`, {
      method: "POST",
      body: JSON.stringify({
        body: "MAIL_DELEGATION_CHAIN_START",
        subject: "邮件委托链根",
        to: [mailChainCaller.id],
      }),
    });
    if (mailChainRoot.workIds?.length !== 1) throw new Error("邮件委托链没有启动唯一 root work");
    const mailChainForwardEntry = await waitFor("邮件 caller 转发到 mail session", async () =>
      (await call(`/api/rooms/${mailChainRoom.id}/messages`)).messages.find(
        (message) =>
          message.author.id === mailChainCaller.id &&
          message.mail?.subject === "委托邮件中转",
      ),
    );
    if (mailChainForwardEntry.mail.inReplyTo !== mailChainRoot.message.id) {
      throw new Error("邮件委托链第一条 sent mail 没有指向用户 source entry");
    }
    const mailChainForwardWork = await waitFor("邮件委托中转收件 work", async () =>
      (await call("/api/works")).find(
        (work) =>
          work.roomId === mailChainRoom.id &&
          work.kind === "mail" &&
          work.employeeId === mailChainForwarder.id &&
          work.sourceEntryId === mailChainForwardEntry.id,
      ),
    );
    if (mailChainForwardWork.parentWorkId !== mailChainRoot.workIds[0]) {
      throw new Error("邮件委托中转 work 没有保留 caller parentWorkId");
    }
    const mailChainDelegateWork = await waitFor("邮件收件员工交办给 send_mail 员工", async () =>
      (await call("/api/works")).find(
        (work) =>
          work.parentWorkId === mailChainForwardWork.id &&
          work.kind === "delegation" &&
          work.employeeId === mailChainSender.id,
      ),
    );
    const mailChainLastEntry = await waitFor("delegated send_mail 延续 mail session", async () =>
      (await call(`/api/rooms/${mailChainRoom.id}/messages`)).messages.find(
        (message) =>
          message.author.id === mailChainSender.id &&
          message.mail?.subject === "邮件委托链末端",
      ),
    );
    if (mailChainLastEntry.mail.inReplyTo !== mailChainForwardEntry.id) {
      throw new Error("delegated send_mail 没有选最近 parent 的 sent mail entry");
    }
    const mailChainTargetWork = await waitFor("delegated send_mail 的 To work", async () =>
      (await call("/api/works")).find(
        (work) =>
          work.roomId === mailChainRoom.id &&
          work.kind === "mail" &&
          work.sourceEntryId === mailChainLastEntry.id,
      ),
    );
    if (mailChainTargetWork.parentWorkId !== mailChainDelegateWork.id) {
      throw new Error("delegated send_mail recipient work 没有记录 sender parentWorkId");
    }
    const mailChainWriteApproval = await approvalForWork(
      mailChainTargetWork.id,
      "approved",
      "委托邮件最终 recipient 在 D 根写入",
    );
    await finishWork(mailChainRoot.workIds[0], "邮件委托链 root 完成");
    await finishWork(mailChainForwardWork.id, "邮件委托中转 work 完成");
    await finishWork(mailChainDelegateWork.id, "邮件委托 send_mail 子工作完成");
    await finishWork(mailChainTargetWork.id, "委托邮件最终 recipient 完成");
    assertDirectoryScope(mailChainWriteApproval, mailChainRoom, [DIR_D], DIR_D, [join(DIR_D, "delegated-mail-marker.txt")]);
    if (readFileSync(join(DIR_D, "delegated-mail-marker.txt"), "utf8") !== "SMOKE-WRITTEN:delegated-mail-marker.txt\n") {
      throw new Error("delegated send_mail recipient 没有继承邮件 session 的 D 根");
    }

    const staleCaller = await call("/api/employees", {
      method: "POST",
      body: JSON.stringify({
        name: "过期 session 发信员工",
        role: "协作",
        instructions: "STALE_MAIL_START 时尝试续发邮件。",
        executionModel: { model: { providerId: "fake", modelId: "fake-chat" }, effort: "off" },
        toolPolicy: { allowedTools: ["send_mail"], trustedReadOnlyTools: [] },
        generateAddress: true,
      }),
    });
    let staleMailRoom = await createRoom({ kind: "mail", name: "变更前 mail session" }, [DIR_D]);
    const staleMailStart = await call(`/api/rooms/${staleMailRoom.id}/messages`, {
      method: "POST",
      body: JSON.stringify({
        body: "STALE_MAIL_START",
        subject: "目录变更后拒绝旧工作",
        to: [staleCaller.id],
      }),
    });
    if (staleMailStart.workIds?.length !== 1) throw new Error("过期目录测试没有启动唯一 caller work");
    await waitFor("fake caller 进入 stale-mail 暂停点", async () => (await staleMailReady()).ready);
    const staleRoomVersion = staleMailRoom.directories.version;
    staleMailRoom = await patchDirectories(staleMailRoom, [DIR_E], DIR_E);
    if (
      staleMailRoom.directories.version !== staleRoomVersion + 1 ||
      staleMailRoom.directories.defaultPath !== DIR_E
    ) {
      throw new Error("stale send_mail fixture 没有实际提升来源目录版本");
    }
    await releaseStaleMail();
    const staleMailWork = await finishWork(staleMailStart.workIds[0], "目录变更后旧邮件 work 结束");
    if (!toolOutput(events, staleMailWork.id).includes("会话工作目录已变更")) {
      throw new Error("目录版本改变后 send_mail 没有拒绝旧 scope");
    }
    const staleMailMessages = (await call(`/api/rooms/${staleMailRoom.id}/messages`)).messages;
    if (staleMailMessages.some((message) => message.mail?.subject === "过期目录续发")) {
      throw new Error("旧 directoryScope 的 send_mail 仍写入了邮件分支");
    }
    if ((await call("/api/rooms")).some((entry) => entry.kind === "mail" && entry.name === "过期目录续发")) {
      throw new Error("目录版本改变后 send_mail 新建了邮件 session");
    }
    log("· 同 parent 多分支共享 D，delegation send_mail 追溯最近 sent entry，旧目录版本续发被拒绝");
    const badNewSessionStart = await call(`/api/rooms/${graphRoom.id}/messages`, {
      method: "POST",
      body: JSON.stringify({
        body: `新会话错误父引用 entry=${graphEntry.id}`,
        subject: "拒绝跨会话父节点",
        to: [graphEmployee.id],
      }),
    });
    if (badNewSessionStart.workIds?.length !== 1) throw new Error("跨会话父节点 fixture 没有启动唯一来源工作");
    await finishWork(badNewSessionStart.workIds[0], "newSession 与旧 inReplyTo 冲突被拒绝");
    if (!toolOutput(events, badNewSessionStart.workIds[0]).includes("新邮件会话不能引用旧会话的 inReplyTo")) {
      throw new Error("newSession 同时提供旧 inReplyTo 没有明确报错");
    }
    if ((await call("/api/rooms")).some((entry) => entry.kind === "mail" && entry.name === "新会话错误父引用")) {
      throw new Error("newSession/inReplyTo 冲突时仍创建了 session");
    }


    const newSessionStart = await call(`/api/rooms/${graphRoom.id}/messages`, {
      method: "POST",
      body: JSON.stringify({
        body: "员工续发新会话",
        subject: "员工续发新会话",
        to: [graphEmployee.id],
      }),
    });
    if (newSessionStart.workIds?.length !== 1) throw new Error("newSession 请求没有启动唯一来源工作");
    const newSessionRoom = await waitFor("发现新邮件 session", async () =>
      (await call("/api/rooms")).find(
        (entry) => entry.kind === "mail" && entry.id !== graphRoom.id && entry.name === "员工续发新会话",
      ),
    );
    const newSessionBranch = await waitFor("send_mail newSession 创建独立邮件 session", async () =>
      (await call(`/api/rooms/${newSessionRoom.id}/messages`)).messages.find(
        (message) =>
          message.author.id === graphEmployee.id &&
          message.author.type === "employee" &&
          message.mail?.subject === "员工续发新会话",
      ),
    );
    if (newSessionBranch.mail.inReplyTo === graphEntry.id) throw new Error("newSession 错误引用了旧 session 父邮件");
    if (newSessionRoom.directories.paths.length !== 0 || newSessionRoom.directories.defaultPath !== "") {
      throw new Error(`newSession 继承了旧的 D 工作目录：${JSON.stringify(newSessionRoom.directories)}`);
    }
    const newSessionWork = await waitFor("newSession 收件人工作启动", async () =>
      (await call("/api/works")).find(
        (work) => work.sourceEntryId === newSessionBranch.id && work.roomId === newSessionRoom.id,
      ),
    );
    if (newSessionWork.parentWorkId !== newSessionStart.workIds[0]) {
      throw new Error("newSession 邮件工作没有记录发起方工作边");
    }
    await finishWork(newSessionWork.id, "newSession 空目录读取被拒绝");
    if (toolOutput(events, newSessionWork.id).includes("SMOKE-DIRECTORY-D")) {
      throw new Error("send_mail newSession 继承了旧 mail session 的 D 文件权限");
    }
    if ((await call("/api/approvals")).approvals.some((approval) => approval.workId === newSessionWork.id)) {
      throw new Error("空目录 newSession 的本地读取错误进入了审批");
    }

    const independentMailRoom = await createRoom({ kind: "mail", name: "同收件人独立 E 邮件" }, [DIR_E]);
    if (independentMailRoom.id === graphRoom.id || independentMailRoom.id === mailRoom.id) {
      throw new Error("新建的 mail session 被按收件员工全局复用了");
    }
    const crossSessionParent = await fetch(`${BASE}/api/rooms/${independentMailRoom.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        body: "不能跨 session 回复",
        subject: "跨 session 拒绝",
        to: [employee.id],
        inReplyTo: graphEntry.id,
      }),
    });
    if (crossSessionParent.status !== 400) throw new Error(`跨 session inReplyTo 返回 ${crossSessionParent.status}`);
    const independentStart = await call(`/api/rooms/${independentMailRoom.id}/messages`, {
      method: "POST",
      body: JSON.stringify({
        body: "帮我读一下 notes.txt",
        subject: "E 根独立读取",
        to: [employee.id],
      }),
    });
    if (independentStart.workIds?.length !== 1) throw new Error("独立邮件 room 没有启动唯一 To 工作");
    const independentWork = await finishWork(independentStart.workIds[0], "独立 E 邮件工作完成");
    if (independentWork.roomId !== independentMailRoom.id || !toolOutput(events, independentWork.id).includes("SMOKE-DIRECTORY-E")) {
      throw new Error("同一收件员工的新 mail room 没有使用独立 E 根");
    }

    const replyRoom = await createRoom({ kind: "mail", name: "用户回复父节点" }, [DIR_D]);
    const originalUserMail = await call(`/api/rooms/${replyRoom.id}/messages`, {
      method: "POST",
      body: JSON.stringify({
        body: "原始邮件",
        subject: "回复测试原信",
        to: [second.id],
      }),
    });
    const userReply = await call(`/api/rooms/${replyRoom.id}/messages`, {
      method: "POST",
      body: JSON.stringify({
        body: "用户回复原信",
        subject: "回复测试",
        to: [second.id],
        inReplyTo: originalUserMail.message.id,
      }),
    });
    if (userReply.message.mail?.inReplyTo !== originalUserMail.message.id) {
      throw new Error("用户邮件回复没有保留 inReplyTo");
    }
    const repliedAnswer = await waitFor("用户回复收到同 session 员工答案", async () =>
      (await call(`/api/rooms/${replyRoom.id}/messages`)).messages.find(
        (message) => message.author.id === second.id && message.mail?.inReplyTo === userReply.message.id,
      ),
    );
    if (repliedAnswer.mail.inReplyTo !== userReply.message.id) throw new Error("员工自动回复没有引用用户回复 entry");
    log("· 邮件 reply/graph 延续相同 session 与父节点，newSession 与同收件人的新邮件使用空/独立目录");
    await call(`/api/rooms/${mailRoom.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ body: "留一封草稿", subject: "冒烟邮件", to: [employee.id], draft: true }),
    });
    const mailbox = (await call("/api/mail")).items;
    if (!mailbox.some((item) => item.message.mail?.draft === true)) throw new Error("草稿不在邮箱里");
    if (!mailbox.some((item) => item.roomId === typedRoom.id)) throw new Error("自己发的邮件不在邮箱里");
    if (!mailbox.some((item) => item.message.author.address === second.address)) {
      throw new Error("员工发给用户的答复不在邮箱里");
    }
    const strays = mailbox.filter(
      (item) =>
        item.message.author.id !== "user" &&
        !item.message.mail.to.some((entry) => entry.address === userAddress) &&
        !item.message.mail.cc.some((entry) => entry.address === userAddress),
    );
    if (strays.length > 0) throw new Error(`邮箱里混入了不是发给用户的邮件：${strays.length} 封`);
    log("· 邮箱只包含用户自己的邮件，含草稿与自发件");

    // ---- a tool outside the allow list is blocked, without an approval -----
    const readonlyDir = join(WORKDIR, "readonly");
    mkdirSync(readonlyDir, { recursive: true });
    const readonly = await call("/api/employees", {
      method: "POST",
      body: JSON.stringify({
        name: "只读员工",
        role: "只读资料",
        instructions: "只读工作目录。",
        executionModel: { model: { providerId: "fake", modelId: "fake-chat" }, effort: "off" },
        toolPolicy: { allowedTools: ["read_file"], trustedReadOnlyTools: [] },
        generateAddress: true,
      }),
    });
    const readonlyRoom = await createRoom({ kind: "dm", name: readonly.name, employeeId: readonly.id }, [readonlyDir]);
    await call(`/api/rooms/${readonlyRoom.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ body: "请使用 run_shell 执行 ls" }),
    });
    const blocked = await waitFor("只读员工的工作结束", async () => {
      const finished = (await call("/api/works")).filter(
        (work) => work.roomId === readonlyRoom.id && work.status !== "running" && work.status !== "queued",
      );
      return finished.length > 0 ? finished[finished.length - 1] : undefined;
    });
    if (blocked.status !== "succeeded") throw new Error(`被阻止的调用让工作变成了 ${blocked.status}: ${blocked.error}`);
    const blockedAnswer = (await call(`/api/rooms/${readonlyRoom.id}/messages`)).messages.filter(
      (message) => message.author.type === "employee",
    );
    if (!blockedAnswer.some((message) => message.body.includes("被阻止"))) {
      throw new Error("模型没有收到工具被阻止的结果");
    }
    if (existsSync(join(readonlyDir, "result.txt"))) throw new Error("越权写入了文件");
    const blockedApprovals = (await call("/api/approvals")).approvals.filter(
      (approval) => approval.workId === blocked.workId,
    );
    if (blockedApprovals.length !== 0) throw new Error("员工无 run_shell 权限时不应创建审批");

    // ---- a model that disappears stops new work, without a fake answer -----
    const vanishedRoom = readonlyRoom;
    const answersBefore = (await call(`/api/rooms/${vanishedRoom.id}/messages`)).messages.filter(
      (message) => message.author.type === "employee",
    ).length;
    await call("/api/providers/custom", { method: "PUT", body: JSON.stringify({ providers: [] }) });
    const refusedWork = await call(`/api/rooms/${vanishedRoom.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ body: "模型还在吗" }),
    });
    if ((refusedWork.error ?? "").length === 0) throw new Error("模型不可用时仍然启动了工作");
    if (!refusedWork.error.includes("模型不可用")) throw new Error(`失败原因不清楚: ${refusedWork.error}`);
    const vanishedMessages = (await call(`/api/rooms/${vanishedRoom.id}/messages`)).messages;
    const answersAfter = vanishedMessages.filter((message) => message.author.type === "employee").length;
    if (answersAfter !== answersBefore) throw new Error("模型不可用却出现了员工回答");
    if ((await call("/api/works")).some((work) => work.status === "running")) {
      throw new Error("模型不可用却留下了运行中的工作");
    }
    await call("/api/providers/custom", { method: "PUT", body: JSON.stringify({ providers: [providerConfig] }) });
    log("· 模型消失时启动工作会明确失败，且没有编造回答");

    // ---- skills: import, bind, read on demand ------------------------------
    const skillDir = join(WORKDIR, "skills", "smoke-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      [
        "---",
        "name: smoke-review",
        "description: 冒烟用的评审技能",
        "---",
        "",
        "# 冒烟技能",
        "",
        "正文里有一句只能通过 load_skill 读到的话：SMOKE-SKILL-BODY。",
        "",
      ].join("\n"),
    );
    const imported = await call("/api/skills/import", {
      method: "POST",
      body: JSON.stringify({ directory: join(WORKDIR, "skills") }),
    });
    const skill = imported.imported.find((entry) => entry.name === "smoke-review");
    if (skill === undefined) throw new Error("技能没有被导入");
    if ((await call("/api/skills")).skills.length !== imported.imported.length) throw new Error("技能列表不一致");
    const skillEmployee = await call("/api/employees", {
      method: "POST",
      body: JSON.stringify({
        name: "技能员工",
        role: "评审",
        instructions: "按绑定的技能工作。",
        executionModel: { model: { providerId: "fake", modelId: "fake-chat" }, effort: "off" },
        toolPolicy: {
          allowedTools: ["read_file", "load_skill"],
          trustedReadOnlyTools: ["load_skill"],
        },
        skillIds: [skill.id],
        generateAddress: true,
      }),
    });
    const skillRoom = await createRoom({ kind: "dm", name: skillEmployee.name, employeeId: skillEmployee.id });
    await call(`/api/rooms/${skillRoom.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ body: "用你的技能（skill）看看" }),
    });
    const skillWork = await waitFor("技能员工的工作结束", async () => {
      const finished = (await call("/api/works")).filter(
        (work) => work.roomId === skillRoom.id && work.status !== "running" && work.status !== "queued",
      );
      return finished.length > 0 ? finished[finished.length - 1] : undefined;
    });
    if (skillWork.status !== "succeeded") throw new Error(`技能流程失败：${skillWork.error}`);
    const skillMessages = (await call(`/api/rooms/${skillRoom.id}/messages`)).messages;
    if (!skillMessages.some((message) => message.body.includes("SMOKE-SKILL-BODY"))) {
      throw new Error("load_skill 没有把技能正文交给模型");
    }
    log("· 技能导入、绑定与按需读取全链路可用");

    // ---- delegation: a chain, its budget, and a cycle -----------------------
    const chainEmployee = async (name, instruction) =>
      call("/api/employees", {
        method: "POST",
        body: JSON.stringify({
          name,
          role: "协作",
          instructions: instruction,
          executionModel: { model: { providerId: "fake", modelId: "fake-chat" }, effort: "off" },
          toolPolicy: { allowedTools: ["read_file"], trustedReadOnlyTools: ["read_file"] },
          generateAddress: true,
        }),
      });

    // One cross-employee wake is allowed, so the second hop must be refused by
    // the budget rather than looping.
    await call("/api/app", {
      method: "PATCH",
      body: JSON.stringify({ collaboration: { maxDepth: 3, maxCrossEmployeeWakes: 1, maxModelTurns: 40 } }),
    });
    const chainA = await chainEmployee("链甲", "把任务交办->链乙");
    await chainEmployee("链乙", "把任务交办->链丙");
    await chainEmployee("链丙", "把任务交办->链丁");
    await chainEmployee("链丁", "结束任务。");
    const chainRoom = await createRoom({ kind: "dm", name: chainA.name, employeeId: chainA.id });
    const chainStarted = await call(`/api/rooms/${chainRoom.id}/messages`, { method: "POST", body: JSON.stringify({ body: "开始" }) });
    const delegation = await waitFor("交办链停下", async () => {
      const all = await call("/api/works");
      const delegations = all.filter((work) => work.rootWorkId === chainStarted.workId && work.kind === "delegation");
      const running = all.filter((work) => work.rootWorkId === chainStarted.workId && (work.status === "running" || work.status === "queued"));
      if (delegations.length === 0 || running.length > 0) return undefined;
      return delegations;
    });
    // One wake is all the budget allows, so only the first hop happens.
    if (delegation.length !== 1) throw new Error(`交办次数不对：${delegation.length}`);
    if (delegation[0].depth !== 1 || delegation[0].kind !== "delegation") {
      throw new Error(`交办记录不对：${JSON.stringify(delegation[0])}`);
    }
    if (!(delegation[0].answer ?? "").includes("跨员工唤醒上限")) {
      throw new Error(`跨员工唤醒上限没有生效：${delegation[0].answer}`);
    }
    const chainMessages = (await call(`/api/rooms/${chainRoom.id}/messages`)).messages;
    if (!chainMessages.some((message) => message.body.includes("链上已完成"))) {
      throw new Error("交办结果没有回到发起会话");
    }
    log("· 跨员工唤醒上限让交办链条在第一跳后停下，结果回到发起会话");

    // The depth limit is the other stop: with a budget to spare, the chain
    // stops when the next hop would be too deep.
    await call("/api/app", {
      method: "PATCH",
      body: JSON.stringify({ collaboration: { maxDepth: 2, maxCrossEmployeeWakes: 12, maxModelTurns: 40 } }),
    });
    const beforeDepth = new Set((await call("/api/works")).map((work) => work.id));
    const depthA = (await call("/api/bootstrap")).employees.find((entry) => entry.name === "链甲");
    const depthRoom = await createRoom({ kind: "dm", name: depthA.name, employeeId: depthA.id });
    await call(`/api/rooms/${depthRoom.id}/messages`, { method: "POST", body: JSON.stringify({ body: "开始" }) });
    const depthStopped = await waitFor("深度上限让交办停下", async () => {
      const works = await call("/api/works");
      const fresh = works.filter((work) => !beforeDepth.has(work.id) && work.kind === "delegation");
      const running = works.filter((work) => work.status === "running" || work.status === "queued");
      if (fresh.length < 2 || running.length > 0) return undefined;
      await new Promise((resolve) => setTimeout(resolve, 800));
      return fresh;
    });
    if (depthStopped.length !== 2) throw new Error(`深度阶段交办次数不对：${depthStopped.length}`);
    const depths = depthStopped.map((work) => work.depth).sort();
    if (depths.join(",") !== "1,2") throw new Error(`交办层数不对：${depths.join(",")}`);
    if (!depthStopped.some((work) => (work.answer ?? "").includes("交办层数"))) {
      throw new Error(`层数上限没有生效：${JSON.stringify(depthStopped.map((work) => work.answer))}`);
    }
    log("· 交办层数到达上限后停下");

    // A cycle is refused where it forms, not after the depth limit runs out.
    await call("/api/app", {
      method: "PATCH",
      body: JSON.stringify({ collaboration: { maxDepth: 3, maxCrossEmployeeWakes: 12, maxModelTurns: 40 } }),
    });
    const beforeCycle = new Set((await call("/api/works")).map((work) => work.id));
    const cycleA = await chainEmployee("环甲", "把任务交办->环乙");
    await chainEmployee("环乙", "把任务交办->环甲");
    const cycleRoom = await createRoom({ kind: "dm", name: cycleA.name, employeeId: cycleA.id });
    await call(`/api/rooms/${cycleRoom.id}/messages`, { method: "POST", body: JSON.stringify({ body: "开始" }) });
    const cycleDelegations = await waitFor("循环交办停下", async () => {
      const works = await call("/api/works");
      const fresh = works.filter((work) => !beforeCycle.has(work.id) && work.kind === "delegation");
      const running = works.filter((work) => work.status === "running" || work.status === "queued");
      if (fresh.length === 0 || running.length > 0) return undefined;
      // Let the run settle: a refused delegation is answered in the same work.
      await new Promise((resolve) => setTimeout(resolve, 800));
      return fresh;
    });
    if (cycleDelegations.length !== 1) throw new Error(`循环交办没有立刻停下：${cycleDelegations.length}`);
    if (!(cycleDelegations[0].answer ?? "").includes("会形成循环")) {
      throw new Error(`循环交办的原因不对：${cycleDelegations[0].answer}`);
    }
    log("· 交办回上级被直接拒绝，没有形成循环");

    // ---- MCP: connect, discover, gate, call --------------------------------
    const mcpServer = await call("/api/mcp", {
      method: "POST",
      body: JSON.stringify({
        name: "fixture",
        transport: "stdio",
        command: process.execPath,
        args: [join(ROOT, "tmp", "fake-mcp.mjs")],
        cwd: WORKDIR,
        enabled: true,
      }),
    });
    const connected = await call(`/api/mcp/${mcpServer.id}/connect`, { method: "POST", body: "{}" });
    if (!connected.ok) throw new Error(`MCP 连接失败：${connected.message}`);
    const discovered = (await call("/api/mcp")).servers.find((server) => server.id === mcpServer.id);
    if (discovered.connection.state !== "connected") throw new Error(`MCP 状态是 ${discovered.connection.state}`);
    const toolNames = discovered.tools.map((tool) => tool.name).sort();
    if (toolNames.join(",") !== "echo_notes,shout") throw new Error(`发现的工具不对：${toolNames.join(",")}`);
    if (!discovered.tools.some((tool) => tool.name === "echo_notes" && tool.readOnly === true)) {
      throw new Error("MCP fixture 没有暴露 readOnlyHint=true");
    }

    // A tool the employee trusts as read-only runs without an approval; the
    // server's own readOnlyHint is not enough on its own.
    const mcpEmployee = await call("/api/employees", {
      method: "POST",
      body: JSON.stringify({
        name: "MCP 员工",
        role: "资料",
        instructions: "用 MCP 工具读资料。",
        executionModel: { model: { providerId: "fake", modelId: "fake-chat" }, effort: "off" },
        toolPolicy: {
          allowedTools: ["read_file", "mcp__fixture__echo_notes"],
          trustedReadOnlyTools: ["fixture/echo_notes"],
        },
        mcpServerIds: [mcpServer.id],
        generateAddress: true,
      }),
    });
    const mcpRoom = await createRoom({ kind: "dm", name: mcpEmployee.name, employeeId: mcpEmployee.id });
    await call(`/api/rooms/${mcpRoom.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ body: "用 MCP 工具看看笔记" }),
    });
    const mcpWork = await waitFor("MCP 员工的工作结束", async () => {
      const finished = (await call("/api/works")).filter(
        (work) => work.roomId === mcpRoom.id && work.status !== "running" && work.status !== "queued",
      );
      return finished.length > 0 ? finished[finished.length - 1] : undefined;
    });
    if (mcpWork.status !== "succeeded") throw new Error(`MCP 调用让工作变成了 ${mcpWork.status}: ${mcpWork.error}`);
    const mcpAnswers = (await call(`/api/rooms/${mcpRoom.id}/messages`)).messages.filter(
      (message) => message.author.type === "employee",
    );
    if (!mcpAnswers.some((message) => message.body.includes("已完成"))) {
      throw new Error("MCP 调用的结果没有回到模型");
    }
    const mcpApprovals = (await call("/api/approvals")).approvals.filter((approval) => approval.workId === mcpWork.id);
    if (mcpApprovals.length !== 0) throw new Error("已信任的 MCP 工具不该请求审批");
    log(`· MCP 连接、发现 ${toolNames.length} 个工具并完成了受信任的调用`);

    // The same readOnlyHint=true MCP tool is still judged by its actual action.
    const untrusted = await call("/api/employees", {
      method: "POST",
      body: JSON.stringify({
        name: "MCP 未信任员工",
        role: "资料",
        instructions: "用 MCP 工具读资料。",
        executionModel: { model: { providerId: "fake", modelId: "fake-chat" }, effort: "off" },
        toolPolicy: { allowedTools: ["mcp__fixture__echo_notes"], trustedReadOnlyTools: [] },
        mcpServerIds: [mcpServer.id],
        generateAddress: true,
      }),
    });
    const untrustedRoom = await createRoom({ kind: "dm", name: untrusted.name, employeeId: untrusted.id });
    const lowMcpStart = await call(`/api/rooms/${untrustedRoom.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ body: "用 MCP 工具看看笔记" }),
    });
    const lowMcp = await waitFor("普通 MCP 查询自动通过", async () =>
      (await call("/api/approvals")).approvals.find(
        (approval) => approval.workId === lowMcpStart.workId && approval.status === "approved",
      ),
    );
    if (lowMcp.evidence?.kind !== "llm" || lowMcp.evidence.outcome !== "allow" || lowMcp.evidence.risk !== "low") {
      throw new Error(`普通 MCP 查询未按 low/allow 自动通过：${JSON.stringify(lowMcp.evidence)}`);
    }
    const lowMcpWork = await waitFor("普通 MCP 查询工作成功", async () =>
      (await call("/api/works")).find((work) => work.id === lowMcpStart.workId && work.status === "succeeded"),
    );
    if (lowMcp.execution.state !== "succeeded" || lowMcpWork.status !== "succeeded") {
      throw new Error("自动通过的普通 MCP 查询没有执行");
    }
    log("· 未信任 MCP 的普通查询由模型按 low/allow 自动通过");

    const emptyMcpRoom = await createRoom({ kind: "channel", name: "无本地目录的 MCP" }, []);
    const mcpTargetBefore = (await call("/api/mcp")).servers.find((server) => server.id === mcpServer.id)?.target;
    const emptyMcpStart = await call(`/api/rooms/${emptyMcpRoom.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ body: "用 MCP 工具看看笔记", employeeId: mcpEmployee.id }),
    });
    const emptyMcpWork = await waitFor("空本地目录的 MCP 调用完成", async () =>
      (await call("/api/works")).find((work) => work.id === emptyMcpStart.workId && work.status === "succeeded"),
    );
    if (emptyMcpWork.status !== "succeeded") throw new Error(`空本地目录禁用了远程 MCP：${emptyMcpWork.error}`);
    if ((await call("/api/approvals")).approvals.some((approval) => approval.workId === emptyMcpStart.workId)) {
      throw new Error("信任的只读 MCP 在空本地目录会话中仍创建审批");
    }
    const mcpAfterEmptyScope = (await call("/api/mcp")).servers.find((server) => server.id === mcpServer.id);
    if (mcpTargetBefore !== mcpAfterEmptyScope?.target || mcpAfterEmptyScope?.connection.state !== "connected") {
      throw new Error("会话目录配置改变了独立 MCP 服务配置或连接状态");
    }
    log("· 空本地目录不禁用受信任 MCP，服务配置保持独立");

    const highMcpStart = await call(`/api/rooms/${untrustedRoom.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ body: "用 MCP 工具触发受控高风险审查" }),
    });
    const highMcp = await waitFor("readOnlyHint MCP 高风险调用等待人工", async () =>
      (await call("/api/approvals")).approvals.find(
        (approval) => approval.workId === highMcpStart.workId && approval.status === "pending-human",
      ),
    );
    if (highMcp.toolName !== "mcp__fixture__echo_notes" || highMcp.argumentsPreview !== '{"path":"SMOKE-CONTROLLED-HIGH"}') {
      throw new Error(`高风险 MCP 审批没有保留真实调用参数：${JSON.stringify(highMcp)}`);
    }
    if (
      highMcp.evidence?.kind !== "llm" ||
      highMcp.evidence.outcome !== "allow" ||
      highMcp.evidence.risk !== "high"
    ) {
      throw new Error(`readOnlyHint=true 的高风险 MCP 调用没有转人工：${JSON.stringify(highMcp.evidence)}`);
    }
    const highMcpBefore = (await call(`/api/rooms/${untrustedRoom.id}/messages`)).messages.filter(
      (message) => message.author.type === "employee",
    ).length;
    await call(`/api/approvals/${highMcp.id}/decision`, {
      method: "POST",
      body: JSON.stringify({ decision: "approved", comment: "受控 MCP high fixture" }),
    });
    await waitFor("高风险 MCP 获批后完成", async () =>
      (await call("/api/works")).find((work) => work.id === highMcpStart.workId && work.status === "succeeded"),
    );
    const highMcpAfter = (await call(`/api/rooms/${untrustedRoom.id}/messages`)).messages.filter(
      (message) => message.author.type === "employee",
    );
    if (highMcpAfter.length !== highMcpBefore + 1) throw new Error("高风险 MCP 获批后没有完成回答");
    const decidedMcp = (await call("/api/approvals")).approvals.find((approval) => approval.id === highMcp.id);
    if (decidedMcp.execution.state !== "succeeded") throw new Error(`高风险 MCP 执行状态是 ${decidedMcp.execution.state}`);
    log("· readOnlyHint=true 不覆盖具体 high 判定，人工批准后 MCP 才执行");

    const secretReadStart = await call(`/api/rooms/${untrustedRoom.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ body: "用 MCP 工具读取密钥" }),
    });
    const secretRead = await waitFor("敏感路径读取按低风险自动通过", async () =>
      (await call("/api/approvals")).approvals.find(
        (approval) => approval.workId === secretReadStart.workId && approval.status === "approved",
      ),
    );
    if (secretRead.evidence?.outcome !== "allow" || secretRead.evidence.risk !== "low") {
      throw new Error(`只读取潜在凭据被错误升级风险：${JSON.stringify(secretRead.evidence)}`);
    }

    const unknownMcpStart = await call(`/api/rooms/${untrustedRoom.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ body: "用 MCP 工具读取不确定内容" }),
    });
    const unknownMcp = await waitFor("unknown 风险 MCP 被阻止", async () =>
      (await call("/api/approvals")).approvals.find(
        (approval) => approval.workId === unknownMcpStart.workId && approval.status === "blocked",
      ),
    );
    if (unknownMcp.evidence?.risk !== "unknown") throw new Error("unknown 风险没有保留为 unknown");
    if ((await call("/api/approvals")).approvals.some(
      (approval) => approval.workId === unknownMcpStart.workId && approval.status === "pending-human",
    )) {
      throw new Error("unknown 风险进入了人工队列");
    }
    log("· 潜在凭据的普通读取不自动升高风险，unknown 则阻止且不进入人工队列");

    // A server that cannot start is reported as an error and can be retried.
    const broken = await call("/api/mcp", {
      method: "POST",
      body: JSON.stringify({
        name: "broken",
        transport: "stdio",
        command: join(ROOT, "tmp", "does-not-exist.mjs"),
        enabled: true,
      }),
    });
    const brokenResult = await call(`/api/mcp/${broken.id}/connect`, { method: "POST", body: "{}" });
    if (brokenResult.ok) throw new Error("不存在的 MCP 命令竟然连上了");
    const brokenRecord = (await call("/api/mcp")).servers.find((server) => server.id === broken.id);
    if (brokenRecord.connection.state !== "error") throw new Error("MCP 失败状态没有记录");
    if ((brokenRecord.connection.message ?? "").length === 0) throw new Error("MCP 失败没有原因");
    log("· 无法启动的 MCP server 记录为错误并保留原因");

    // ---- OpenCode Go employee: one session per durable conversation --------
    const goEmployee = await call("/api/employees", {
      method: "POST",
      body: JSON.stringify({
        name: "Go 员工",
        role: "资料助手",
        instructions: "读取工作目录内的文件并汇报。",
        executionModel: { model: { providerId: "opencode-go", modelId: "deepseek-v4.1-flash" }, effort: "low" },
        toolPolicy: { allowedTools: ["read_file"], trustedReadOnlyTools: [] },
        generateAddress: true,
      }),
    });
    const goRoom = await createRoom({ kind: "dm", name: goEmployee.name, employeeId: goEmployee.id });

    const goBeforeFirst = (await goSessions()).length;
    await call(`/api/rooms/${goRoom.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ body: "帮我读一下 notes.txt" }),
    });
    const goWork = await waitFor("Go 员工的工作结束", async () => {
      const finished = (await call("/api/works")).filter(
        (work) => work.roomId === goRoom.id && work.status !== "running" && work.status !== "queued",
      );
      return finished.length > 0 ? finished[finished.length - 1] : undefined;
    });
    if (goWork.status !== "succeeded") throw new Error(`Go 员工的工作状态是 ${goWork.status}: ${goWork.error}`);
    const goAnswers = (await call(`/api/rooms/${goRoom.id}/messages`)).messages.filter(
      (message) => message.author.type === "employee",
    );
    if (!goAnswers.some((message) => message.body.includes("已完成"))) {
      throw new Error("Go 员工的回答没有回到会话");
    }
    const firstSessions = (await goSessions()).slice(goBeforeFirst).map((entry) => entry.sessionId);
    if (firstSessions.length < 2) throw new Error(`Go 员工的多轮请求不足：${firstSessions.length}`);
    if (new Set(firstSessions).size !== 1) {
      throw new Error(`同一会话的请求使用了不同 session：${firstSessions.join(",")}`);
    }
    const workSession = firstSessions[0];
    if (!/^\d+$/.test(workSession)) throw new Error(`会话 id 不是持久化会话号：${workSession}`);
    if (workSession === checkSession) throw new Error("员工会话与连接检查共用了 session");

    // A second work is a different conversation and must not reuse the session.
    const goBeforeSecond = (await goSessions()).length;
    await call(`/api/rooms/${goRoom.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ body: "再读一次 notes.txt" }),
    });
    const goWork2 = await waitFor("Go 员工的第二项工作结束", async () => {
      const finished = (await call("/api/works")).filter(
        (work) => work.roomId === goRoom.id && work.status === "succeeded",
      );
      return finished.length >= 2 ? finished.sort((a, b) => a.startedAt - b.startedAt)[1] : undefined;
    });
    const secondSessions = (await goSessions()).slice(goBeforeSecond).map((entry) => entry.sessionId);
    if (secondSessions.length < 2) throw new Error(`第二项 Go 工作的请求不足：${secondSessions.length}`);
    if (new Set(secondSessions).size !== 1) {
      throw new Error(`第二项工作的 session 不稳定：${secondSessions.join(",")}`);
    }
    if (secondSessions[0] === workSession) throw new Error("不同工作复用了同一个 session");
    if (goWork2.status !== "succeeded") throw new Error(`第二项 Go 工作状态是 ${goWork2.status}`);
    log(`· Go 员工多轮生成共享会话 ${workSession}，不同工作使用不同会话`);

    log("\nSMOKE OK");
  } finally {
    server.kill("SIGTERM");
    provider.kill("SIGTERM");
    rmSync(ROOT_CWD_PROOF, { force: true });
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.stack ?? error.message : String(error));
  // The SSE reader stays open on purpose; end the run explicitly instead of
  // waiting for the outer timeout.
  process.exit(1);
});
