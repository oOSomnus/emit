import { describe, expect, it } from "vitest";
import type { WorkExecutionStepDTO } from "../src/shared/contracts.ts";
import { mergeExecutionSteps } from "../src/web/execution-steps.ts";

function page(first: number, last: number): WorkExecutionStepDTO[] {
  return Array.from({ length: last - first + 1 }, (_, index) => {
    const number = first + index;
    return { id: `step-${number}`, entryId: `entry-${number}`, kind: "input", text: `Input ${number}` };
  });
}

const ids = (steps: WorkExecutionStepDTO[]): string[] => steps.map((step) => step.id);

describe("execution page retention", () => {
  it("keeps the boundary step when the newest page advances after loading history", () => {
    const loaded = mergeExecutionSteps(page(101, 200), page(1, 100), "older");
    const refreshed = mergeExecutionSteps(loaded, page(102, 201), "newer");
    expect(ids(refreshed)).toEqual(ids(page(1, 201)));
  });

  it("keeps displayed steps when a live refresh arrives before an older page", () => {
    const refreshed = mergeExecutionSteps(page(101, 200), page(105, 204), "newer");
    const loaded = mergeExecutionSteps(refreshed, page(1, 100), "older");
    expect(ids(loaded)).toEqual(ids(page(1, 204)));
  });

  it("updates task state without duplicating or moving an overlapping step", () => {
    const current = page(1, 3);
    const updated: WorkExecutionStepDTO = {
      ...current[1]!,
      taskId: "task-2",
      taskStatus: "terminal",
      taskError: "Execution failed",
    };
    const refreshed = mergeExecutionSteps(current, [updated, current[2]!], "newer");
    expect(ids(refreshed)).toEqual(["step-1", "step-2", "step-3"]);
    expect(refreshed[1]).toEqual(updated);
    expect(current[1]?.taskStatus).toBeUndefined();
  });
});
