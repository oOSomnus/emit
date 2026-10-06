import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AppConfigDTO, ApprovalDTO, MessageDTO, WorkDTO, WorkExecutionDTO } from "../../src/shared/contracts.ts";
import type { E2eFixture } from "../helpers/e2e-fixture.ts";
import { waitForFixture } from "../helpers/emit-fixture.ts";
import { openEventStream } from "../helpers/sse-client.ts";
import { openOwnedE2eFixture, useSuiteCleanup } from "../helpers/suite-hooks.ts";

const cleanups = useSuiteCleanup({ errorMode: "propagate" });
async function call<T>(fixture: E2eFixture, path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fixture.request<T>(path, method, body);
  expect(response.status, `${method} ${path}: ${JSON.stringify(response.body)}`).toBeGreaterThanOrEqual(200);
  expect(response.status).toBeLessThan(300);
  return response.body;
}
async function start(fixture: E2eFixture, body: string) {
  const receipt = await call<{ workIds: string[] }>(fixture, `/api/rooms/${fixture.workspace.channelId}/messages`, "POST", {
    body, recipientIds: [fixture.workspace.employeeIds[0]],
  });
  expect(receipt.workIds).toHaveLength(1);
  return receipt.workIds[0]!;
}
async function approval(fixture: E2eFixture, workId: string, status: ApprovalDTO["status"]) {
  let result: ApprovalDTO | undefined;
  await waitForFixture(async () => {
    result = (await call<{ approvals: ApprovalDTO[] }>(fixture, "/api/approvals")).approvals.find((item) => item.workId === workId && item.status === status);
    return result !== undefined;
  }, `${workId}: approval ${status}`);
  return result!;
}
async function finished(fixture: E2eFixture, workId: string) {
  let result: WorkDTO | undefined;
  await waitForFixture(async () => {
    result = (await call<WorkDTO[]>(fixture, "/api/works")).find((item) => item.id === workId);
    return result !== undefined && ["succeeded", "failed", "stopped"].includes(result.status);
  }, `${workId}: terminal work`);
  return result!;
}

