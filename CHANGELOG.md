# Changelog

## Unreleased

- Added English and Simplified Chinese UI languages, with browser-language detection, a locally saved override, and translated application messages; user content, model replies, and third-party output stay unchanged.
- Removed completed repository planning documents; maintained documentation now lives in the README and topic guides.
- Fixed: model search in settings previously showed no results — while any filter (search term or provider) is active, the model list expands to six native rows and reports "N matching models" or "No matching models"; a selected model is kept and marked as the current selection outside the filter, and filtering itself never rewrites the saved model.
- Prompts centralized: every prompt sent to a model moved out of business code into `src/server/prompts/` (`employee.md`, `work-input.md`, `context.md`, `approval-*.md`, `tool-results.md`, `skills.md`, `continuations.md`, `address-*.md`, `tools.json`, `classifier.json`), loaded and rendered by one loader; code only assembles arguments. Behavior unchanged, and reading or editing a prompt no longer means searching TypeScript for strings.
- Mail is genuinely asynchronous: sending queues — the body, each recipient's work, and the dispatch tasks are committed together before the model is called, so closing the browser or a hard kill followed by a restart continues rather than losing or double-delivering mail. A recipient's answer is a reply in the thread, with `inReplyTo` pointing at the mail it answers.
- The mail reading pane no longer pretends to be chat: it does not show text being generated, and instead shows the mail's work status (Queued / Running / Waiting for reply / Completed / Failed / Stopped) and a `View execution` panel with the real input, tool calls, tool results, and answer, paginated for earlier steps; waiting work can be stopped directly.
- Help requests: `send_mail` with `awaitReply: true` pauses the initiator as `Waiting for reply`, and answers written while waiting are withheld from delivery. When the other employee replies, the initiator continues with the reply text and delivers only one final answer. Stopping waiting work clears the waiting link; a late reply still arrives as ordinary mail but is no longer treated as an answer. After a hard kill, the waiting link, withheld answers, and continuation on reply all survive.
- Fixed mail handling going silent for a long time: the task previously received only the body, without the sender or the automatic-delivery contract, so the model could think it had to read files or send mail manually. It now receives the complete original envelope and is told the final answer becomes the reply, without changing models or directory permissions.
- The end-work control is unified as a visible X while keeping the stop semantics; the narrow-screen navigation close button sits above the overlay and is actually visible and clickable.
- Working directories moved to channels, DMs, and mail sessions: multiple roots, a default directory, real-path validation, version conflicts, and immediate grant invalidation. Delegation inherits the source; employees no longer store a cwd; old records are not migrated and old authorization is not inherited automatically.
- Mail drafts and sends save this session's directories first; replies explicitly link `inReplyTo`, employee continuations keep the current graph session by default, and an explicit new session is independent and inherits no directories.
- Interface rework: the whole app uses semantic-token styling (14px body text, 36px controls, 8/12px radii, shadows only on overlays) with light/dark/follow-system themes; the theme can be switched from the sidebar, `Settings → Workspace`, and first-run setup, stored locally and applied before the first frame.
- Fixed: the bottom `Approvals / Work / Employees / Settings` items are no longer stretched vertically — the room list and bottom navigation are separate scrolling/fixed regions, buttons are fixed at 36px and count badges at 20px; no matter how many rooms exist, only the room list scrolls and the bottom navigation stays visible.
- Sidebar navigation: the mailbox collapses to one entry showing the total unread count, and individual mail threads no longer occupy the sidebar; navigation items carry `aria-current`, and narrow screens get a 44px top bar and a modal overlay drawer where Escape, clicking the overlay, or choosing a navigation item closes it and returns focus to the menu button.
- Mailbox reworked after Gmail: folders (Inbox/Sent/Drafts/Archived) on the left, compact mail rows in the middle, and a reading pane on the right; on wide windows (≥1440px) the list and reading pane sit side by side, and on narrow windows the reading pane replaces the list and offers a back button. Search by participant, subject, and body (no results and an empty folder are two distinct states); drafts are listed individually, and every draft in a thread can still be edited, sent, or discarded.
- Compose moved to a fixed panel at the bottom right (full-screen on narrow screens): recipient chips plus free-form addresses, expandable CC, subject, and body; closing with unsaved text first asks `Save draft / Discard / Keep editing`, and switching folders does not lose the text. Editing a draft saves it in the draft's own thread; a successful send retires the old draft without losing recipients or CC.
- Mail read/archive follows the real per-mail flags: mark directly on a list row; opening a thread marks only the unread non-draft mail the user received, and only once per thread per session (manually marking it unread again is not overridden by the same open). Unread means: not sent by the user, To/CC contains the user's address, not a draft, not archived, and not read — the sidebar total, the inbox, and room events all agree, and flagging no longer clears unread counts.
- Automatic review upgraded to schema/criteria v3: the complete redacted action, canonical directories and targets, active execution history, and real user-authorization provenance enter the review; history has a UTF-8 budget with omission markers, and an oversized complete action blocks execution.
- The LLM and the native classifier share one risk policy: allow/low and allow/medium are approved automatically, allow/high goes to a human; deny/critical is rejected, and unknown/model failure/invalid output is blocked. Read-only and authorization probability thresholds were removed — probabilities are audit evidence only; MCP `readOnlyHint` cannot grant trust by itself.
- First-run setup and settings must configure a usable approval judge separately, never falling back to an employee model. The approvals page shows the actual risk, outcome, session roots/version, and canonical cwd/targets; a blocked review is not a human queue.
- Visual model management: first-run setup and `Settings → Model providers` list all 42 native Pi providers plus custom OpenAI-compatible endpoints, with search and a configured-only filter.
- Native authentication: run Pi's own login flows in the interface — API key, OAuth/subscription, cloud credentials (Azure endpoint/deployment mapping, Bedrock, Vertex, Cloudflare); login sessions are bridged over HTTP with prompts, authorization links, device codes, cancellation, and refresh recovery, and keys never go back to the page.
- Credential persistence moved to Pi's native CredentialStore, so OAuth refresh results are no longer overwritten by another cache; deleting a provider or switching it to keyless also removes its stored credential and catalog cache.
- Custom-endpoint form: editable id/name/base URL/three wire APIs/whether an API key is needed, plus model id, name, contextWindow, maxTokens, reasoning, and text/image input; an invalid submission is rejected as a whole.
- The model picker is searchable (by model and provider), models without credentials are browsable but not selectable, a stale reference shows as `Model unavailable` instead of silently switching, and the default model, approval judge, and employee editor all offer `Check connection`.
- Fixed: bodyless DELETE requests no longer claim a JSON content-type, which previously caused `Body cannot be empty` and made it impossible to cancel authentication or delete resources.
- Fixed: every OpenCode Go request now carries a stable session identifier (`x-opencode-session`) — connection checks use a fresh session, approval evaluations use the evaluationId, and employee generations and compactions use the persisted conversationId — while keeping Pi's native non-generic User-Agent. A `patch-package` patch (`patches/`, applied on `npm install`) teaches pi-durable this; a mismatched patch makes the install exit nonzero.

