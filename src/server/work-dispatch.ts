/**
 * Durable work dispatch: the two-phase task that starts one queued work item.
 *
 * Every queued run — a channel message, a direct message, a mail — is started
 * by this task, never by the caller's request. The task commits its phase
 * ("start" creates the execution conversation, "submit" admits the prompt), so
 * a crash between queueing and starting is recovered by the native scheduler
 * exactly once. Sends write the queued work and this task in the same commit,
 * which is what makes "the message was accepted" and "the employee will run"
 * the same fact.
 */

import {
  defineExtension,
  defineTask,
  type Extension,
  type Task,
  type TaskOutcome,
  type TaskRuntime,
} from "@earendil-works/pi-durable";
import type { Context as ChordContext } from "@earendil-works/chord";
import { AppDoc, EmployeeDoc, WorkContextDoc, type WorkRecord } from "./documents.ts";
import {
  WorkFinishedError,
  ensureWorkConversationIn,
  findWork,
  installEmployeeExtension,
  isTerminal,
  markFailed,
  startQueuedWork,
  type Resume,
} from "./work.ts";
import { toThinkingLevel } from "./agents.ts";
import { fromError, type AppText } from "./app-text.ts";
import { appMessages } from "./messages.ts";

export type WorkDispatchInput = { workId: string };
export type WorkDispatchState = { phase: "start" | "submit" };
export type WorkDispatchResult = { workId: string };

/** The task definition other modules reference without re-deriving its type. */
export type WorkDispatchTask = Task<WorkDispatchInput, WorkDispatchState, WorkDispatchResult, object>;

/** Commit one terminal outcome; a phase that ends without durable progress faults the task. */
export async function commitTerminal<I, S extends { phase: string }, R>(
  taskRuntime: TaskRuntime<I, S, R, object>,
  outcome: TaskOutcome<R>,
  context: ChordContext,
): Promise<void> {
  await taskRuntime.commit(async () => ({ status: "terminal", outcome }), context);
}

/** Settle a dispatch failure: fail the work once with a notice, then the task. */
async function failDispatch(
  resume: Resume,
  taskRuntime: TaskRuntime<WorkDispatchInput, WorkDispatchState, WorkDispatchResult, object>,
  work: WorkRecord,
  reason: AppText,
  context: ChordContext,
): Promise<void> {
  if (!isTerminal(work.status) && work.status !== "stopped") {
    await markFailed(resume, work, reason);
  }
  await commitTerminal(taskRuntime, { status: "failed", error: { message: reason.text } }, context);
}

/**
 * The durable dispatch task.
 *
 * `resolve` hands back the process `Resume` only when a phase actually runs,
 * so the task definition can be built before the rest of the application is
 * wired without module cycles.
 */