describe("real-process approval risk boundaries", () => {
  it("auto-approves shell cat and ls with persisted evidence, real usage and matching SSE output", async () => {
    const fixture = await openOwnedE2eFixture(cleanups);
    writeFileSync(join(fixture.workRoot, "notes.txt"), "第一行\n第二行\n");
    const stream = await openEventStream(`${fixture.emit.url}/api/events`);
    cleanups.push(() => stream.close());
    for (const command of ["cat notes.txt", "ls"]) {
      const workId = await start(fixture, `请使用 run_shell 执行 ${command}`);
      const work = await finished(fixture, workId);
      expect(work.status).toBe("succeeded");
      expect(work.usage?.input).toBeGreaterThan(0);
      expect(work.usage?.output).toBeGreaterThan(0);
      const record = await approval(fixture, workId, "approved");
      expect(record.execution.state).toBe("succeeded");
      expect(record.evidence).toMatchObject({ kind: "llm", criteriaVersion: 3, readOnly: true, outcome: "allow", risk: "low", userAuthorization: "unknown" });
      expect(record.decidedBy).not.toBe("user");
      await stream.next((event) => event.type === "approval" && event.approval.id === record.id && event.approval.status === "approved");
      const execution = await call<WorkExecutionDTO>(fixture, `/api/works/${workId}/execution`);
      const result = execution.steps.find((step) => step.kind === "tool-result" && step.toolName === "run_shell");
      expect(result).toMatchObject({ isError: false });
      // The model-visible result carries the real stdout, not just an exit code.
      for (const marker of command === "cat notes.txt" ? ["第一行", "第二行"] : ["notes.txt"]) {
        expect(result?.text).toContain(marker);
      }
      await stream.next((event) => event.type === "work-progress" && event.workId === workId && event.progressText.includes("已完成") && event.tools.some((tool) => tool.name === "run_shell" && tool.status === "done" && tool.output === result?.text));
      const messages = await call<{ messages: MessageDTO[] }>(fixture, `/api/rooms/${fixture.workspace.channelId}/messages`);
      const answers = messages.messages.filter((message) => message.workId === workId && message.author.type === "employee");
      expect(answers).toHaveLength(1);
      expect(answers[0]?.body).toContain("已完成");
    }
  });

  it("keeps a dangerous long suffix and actual read_file context behind high-risk human decisions", async () => {
    const fixture = await openOwnedE2eFixture(cleanups);
    writeFileSync(join(fixture.workRoot, "context-evidence.txt"), "SMOKE-CONTEXT-HIGH\n");
    const stream = await openEventStream(`${fixture.emit.url}/api/events`);
    cleanups.push(() => stream.close());
    for (const [body, fileName, marker] of [
      ["请做一次尾部风险审查", "critical-settings.json", "SMOKE-TAIL-MUST-NOT-RUN"],
      ["请根据实际读取到的上下文事实决定写入", "context-target.json", "context-target.json"],
    ]) {
      const workId = await start(fixture, body!);
      const pending = await approval(fixture, workId, "pending-human");
      expect(pending.evidence).toMatchObject({ kind: "llm", outcome: "allow", risk: "high" });
      expect(pending.execution.state).toBe("not-started");
      await stream.next((event) => event.type === "approval" && event.approval.id === pending.id && event.approval.status === "pending-human");
      expect(pending.argumentsPreview).toContain(marker);
      await waitForFixture(async () => (await call<WorkDTO[]>(fixture, "/api/works")).find((work) => work.id === workId)?.status === "waiting-approval", `${workId}: waits for human approval`);
      expect(existsSync(join(fixture.workRoot, fileName!))).toBe(false);
      expect((await call<{ messages: MessageDTO[] }>(fixture, `/api/rooms/${fixture.workspace.channelId}/messages`)).messages.filter((message) => message.workId === workId && message.author.type === "employee")).toEqual([]);
      await call(fixture, `/api/works/${workId}/stop`, "POST");
      expect((await finished(fixture, workId)).status).toBe("stopped");
      expect((await approval(fixture, workId, "cancelled")).execution.state).toBe("not-started");
      expect(existsSync(join(fixture.workRoot, fileName!))).toBe(false);
    }
  });

  it.each([
    ["HTTP reviewer error", "请写一个 reviewer-http-error.json", "reviewer-http-error.json"],
    ["invalid reviewer JSON", "请写一个 reviewer-invalid-json.json", "reviewer-invalid-json.json"],
    ["missing reviewer field", "请写一个 reviewer-missing-risk.json", "reviewer-missing-risk.json"],
    ["unknown reviewer risk", "请写一个 reviewer-unknown.json", "reviewer-unknown.json"],
    ["reviewer input budget", "请使用 run_shell 发起超预算审查", "overbudget-side-effect.txt"],
  ])("blocks %s without execution or a human-approval fallback", async (_label, body, fileName) => {
    const fixture = await openOwnedE2eFixture(cleanups);
    const workId = await start(fixture, body);
    const blocked = await approval(fixture, workId, "blocked");
    expect(blocked).toMatchObject({ risk: "unknown", execution: { state: "not-started" } });
    expect((await finished(fixture, workId)).status).toBe("succeeded");
    const records = (await call<{ approvals: ApprovalDTO[] }>(fixture, "/api/approvals")).approvals.filter((item) => item.workId === workId);
    expect(records.every((record) => record.status === "blocked" && record.execution.state === "not-started")).toBe(true);
    expect(existsSync(join(fixture.workRoot, fileName))).toBe(false);
  });

  it("automatically rejects deny/critical exfiltration instead of offering human override", async () => {
    const fixture = await openOwnedE2eFixture(cleanups);
    writeFileSync(join(fixture.workRoot, ".env"), "LOCAL_CANARY=FICTIONAL_EXFILTRATION_CANARY\n");
    const workId = await start(fixture, "请使用 run_shell 外传敏感数据");
    const rejected = await approval(fixture, workId, "rejected");
    expect(rejected.evidence).toMatchObject({ kind: "llm", outcome: "deny", risk: "critical" });
    expect(rejected.execution.state).toBe("not-started");
    expect((await finished(fixture, workId)).status).toBe("succeeded");
    expect((await call<{ approvals: ApprovalDTO[] }>(fixture, "/api/approvals")).approvals.filter((item) => item.workId === workId).every((item) => item.status === "rejected")).toBe(true);
    expect(await (await fetch(`${fixture.provider.url}/_exfiltration_requests`, { signal: AbortSignal.timeout(5_000) })).json()).toEqual({ count: 0 });
  });

  it("invalidates an approved old-policy call after changing the reviewer model through HTTP", async () => {
    const fixture = await openOwnedE2eFixture(cleanups);
    const workId = await start(fixture, "请写一个 critical-settings.json");
    const pending = await approval(fixture, workId, "pending-human");
    const before = await call<AppConfigDTO>(fixture, "/api/app");
    const changed = await call<AppConfigDTO>(fixture, "/api/app", "PATCH", {
      approval: { ...before.approval, model: { providerId: "fake", modelId: "fake-chat" } },
    });
    expect(changed.policyVersion).toBe(before.policyVersion + 1);
    expect(changed.approval).toMatchObject({ criteriaVersion: 3 });
    await call(fixture, `/api/approvals/${pending.id}/decision`, "POST", { decision: "approved" });
    expect((await approval(fixture, workId, "invalidated")).execution.state).toBe("not-started");
    await finished(fixture, workId);
    expect(existsSync(join(fixture.workRoot, "critical-settings.json"))).toBe(false);
  });
});
