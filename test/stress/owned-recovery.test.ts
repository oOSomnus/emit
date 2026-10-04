import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { ApprovalDTO, EmployeeDTO, MessageDTO, RoomDTO, WorkDTO, WorkExecutionDTO } from "../../src/shared/contracts.ts";
import { describe, expect, it } from "vitest";
import { createE2eFixture } from "../helpers/e2e-fixture.ts";
import { waitForFixture } from "../helpers/emit-fixture.ts";
import { loadTestSettings } from "../helpers/test-settings.ts";
import { printStressMetrics, StressMetrics, stressRequest } from "../helpers/stress-metrics.ts";

const settings = loadTestSettings();
const requestTimeoutMs = Math.min(settings.durationMs, 30_000);
const restartWaitMs = settings.durationMs;
const testTimeoutMs = Math.max(1, settings.restarts) * restartWaitMs * 4 + settings.restarts * 45_000 + 120_000;

type SentMessage = { message: MessageDTO; workIds: string[] };

async function waitForWork(
  metrics: StressMetrics,
  baseUrl: string,
  workId: string,
  predicate: (work: WorkDTO) => boolean,
  description: string,
): Promise<WorkDTO> {
  let observed: WorkDTO | undefined;
  await waitForFixture(async () => {
    const response = await stressRequest<WorkDTO[]>(metrics, baseUrl, "/api/works", { timeoutMs: requestTimeoutMs });
    observed = response.body.find((work) => work.id === workId);
    return observed !== undefined && predicate(observed);
  }, description, restartWaitMs);
  if (observed === undefined) throw new Error(`Work ${workId} disappeared while waiting for ${description}`);
  return observed;
}

async function waitForPendingApproval(metrics: StressMetrics, baseUrl: string, workId: string): Promise<ApprovalDTO> {
  let approval: ApprovalDTO | undefined;
  await waitForFixture(async () => {
    const response = await stressRequest<{ approvals: ApprovalDTO[] }>(metrics, baseUrl, "/api/approvals", {
      timeoutMs: requestTimeoutMs,
    });
    approval = response.body.approvals.find((candidate) => candidate.workId === workId && candidate.status === "pending-human");
    return approval !== undefined;
  }, `pending human approval for work ${workId}`, restartWaitMs);
  if (approval === undefined) throw new Error(`Work ${workId} never reached a pending human approval`);
  return approval;
}

async function currentApproval(metrics: StressMetrics, baseUrl: string, approvalId: string): Promise<ApprovalDTO> {
  const response = await stressRequest<{ approvals: ApprovalDTO[] }>(metrics, baseUrl, "/api/approvals", {
    timeoutMs: requestTimeoutMs,
  });
  const matches = response.body.approvals.filter((approval) => approval.id === approvalId);
  expect(matches).toHaveLength(1);
  const approval = matches[0];
  if (approval === undefined) throw new Error(`Approval ${approvalId} disappeared`);
  return approval;
}

