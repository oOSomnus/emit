# Development

[English](development.md) | [Simplified Chinese](development.zh-CN.md) · [README](../README.md)

Scripts, the dependency patch, prompt resources, and the technology stack. Setup and CLI options are in [Operations](operations.md); user-visible behavior is in [Usage](usage.md).

## Commands

```bash
make install         # install dependencies from the lockfile
make dev             # build the web UI, then tsx watch src/server/main.ts
make typecheck       # separate server, web, and browser-test TypeScript environments
make lint            # ESLint over sources, scripts, and tests
make build           # typecheck + vite build
make test            # daily Vitest projects: core, integration, api, e2e
make                 # native single-file build (dist/emit, Node SEA)
make smoke           # rebuild and run the native-binary smoke suite
make e2e             # isolated real-process tests (npm run test:e2e)
make mock            # throwaway workspace seeded from the real config, run with real models
```

`make help` lists every target; runtime arguments go through `ARGS`, for example `make test ARGS='test/mock.test.ts'` or `make start ARGS='--port 8787'`. The npm scripts remain the internal implementation of these targets.

`make e2e` builds the frontend and runs the isolated `e2e` project against real Emit processes and local protocol fixtures in `test/fixtures/`. Every scenario owns temporary data, HOME, work/outside roots, ephemeral loopback ports, and child process groups. It never clears repository scratch directories or reads real provider credentials. The test-only fetch preload rejects
unregistered origins; OpenCode Go is redirected only to the explicitly registered local provider.

`make mock` is the opposite trade-off: it reads the real data directory (default `~/.emit`, `EMIT_DATA_DIR`, or `--source-data-dir`) through a read-only SQLite backup — committed state including the WAL — copies the provider credentials (never saved OAuth logins, which could invalidate the real session), seeds `Alice`/`Bob`/`Carol` plus two channels and a work context in a
fresh private temp directory, and starts the real server on it, so a breaking change never requires hand-rebuilding a test scenario. Seeding makes no model calls; sending messages in the started workspace does, with the configured real models, and may cost money. The temp root is removed when the service exits, and the source workspace is never opened as a runtime.

Daily layers are independently runnable with `npm run test:unit`, `test:integration`, `test:api`, and `test:e2e`; `test:coverage` measures the server/shared code and pure web helpers. `npm run test:gate` executes build, daily coverage, two Chromium projects, native build, and native smoke, preserving every reachable layer's exit code. `npm run test:fault` and
`npm run test:stress` are explicit manual commands, never implicit in `npm test` or watch. Stress defaults to 8 concurrent requests, 500 operations or 60 seconds, and at most 3 restarts; heavier loads require explicit `EMIT_TEST_*` settings.

`npm run lint` (or `make lint`) runs ESLint's recommended JavaScript and typescript-eslint presets over `src`, `scripts`, and `test` with zero tolerated warnings; type checking stays with the three project tsconfigs. Copy/paste duplication is measured with jscpd through `.jscpd.json`, which reports duplicated blocks of 150 tokens or more. Both gates run in GitHub
Actions: `.github/workflows/test.yml` executes `npm run test:gate`, and `.github/workflows/mega-linter.yml` runs MegaLinter (stylelint, ESLint, jscpd, spelling, links, secrets, and workflow audits) over the whole codebase and uploads `megalinter-reports/` as an artifact.

### Layered test matrix

