# Usage

[English](usage.md) | [Simplified Chinese](usage.zh-CN.md) · [README](../README.md)

Day-to-day behavior of employees, collaboration, sessions, mail, and the interface. Approval rules live in [Security](security.md); CLI options, data files, and credentials live in [Operations](operations.md).

## Employees and collaboration

### First-run setup

- The workspace name is prefilled with a default (`My digital team`) and can be changed.
- Your name is required.
- The default execution model must be a configured chat model from the catalog, and its reasoning effort must be one that model actually supports. A selection that does not meet this cannot be saved: the UI reports the reason instead of failing later during a run.
- The approval judge is configured separately — a chat model from the same catalog, or a classifier. Judge calls are made without tools, so no special "no-tools model" is required, and the judge is never silently inherited from an employee model. "Independently configured" does not mean the model ID has to differ from an employee's.
- Providers are configured in the setup wizard or later under `Settings → Model providers`. Authentication uses each provider's native flow (API key, OAuth/subscription, cloud credentials). Environment variables remain an equivalent ambient source when a provider has no saved credential.

### Employee configuration

- Each employee has an execution model and reasoning effort, skill bindings, MCP bindings, the tools it may call, and a list of MCP tools trusted as read-only.
- The model must exist in the catalog, be a chat model that supports tool calling, and support the selected effort; otherwise saving fails with a clear reason. If the model is later removed from the credentials, new work fails explicitly instead of silently switching to another model.
- Working directories do not belong to employees. Changing an employee's configuration bumps its configuration version.

### Collaboration and delegation

- Employees can message each other, send mail, and delegate tasks. Collaboration is capped by delegation depth, cross-employee wake count, and model turns, and delegating a task back to the delegating supervisor is rejected because it would form a cycle. Reaching a limit stops with an explanation instead of continuing silently.
- The final answer of delegated work is visible on the Work page; open `View execution` to read the real steps, tool calls, approvals, and final answer. The result also returns to the originating session.

### Channels and direct messages

- In a channel, an employee is woken only when you assign one in the `Assign employee` dropdown. The options show `@name · role`; the default option records the message without assigning anyone. `@` mentions in the body do not wake employees by themselves.
- Direct messages wake the target employee by default.
- Only actual user room messages constitute human authorization; delegated tasks, tool results, and synthetic user roles do not escalate it (see [Security](security.md)).

## Session working directories

