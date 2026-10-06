import { performance } from "node:perf_hooks";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { loadTestSettings } from "./test-settings.ts";

export type StressHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type RssReader = () => number | undefined;

type LatencySummary = { count: number; p50Ms: number | null; p95Ms: number | null; p99Ms: number | null; maxMs: number | null };

/** Counts real loopback HTTP requests and samples the owned Emit child process RSS. */
export class StressMetrics {
  readonly startedAt = performance.now();
  readonly startedRssBytes: number | undefined;
  readonly #rssReader: RssReader;
  readonly #requestLatenciesMs: number[] = [];
  readonly #observationLatenciesMs: number[] = [];
  #peakRssBytes: number | undefined;
  #errors = 0;
  #observations = 0;
  #observationErrors = 0;

  constructor(rssReader: RssReader) {
    this.#rssReader = rssReader;
    this.startedRssBytes = rssReader();
    this.#peakRssBytes = this.startedRssBytes;
  }

  recordRequest(elapsedMs: number, failed = false): void {
    this.#requestLatenciesMs.push(elapsedMs);
    if (failed) this.#errors += 1;
    this.#sampleRss();
  }

  recordObservation(elapsedMs: number, failed = false): void {
    this.#observations += 1;
    this.#observationLatenciesMs.push(elapsedMs);
    if (failed) this.#observationErrors += 1;
    this.#sampleRss();
  }

  recordError(): void {
    this.#errors += 1;
  }

  summary(): {
    operations: number;
    errors: number;
    observations: number;
    observationErrors: number;
    requestLatencyMs: LatencySummary;
    observationLatencyMs: LatencySummary;
    ownedServerRssBytes: { platform: typeof process.platform; available: boolean; initial: number | null; sampledPeak: number | null; final: number | null };
    elapsedMs: number;
  } {
    const finalRss = this.#rssReader();
    if (finalRss !== undefined) this.#peakRssBytes = Math.max(this.#peakRssBytes ?? finalRss, finalRss);
    return {
      operations: this.#requestLatenciesMs.length,
      errors: this.#errors,
      observations: this.#observations,
      observationErrors: this.#observationErrors,
      requestLatencyMs: summarizeLatencies(this.#requestLatenciesMs),
      observationLatencyMs: summarizeLatencies(this.#observationLatenciesMs),
      ownedServerRssBytes: {
        platform: process.platform,
        available: this.startedRssBytes !== undefined || this.#peakRssBytes !== undefined || finalRss !== undefined,
        initial: this.startedRssBytes ?? null,
        sampledPeak: this.#peakRssBytes ?? null,
        final: finalRss ?? null,
      },
      elapsedMs: performance.now() - this.startedAt,
    };
  }

  close(): void {
    this.#sampleRss();
  }

  #sampleRss(): void {
    const currentRss = this.#rssReader();
    if (currentRss !== undefined) this.#peakRssBytes = Math.max(this.#peakRssBytes ?? currentRss, currentRss);
  }
}

export async function stressRequest<T>(
  metrics: StressMetrics,
  baseUrl: string,
  path: string,
  options: {
    method?: StressHttpMethod;
    body?: unknown;
    expectedStatuses?: readonly number[];
    timeoutMs?: number;
  } = {},
): Promise<{ status: number; body: T; elapsedMs: number }> {
  const started = performance.now();
  let recorded = false;
  const method = options.method ?? "GET";
  try {
    const response = await fetch(new URL(path, baseUrl), {
      method,
      ...(options.body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(options.body) }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
    const text = await response.text();
    const elapsedMs = performance.now() - started;
    const expectedStatuses = options.expectedStatuses ?? [200];
    const accepted = expectedStatuses.includes(response.status);
    metrics.recordRequest(elapsedMs, !accepted);
    recorded = true;
    let body: T;
    try {
      body = JSON.parse(text) as T;
    } catch (error) {
      if (accepted) metrics.recordError();
      throw new Error(`${method} ${path} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    if (!accepted) {
      throw new Error(`${method} ${path} returned HTTP ${response.status}: ${text}`);
    }
    return { status: response.status, body, elapsedMs };
  } catch (error) {
    if (!recorded) metrics.recordRequest(performance.now() - started, true);
    throw error;
  }
}

export function printStressMetrics(name: string, metrics: StressMetrics): void {
  const report = { completedAt: new Date().toISOString(), settings: loadTestSettings(), ...metrics.summary() };
  const directory = fileURLToPath(new URL("../../test-results/stress/", import.meta.url));
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${name}.json`), `${JSON.stringify(report, null, 2)}\n`);
  console.info(`[stress] ${name} ${JSON.stringify(report)}`);
}

function summarizeLatencies(latencies: readonly number[]): LatencySummary {
  const sorted = [...latencies].sort((left, right) => left - right);
  return {
    count: sorted.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    maxMs: sorted.at(-1) ?? null,
  };
}

function percentile(sorted: readonly number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.ceil(fraction * sorted.length) - 1] ?? sorted[sorted.length - 1] ?? null;
}
