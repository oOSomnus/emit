# Development

[English](development.md) | [简体中文](development.zh-CN.md) · [README](../README.md)

Scripts, the dependency patch, prompt resources, and the technology stack. Setup and CLI options are in [Operations](operations.md); user-visible behavior is in [Usage](usage.md).

## Commands

```bash
npm run dev          # build the web UI, then tsx watch src/server/main.ts
npm run typecheck    # tsc for the server project and the web project
npm run build        # typecheck + vite build
npm test             # vitest run
node tmp/smoke.mjs   # end-to-end smoke test
```

`node tmp/smoke.mjs` drives a fake provider through the real harness and covers approvals, manual decisions, denials, stopping, mail, and SIGKILL recovery. It clears and rebuilds `tmp/smoke-data`, `tmp/smoke-work`, and `tmp/smoke-outside`, and it uses ports 8898 (server) and 8899 (fake provider). It is not a normal quick-start command: run it only when those directories and ports are free. `tmp/fake-provider.mjs` is the OpenAI-compatible fake model it uses.

## Dependency patch

`npm install` runs `postinstall`, which applies the [`patch-package`](https://github.com/ds300/patch-package) patch `patches/@earendil-works+pi-durable+1.0.0.patch` to `node_modules`. The patch adds the per-session identifiers OpenCode Go requires to pi-durable's generate and compact requests. If the patch cannot be applied, install exits nonzero and does not continue with an unpatched dependency.

## Prompt resources

All application-owned model prompts are reviewable text resources under `src/server/prompts/`: `employee.md` (employee identity and guidelines skeleton), `work-input.md` (task input), `context.md` (history and compaction), `approval-system.md` / `approval-user.md` (the judge), `tool-results.md`, `skills.md`, `continuations.md`, `address-*.md`, and more, plus `tools.json` and `classifier.json` for tool descriptions and judging rules. A loader loads them once and typed renderers fill their parameters; code only assembles arguments and does not embed long prompt text. Missing or duplicate fragments cause explicit configuration errors, with no fallback to older inline text. Employee instructions, skill bodies, and remote MCP descriptions remain dynamic sources with unchanged editing workflows.

## Stack

- Backend: Node >= 22.19, TypeScript, Fastify, `@earendil-works/pi-durable` / `pi-ai` / `pi-mcp` / `chord`.
- Frontend: React 19 + Vite; a single SSE channel pushes all realtime updates.
- Storage: SQLite (opened by pi-durable's storage).
