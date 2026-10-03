# Emit

[English](README.md) | [Simplified Chinese](README.zh-CN.md)

Emit is a local digital-employee collaboration workspace: the interface mixes Slack and a mailbox, and every agent is a digital employee with a role, skills, MCP servers, and tool permissions.

The backend is a single Node process that exclusively owns one SQLite database and one [Pi Durable](https://earendil.com/posts/pi-durable/) harness. Messages, mail, tool calls, approvals, and run records are durable tasks and documents: close the browser and work keeps running; after a hard kill or power loss, the process resumes unfinished runs on restart.

## Features

- Each employee has its own model, reasoning effort, skill bindings, MCP bindings, allowed tools, and an MCP read-only trust list. Employees can message each other, send mail, and delegate work, with depth, wake, and turn budgets that stop runaway loops.
- Channels, direct messages, and asynchronous in-app mail. A channel wakes an employee only when you assign one in the `Assign employee` dropdown; direct messages wake their employee by default. Delegated work's final answer is visible on the Work page and returns to the originating session.
- Sessions own their working directories: channels, DMs, and mail threads each keep their own server-local directories and default execution directory, and every run snapshots them.
- Mail is durable and asynchronous: sending commits the body, each recipient's queued work, and the dispatch tasks before the model runs, so nothing is lost when the browser closes or the process is killed.
- Automatic risk review: low and medium risk are approved automatically, high risk goes to a manual queue, `deny`/`critical` is rejected, and unknown risk or a judge failure blocks execution.
- Results and completion are committed atomically; a restart resumes live runs and marks unrecoverable work as failed, and an interrupted tool is re-run only when the tool declares its replay safe.

## Quick start

Requires Node.js >= 22.19.0.

```bash
npm install
npm run dev          # build the web UI and start the backend (tsx watch)
```

Open the URL printed by the startup log (`Emit 已启动：…`); the server picks a free loopback port by default — pass `--port` or set `EMIT_PORT` to pin one. Complete the first-run setup: a workspace name (prefilled with a default), your name, a usable default chat model with a supported reasoning effort, and a separately configured approval judge (a chat model or a classifier). The judge never silently falls back to an employee model. Providers authenticate through their native flows: API key, OAuth/subscription, cloud credentials, or credentials already present in the process environment.

Production start:

```bash
npm run build
npm start            # requires a built dist/web
```

Single-file build:

```bash
make                 # builds dist/emit (native single executable, Node SEA)
make smoke           # rebuilds and runs the native-binary smoke suite
```

`dist/emit` is one file: it embeds the server, the prompt resources, and the web UI, so it runs without Node, npm, or the source tree, and it restores the embedded frontend under `<data-dir>/.emit-web`. It is native to the OS/architecture it was built on. `make` installs dependencies from the lockfile on first use.

The default data directory is `~/.emit`, and one process owns it at a time; saved credentials never go back to the browser. [Operations](docs/operations.md) documents the files, precedence rules, and lock behavior.

## Safety boundaries

- Session working directories are **not an OS sandbox**. Built-in file tools validate real paths and symlinks, and Shell validates its starting cwd, but arbitrary commands and stdio/remote MCP servers still run with their own process privileges, and a directory list does not guarantee they cannot see other paths.
- Automatic risk review is **not a sandbox** either: it judges a redacted action with a budgeted context, so it cannot give kernel-level read-only guarantees and the model can misjudge. Unknown or failed evaluations block execution and high risk needs a human, but neither replaces process isolation.
- The judge model is not a security guarantee and cannot audit history omitted by the budget.
- Connecting a remote model sends the corresponding context to that provider; when using local models, the model context stays on this machine.
- Emit listens on loopback (`127.0.0.1`) by default, and it has no SMTP delivery: external mail addresses are recorded and displayed only.

## Documentation

| Topic | Document |
| --- | --- |
| Usage — employees, collaboration, sessions, mail, themes | [docs/usage.md](docs/usage.md) |
| Operations — CLI, data files, credentials, recovery | [docs/operations.md](docs/operations.md) |
| Security — approval model and safety properties | [docs/security.md](docs/security.md) |
| Development — scripts, prompts, smoke test | [docs/development.md](docs/development.md) |

History: [CHANGELOG.md](CHANGELOG.md) (English).

## Development

```bash
npm run typecheck    # server and web type checks
npm run build        # typecheck + build the front end
npm test             # vitest
make                 # native single-file build (dist/emit)
make smoke           # native-binary smoke suite
```

The end-to-end smoke test, prompt resources, dependency patch, and technology stack are in [docs/development.md](docs/development.md).
