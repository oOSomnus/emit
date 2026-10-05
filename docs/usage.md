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
- Every employee has a generated default avatar: a rounded mosaic pattern derived deterministically from the employee's stable id. Renaming an employee does not change the pattern, deleted employees keep their pattern in history, and nothing is fetched from the network; the name and role stay next to the image.

### Collaboration and delegation

- Employees can message each other, send mail, and delegate tasks. Collaboration is capped by delegation depth, cross-employee wake count, and model turns, and delegating a task back to the delegating supervisor is rejected because it would form a cycle. Reaching a limit stops with an explanation instead of continuing silently.
- The final answer of delegated work is visible on the Work page; open `View execution` to read the real steps, tool calls, approvals, and final answer. The result also returns to the originating session.

### Channels and direct messages

- A channel has explicit members: choose them when creating the channel, or later under `Manage members`. Employees can also invite each other with `invite_to_channel`; an invitation takes effect immediately and does not start the invited employee. Every member can read the channel's public history, including messages from before they joined.
- A message wakes only the employees it addresses. Type `@` in the composer to pick from the channel's enabled members and `@all`, or use the member chips; the composer previews exactly who will reply (`replies: A, B`) or states that nobody is addressed. `@all` starts every enabled member; disabled members are skipped and reported. An email address or an `@` inside code does not address anyone.
- An unaddressed message is still recorded — every member can read it — but it starts zero model calls. Adding a member later does not re-send past messages, and an invitation never wakes anyone by itself.
- Duplicate display names must be disambiguated by full address or chips: an ambiguous `@name` is rejected instead of guessed, and addressing a non-member or a disabled employee is rejected before the message is saved.
- Direct messages are per work: the same employee has a separate DM thread in each work. Employee-to-employee DMs sit alongside user DMs; the user cannot be added to an employee-to-employee thread, which the interface shows as `A ↔ B` with sending disabled.
- Removing a member stops that employee's unfinished work in the channel; other members' work and every existing message stay untouched.
- Only actual user room messages constitute human authorization; delegated tasks, tool results, and synthetic user roles do not escalate it (see [Security](security.md)).

## Works, directories, and shared notes

- A **work** is a first-class object — a project, a feature, or any piece of work. It owns multiple server-local directories plus one default execution directory, a goal, work instructions, file/URL resources, and shared notes. Each channel, DM, and mail thread belongs to exactly one work; switching the work only changes what you create next, and it never re-binds an existing conversation.
- Manage works under `Work` in the sidebar: name, goal, work instructions, directories, file/URL resources, and shared notes. Paths must be absolute, must exist, and must be accessible; saving resolves real paths, removes duplicates, and validates the default directory. A URL resource is listed only — Emit never fetches it — and a file resource must already exist inside the work's directories.
- Directories no longer belong to a session. With an empty work configuration, local Shell and ordinary file access are unavailable; skill directories already bound to an employee still load read-only, and remote MCP servers do not depend on a local directory.
- Shared notes are the only memory a work's conversations share. Employees read them only when asked (`list_work_notes` / `read_work_note`); the goal, instructions, and the note and resource indexes enter the prompt, and other conversations' full histories are never loaded automatically. Notes saved from a private conversation become readable by everyone working in that work — the interface says so before saving. A work's notes are invisible to other works, and a note can be read only inside the work that owns it.
- Every run snapshots the work's directory version. Delegated work inherits the source snapshot; a new DM or mail thread binds to the work without copying a snapshot. Changing a work's directories immediately invalidates unexecuted approvals and waiting-approval work in **every** room of that work — later calls of old work must stop and be re-sent, while tools that have already started may finish. Changing the goal, instructions, resources, or notes does not invalidate directory approvals.

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
- An employee's `send_mail` continues the current session by default and branches with the current mail as `inReplyTo`. An explicit `newSession=true`, or a non-mail origin, creates an independent session in the same work (the work's directories still apply; no directory snapshot is copied), and cross-session parents are rejected.

### Drafts and Compose

- Drafts live in their thread, are never delivered, and wake nobody. Each draft is listed as its own entry: multiple drafts in one thread can each be edited, sent, or discarded, and saving an edit retires the older version, keeping only the newest.
- Compose picks a work; the new thread is fixed to it and uses that work's directories. It copies nothing from the mail you are reading. A draft keeps its own thread and work, and a reply stays in the work of the thread it answers.
- Compose is a fixed panel at the bottom right (full-screen on narrow displays). Switching folders or reading other mail does not discard unfinished content; closing with unsaved text first asks `Save draft / Discard / Keep editing`. Manually saving a draft requires body text.
- Read and archive are per-message flags: you can mark them directly on a list row. Opening a thread marks only the unread mail you received as read, and only once per thread per session; manually marking a message unread again will not be immediately changed back.

### Addresses and delivery scope

- Addresses look like `name@workspace.test` and are local-only; no real mail is sent. Unicode characters in a name are preserved in the address, duplicate names get a deterministic suffix, and the user's address is never taken by an employee.
- Emit has no SMTP delivery: external addresses are recorded and displayed only.

## Appearance and navigation

- The left sidebar contains the workspace name and the work selector; channels and DMs (each list scrolls independently and has a `+` to create); a single `Mailbox` entry; and a fixed bottom section with `Approvals / Work / Runs / Employees / Settings` plus the appearance and language pickers. `Work` manages works (goal, instructions, directories, resources, notes); `Runs` is the execution-record page. Count badges show counts only.
- Three themes are available: light, dark, and follow-system. Switch them from the sidebar bottom, `Settings → Workspace`, or first-run setup. The choice is stored in the browser and applied before the first frame, so navigating never flashes the old palette.
- The interface has two languages, English and Simplified Chinese. The language picker (sidebar bottom, `Settings → Workspace`, or first-run setup) has three states: follow-browser, English, and Simplified Chinese. Follow-browser uses the first browser language (`zh*` → Simplified Chinese, otherwise English); the choice is saved in the browser, applied before the first frame (`<html lang>` and the document title included), and synchronizes across tabs of the same origin. Switching the language redraws the interface and the application messages already on screen in place — it never reloads the page, restarts a live run, or resends anything. Only interface text and application-authored messages change: user content, model answers, third-party provider and MCP output, and recorded execution evidence keep their original text, and records saved before a translation existed keep their original text too.
- On narrow screens the sidebar becomes an overlay drawer reached from the top bar's menu button. Escape or clicking the overlay closes it and returns focus to the menu button; selecting a navigation item only closes the drawer. Forms and lists collapse to a single column.
- All pages share one set of spacing, type, and semantic color tokens defined as variables at the top of `src/web/styles.css`; components do not hard-code colors.

## Session export

- The download button in a channel, DM, or mail thread header (and in the work-execution modal) writes one complete debug snapshot to a private file under the OS temporary directory and downloads that same file. A toast reports the saved path.
- A snapshot is one coherent committed state: the full transcript (messages, tool calls, tool results), the task and submission records, the work, room, employee, skill, and MCP documents that scope the selection, and the spilled full output of `run_shell` calls. Related sessions reached through the work tree carry only their relevant entries, never another session's full transcript.
- Secrets never travel in a snapshot: approval-redacted text and MCP `env`/`headers` values are replaced with `[REDACTED]`, and spill files are read only from the execution environment's own temporary directory.