describe("manual stress: repeated owned-process recovery and approval races", () => {
  it("restarts the owned server around pending approvals and executes each raced approval once", async () => {
    const fixture = await createE2eFixture();
    const metrics = new StressMetrics(() => fixture.emit.rssBytes());
    try {
      const writerResponse = await stressRequest<EmployeeDTO>(metrics, fixture.emit.url, "/api/employees", {
        method: "POST",
        body: {
          name: "Stress recovery writer",
          role: "Recovery test writer",
          executionModel: { model: { providerId: "fake", modelId: "fake-chat" }, effort: "off" },
          toolPolicy: { allowedTools: ["write_file"], trustedReadOnlyTools: [] },
          generateAddress: false,
        },
        timeoutMs: requestTimeoutMs,
      });
      const writerId = writerResponse.body.id;
      const channel = (await stressRequest<RoomDTO[]>(metrics, fixture.emit.url, "/api/rooms", { timeoutMs: requestTimeoutMs })).body
        .find((room) => room.id === fixture.workspace.channelId)!;
      await stressRequest(metrics, fixture.emit.url, `/api/rooms/${channel.id}/members`, {
        method: "PATCH", body: { memberIds: [...channel.memberIds, writerId], expectedVersion: channel.membershipVersion },
        timeoutMs: requestTimeoutMs,
      });
      const recoveryRounds = Math.max(1, settings.restarts);
      const decisionFanout = Math.max(2, settings.concurrency);
      let completedRestarts = 0;

      for (let round = 0; round < recoveryRounds; round += 1) {
        const fileName = `critical-settings.json-recovery-${String(round).padStart(3, "0")}.txt`;
        const accepted = await stressRequest<SentMessage>(
          metrics,
          fixture.emit.url,
          `/api/rooms/${fixture.workspace.channelId}/messages`,
          { method: "POST", body: { body: `请写一个 ${fileName}`, recipientIds: [writerId] }, timeoutMs: requestTimeoutMs },
        );
        expect(accepted.body.workIds).toHaveLength(1);
        const workId = accepted.body.workIds[0];
        if (workId === undefined) throw new Error(`The public request for ${fileName} did not create work`);

        const pendingWork = await waitForWork(
          metrics,
          fixture.emit.url,
          workId,
          (work) => work.status === "waiting-approval",
          `work ${workId} to wait for a human approval`,
        );
        expect(pendingWork.status).toBe("waiting-approval");
        const pendingApproval = await waitForPendingApproval(metrics, fixture.emit.url, workId);
        expect(pendingApproval).toMatchObject({
          workId,
          toolName: "write_file",
          risk: "high",
          status: "pending-human",
          execution: { state: "not-started" },
        });
        const beforeRestartMessages = await stressRequest<{ messages: MessageDTO[] }>(
          metrics,
          fixture.emit.url,
          `/api/rooms/${fixture.workspace.channelId}/messages`,
          { timeoutMs: requestTimeoutMs },
        );
        expect(beforeRestartMessages.body.messages.filter((message) => message.author.type === "employee" && message.workId === workId)).toEqual([]);
        const target = join(fixture.workRoot, fileName);
        expect(existsSync(target)).toBe(false);

        if (round < settings.restarts) {
          const restartStarted = performance.now();
          try {
            await fixture.emit.kill();
            await fixture.emit.restart();
            completedRestarts += 1;
            metrics.recordObservation(performance.now() - restartStarted);
          } catch (error) {
            metrics.recordObservation(performance.now() - restartStarted, true);
            throw error;
          }
          const restoredWork = await waitForWork(
            metrics,
            fixture.emit.url,
            workId,
            (work) => work.status === "waiting-approval",
            `work ${workId} to remain approval-gated after owned restart ${completedRestarts}`,
          );
          expect(restoredWork.status).toBe("waiting-approval");
          const restoredApproval = await currentApproval(metrics, fixture.emit.url, pendingApproval.id);
          expect(restoredApproval).toMatchObject({
            id: pendingApproval.id,
            workId,
            toolName: "write_file",
            status: "pending-human",
            execution: { state: "not-started" },
          });
          const approvalsForWork = (await stressRequest<{ approvals: ApprovalDTO[] }>(metrics, fixture.emit.url, "/api/approvals", {
            timeoutMs: requestTimeoutMs,
          })).body.approvals.filter((approval) => approval.workId === workId);
          expect(approvalsForWork).toHaveLength(1);
          expect(existsSync(target)).toBe(false);
        }

        const decisions = await Promise.allSettled(Array.from({ length: decisionFanout }, () =>
          stressRequest<ApprovalDTO>(metrics, fixture.emit.url, `/api/approvals/${pendingApproval.id}/decision`, {
            method: "POST",
            body: { decision: "approved" },
            expectedStatuses: [200, 409],
            timeoutMs: requestTimeoutMs,
          }),
        ));
        const rejectedRequests = decisions.filter((result) => result.status === "rejected");
        expect(rejectedRequests, `approval race for ${pendingApproval.id} had unexpected transport or HTTP failures`).toHaveLength(0);
        const decisionStatuses = decisions.flatMap((result) => result.status === "fulfilled" ? [result.value.status] : []);
        expect(decisionStatuses.some((status) => status === 200)).toBe(true);
        expect(decisionStatuses.every((status) => status === 200 || status === 409)).toBe(true);

        const finished = await waitForWork(metrics, fixture.emit.url, workId, (work) => work.status === "succeeded", `work ${workId} to finish after approval`);
        expect(finished.status).toBe("succeeded");
        expect(readFileSync(target, "utf8")).toBe(`SMOKE-WRITTEN:${fileName}\n`);
        const finalApproval = await currentApproval(metrics, fixture.emit.url, pendingApproval.id);
        expect(finalApproval).toMatchObject({ status: "approved", execution: { state: "succeeded" } });
        const lateDecision = await stressRequest<unknown>(metrics, fixture.emit.url, `/api/approvals/${pendingApproval.id}/decision`, {
          method: "POST",
          body: { decision: "approved" },
          expectedStatuses: [409],
          timeoutMs: requestTimeoutMs,
        });
        expect(lateDecision.status).toBe(409);

        const finalMessages = await stressRequest<{ messages: MessageDTO[] }>(
          metrics,
          fixture.emit.url,
          `/api/rooms/${fixture.workspace.channelId}/messages`,
          { timeoutMs: requestTimeoutMs },
        );
        expect(finalMessages.body.messages.filter((message) => message.author.type === "employee" && message.workId === workId)).toHaveLength(1);
        const execution = await stressRequest<WorkExecutionDTO>(metrics, fixture.emit.url, `/api/works/${workId}/execution`, {
          timeoutMs: requestTimeoutMs,
        });
        expect(execution.body.steps.filter((step) => step.kind === "tool-call" && step.toolName === "write_file")).toHaveLength(1);
        expect(execution.body.steps.filter((step) => step.kind === "tool-result" && step.toolName === "write_file")).toHaveLength(1);
      }

      expect(completedRestarts).toBe(settings.restarts);
      expect(metrics.summary().errors).toBe(0);
      expect(metrics.summary().observationErrors).toBe(0);
      console.info(`[stress] recovery-workload ${JSON.stringify({ restartBatches: completedRestarts, approvalRaceRequestsPerBatch: decisionFanout, recoveryRounds })}`);
    } finally {
      try {
        metrics.close();
        printStressMetrics("owned-process-recovery", metrics);
      } finally { await fixture.close(); }
    }
  }, testTimeoutMs);
});
