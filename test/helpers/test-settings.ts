export type TestSettings = Readonly<{
  seed: number;
  propertyRuns: number;
  concurrency: number;
  operations: number;
  durationMs: number;
  restarts: number;
  path?: string;
}>;

const SETTING_ENV_KEYS = [
  "EMIT_TEST_SEED",
  "EMIT_TEST_PROPERTY_RUNS",
  "EMIT_TEST_CONCURRENCY",
  "EMIT_TEST_OPERATIONS",
  "EMIT_TEST_DURATION_MS",
  "EMIT_TEST_RESTARTS",
  "EMIT_TEST_PATH",
] as const;
const ORCHESTRATION_ENV_KEYS = ["EMIT_TEST_OAUTH_URL"] as const;
const ALLOWED_TEST_ENV_KEYS: Readonly<Record<string, true>> = {
  EMIT_TEST_SEED: true,
  EMIT_TEST_PROPERTY_RUNS: true,
  EMIT_TEST_CONCURRENCY: true,
  EMIT_TEST_OPERATIONS: true,
  EMIT_TEST_DURATION_MS: true,
  EMIT_TEST_RESTARTS: true,
  EMIT_TEST_PATH: true,
  EMIT_TEST_OAUTH_URL: true,
};

type TestEnvironment = Readonly<Record<string, string | undefined>>;

/** Copy only explicitly supplied, recognized test settings across environment isolation. */
export function captureExplicitTestEnvironment(
  environment: TestEnvironment = process.env,
): Record<string, string> {
  assertKnownTestEnvironmentKeys(environment);

  const captured: Record<string, string> = {};
  for (const key of [...SETTING_ENV_KEYS, ...ORCHESTRATION_ENV_KEYS]) {
    const value = environment[key];
    if (value !== undefined) captured[key] = value;
  }
  return captured;
}

/** Parse test-only knobs without accepting prefixes, partial numbers, or silent fallbacks. */
export function loadTestSettings(
  environment: TestEnvironment = process.env,
): TestSettings {
  assertKnownTestEnvironmentKeys(environment);
  validateOAuthOrigin(environment.EMIT_TEST_OAUTH_URL);

  const settings: TestSettings = {
    seed: boundedInteger(
      "EMIT_TEST_SEED",
      environment.EMIT_TEST_SEED,
      20_261_004,
      -2_147_483_648,
      2_147_483_647,
      true,
    ),
    propertyRuns: boundedInteger(
      "EMIT_TEST_PROPERTY_RUNS",
      environment.EMIT_TEST_PROPERTY_RUNS,
      200,
      1,
      100_000,
    ),
    concurrency: boundedInteger("EMIT_TEST_CONCURRENCY", environment.EMIT_TEST_CONCURRENCY, 8, 1, 128),
    operations: boundedInteger("EMIT_TEST_OPERATIONS", environment.EMIT_TEST_OPERATIONS, 500, 1, 100_000),
    durationMs: boundedInteger(
      "EMIT_TEST_DURATION_MS",
      environment.EMIT_TEST_DURATION_MS,
      60_000,
      1_000,
      3_600_000,
    ),
    restarts: boundedInteger("EMIT_TEST_RESTARTS", environment.EMIT_TEST_RESTARTS, 3, 0, 100),
  };

  const path = environment.EMIT_TEST_PATH;
  if (path === "") {
    throw new Error("EMIT_TEST_PATH must be omitted or contain a fast-check path");
  }
  return path === undefined ? settings : { ...settings, path };
}

function assertKnownTestEnvironmentKeys(environment: TestEnvironment): void {
  for (const key of Object.keys(environment)) {
    if (key.startsWith("EMIT_TEST_") && !Object.hasOwn(ALLOWED_TEST_ENV_KEYS, key)) {
      throw new Error(`Unrecognized test environment setting: ${key}`);
    }
  }
}

function boundedInteger(
  name: string,
  raw: string | undefined,
  defaultValue: number,
  minimum: number,
  maximum: number,
  signed = false,
): number {
  if (raw === undefined) return defaultValue;
  const syntax = signed ? /^-?(?:0|[1-9]\d*)$/ : /^(?:0|[1-9]\d*)$/;
  if (!syntax.test(raw)) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
  }

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function validateOAuthOrigin(raw: string | undefined): void {
  if (raw === undefined) return;
  let origin: URL;
  try {
    origin = new URL(raw);
  } catch {
    throw new Error("EMIT_TEST_OAUTH_URL must be a loopback HTTP origin");
  }

  const hostname = origin.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const loopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  if (
    origin.protocol !== "http:" ||
    !loopback ||
    origin.origin !== raw ||
    origin.username !== "" ||
    origin.password !== ""
  ) {
    throw new Error("EMIT_TEST_OAUTH_URL must be a loopback HTTP origin");
  }
}
