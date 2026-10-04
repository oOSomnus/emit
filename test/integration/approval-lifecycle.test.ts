import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decideApproval, findApproval, gateToolCall, invalidateStaleGrants, invalidateWorkContextDirectoryGrants, listApprovals, verifyGrant, type ApprovalRequest } from "../../src/server/approval/state.ts";
import { sendQueuedMessage } from "../../src/server/channel-messages.ts";
import type { ApprovalRecord, EmployeeRecord, RoomRecord, WorkContextRecord } from "../../src/server/documents.ts";
import { createRoom } from "../../src/server/rooms.ts";
import { ensureWorkConversation, findWork, listWorks, stopWork, type Resume } from "../../src/server/work.ts";
import type { EmitRuntime } from "../../src/server/runtime.ts";
import { createWorkContext, findWorkContext, updateWorkContext } from "../../src/server/work-contexts.ts";
import { readApp, updateAppConfig, updateEmployee } from "../../src/server/workspace.ts";
import {
  FAKE_KEY_ENV,
  createWorkContextFixture,
  mkdtempDataDir,
  openRuntime,
  providerConfig,
  setupFixtureWorkspace,
  startFixture,
  waitForFixture,
  type Fixture,
  type FixtureAnswer,
  type FixtureRequest,
} from "../helpers/emit-fixture.ts";

const cleanups: Array<() => Promise<void> | void> = [];
let previousApiKey: string | undefined;

beforeEach(() => {
  previousApiKey = process.env[FAKE_KEY_ENV];
  process.env[FAKE_KEY_ENV] = "local-fixture-key";
});

afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) {
    try {
      await close();
    } catch {
      // Cleanup must not replace the assertion that failed.
    }
  }
  if (previousApiKey === undefined) delete process.env[FAKE_KEY_ENV];
  else process.env[FAKE_KEY_ENV] = previousApiKey;
});

const userAuthor = { type: "user" as const, id: "user", name: "Test User", address: "" };
const highVerdict = JSON.stringify({
  outcome: "allow",
  risk: "high",
  rationale: "The local file write needs a human decision.",
  readOnly: false,
  userAuthorization: "high",
});
const lowVerdict = JSON.stringify({
  outcome: "allow",
  risk: "low",
  rationale: "The local command is low risk.",
  readOnly: true,
  userAuthorization: "unknown",
});

type ApprovalWorkspace = {
  runtime: EmitRuntime;
  resume: Resume;
  dataDir: string;
  worker: EmployeeRecord;
  room: RoomRecord;
  workContext: WorkContextRecord;
  workRoot: string;
};

async function openApprovalWorkspace(
  decide: (request: FixtureRequest) => FixtureAnswer,
  prefix: string,
): Promise<ApprovalWorkspace> {
  const fixture = await startFixture(decide);
  cleanups.push(() => fixture.close());
  const dataDir = mkdtempDataDir(prefix);
  cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const opened = await openRuntime(dataDir);
  cleanups.push(() => opened.runtime.close());
  await opened.runtime.storeCustomProviders([providerConfig(fixture.baseUrl)]);
  const [worker] = await setupFixtureWorkspace(opened.runtime, opened.resume, ["Worker"]);
  if (worker === undefined) throw new Error("Missing fixture worker");
  const workRoot = join(dataDir, "authorized-work");
  const workContext = await createWorkContextFixture(opened.runtime, "Approval work", {
    paths: [workRoot],
    defaultPath: workRoot,
  });
  const room = await createRoom(opened.runtime, {
    kind: "channel",
    name: "Approval channel",
    workContextId: workContext.id,
    memberIds: [worker.id],
  });
  return { ...opened, dataDir, worker, room, workContext, workRoot };
}

async function enqueueWork(resume: Resume, room: RoomRecord, worker: EmployeeRecord, body: string): Promise<string> {
  const result = await sendQueuedMessage(resume, {
    roomId: room.id,
    author: userAuthor,
    body,
    recipientIds: [worker.id],
  });
  const workId = result.workIds[0];
  if (workId === undefined) throw new Error(`No work was queued for ${body}`);
  return workId;
}

async function waitForWorkStatus(runtime: ApprovalWorkspace["runtime"], workId: string, status: string): Promise<void> {
  await waitForFixture(async () => (await findWork(runtime, workId))?.status === status, `work ${workId} to become ${status}`);
}