- Channel, direct-message, and mail sessions each keep multiple server-local directories plus one default execution directory. Channel employees share the room's configuration; a DM's configuration applies to that conversation only; mail reply chains and graph branches in the same room share their session configuration, while different sessions stay independent.
- Edit directories in the chat page under `Working directories`, or in the mail reading pane and Compose panel under `Session working directories`.
- A brand-new Compose starts with an empty directory list — it does not copy the authorization of the mail you are reading. A draft keeps its own session and directories, and a reply reuses the directory configuration of the thread it answers (employees answering mail follow the mailbox session's directories).
- Paths must be absolute, must exist, and must be accessible. Saving resolves real paths, removes duplicates, and validates the default directory.
- With an empty configuration, local Shell and ordinary file access are unavailable. Skill directories already bound to an employee still load read-only, and remote MCP servers do not depend on a local directory.
- Every run snapshots the directory version. Delegated work inherits the source session's directories; a cross-employee DM uses the target DM's configuration. Changing directories immediately invalidates unexecuted approvals and waiting-approval work in that session; later calls of old work must stop and be re-sent, while tools that have already started may finish.

## Mail

### Folders, search, and the reading pane

- The mailbox has a Gmail-like shape: `Inbox / Sent / Drafts / Archived` on the left, compact mail rows in the middle (unread rows are bold with a dot), and the reading pane on the right. On wide windows the list and the reading pane sit side by side; on narrower windows the reading pane replaces the list and offers a back button, and the folders collapse into a dropdown on narrow screens.
- The sidebar's single `Mailbox` entry shows the total unread count. Unread means: not sent by the user, To/CC contains the user's address, not a draft, not archived, and not read. The inbox, the sidebar, and live room events all use this same definition.
- Search matches participants, subject, and body. "No matching mail" and "this folder is empty" are two different states.

### Sending, recipients, and replies

- An envelope carries its recipients: every employee in To starts their own asynchronous work; CC receives a copy only and starts nothing; mail addressed only to the user is only delivered.
- Reply answers the original sender. Replying to your own sent mail answers its original recipients. Reply-all adds the original mail's other recipients, excluding yourself and duplicate addresses.
- Recipients can be picked from the employee directory or typed directly. Addresses outside the directory are recorded as typed but wake nobody — only employees start work.

### Durable, asynchronous delivery

- Sending is queuing: the body, the queued work for every recipient, and the dispatch tasks are all committed in one transaction before the model is called. Closing the browser, or even killing the process, does not lose the mail; recipients' work continues after restart.
- Mail is asynchronous and does not pretend to be chat: the reading pane does not stream text an employee is still generating. It shows the mail's work status — `Queued / Running / Waiting for approval / Waiting for reply / Completed / Failed / Stopped` — and a `View execution` panel with the real input, tool calls, tool results, and answer, paginated for earlier steps. Work that is waiting can be stopped from the panel.
- An employee task receives the complete original envelope (sender, To/CC, subject, parents, and body). The employee's final text answer is delivered automatically as a reply to this mail, so an ordinary reply needs no `send_mail` call and no working directory. `send_mail` is for sending a separate mail or creating a collaboration branch.
- `send_mail` with `awaitReply: true` is a real request for help: the initiator's work pauses as `Waiting for reply`, and any answer written while waiting is withheld from delivery. When the other employee replies, the initiator continues with the reply text and delivers only one final answer. Stopping waiting work also clears the waiting link; a late reply still arrives as ordinary mail but is no longer treated as an answer.
- An employee's `send_mail` continues the current session by default and branches with the current mail as `inReplyTo`. An explicit `newSession=true`, or a non-mail origin, creates an independent session with an empty directory; cross-session parents are rejected.

### Drafts and Compose

- Drafts live in their thread, are never delivered, and wake nobody. Each draft is listed as its own entry: multiple drafts in one thread can each be edited, sent, or discarded, and saving an edit retires the older version, keeping only the newest.
- Compose is a fixed panel at the bottom right (full-screen on narrow displays). Switching folders or reading other mail does not discard unfinished content; closing with unsaved text first asks `Save draft / Discard / Keep editing`. Manually saving a draft requires body text.
- Read and archive are per-message flags: you can mark them directly on a list row. Opening a thread marks only the unread mail you received as read, and only once per thread per session; manually marking a message unread again will not be immediately changed back.

### Addresses and delivery scope

- Addresses look like `name@workspace.test` and are local-only; no real mail is sent. Unicode characters in a name are preserved in the address, duplicate names get a deterministic suffix, and the user's address is never taken by an employee.
- Emit has no SMTP delivery: external addresses are recorded and displayed only.

## Appearance and navigation

- The left sidebar contains the workspace name; channels and DMs (each list scrolls independently and has a `+` to create); a single `Mailbox` entry; and a fixed bottom section with `Approvals / Work / Employees / Settings` plus the appearance and language pickers. Count badges show counts only.
- Three themes are available: light, dark, and follow-system. Switch them from the sidebar bottom, `Settings → Workspace`, or first-run setup. The choice is stored in the browser and applied before the first frame, so navigating never flashes the old palette.
- The interface has two languages, English and Simplified Chinese. The language picker (sidebar bottom, `Settings → Workspace`, or first-run setup) has three states: follow-browser, English, and Simplified Chinese. Follow-browser uses the first browser language (`zh*` → Simplified Chinese, otherwise English); the choice is saved in the browser, applied before the first frame (`<html lang>` and the document title included), and synchronizes across tabs of the same origin. Switching the language redraws the interface and the application messages already on screen in place — it never reloads the page, restarts a live run, or resends anything. Only interface text and application-authored messages change: user content, model answers, third-party provider and MCP output, and recorded execution evidence keep their original text, and records saved before a translation existed keep their original text too.
- On narrow screens the sidebar becomes an overlay drawer reached from the top bar's menu button. Escape or clicking the overlay closes it and returns focus to the menu button; selecting a navigation item only closes the drawer. Forms and lists collapse to a single column.
- All pages share one set of spacing, type, and semantic color tokens defined as variables at the top of `src/web/styles.css`; components do not hard-code colors.
