import type { WorkExecutionStepDTO } from "../shared/contracts.ts";

/** Preserve displayed steps in page order while refreshing their task state. */
export function mergeExecutionSteps(
  current: readonly WorkExecutionStepDTO[],
  page: readonly WorkExecutionStepDTO[],
  position: "older" | "newer",
): WorkExecutionStepDTO[] {
  const merged = new Map<string, WorkExecutionStepDTO>();
  if (position === "older") {
    for (const step of page) merged.set(step.id, step);
  }
  for (const step of current) merged.set(step.id, step);
  for (const step of page) merged.set(step.id, step);
  return [...merged.values()];
}