## 0.1.0

The first usable release: a local, single-process digital-employee collaboration workspace.

### Features

- First-run setup wizard: workspace name, user name, default execution model, approval judge, and provider credentials.
- Employees: create/edit/delete with an independent role, working guidelines, model and reasoning effort, working directory, skill bindings, MCP bindings, allowed tools, and MCP tools trusted as read-only.
- Communication: channels, DMs, and mail threads share one room-and-message model; a channel wakes an employee only when explicitly assigned or `@`-mentioned, and a DM wakes its employee by default.
- Mail: every employee in To starts an asynchronous work item and CC receives a copy only; drafts can be saved/continued/sent/discarded; threads show subject, To/CC, read, and archive state; a reply goes to the original sender, and reply-all includes the original mail's other recipients.
- Mailbox addresses `name@workspace.test` preserve Chinese characters and add a deterministic suffix for duplicates, and the user's address is never taken by an employee.
- Live progress: a running employee's answer streams text and tool activity.
- Employee collaboration: `send_message`, `send_mail`, `delegate_task`; results return to the parent session and the final answer appears on the Work page; delegation depth, cross-employee wake count, and model turns are capped, and delegating a task back to one's own supervisor is rejected outright.
- Auto-mode approval: an LLM or classifier judge evaluates first; low-risk calls are approved automatically and the rest enter a human queue; an approved call re-verifies its authorization binding, employee permissions, and configuration version before execution.
- Approvals center: pending decisions, history, evidence (an LLM rationale or the classifier's questions and probabilities), and the complete timeline.
- Skills: import Agent Skills from a directory, bind them per employee, and read their body on demand with `load_skill`.
- MCP: stdio and Streamable HTTP, connection checks, tool discovery, per-employee binding, and per-tool read-only trust.
- Models and credentials: reuse Pi's provider collection and support custom OpenAI-compatible endpoints; credentials live in a `0600` local file or environment variables, and the interface only shows configuration state.
- Model validation: employees and the approval judge can only save models that resolve in the catalog with supported reasoning efforts; a credential change replaces the provider set wholesale, and a removed provider and its models stop resolving immediately.

### Durability and recovery

- A work item runs in its own execution conversation; the answer and "work completed" are written in one commit, so repeated recovery does not double-deliver.
- Tool authorization happens in `beforeTool` (before the intent is written), so a crash while waiting for a human approval re-finds the same approval record on recovery and keeps waiting; during that wait the work shows as "waiting for approval".
- Idempotent commits within a work use `work:<workId>` and `deliver:<workId>` as requestIds.
- On startup the process resumes running tasks first, then marks work it could not recover as failed and explains why in the original session.
- The data directory has a single-instance lock: a second process waits and then refuses to open the same directory; a lock left by a force-killed process expires after 15 seconds and the next startup takes it over.

### Fixes

- Crash recovery no longer treats a call waiting for a human decision as rejected: recovery re-finds the same approval record and keeps waiting, with the work shown as "waiting for approval".
- Stopping a work that is waiting for a decision no longer deadlocks: it records the stop first, then cancels approvals, and finally aborts the session.
- No backend restart is needed after rebuilding the front end: static files are served from disk content rather than frozen build-time filenames.
- Opening the interface loads the current session's record automatically instead of showing an empty conversation.
- Shutdown no longer hangs on the browser's event-stream connection.
- System notices inside messages are no longer mistaken for the bottom-right floating toast.
- Chinese names no longer degrade to `workspace@…`/`employee@…`: the address preserves the name itself, and an employee is never assigned an address the user is already using.
- The cross-employee wake budget can no longer be bypassed: reaching the cap now actually rejects instead of continuing to let work through.
- Deleting a custom provider no longer leaves its models resolvable: the provider set is replaced wholesale, so deletion takes effect immediately.
- When a mail recipient cannot start work (disabled, model unavailable), it is no longer skipped silently — the session shows a system notice.

### Known limitations

- Shell and stdio MCP run as the current user; working directories are not a sandbox.
- The judge model only advises; it is not a security guarantee.
- SQLite uses WAL + `synchronous=NORMAL`: process crashes are recoverable, but a power loss may lose the last commit; external side effects are not guaranteed exactly-once.
- No work runs while the backend is down; recovery happens only on the next startup.
