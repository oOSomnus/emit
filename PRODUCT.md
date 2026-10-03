# Emit

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The primary user is an individual knowledge worker coordinating AI employees for research, writing, planning, and execution on their own machine. This audience was confirmed during initialization.

The user directs and reviews a digital team. Coding and local automation are supported workflows, not the exclusive audience. Shared multi-human collaboration is not part of the confirmed product brief.

## Product Purpose

Emit is a local digital-employee collaboration workspace. It makes role-based AI employees manageable through familiar channels, direct messages, and asynchronous in-app mail.

Success means the user can assign work, let employees collaborate, understand what happened, resolve decisions that require human input, and receive results without keeping the browser open.

## Positioning

**A digital team, not a chat bot.** This is the user-confirmed central product promise.

Employees have distinct roles, models, reasoning effort, skill bindings, MCP bindings, and tool permissions. They can message, send mail, and delegate work to one another. Chat and mail are working communication mechanisms, not decorative metaphors around isolated prompts.

Durable execution and inspectable approvals support this promise; they are not substitutes for the team-oriented positioning.

## Operating Context

- A local browser interface connects to one Node process, which exclusively owns one SQLite database and one Pi Durable harness. The server listens on loopback by default.
- First-run setup configures the workspace, the human user's name, provider authentication, a usable default chat model, and a separately configured approval judge.
- The human configures employees, assigns channel work, talks directly to employees, sends mail, reviews execution and results, and handles high-risk approvals.
- Channels, direct messages, and mail sessions own their server-local working directories. Employees do not own directories; each run snapshots its session configuration.
- Closing the browser does not stop backend work. Restart recovery follows durable task state and tool replay declarations.
- Model providers may be remote or local. Remote providers receive the corresponding model context; local operation of Emit does not imply all model processing is local.

## Capabilities and Constraints

### Existing capabilities

- Channels wake employees through explicit assignment; body mentions alone do not wake them. Direct messages wake their employee by default.
- Mail is durable and asynchronous. To recipients that are employees start work; CC receives a copy without starting work. Employees' final answers are delivered as replies.
- Drafts, reply/reply-all, read/archive flags, search, and execution inspection support the mailbox workflow.
- Delegation is bounded by depth, cross-employee wake count, and model-turn budgets; delegation cycles back to a supervisor are rejected.
- Work records expose execution steps, tool calls, approvals, status, and final answers. Waiting work can be stopped.
- Automatic risk review approves low/medium risk, sends high risk to the human, rejects deny/critical, and blocks unknown risk or failed evaluations. The judge is configured separately and never silently inherited from an employee model.
- Provider authentication follows supported native mechanisms, including API keys, OAuth/subscription flows, cloud credentials, and ambient environment credentials. Saved credential values are not returned to the browser.

### Boundaries future work must preserve

- Session directories and risk review are **not OS sandboxes**. Shell commands and MCP servers retain their process privileges; a judge can misjudge and sees only its budgeted context.
- Local mail addresses are in-app identities, not external email delivery. Emit has no SMTP delivery; external addresses are recorded and displayed only.
- One process owns a data directory. Do not imply hosted-service, multi-tenant, or shared-human access guarantees.
- Interrupted unsafe tools are not automatically replayed. External side effects are not guaranteed exactly-once.
- SQLite uses WAL with `synchronous=NORMAL`; power loss may lose the last commit. Do not promise lossless power-failure recovery.
- Missing or invalid models fail explicitly; do not silently replace the selected employee model.

### Durable commitments selected under delegated authority

The user delegated constraint selection during initialization. The following choices preserve the existing product rather than expanding its scope:

- Preserve local-first operation for an individual operator; do not introduce a hosted-service or multi-user assumption without a new product decision.
- Maintain English and Simplified Chinese interface support, including follow-browser selection. Localization must not rewrite user content, model answers, or third-party diagnostics.
- Preserve usable narrow-screen workflows as well as desktop operation. No exclusive device priority was established.
- Maintain keyboard-operable controls, meaningful accessible labels, and intentional focus handling. This is a requirement for future work, not a claim of audited compliance.

### Open decisions

- Formal accessibility standard or certification target.
- Whether desktop work and mobile oversight should become an explicit device-priority strategy.
- Any future hosted deployment or shared multi-human collaboration model; neither is part of the current confirmed brief.

## Brand Commitments

- Product name: **Emit**.
- Use the digital-employee/team vocabulary consistently with actual roles and collaboration behavior.
- Product explanations should describe real capabilities and state limits plainly. Do not describe approval review as a security guarantee or local mail as external email.
- No new visual direction, aesthetic constraints, or broader brand-personality brief was established during initialization. Existing interface styling is not changed by this record.

## Evidence on Hand

- `README.md` and `README.zh-CN.md`: product overview, setup, features, and safety boundaries.
- `docs/usage.md` and `docs/usage.zh-CN.md`: employee collaboration, session directories, mail semantics, navigation, language, and appearance behavior.
- `docs/operations.md` and `docs/operations.zh-CN.md`: deployment, credentials, process locking, SQLite durability, and recovery limits.
- `docs/security.md` and `docs/security.zh-CN.md`: approval model and safety properties.
- `docs/development.md`: runtime stack, development commands, prompt resources, and the existing end-to-end smoke harness.
- `src/web/App.tsx` and `src/web/views/`: implemented setup and workspace surfaces. `src/web/styles.css` holds the incumbent interface tokens; this file does not establish a replacement design system.
- `test/` and `tmp/smoke.mjs`: automated verification resources, not customer proof or independently audited guarantees.

No testimonials, customer endorsements, performance benchmarks, or compliance certifications were supplied during initialization. Future work must not invent them.

## Product Principles

1. **Make the team real.** Roles, permissions, communication, and delegation must have operational meaning, not merely employee-themed presentation.
2. **Let work outlive the browser.** Preserve durable asynchronous workflows while stating replay and power-loss limits accurately.
3. **Keep the human informed and in control.** Assignment, execution state, risk decisions, and final results must remain inspectable.
4. **Respect session boundaries.** Directory authority belongs to the session and must not be copied silently into unrelated work.
5. **Prefer explicit behavior over hidden substitution.** Do not silently switch models, escalate authority, or imply delivery and isolation guarantees the product does not provide.

## Accessibility & Inclusion

English and Simplified Chinese are supported interface languages. Preserve user and model content across language changes and keep task execution independent of interface language.

Keyboard access, accessible control names, and focus restoration are durable requirements selected under delegated authority. Preserve responsive access on narrow screens without removing essential messaging, review, or approval functions. A formal compliance target remains undecided.
