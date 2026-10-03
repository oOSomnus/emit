# Security

[English](security.md) | [Simplified Chinese](security.zh-CN.md) · [README](../README.md)

The automatic risk review and its safety properties. Day-to-day behavior is in [Usage](usage.md); where data and credentials live is in [Operations](operations.md).

## Approval model

Risky tool calls — writing or editing files, executing Shell, untrusted MCP calls — first create an approval record:

1. First-run setup must select a usable approval judge on its own: a chat model (its judge calls are made without tools, so no special "no-tools" model is required) or a classifier. The judge is never silently inherited from an employee model.
2. The judge receives the complete redacted action, canonical target paths, session directories and version, real user-instruction provenance, and the active execution history (including tool calls and results).
3. `allow/low` and `allow/medium` are approved automatically — ordinary queries and small reversible writes need no human; only `allow/high` enters the manual queue. `deny` or `critical` is rejected automatically; unknown risk, judge failure, missing fields, or over-budget history shows "automatic review blocked" and blocks execution instead of going to a human queue.
4. An approval is valid for that single call only: before execution, parameters, directory snapshot, employee configuration, and policy version are checked atomically and a one-time grant is claimed.

## Safety properties

- Approval identity binds `toolTaskId + employeeId + toolName + parameter hash + canonical cwd/target paths + session directory ID/full roots/version + configuration version + policy version`. Recovery finds the same record for the same action; approvals cannot be reused across sessions, directories, or changed parameters.
- Changing approval configuration bumps the policy version; changing a session's directories invalidates only that session's unexecuted approvals, not other sessions'.
- Read-only file reads, reading a bound skill's `SKILL.md`, and MCP tools the employee has trusted as read-only skip approval. Everything else enters it, including untrusted MCP tools (the judge may still approve such a call directly).
- Judging targets the complete action, not command prefixes: plain `ls/pwd/cat/rg/git status/diff/log` are usually low risk; redirection, writes, scripts, and outbound sends are judged by their actual effect. Being outside a directory is not inherently high risk, normal authentication is not credential probing, and reading a possibly secret file is not automatically forbidden; exfiltrating secrets or major irreversible destruction is still rejected.
- Read-only conclusions, authorization strength, and classification probabilities are evidence — they do not add a conservative threshold. An explicit `deny` or malicious injection is not overridden by a read-only conclusion. MCP descriptions and hints are only tool declarations.
- Execution history respects resets and compaction; history is kept within a UTF-8 budget with omissions marked, and calls and results stay grouped. A complete action is never truncated before approval; if it does not fit the budget, execution is blocked. Only actual user room messages constitute human authorization; employee delegations, tool results, and synthetic user roles do not escalate it.
- MCP tools are never auto-trusted from a server's self-declared `readOnlyHint`; a human must mark them in the employee configuration.
- Stopping a work cancels all undecided approvals under it; a late approval starts nothing.

## Boundaries

- Session working directories are **not an OS sandbox**. Built-in file tools validate real paths and symlinks; Shell validates its starting cwd, but arbitrary commands and stdio/remote MCP servers continue to run with their own process privileges, and a directory list does not guarantee they cannot see other paths.
- Automatic risk review is **not a sandbox**: reviewing complete redacted parameters with a budgeted real context cannot provide kernel-level read-only guarantees, and the model can misjudge. Unknown or failed evaluations block execution and high risk needs a human; neither replaces process isolation.
- The judge model is not a security guarantee and cannot audit history omitted by the budget. Ordinary low/medium risk is not escalated to manual merely because authorization is insufficient.
- Connecting remote models sends the corresponding context to that provider; data stays on this machine only with local models.
- Emit listens on loopback (`127.0.0.1`) by default.