export function buildWorkDispatchTask(resolve: () => Resume): WorkDispatchTask {
  return defineTask<WorkDispatchInput, WorkDispatchState, WorkDispatchResult, object>({
    name: "emit.work-dispatch",
    version: 1,
    initial: () => ({ phase: "start" }),
    phases: {
      start: async (task, taskRuntime, context) => {
        const resume = resolve();
        const { runtime } = resume;
        const work = await findWork(runtime, task.input.workId);
        if (work === undefined) {
          await commitTerminal(
            taskRuntime,
            { status: "failed", error: { message: appMessages.work.workNotFound(task.input.workId).text } },
            context,
          );
          return;
        }
        // A work stopped before its start must not be started by the
        // scheduler that just recovered the task.
        if (work.status === "stopped" || isTerminal(work.status)) {
          await commitTerminal(taskRuntime, { status: "completed", result: { workId: task.input.workId } }, context);
          return;
        }
        const app = await runtime.readSession(AppDoc);
        if (work.depth > app.collaboration.maxDepth) {
          await failDispatch(resume, taskRuntime, work, appMessages.work.depthOverLimit(app.collaboration.maxDepth), context);
          return;
        }
        const employee = await runtime.readFamily(EmployeeDoc, work.employeeId, { id: work.employeeId });
        if (employee === undefined) {
          await failDispatch(resume, taskRuntime, work, appMessages.work.employeeNotFound(work.employeeId), context);
          return;
        }
        if (!employee.enabled) {
          await failDispatch(resume, taskRuntime, work, appMessages.work.employeeDisabled(employee.name), context);
          return;
        }
        const modelProblem = runtime.catalog.chatSelectionProblem({
          providerId: employee.executionModel.providerId,
          modelId: employee.executionModel.modelId,
          effort: employee.executionModel.effort,
        });
        if (modelProblem !== undefined) {
          await failDispatch(resume, taskRuntime, work, appMessages.work.modelUnavailable(employee.name, modelProblem), context);
          return;
        }
        try {
          // The extension must be built and installed before the commit: the
          // agent configuration inside the transaction stores it by name.
          const extension = work.conversationId === 0 ? await installEmployeeExtension(resume, employee) : undefined;
          await taskRuntime.commit(async (tx) => {
            if (work.conversationId === 0) {
              // The send-time directory snapshot is what this run may use; a
              // later directory save must not leak into a queued run.
              const workContext = await tx.doc(WorkContextDoc, work.workContextId, { id: work.workContextId });
              if (
                workContext.createdAt === 0 ||
                workContext.directories.version !== work.directoryScope.version
              ) {
                throw new Error(appMessages.work.directoryChanged().text);
              }
              await ensureWorkConversationIn(tx, work.id, {
                extension: extension!,
                model: { provider: employee.executionModel.providerId, modelId: employee.executionModel.modelId },
                thinkingLevel: toThinkingLevel(employee.executionModel.effort),
                cwd: work.directoryScope.defaultPath || null,
              });
            }
            return { status: "running", checkpoint: { phase: "submit" } };
          }, context);
        } catch (error) {
          if (error instanceof WorkFinishedError) {
            await commitTerminal(taskRuntime, { status: "completed", result: { workId: task.input.workId } }, context);
            return;
          }
          const reason = fromError(error);
          const current = await findWork(runtime, task.input.workId);
          if (current !== undefined && !isTerminal(current.status) && current.status !== "stopped") {
            await failDispatch(resume, taskRuntime, current, reason, context);
            return;
          }
          await commitTerminal(taskRuntime, { status: "failed", error: { message: reason.text } }, context);
        }
      },
      submit: async (task, taskRuntime, context) => {
        const resume = resolve();
        try {
          await startQueuedWork(resume, task.input.workId);
        } catch (error) {
          if (error instanceof WorkFinishedError) {
            await commitTerminal(taskRuntime, { status: "completed", result: { workId: task.input.workId } }, context);
            return;
          }
          const reason = fromError(error);
          const current = await findWork(resume.runtime, task.input.workId);
          if (current !== undefined && !isTerminal(current.status) && current.status !== "stopped") {
            await failDispatch(resume, taskRuntime, current, reason, context);
            return;
          }
          await commitTerminal(taskRuntime, { status: "failed", error: { message: reason.text } }, context);
          return;
        }
        await commitTerminal(taskRuntime, { status: "completed", result: { workId: task.input.workId } }, context);
      },
    },
    abort: async (_task, taskRuntime, context) => {
      // The work itself was already marked stopped by `stopWork`; the task
      // only records that it will never submit.
      await taskRuntime.commit(
        async () => ({
          status: "terminal",
          outcome: { status: "failed", error: { message: appMessages.work.dispatchStopped().text } },
        }),
        context,
      );
    },
  });
}

/** Extension that registers the dispatch task globally; conversations do not select it. */
export function buildWorkDispatchExtension(dispatch: WorkDispatchTask): Extension {
  return defineExtension({ name: "emit.work-dispatch", tasks: [dispatch] });
}
