# Development

[English](development.md) | [Simplified Chinese](development.zh-CN.md) · [README](../README.md)

Scripts, the dependency patch, prompt resources, and the technology stack. Setup and CLI options are in [Operations](operations.md); user-visible behavior is in [Usage](usage.md).

## Commands

```bash
npm run dev          # build the web UI, then tsx watch src/server/main.ts
npm run typecheck    # tsc for the server project and the web project
npm run build        # typecheck + vite build
npm test             # vitest run
make                 # native single-file build (dist/emit, Node SEA)
make smoke           # rebuild and run the native-binary smoke suite
node tmp/smoke.mjs   # end-to-end smoke test
```

`node tmp/smoke.mjs` drives a fake provider through the real harness and covers approvals, manual decisions, denials, stopping, mail, and SIGKILL recovery. It clears and rebuilds `tmp/smoke-data`, `tmp/smoke-work`, and `tmp/smoke-outside`, and it uses ports 8898 (server) and 8899 (fake provider). It is not a normal quick-start command: run it only when those directories and ports are free. `tmp/fake-provider.mjs` is the OpenAI-compatible fake model it uses.

## Web interface

[`DESIGN.md`](../DESIGN.md) records the implemented bilingual agenda-style workspace; `.impeccable/design.json` contains its design-panel previews. `src/web/styles.css` is the single source of semantic colors, typography, spacing, and responsive rules. Keep light/dark themes and English/Simplified Chinese on the existing preference providers; do not introduce another theme system or remote fonts.

Chat and mail share employee identity metadata and reading typography, but retain their synchronous and asynchronous workflows. Mail thread-open buttons and their sibling read/archive/draft actions are separate keyboard and touch targets; an action must not also open a thread. Folder and thread layouts respond to the mail pane's available width. Coarse-pointer controls have a 44px minimum target; narrow screens retain the existing navigation drawer.

For interface smoke checks, run the application and fake provider with an isolated temporary data directory and unused ports. Never reuse a real workspace or the destructive smoke script's directories for screenshots. Check both communication surfaces, supporting views, themes, languages, and touch/keyboard interaction; use real harness records when checking execution pagination.

## Dependency patch

`npm install` runs `postinstall`, which executes `scripts/apply-pi-durable-patch.mjs` against the installed `@earendil-works/pi-durable`. The patch adds the per-session identifiers OpenCode Go requires to pi-durable's generate and compact requests. The script checks the package name/version, accepts only "unpatched anchor exactly once" or "already patched" per file, and exits nonzero with the target path on anything else — including a changed dependency version — so a reinstall never continues with an unpatched or half-patched dependency. `node scripts/apply-pi-durable-patch.mjs` applies or verifies it manually and is idempotent. The build (`scripts/build-binary.mjs`) calls the same function before bundling, so a binary never embeds an unpatched dependency.

## Native binary

`make` produces `dist/emit` (Windows: `dist/emit.exe`) for the host OS/architecture — there is no cross-compilation and no release matrix. `scripts/build-binary.mjs` bundles `src/server/main.ts` with esbuild (`platform: node`, `format: cjs`, all dependencies embedded except Node builtins), rewrites `import.meta.url`/`import.meta.dirname` to the executable's path, maps `@earendil-works/pi-coding-agent` to its skill loader only, and bakes that package's own metadata into its config so the binary never reads a stray `package.json` next to itself. It then embeds `src/server/prompts/**` and the file list of `dist/web` as SEA assets, generates the blob with the same `node` that is copied into the output, and injects it with postject. `src/server/pi-modules.ts` registers pi-ai's static OAuth flows and Bedrock module at startup, because their variable-specifier imports cannot be bundled. Building requires Node >= 22.19 (SEA and built-in SQLite) and GNU make; a missing prerequisite fails the build instead of shipping a partial artifact.

`test/native-binary.smoke.mjs` (run by `make smoke`) exercises the real executable with an isolated environment: `--help`, default and explicit port allocation (including an occupied port), embedded UI and SPA fallback, persistence and cache repair across restarts, skill import through the bundled Pi loader, SSE shutdown, and `--web-root` override. It never touches the real data directory.

## Prompt resources

All application-owned model prompts are reviewable text resources under `src/server/prompts/`: `employee.md` (employee identity and guidelines skeleton), `work-input.md` (task input), `context.md` (history and compaction), `approval-system.md` / `approval-user.md` (the judge), `tool-results.md`, `skills.md`, `continuations.md`, `address-*.md`, and more, plus `tools.json` and `classifier.json` for tool descriptions and judging rules. A loader loads them once and typed renderers fill their parameters; code only assembles arguments and does not embed long prompt text. Missing or duplicate fragments cause explicit configuration errors, with no fallback to older inline text. Employee instructions, skill bodies, and remote MCP descriptions remain dynamic sources with unchanged editing workflows.

## Stack

- Backend: Node >= 22.19, TypeScript, Fastify, `@earendil-works/pi-durable` / `pi-ai` / `pi-mcp` / `chord`.
- Frontend: React 19 + Vite; a single SSE channel pushes all realtime updates.
- Storage: SQLite (opened by pi-durable's storage).