async function waitForWorkTerminal(runtime: ApprovalWorkspace["runtime"], workId: string): Promise<void> {
  await waitForFixture(async () => {
    const work = await findWork(runtime, workId);
    return work !== undefined && ["succeeded", "failed", "stopped"].includes(work.status);
  }, `work ${workId} to finish`);
}

async function approvalForWork(runtime: ApprovalWorkspace["runtime"], workId: string): Promise<ApprovalRecord> {
  await waitForFixture(
    async () => (await listApprovals(runtime)).some((approval) => approval.workId === workId),
    `approval for work ${workId}`,
  );
  const approval = (await listApprovals(runtime)).find((candidate) => candidate.workId === workId);
  if (approval === undefined) throw new Error(`Missing approval for work ${workId}`);
  return approval;
}

async function makeHumanDecision(workspace: ApprovalWorkspace, body: string, decision: "approved" | "rejected") {
  const workId = await enqueueWork(workspace.resume, workspace.room, workspace.worker, body);
  await waitForWorkStatus(workspace.runtime, workId, "waiting-approval");
  const approval = await approvalForWork(workspace.runtime, workId);
  expect(approval.status).toBe("pending-human");
  const result = await decideApproval(workspace.runtime, approval.id, decision, `human ${decision}`);
  expect(result.ok).toBe(true);
  await waitForWorkTerminal(workspace.runtime, workId);
  return { approval, workId };
}

async function grantForWork(
  workspace: ApprovalWorkspace,
  workId: string,
  taskId: string,
  args: { command: string },
): Promise<{ record: ApprovalRecord; request: ApprovalRequest }> {
  const conversation = await ensureWorkConversation(workspace.resume, workId);
  await conversation.submit(
    { type: "input", content: `Grant evidence ${taskId}`, requestId: `grant:${taskId}` },
    workspace.runtime.ctx,
  );
  await waitForFixture(
    async () => ((await conversation.context(workspace.runtime.ctx))?.entries.length ?? 0) > 0,
    `execution context for grant ${taskId}`,
  );
  const result = await gateToolCall({
    runtime: workspace.runtime,
    toolDescription: "Run a local command in the authorized work directory.",
    toolTaskId: taskId,
    conversationId: Number(conversation.id),
    toolName: "run_shell",
    toolKind: "shell",
    arguments: args,
    signal: undefined,
  });
  if (!result.allow) throw new Error(`Fixture grant was blocked: ${result.message}`);
  const record = result.record;
  return {
    record,
    request: {
      toolTaskId: record.toolTaskId,
      employeeId: record.employeeId,
      employeeName: record.employeeName,
      toolName: record.toolName,
      toolKind: "shell",
      arguments: args,
      cwd: record.cwd,
      directoryWorkContextId: record.directoryWorkContextId,
      directoryRoomId: record.directoryRoomId,
      directoryVersion: record.directoryVersion,
      directoryPaths: [...record.directoryPaths],
      targetPaths: [...record.targetPaths],
    },
  };
}

function fixtureAnswers(request: FixtureRequest) {
  if (request.model === "fake-reviewer") return { content: highVerdict };
  for (const marker of ["APPROVE_WRITE", "REJECT_WRITE", "STOP_WRITE", "DELAYED_REVIEW", "BAD_REVIEW", "ERROR_REVIEW"]) {
    if (request.prompt.includes(marker) && !request.prompt.includes('"role":"tool"')) {
      return { toolCall: { name: "write_file", args: { path: `${marker}.txt`, content: marker } } };
    }
  }
  return { content: "The request is complete." };
}

