import { afterEach, beforeEach } from "vitest";
import { createE2eFixture, type E2eFixture } from "./e2e-fixture.ts";

export type SuiteCleanup = Array<() => void | Promise<void>>;

export function useSuiteCleanup(options: {
  key?: { env: string; value: string };
  errorMode: "ignore" | "propagate";
}): SuiteCleanup {
  const cleanups: SuiteCleanup = [];
  const key = options.key;
  let previousKey: string | undefined;

  if (key !== undefined) {
    beforeEach(() => {
      previousKey = process.env[key.env];
      process.env[key.env] = key.value;
    });
  }

  afterEach(async () => {
    for (const close of cleanups.splice(0).reverse()) {
      if (options.errorMode === "ignore") {
        try {
          await close();
        } catch {
          // Cleanup must not replace the assertion that failed.
        }
      } else {
        await close();
      }
    }
    if (key !== undefined) {
      if (previousKey === undefined) delete process.env[key.env];
      else process.env[key.env] = previousKey;
    }
  });

  return cleanups;
}

export async function openOwnedE2eFixture(cleanups: SuiteCleanup): Promise<E2eFixture> {
  const fixture = await createE2eFixture();
  cleanups.push(() => fixture.close());
  return fixture;
}
