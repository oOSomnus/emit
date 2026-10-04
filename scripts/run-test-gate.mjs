import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const gateDirectory = resolve(repositoryRoot, "test-results", "gate");
const testArguments = process.argv.slice(2);
const results = [];

function runStep(name, executable, args) {
  const displayCommand = [executable, ...args].join(" ");
  console.log(`\n=== ${name}: ${displayCommand} ===`);

  let result;
  try {
    result = spawnSync(executable, args, {
      cwd: repositoryRoot,
      stdio: "inherit",
    });
  } catch (error) {
    const step = {
      name,
      command: displayCommand,
      status: "failed",
      exitCode: null,
      error: error instanceof Error ? error.message : String(error),
    };
    results.push(step);
    return step;
  }

  const step = {
    name,
    command: displayCommand,
    status: result.status === 0 && result.error === undefined ? "passed" : "failed",
    exitCode: result.status,
    ...(result.signal === null ? {} : { signal: result.signal }),
    ...(result.error === undefined ? {} : { error: result.error.message }),
  };
  results.push(step);
  return step;
}

function markBlocked(name, command, prerequisite) {
  const step = {
    name,
    command,
    status: "blocked",
    exitCode: null,
    prerequisite,
  };
  results.push(step);
  return step;
}

const build = runStep("build", "npm", ["run", "build"]);
const coverageArgs = ["run", "test:coverage"];
if (testArguments.length > 0) coverageArgs.push("--", ...testArguments);
runStep("node-coverage", "npm", coverageArgs);

if (build.status === "passed") {
  runStep("browser", "npm", ["run", "test:browser"]);
  const binary = runStep("binary-build", process.execPath, ["scripts/build-binary.mjs"]);
  if (binary.status === "passed") {
    runStep("native-smoke", process.execPath, ["test/native-binary.smoke.mjs"]);
  } else {
    markBlocked("native-smoke", "node test/native-binary.smoke.mjs", "binary-build must succeed");
  }
} else {
  markBlocked("browser", "npm run test:browser", "npm run build must succeed");
  markBlocked("binary-build", "node scripts/build-binary.mjs", "npm run build must succeed");
  markBlocked("native-smoke", "node test/native-binary.smoke.mjs", "build and binary-build must succeed");
}

console.log("\nTest gate summary:");
for (const step of results) {
  const code = step.exitCode === null ? "no process" : `exit ${step.exitCode}`;
  console.log(`- ${step.name}: ${step.status} (${code})`);
}

let reportWriteFailed = false;
try {
  mkdirSync(gateDirectory, { recursive: true });
  writeFileSync(
    resolve(gateDirectory, "results.json"),
    `${JSON.stringify({ completedAt: new Date().toISOString(), steps: results }, null, 2)}\n`,
  );
} catch (error) {
  reportWriteFailed = true;
  console.error("Unable to write test gate results:", error instanceof Error ? error.message : error);
}

process.exitCode = reportWriteFailed || results.some((step) => step.status !== "passed") ? 1 : 0;
