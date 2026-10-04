import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { captureExplicitTestEnvironment, loadTestSettings } from "./test-settings.ts";

const SAFE_ENVIRONMENT_KEYS = [
  "PATH",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "TZ",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
] as const;
type IsolationState = {
  readonly safeEnvironment: Record<string, string>;
  readonly testEnvironment: Record<string, string>;
  readonly temporaryParent: string;
  currentRoot?: string;
};

type IsolatedProcess = NodeJS.Process & { __emitVitestIsolationState?: IsolationState };

const isolatedProcess = process as IsolatedProcess;
let state = isolatedProcess.__emitVitestIsolationState;
if (state === undefined) {
  const safeEnvironment: Record<string, string> = {};
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    const value = process.env[key];
    if (value !== undefined) safeEnvironment[key] = value;
  }
  const testEnvironment = captureExplicitTestEnvironment(process.env);
  loadTestSettings(testEnvironment);
  state = {
    safeEnvironment,
    testEnvironment,
    temporaryParent: tmpdir(),
  };
  Object.defineProperty(isolatedProcess, "__emitVitestIsolationState", {
    configurable: false,
    enumerable: false,
    value: state,
    writable: false,
  });
}

loadTestSettings(state.testEnvironment);
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, state.safeEnvironment, state.testEnvironment);

const root = mkdtempSync(join(state.temporaryParent, `emit-vitest-${process.pid}-`));
state.currentRoot = root;
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  if (state?.currentRoot === root) state.currentRoot = undefined;
});

const home = join(root, "home");
const temporary = join(root, "tmp");
const xdgConfig = join(root, "xdg-config");
const xdgCache = join(root, "xdg-cache");
for (const directory of [home, temporary, xdgConfig, xdgCache]) {
  mkdirSync(directory, { recursive: true });
}

process.env.HOME = home;
process.env.TMPDIR = temporary;
process.env.XDG_CONFIG_HOME = xdgConfig;
process.env.XDG_CACHE_HOME = xdgCache;
