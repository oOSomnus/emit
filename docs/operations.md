# Operations

[English](operations.md) | [Simplified Chinese](operations.zh-CN.md) · [README](../README.md)

CLI options, environment variables, data files, credentials, locking, and crash recovery for the single Emit process. Usage behavior is in [Usage](usage.md); approval rules are in [Security](security.md).

## Command line

`npm run dev` builds the web UI and starts the backend with `tsx watch`. `npm start` runs the TypeScript server and expects an already built `dist/web`.

| Option | Meaning | Default | Environment |
| --- | --- | --- | --- |
| `--data-dir <dir>` | Directory holding the database, credentials, and lock | `~/.emit` | `EMIT_DATA_DIR` |
| `--host <address>` | Listen address | `127.0.0.1` | `EMIT_HOST` |
| `--port <port>` | Listen port; `0` picks a free one | auto (`0`) | `EMIT_PORT` |
| `--web-root <dir>` | Built front-end directory | `dist/web` from the source tree; the single-file binary serves its embedded frontend | — |
| `--help`, `-h` | Print usage and exit | — | — |

`make` builds `dist/emit`, a native single-file executable (Node SEA) that embeds the server, prompts, and web UI and accepts the same options; it needs no Node installation. The startup log prints the address the server actually bound.

For data-dir, host, and port, the command-line option takes precedence over the environment variable. Example (replace the data-dir path with your own directory):

```bash
npm start -- --data-dir /absolute/path/to/data --port 8787
```

`.env.example` lists variable names and examples only — Emit does not load `.env` automatically. Export variables in the shell, or configure providers in the UI.

## Data files

- `<data-dir>/emit.sqlite` — all sessions, documents, tasks, and approvals.
- `<data-dir>/credentials.json` (written with mode 0600) — native provider credentials, custom provider endpoints, the dynamic model catalog cache, and a stable installation id. The native credential store is the single source of truth for provider authentication; OAuth refreshes are persisted here, and values are never sent to the browser.
- `<data-dir>/emit.lock` — the lock `proper-lockfile` uses to keep one process per data directory.
- `<data-dir>/.emit-web/` — only for the single-file binary: a self-repairing copy of the embedded frontend, restored on startup. `--web-root` replaces it entirely, and deleting it is safe.

### Credential precedence

- A provider with native saved credentials (the file's `auth` section) takes priority over environment variables. A provider without a saved credential falls back to ambient environment variables such as `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, or `TYPESAFE_API_KEY`.
- The file's `env` map is injected into the process environment at startup, but values already present in the environment win: a shell export always overrides the file.
- A missing credentials file is fine — Emit initializes it. Malformed JSON or a non-object file is rejected at startup.
- 0600 is the mode used when writing the file. It does not by itself make the data directory private; protect the directory with OS permissions if other users share the machine.

## Locking and recovery

- One data directory allows one process at a time. A second process retries for about 20 seconds and then refuses to start with the lock path in its error. Do not delete the lock while a process may still be running.
- After a hard kill (SIGKILL, power loss) the lock left behind stops being refreshed; once it is older than 15 seconds it is treated as stale and a new process takes it over automatically.
- SQLite runs in WAL mode with `synchronous=NORMAL`: process crashes are recoverable, but a power loss may lose the last commit.
- Every work runs in its own execution conversation; the room's public record lives in the room's own conversation, so they do not pollute each other.
- An answer and "work completed" are written in the same commit: a crash leaves both unwritten, and recovery re-delivers instead of producing a half state.
- On startup the process resumes running tasks first, then marks work that has no live task and no unsettled submission as failed and explains why in its original session.
- Recovery follows each tool's replay declaration. `read_file`, `load_skill`, and `send_mail` declare `replay=safe`, so an interrupted call may be re-run (mail is deduplicated by a durable receipt); tools that do not declare it (file writes/edits, Shell, ...) and MCP tools with `replay=unsafe` are not re-run automatically after an interruption, and the model sees the interrupted call and decides what to do next. External side effects are not promised exactly-once.

## Upgrading from earlier data models

Work contexts replaced session-owned working directories and the per-channel assignment model. This was a clean cutover: existing rooms, messages, notes, and approvals are not migrated, old session directories and grants are not inherited automatically, and the database is not cleared. Conversations created by an older version must be recreated under a work.

Earlier, session-owned working directories replaced employee-owned `cwd`, and the approval contract moved to v3 with a separately configured evaluation model; that change was a clean cutover too — old employee directories are not migrated and old paths are not granted automatically.