describe("real-runtime approval lifecycle", () => {
  it("executes only an approved write, rejects denied writes, and refuses an approval after stop", async () => {
    const workspace = await openApprovalWorkspace(fixtureAnswers, "emit-approval-decisions-");
    workspace.runtime.resume();

    const approved = await makeHumanDecision(workspace, "APPROVE_WRITE", "approved");
    expect((await findWork(workspace.runtime, approved.workId))?.status).toBe("succeeded");
    expect(readFileSync(join(workspace.workRoot, "APPROVE_WRITE.txt"), "utf8")).toBe("APPROVE_WRITE");
    expect((await findApproval(workspace.runtime, approved.approval.id))?.executionState).toBe("succeeded");

    const rejected = await makeHumanDecision(workspace, "REJECT_WRITE", "rejected");
    expect((await findWork(workspace.runtime, rejected.workId))?.status).toBe("succeeded");
    expect(existsSync(join(workspace.workRoot, "REJECT_WRITE.txt"))).toBe(false);
    expect((await findApproval(workspace.runtime, rejected.approval.id))?.executionState).toBe("not-started");

    const stoppedWorkId = await enqueueWork(workspace.resume, workspace.room, workspace.worker, "STOP_WRITE");
    await waitForWorkStatus(workspace.runtime, stoppedWorkId, "waiting-approval");
    const stoppedApproval = await approvalForWork(workspace.runtime, stoppedWorkId);
    const stopped = await stopWork(workspace.resume, stoppedWorkId);
    expect(stopped?.status).toBe("stopped");
    const lateDecision = await decideApproval(workspace.runtime, stoppedApproval.id, "approved", "arrived after stop");
    expect(lateDecision.ok).toBe(false);
    await waitForWorkStatus(workspace.runtime, stoppedWorkId, "stopped");
    expect(existsSync(join(workspace.workRoot, "STOP_WRITE.txt"))).toBe(false);
    expect((await findApproval(workspace.runtime, stoppedApproval.id))?.status).toBe("cancelled");
  }, 60_000);

  it("cancels a gated reviewer verdict when the work is stopped", async () => {
    const reviewerGate = Promise.withResolvers<void>();
    let reviewerStarted = false;
    const workspace = await openApprovalWorkspace((request) => {
      if (request.model === "fake-reviewer") {
        reviewerStarted = true;
        return { content: highVerdict, gate: reviewerGate.promise };
      }
      return fixtureAnswers(request);
    }, "emit-approval-delayed-review-");
    cleanups.push(() => reviewerGate.resolve());
    workspace.runtime.resume();

    const workId = await enqueueWork(workspace.resume, workspace.room, workspace.worker, "DELAYED_REVIEW");
    await waitForFixture(() => Promise.resolve(reviewerStarted), "reviewer to enter its gated verdict");
    const approval = await approvalForWork(workspace.runtime, workId);
    expect(approval.status).toBe("evaluating");

    const stopping = stopWork(workspace.resume, workId);
    await waitForWorkStatus(workspace.runtime, workId, "stopped");
    reviewerGate.resolve();
    await stopping;
    await waitForFixture(
      async () => (await findApproval(workspace.runtime, approval.id))?.status === "cancelled",
      `approval ${approval.id} to remain cancelled after reviewer release`,
    );
    expect(existsSync(join(workspace.workRoot, "DELAYED_REVIEW.txt"))).toBe(false);
    expect((await listWorks(workspace.runtime)).find((work) => work.id === workId)?.status).toBe("stopped");
  }, 60_000);

  it("blocks malformed and unavailable reviewer responses without executing the requested write", async () => {
    let reviewerMode: "malformed" | "http-error" = "malformed";
    const workspace = await openApprovalWorkspace((request) => {
      if (request.model === "fake-reviewer") {
        return reviewerMode === "malformed"
          ? { content: "not a reviewer verdict" }
          : { httpStatus: 503, content: "reviewer unavailable" };
      }
      return fixtureAnswers(request);
    }, "emit-approval-fail-closed-");
    workspace.runtime.resume();

    for (const [mode, marker] of [
      ["malformed", "BAD_REVIEW"],
      ["http-error", "ERROR_REVIEW"],
    ] as const) {
      reviewerMode = mode;
      const workId = await enqueueWork(workspace.resume, workspace.room, workspace.worker, marker);
      await waitForWorkTerminal(workspace.runtime, workId);
      const approval = await approvalForWork(workspace.runtime, workId);
      expect(approval.status).toBe("blocked");
      expect(approval.executionState).toBe("not-started");
      expect(existsSync(join(workspace.workRoot, `${marker}.txt`))).toBe(false);
    }
  }, 60_000);

  it("claims a grant once and rejects changed arguments, employee configuration, directory, and policy snapshots", async () => {
    const workspace = await openApprovalWorkspace((request) =>
      request.model === "fake-reviewer" ? { content: lowVerdict } : { content: "Grant context is ready." },
    "emit-approval-grant-invalidation-");

    const baseWorkId = await enqueueWork(workspace.resume, workspace.room, workspace.worker, "grant-base");
    const oneUseGrant = await grantForWork(workspace, baseWorkId, "grant-once", { command: "printf once" });
    const firstClaim = await verifyGrant(workspace.runtime, workspace.worker, await readApp(workspace.runtime), oneUseGrant.request);
    expect(firstClaim.allow).toBe(true);
    const secondClaim = await verifyGrant(workspace.runtime, workspace.worker, await readApp(workspace.runtime), oneUseGrant.request);
    expect(secondClaim.allow).toBe(false);
    expect((await findApproval(workspace.runtime, oneUseGrant.record.id))?.executionState).toBe("running");

    const changedArgsGrant = await grantForWork(workspace, baseWorkId, "grant-args", { command: "printf authorized" });
    const changedArguments = { ...changedArgsGrant.request, arguments: { command: "printf changed" } };
    expect((await verifyGrant(workspace.runtime, workspace.worker, await readApp(workspace.runtime), changedArguments)).allow).toBe(false);

    const configGrant = await grantForWork(workspace, baseWorkId, "grant-config", { command: "printf configuration" });
    const updatedWorker = await updateEmployee(workspace.runtime, workspace.worker.id, {
      toolPolicy: { allowedTools: [], trustedReadOnlyTools: [] },
    });
    expect(updatedWorker.configVersion).toBeGreaterThan(workspace.worker.configVersion);
    expect((await verifyGrant(workspace.runtime, updatedWorker, await readApp(workspace.runtime), configGrant.request)).allow).toBe(false);

    const directoryRoot = join(workspace.dataDir, "replacement-directory");
    mkdirSync(directoryRoot, { recursive: true });
    const directoryContext = await findWorkContext(workspace.runtime, workspace.workContext.id);
    if (directoryContext === undefined) throw new Error("Missing directory work context");
    const directoryGrant = await grantForWork(workspace, baseWorkId, "grant-directory", { command: "printf directory" });
    const updatedDirectory = await updateWorkContext(workspace.runtime, directoryContext.id, {
      expectedVersion: directoryContext.version,
      directories: { paths: [directoryRoot], defaultPath: directoryRoot },
    });
    await invalidateWorkContextDirectoryGrants(workspace.runtime, directoryContext.id, updatedDirectory.directories.version);
    expect((await findApproval(workspace.runtime, directoryGrant.record.id))?.status).toBe("invalidated");
    expect((await verifyGrant(workspace.runtime, updatedWorker, await readApp(workspace.runtime), directoryGrant.request)).allow).toBe(false);

    const policyRoot = join(workspace.dataDir, "policy-work");
    mkdirSync(policyRoot, { recursive: true });
    const policyContext = await createWorkContext(workspace.runtime, {
      name: "Policy work",
      directories: { paths: [policyRoot], defaultPath: policyRoot },
    });
    const policyRoom = await createRoom(workspace.runtime, {
      kind: "channel",
      name: "Policy channel",
      workContextId: policyContext.id,
      memberIds: [updatedWorker.id],
    });
    const policyWorkId = await enqueueWork(workspace.resume, policyRoom, updatedWorker, "policy-grant");
    const policyGrant = await grantForWork(workspace, policyWorkId, "grant-policy", { command: "printf policy" });
    const app = await readApp(workspace.runtime);
    const updatedApp = await updateAppConfig(workspace.runtime, {
      approval: { kind: "llm", model: { providerId: "fake", modelId: "fake-reviewer" }, effort: "off", criteriaVersion: 3 },
    });
    expect(updatedApp.policyVersion).toBe(app.policyVersion + 1);
    expect(await invalidateStaleGrants(workspace.runtime, updatedApp.policyVersion)).toBeGreaterThan(0);
    expect((await findApproval(workspace.runtime, policyGrant.record.id))?.status).toBe("invalidated");
    expect((await verifyGrant(workspace.runtime, updatedWorker, updatedApp, policyGrant.request)).allow).toBe(false);
  }, 60_000);
});
