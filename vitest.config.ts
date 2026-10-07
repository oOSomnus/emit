import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import type { Reporter } from "vitest/node";
import { loadTestSettings } from "./test/helpers/test-settings.ts";

const repositoryRoot = dirname(fileURLToPath(import.meta.url));
const setupFiles = ["test/helpers/isolation-setup.ts"];
const stressTimeout = loadTestSettings().durationMs + 120_000;

function project(
  name: string,
  include: string[],
  maxWorkers: number,
  testTimeout: number,
) {
  return {
    extends: true,
    test: {
      name,
      include,
      environment: "node",
      pool: "forks",
      isolate: true,
      setupFiles,
      allowOnly: false,
      passWithNoTests: false,
      fileParallelism: true,
      maxWorkers,
      testTimeout,
      hookTimeout: testTimeout,
    },
  };
}

type ProjectSummary = {
  files: number;
  tests: number;
  passed: number;
  failed: number;
  skipped: number;
  collectionErrors: number;
  durationMs: number;
};

const projectSummaryReporter: Reporter = {
  onTestRunEnd(testModules, unhandledErrors, reason) {
    const summaries = new Map<string, ProjectSummary>();
    for (const module of testModules) {
      const projectName = module.project.name || "unnamed";
      let summary = summaries.get(projectName);
      if (summary === undefined) {
        summary = {
          files: 0,
          tests: 0,
          passed: 0,
          failed: 0,
          skipped: 0,
          collectionErrors: 0,
          durationMs: 0,
        };
        summaries.set(projectName, summary);
      }

      summary.files += 1;
      const collectionErrorCount = module.errors().length;
      summary.collectionErrors += collectionErrorCount;
      summary.failed += collectionErrorCount;
      for (const testCase of module.children.allTests()) {
        summary.tests += 1;
        summary.durationMs += testCase.diagnostic()?.duration ?? 0;
        const state = testCase.result().state;
        if (state === "passed") summary.passed += 1;
        else if (state === "failed") summary.failed += 1;
        else summary.skipped += 1;
      }
    }

    for (const [projectName, summary] of summaries) {
      const outputDirectory = resolve(repositoryRoot, "test-results", projectName);
      mkdirSync(outputDirectory, { recursive: true });
      writeFileSync(
        resolve(outputDirectory, "summary.json"),
        `${JSON.stringify({ ...summary, status: summary.failed > 0 || unhandledErrors.length > 0 ? "failed" : "passed", unhandledErrors: unhandledErrors.length, runReason: reason }, null, 2)}\n`,
      );
    }
  },
};

export default defineConfig({
  test: {
    root: repositoryRoot,
    allowOnly: false,
    passWithNoTests: false,
    reporters: [
      "default",
      ["junit", { outputFile: "test-results/node/junit.xml" }],
      projectSummaryReporter,
    ],
    coverage: {
      provider: "v8",
      reportOnFailure: true,
      reportsDirectory: "coverage",
      reporter: ["text", "html", "lcov", "json-summary"],
      include: [
        "src/server/**/*.ts",
        "src/shared/**/*.ts",
        "src/web/avatar.ts",
        "src/web/execution-steps.ts",
      ],
    },
    projects: [
      project(
        "core",
        [
          "test/unit.test.ts",
          "test/message-addressing.test.ts",
          "test/i18n.test.ts",
          "test/avatar.test.ts",
          "test/execution-steps.test.ts",
          "test/core/**/*.test.ts",
        ],
        2,
        10_000,
      ),
      project(
        "integration",
        [
          "test/collaboration.test.ts",
          "test/mail.test.ts",
          "test/work-contexts.test.ts",
          "test/approval-policy.test.ts",
          "test/provider-auth.test.ts",
          "test/opencode-session.test.ts",
          "test/integration/**/*.test.ts",
        ],
        2,
        30_000,
      ),
      project("api", ["test/api/**/*.test.ts"], 2, 30_000),
      project(
        "e2e",
        ["test/mock.test.ts", "test/e2e/**/*.test.ts"],
        process.env.CI === "true" ? 2 : 1,
        90_000,
      ),
      project("fault", ["test/fault/**/*.test.ts"], 1, 120_000),
      project("stress", ["test/stress/**/*.test.ts"], 1, stressTimeout),
    ],
  },
});