| Layer                         | Entry point                        | Behavioral boundaries                                                                                                                                    |
|-------------------------------|------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------|
| L1: specifications/properties | `npm run test:unit`                | Addressing, approval policy, normalized roots, execution records, localization, deterministic random inputs and boundary values                          |
| L2: real runtime              | `npm run test:integration`         | SQLite persistence, approval transitions, races, history cursors, work limits, permissions after root replacement                                        |
| L3: HTTP/SSE                  | `npm run test:api`                 | Rejected writes leave no state, event/final-state convergence, mail delivery, execution redaction, native auth and refresh                               |
| L4: processes/native          | `npm run test:e2e` / `test:native` | SIGKILL recovery, ownership locks, unique answers, collaboration graphs, scope isolation, real shell/MCP, Go sessions, native startup without a checkout |
| L5: browser                   | `npm run test:browser`             | Real onboarding, chat, approvals, mailbox, settings, mobile navigation, preferences, reconnect                                                           |
| L6: fault injection           | `npm run test:fault`               | Upstream errors, malformed/truncated streams, MCP faults, SSE lifecycle, safe convergence after process interruption                                     |
| L7: stress/state models       | `npm run test:stress`              | Concurrent load, history/event fanout, random commands, repeated restart; measured latency/errors/memory                                                 |

The daily gate continues independently runnable layers after failure. Missing build prerequisites are explicitly blocked; any failed or blocked layer yields a nonzero exit. Node summaries: `test-results/<project>/summary.json`; aggregate: `test-results/gate/results.json`; coverage: `coverage/`; browser JUnit/failure screenshots/traces/videos and HTML: `test-results/browser/`
and `playwright-report/`. Retain failing behavioral assertions; do not hide defects behind skips, retries, or expectations that bless the current error.

Coverage reports are written even when contracts fail. Per-project summaries distinguish that project's `status` from the whole invocation's `runReason`; one red project must not label every other project failed.

Native scenario outcomes are written to `test-results/native/summary.json`, including independently exercised startup faults and the number of unexercised scenarios when a prerequisite fails.

Stress measurements are persisted in `test-results/stress/{public-runtime-load,execution-pagination,public-command-model,owned-process-recovery}.json`: settings/seed, real request and observation errors, latency percentiles, and sampled owned-server RSS. These are observations, not performance guarantees or continuous peak-memory measurements.

### Explicit heavy load and replay

Only these test knobs are accepted. Unknown `EMIT_TEST_*` keys, out-of-range values and partial/non-integer numbers fail immediately.

| Variable                  | Default    | Bounds/purpose                                  |
|---------------------------|------------|-------------------------------------------------|
| `EMIT_TEST_SEED`          | `20261004` | Signed 32-bit integer; deterministic randomness |
| `EMIT_TEST_PROPERTY_RUNS` | `200`      | `1..100000`; property runs                      |
| `EMIT_TEST_CONCURRENCY`   | `8`        | `1..128`; clients/work concurrency              |
| `EMIT_TEST_OPERATIONS`    | `500`      | `1..100000`; operations                         |
| `EMIT_TEST_DURATION_MS`   | `60000`    | `1000..3600000`; duration bound                 |
| `EMIT_TEST_RESTARTS`      | `3`        | `0..100`; owned-process restarts                |
| `EMIT_TEST_PATH`          | Unset      | Shrunk path from the fast-check failure report  |

```bash
EMIT_TEST_PROPERTY_RUNS=10000 npm run test:unit
EMIT_TEST_CONCURRENCY=32 EMIT_TEST_OPERATIONS=1000 npm run test:stress
EMIT_TEST_CONCURRENCY=128 EMIT_TEST_OPERATIONS=10000 EMIT_TEST_RESTARTS=20 npm run test:stress
# Supply the original failing file/name and reported seed/path.
EMIT_TEST_SEED=20261004 EMIT_TEST_PATH='0:1:2' npm run test:unit -- test/core/properties.test.ts
```

`EMIT_TEST_OAUTH_URL` is an orchestration setting for a registered loopback HTTP auth fixture, never a public load target. All test accounts, credentials and files are fictional/private. Fault/load cleanup kills only owned process groups, never deletes locks, scans unrelated processes, or removes user scratch data.

## Web interface

[`DESIGN.md`](../DESIGN.md) records the implemented bilingual agenda-style workspace; `.impeccable/design.json` contains its design-panel previews. `src/web/styles.css` is the single source of semantic colors, typography, spacing, and responsive rules. Keep light/dark themes and English/Simplified Chinese on the existing preference providers; do not introduce another theme system or remote fonts.

