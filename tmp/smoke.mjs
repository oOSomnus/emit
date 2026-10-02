/**
 * End-to-end smoke run against a fake provider.
 *
 * Verifies the whole durable path with a real harness: onboarding, employee
 * creation, a room message that starts work, the read-only tool path, the
 * gated write path that waits for a human, the human decision, the grant check
 * inside execute, delivery back into the room, resumption after SIGKILL, and
 * the two ways a human says no: rejecting the call, and stopping the work.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const DATA = join(ROOT, "tmp", "smoke-data");
const WORKDIR = join(ROOT, "tmp", "smoke-work");
const SERVER_PORT = 8898;
const PROVIDER_PORT = 8899;
const BASE = `http://127.0.0.1:${SERVER_PORT}`;

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

async function waitFor(description, check, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check().catch(() => undefined);
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`超时: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
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
  // The run asserts it starts from an empty directory, so it clears its own.
  rmSync(DATA, { recursive: true, force: true });
  rmSync(WORKDIR, { recursive: true, force: true });
  mkdirSync(DATA, { recursive: true });
  mkdirSync(WORKDIR, { recursive: true });
  writeFileSync(join(WORKDIR, "notes.txt"), "第一行\n第二行\n");

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

    await call("/api/setup", {
      method: "POST",
      body: JSON.stringify({
        workspaceName: "冒烟工作区",
        userName: "测试者",
        defaultExecutionModel: { model: { providerId: "fake", modelId: "fake-chat" }, effort: "off" },
        approval: {
          kind: "llm",
          model: { providerId: "fake", modelId: "fake-chat" },
          effort: "off",
          criteriaVersion: 2,
        },
      }),
    });
    log("· 已完成初始化");

    const employee = await call("/api/employees", {
      method: "POST",
      body: JSON.stringify({
        name: "小柯",
        role: "文档助手",
        instructions: "简洁回答。",
        executionModel: { model: { providerId: "fake", modelId: "fake-chat" }, effort: "off" },
        cwd: WORKDIR,
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

    const room = await call("/api/rooms", {
      method: "POST",
      body: JSON.stringify({ kind: "dm", name: "小柯", employeeId: employee.id }),
    });

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
    if (catApproval.evidence?.kind !== "llm" || catApproval.evidence.readOnly !== true) {
      throw new Error(`cat 缺少只读判断证据：${JSON.stringify(catApproval.evidence)}`);
    }
    if (catApproval.evidence.criteriaVersion !== 2) {
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
    if (lsApproval.evidence?.kind !== "llm" || lsApproval.evidence.readOnly !== true) {
      throw new Error(`ls 缺少只读判断证据：${JSON.stringify(lsApproval.evidence)}`);
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
        cwd: WORKDIR,
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
        cwd: WORKDIR,
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
    await call(`/api/rooms/${room.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ body: "请写一个 result.txt" }),
    });
    const pending = await waitFor("等待人工审批的调用", async () => {
      const payload = await call("/api/approvals");
      return payload.approvals.find((approval) => approval.status === "pending-human" && approval.toolName === "write_file");
    });
    if (pending.evidence?.kind !== "llm" || pending.evidence.recommendation !== "review") {
      throw new Error(`审批依据不符合预期: ${JSON.stringify(pending.evidence)}`);
    }
    if (!pending.autoDecision?.reason.includes("review")) throw new Error("没有记录自动判断的理由");
    log(`· 写文件已转人工：${pending.autoDecision.reason}`);

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

    const contents = readFileSync(join(WORKDIR, "result.txt"), "utf8");
    if (!contents.includes("来自员工的问候")) throw new Error(`文件内容不符合预期: ${contents}`);
    log("· 批准后工具真的执行了，文件已写入");

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
    await rmdir(join(WORKDIR, "result.txt"));
    const seen = new Set(finalApprovals.approvals.map((approval) => approval.id));
    await call(`/api/rooms/${room.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ body: "请写一个 rejected.txt" }),
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
    if (existsSync(join(WORKDIR, "result.txt"))) throw new Error("被拒绝的调用仍然写了文件");
    await waitFor("被拒绝那次的回答", async () => {
      const payload = await call(`/api/rooms/${room.id}/messages`);
      return payload.messages.filter((message) => message.author.type === "employee").length >= 4;
    });
    log("· 拒绝后文件未写入，员工按被阻止的结果作答");

    // ---- stopping a work while its call waits for a decision ---------------
    const seenSecond = new Set((await call("/api/approvals")).approvals.map((approval) => approval.id));
    await call(`/api/rooms/${room.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ body: "请写一个 stopped.txt" }),
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
    if (existsSync(join(WORKDIR, "result.txt"))) throw new Error("被停止的调用仍然写了文件");
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
      body: JSON.stringify({ body: "请写一个 policy-stale.txt" }),
    });
    const stalePending = await waitFor("策略变更前等待人工的写调用", async () =>
      (await call("/api/approvals")).approvals.find(
        (approval) => approval.workId === staleStart.workId && approval.status === "pending-human",
      ),
    );
    const policyChanged = await call("/api/app", {
      method: "PATCH",
      body: JSON.stringify({
        approval: { ...appBeforePolicyChange.approval, criteriaVersion: 1 },
      }),
    });
    if (policyChanged.policyVersion !== appBeforePolicyChange.policyVersion + 1) {
      throw new Error("审批策略变更没有递增策略版本");
    }
    if (policyChanged.approval?.criteriaVersion !== 2) {
      throw new Error(`服务端没有使用实际标准版本 2：${policyChanged.approval?.criteriaVersion}`);
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
    if (existsSync(join(WORKDIR, "result.txt"))) throw new Error("旧策略审批越过了执行时授权验证");
    log("· 策略更新后旧批准失效，客户端旧 criteriaVersion 未改变服务端版本");

    // ---- mail: recipients, copies, and drafts ------------------------------
    const second = await call("/api/employees", {
      method: "POST",
      body: JSON.stringify({
        name: "小柯二",
        role: "文档助手",
        instructions: "简洁回答。",
        executionModel: { model: { providerId: "fake", modelId: "fake-chat" }, effort: "off" },
        cwd: WORKDIR,
        toolPolicy: { allowedTools: ["read_file", "write_file"], trustedReadOnlyTools: [] },
        generateAddress: true,
      }),
    });

    const mailRoom = await call("/api/rooms", {
      method: "POST",
      body: JSON.stringify({ kind: "mail", name: "冒烟邮件" }),
    });

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

    const flagged = await call(`/api/rooms/${mailRoom.id}/mail-flag`, {
      method: "POST",
      body: JSON.stringify({ entryId: mailReplies[0].id, read: true, archived: true }),
    });
    const marked = flagged.messages.find((message) => message.id === mailReplies[0].id);
    if (marked.mail.read !== true || marked.mail.archived !== true) throw new Error("已读/归档没有保存");
    log("· 已读与归档状态已保存");

    // CC is a copy: it is recorded and never wakes anybody.
    const ccRoom = await call("/api/rooms", {
      method: "POST",
      body: JSON.stringify({ kind: "mail", name: "抄送测试" }),
    });
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
    const selfRoom = await call("/api/rooms", {
      method: "POST",
      body: JSON.stringify({ kind: "mail", name: "只投递" }),
    });
    const worksBeforeSelf = (await call("/api/works")).length;
    await call(`/api/rooms/${selfRoom.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ body: "只记录这封邮件", subject: "只投递", to: ["user"] }),
    });
    await new Promise((resolve) => setTimeout(resolve, 600));
    if ((await call("/api/works")).length !== worksBeforeSelf) throw new Error("发给用户自己的邮件启动了工作");
    log("· 发给用户自己的邮件只投递");

    // ---- a typed address is recorded, never woken --------------------------
    const typedRoom = await call("/api/rooms", {
      method: "POST",
      body: JSON.stringify({ kind: "mail", name: "外部地址" }),
    });
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
        cwd: readonlyDir,
        toolPolicy: { allowedTools: ["read_file"], trustedReadOnlyTools: [] },
        generateAddress: true,
      }),
    });
    const readonlyRoom = await call("/api/rooms", {
      method: "POST",
      body: JSON.stringify({ kind: "dm", name: readonly.name, employeeId: readonly.id }),
    });
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
        cwd: WORKDIR,
        toolPolicy: {
          allowedTools: ["read_file", "load_skill"],
          trustedReadOnlyTools: ["load_skill"],
        },
        skillIds: [skill.id],
        generateAddress: true,
      }),
    });
    const skillRoom = await call("/api/rooms", {
      method: "POST",
      body: JSON.stringify({ kind: "dm", name: skillEmployee.name, employeeId: skillEmployee.id }),
    });
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
          cwd: WORKDIR,
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
    const chainRoom = await call("/api/rooms", {
      method: "POST",
      body: JSON.stringify({ kind: "dm", name: chainA.name, employeeId: chainA.id }),
    });
    await call(`/api/rooms/${chainRoom.id}/messages`, { method: "POST", body: JSON.stringify({ body: "开始" }) });
    const delegation = await waitFor("交办链停下", async () => {
      const all = await call("/api/works");
      const delegations = all.filter((work) => work.kind === "delegation");
      const running = all.filter((work) => work.status === "running" || work.status === "queued");
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
    const depthRoom = await call("/api/rooms", {
      method: "POST",
      body: JSON.stringify({ kind: "dm", name: depthA.name, employeeId: depthA.id }),
    });
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
    const cycleRoom = await call("/api/rooms", {
      method: "POST",
      body: JSON.stringify({ kind: "dm", name: cycleA.name, employeeId: cycleA.id }),
    });
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
        cwd: WORKDIR,
        toolPolicy: {
          allowedTools: ["read_file", "mcp__fixture__echo_notes"],
          trustedReadOnlyTools: ["fixture/echo_notes"],
        },
        mcpServerIds: [mcpServer.id],
        generateAddress: true,
      }),
    });
    const mcpRoom = await call("/api/rooms", {
      method: "POST",
      body: JSON.stringify({ kind: "dm", name: mcpEmployee.name, employeeId: mcpEmployee.id }),
    });
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

    // The same tool without the trust entry goes through the approval gate.
    const untrusted = await call("/api/employees", {
      method: "POST",
      body: JSON.stringify({
        name: "MCP 未信任员工",
        role: "资料",
        instructions: "用 MCP 工具读资料。",
        executionModel: { model: { providerId: "fake", modelId: "fake-chat" }, effort: "off" },
        cwd: WORKDIR,
        toolPolicy: { allowedTools: ["mcp__fixture__echo_notes"], trustedReadOnlyTools: [] },
        mcpServerIds: [mcpServer.id],
        generateAddress: true,
      }),
    });
    const untrustedRoom = await call("/api/rooms", {
      method: "POST",
      body: JSON.stringify({ kind: "dm", name: untrusted.name, employeeId: untrusted.id }),
    });
    await call(`/api/rooms/${untrustedRoom.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ body: "用 MCP 工具看看笔记" }),
    });
    const gate = await waitFor("未信任的 MCP 调用等待裁决", async () => {
      const pending = (await call("/api/approvals")).approvals.filter(
        (approval) =>
          approval.origin.kind === "room" &&
          approval.origin.roomId === untrustedRoom.id &&
          approval.status === "pending-human",
      );
      return pending.length > 0 ? pending[0] : undefined;
    });
    if (!gate.toolName.includes("mcp__fixture__echo_notes")) {
      throw new Error(`审批没有指向 MCP 工具：${gate.toolName}`);
    }
    if (gate.argumentsPreview !== '{"path":"notes.txt"}') {
      throw new Error(`MCP 审批没有使用实际参数：${gate.argumentsPreview}`);
    }
    if (
      gate.evidence?.kind !== "llm" ||
      gate.evidence.recommendation !== "review" ||
      gate.evidence.readOnly !== false
    ) {
      throw new Error(`readOnlyHint=true 的 MCP review 没有进入人工队列：${JSON.stringify(gate.evidence)}`);
    }
    if (!events.some((event) => event.type === "approval" && event.approval.id === gate.id && event.approval.status === "pending-human")) {
      throw new Error("SSE 没有播送 MCP 的 pending-human 输出");
    }
    if (gate.autoDecision?.source !== "llm") throw new Error("MCP 审批没有记录自动判断来源");
    const mcpAnswersBefore = (await call(`/api/rooms/${untrustedRoom.id}/messages`)).messages.filter(
      (message) => message.author.type === "employee",
    ).length;
    await call(`/api/approvals/${gate.id}/decision`, {
      method: "POST",
      body: JSON.stringify({ decision: "approved" }),
    });
    await waitFor("MCP 调用在被批准后完成", async () => {
      const finished = (await call("/api/works")).filter(
        (work) => work.roomId === untrustedRoom.id && work.status === "succeeded",
      );
      return finished.length > 0;
    });
    const mcpAnswersAfter = (await call(`/api/rooms/${untrustedRoom.id}/messages`)).messages.filter(
      (message) => message.author.type === "employee",
    );
    if (mcpAnswersAfter.length !== mcpAnswersBefore + 1) {
      throw new Error(`批准后 MCP 调用的回答数量不对：${mcpAnswersAfter.length}`);
    }
    const decidedMcp = (await call("/api/approvals")).approvals.find((approval) => approval.id === gate.id);
    if (decidedMcp.execution.state !== "succeeded") {
      throw new Error(`MCP 调用的执行状态是 ${decidedMcp.execution.state}`);
    }
    log("· 未受信任的 MCP 工具先问人，批准后才真正调用");
    for (const scenario of [
      { label: "敏感 MCP", body: "用 MCP 工具读取密钥", expected: ".env" },
      { label: "不确定 MCP", body: "用 MCP 工具读取不确定内容", expected: '"path":""' },
    ]) {
      const started = await call(`/api/rooms/${untrustedRoom.id}/messages`, {
        method: "POST",
        body: JSON.stringify({ body: scenario.body }),
      });
      const awaitingReview = await waitFor(`${scenario.label} 等待人工裁决`, async () =>
        (await call("/api/approvals")).approvals.find(
          (approval) => approval.workId === started.workId && approval.status === "pending-human",
        ),
      );
      if (!awaitingReview.argumentsPreview.includes(scenario.expected)) {
        throw new Error(`${scenario.label} 没有按真实参数触发：${awaitingReview.argumentsPreview}`);
      }
      if (
        awaitingReview.evidence?.kind !== "llm" ||
        awaitingReview.evidence.recommendation !== "review" ||
        awaitingReview.evidence.readOnly !== false
      ) {
        throw new Error(`${scenario.label} 没有保留 review 依据：${JSON.stringify(awaitingReview.evidence)}`);
      }
      if (!events.some((event) => event.type === "approval" && event.approval.id === awaitingReview.id && event.approval.status === "pending-human")) {
        throw new Error(`${scenario.label} 的 pending-human 结果没有进入 SSE`);
      }
      await call(`/api/approvals/${awaitingReview.id}/decision`, {
        method: "POST",
        body: JSON.stringify({ decision: "rejected", comment: `${scenario.label} 拒绝` }),
      });
      const refusedMcp = await waitFor(`${scenario.label} 人工拒绝持久化`, async () =>
        (await call("/api/approvals")).approvals.find(
          (approval) => approval.id === awaitingReview.id && approval.status === "rejected",
        ),
      );
      if (refusedMcp.execution.state !== "not-started") {
        throw new Error(`${scenario.label} 拒绝后仍执行了 MCP`);
      }
      const refusedWork = await waitFor(`${scenario.label} 拒绝后工作结束`, async () =>
        (await call("/api/works")).find(
          (work) => work.id === started.workId && work.status === "succeeded",
        ),
      );
      if (refusedWork.status !== "succeeded") {
        throw new Error(`${scenario.label} 拒绝后工作状态是 ${refusedWork.status}`);
      }
      log(`· ${scenario.label} 按参数进入人工审批并拒绝`);
    }


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
        cwd: WORKDIR,
        toolPolicy: { allowedTools: ["read_file"], trustedReadOnlyTools: [] },
        generateAddress: true,
      }),
    });
    const goRoom = await call("/api/rooms", {
      method: "POST",
      body: JSON.stringify({ kind: "dm", name: goEmployee.name, employeeId: goEmployee.id }),
    });

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
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.stack ?? error.message : String(error));
  // The SSE reader stays open on purpose; end the run explicitly instead of
  // waiting for the outer timeout.
  process.exit(1);
});