Chat and mail share employee identity metadata and reading typography, but retain their synchronous and asynchronous workflows. Mail thread-open buttons and their sibling read/archive/draft actions are separate keyboard and touch targets; an action must not also open a thread. Folder and thread layouts respond to the mail pane's available width. Coarse-pointer controls have a
44px minimum target; narrow screens retain the existing navigation drawer.

For interface checks, build the web UI and run `npm run test:browser` for Chromium desktop/mobile; `npm run test:browser:all` explicitly adds Firefox/WebKit. Install engines with `npx playwright install chromium firefox webkit`, and system libraries with `npx playwright install-deps chromium firefox webkit` when needed. Scenarios use private workspaces and real HTTP/SSE, not
DOM or REST mocks. Missing browser prerequisites are failures, not skipped success.

## Dependency patch

`npm install` runs `postinstall`, which executes `scripts/apply-pi-durable-patch.mjs` against the installed `@earendil-works/pi-durable`. The patch adds the per-session identifiers OpenCode Go requires to pi-durable's generate and compact requests. The script checks the package name/version, accepts only "unpatched anchor exactly once" or "already patched" per file, and exits
nonzero with the target path on anything else — including a changed dependency version — so a reinstall never continues with an unpatched or half-patched dependency. `node scripts/apply-pi-durable-patch.mjs` applies or verifies it manually and is idempotent. The build (`scripts/build-binary.mjs`) calls the same function before bundling, so a binary never embeds an unpatched
dependency.

## Native binary

`make` produces `dist/emit` (Windows: `dist/emit.exe`) for the host OS/architecture — there is no cross-compilation and no release matrix. `scripts/build-binary.mjs` bundles `src/server/main.ts` with esbuild (`platform: node`, `format: cjs`, all dependencies embedded except Node builtins), rewrites `import.meta.url`/`import.meta.dirname` to the executable's path, maps
`@earendil-works/pi-coding-agent` to its skill loader only, and bakes that package's own metadata into its config so the binary never reads a stray `package.json` next to itself. It then embeds `src/server/prompts/**` and the file list of `dist/web` as SEA assets, generates the blob with the same `node` that is copied into the output, and injects it with postject.
`src/server/pi-modules.ts` registers pi-ai's static OAuth flows and Bedrock module at startup, because their variable-specifier imports cannot be bundled. Building requires Node >= 22.19 (SEA and built-in SQLite) and GNU make; a missing prerequisite fails the build instead of shipping a partial artifact.

`test/native-binary.smoke.mjs` (run by `make smoke`) exercises the real executable with an isolated environment: `--help`, default and explicit port allocation (including an occupied port), embedded UI and SPA fallback, persistence and cache repair across restarts, skill import through the bundled Pi loader, SSE shutdown, and `--web-root` override. It never touches the real data directory.

## Prompt resources

All application-owned model prompts are reviewable text resources under `src/server/prompts/`: `employee.md` (employee identity and guidelines skeleton), `work-input.md` (task input), `context.md` (history and compaction), `approval-system.md` / `approval-user.md` (the judge), `tool-results.md`, `skills.md`, `continuations.md`, `address-*.md`, and more, plus `tools.json` and
`classifier.json` for tool descriptions and judging rules. A loader loads them once and typed renderers fill their parameters; code only assembles arguments and does not embed long prompt text. Missing or duplicate fragments cause explicit configuration errors, with no fallback to older inline text. Employee instructions, skill bodies, and remote MCP descriptions remain
dynamic sources with unchanged editing workflows.

## Stack

- Backend: Node >= 22.19, TypeScript, Fastify, `@earendil-works/pi-durable` / `pi-ai` / `pi-mcp` / `chord`.
- Frontend: React 19 + Vite; a single SSE channel pushes all realtime updates.
- Storage: SQLite (opened by pi-durable's storage).
