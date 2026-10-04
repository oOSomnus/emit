/**
 * The left rail: channels, direct messages, the mailbox, and the work surfaces.
 *
 * Slack's shape and a mailbox's shape are the same list of rooms; mail threads
 * are not listed one by one here — the mailbox owns them and the rail only
 * carries one entry with the unread total.
 */

import { useState, type ReactNode } from "react";
import { api } from "../api.ts";
import { errorDisplay } from "../../shared/i18n.ts";
import { LanguagePicker, useI18n } from "../i18n.tsx";
import { useApp, type View } from "../state.tsx";
import { Chip, EmployeeAvatar, Icon, IconButton } from "./ui.tsx";
import { ThemePicker } from "../theme.tsx";

export function Sidebar({ onNavigate }: { onNavigate?: () => void }): ReactNode {
  const { state, dispatch, openRoom, setError } = useApp();
  const { messages } = useI18n();
  const [creating, setCreating] = useState<"channel" | "dm" | undefined>(undefined);
  const [draftName, setDraftName] = useState("");
  const [draftEmployee, setDraftEmployee] = useState("");
  const [draftMembers, setDraftMembers] = useState<string[]>([]);

  const channels = state.rooms.filter(
    (room) => room.kind === "channel" && room.workContextId === state.activeWorkContextId,
  );
  const directs = state.rooms.filter((room) => room.kind === "dm" && room.workContextId === state.activeWorkContextId);
  const mailUnread = state.rooms
    .filter((room) => room.kind === "mail")
    .reduce((total, room) => total + room.unread, 0);
  const pendingApprovals = state.approvals.filter((approval) => approval.status === "pending-human").length;
  const running = state.work.filter((work) => work.status === "running" || work.status === "queued").length;

  const select = (view: View) => {
    dispatch({ type: "view", view });
    onNavigate?.();
  };

  const startCreating = (kind: "channel" | "dm") => {
    if (state.activeWorkContextId === undefined) {
      select("work-contexts");
      return;
    }
    setCreating(kind);
    setDraftName("");
    setDraftEmployee(state.employees.find((employee) => employee.enabled)?.id ?? "");
    setDraftMembers([]);
  };

  const commit = async () => {
    if (creating === undefined) return;
    const workContextId = state.activeWorkContextId;
    if (workContextId === undefined) {
      setCreating(undefined);
      select("work-contexts");
      return;
    }
    const employee = state.employees.find((entry) => entry.id === draftEmployee && entry.enabled);
    if (creating === "dm" && employee === undefined) return;
    const name = draftName.trim().length > 0 ? draftName.trim() : employee?.name ?? "";
    if (name.length === 0) return;
    try {
      const room = await api.createRoom({
        kind: creating,
        name,
        workContextId,
        memberIds: creating === "channel" ? draftMembers : [],
        employeeId: creating === "dm" ? employee?.id : undefined,
      });
      setCreating(undefined);
      dispatch({ type: "room", room });
      await openRoom(room.id);
      dispatch({ type: "view", view: "chat" });
      onNavigate?.();
    } catch (error) {
      setError(errorDisplay(error));
    }
  };

  const renderRoom = (roomId: string, kind: "channel" | "dm") => {
    const room = state.rooms.find((entry) => entry.id === roomId);
    if (room === undefined) return null;
    const employeeIds = room.dmParticipantIds.filter((id) => id !== "user");
    const firstParticipant = state.employees.find((entry) => entry.id === employeeIds[0]);
    const secondParticipant = state.employees.find((entry) => entry.id === employeeIds[1]);
    const employee = state.employees.find((entry) => entry.id === room.employeeId) ?? firstParticipant;
    const avatarEmployeeId = employee?.id ?? employeeIds[0];
    const label =
      room.kind !== "dm"
        ? room.name
        : employeeIds.length > 1
          ? `${firstParticipant?.name ?? room.name} ↔ ${secondParticipant?.name ?? employeeIds[1]}`
          : employee?.name ?? room.name;
    const active = state.activeRoomId === room.id && state.view === "chat";
    return (
      <button
        key={room.id}
        type="button"
        className={`room room-${kind}${active ? " active" : ""}`}
        aria-current={active ? "page" : undefined}
        onClick={() => {
          void openRoom(room.id);
          dispatch({ type: "view", view: "chat" });
          onNavigate?.();
        }}
      >
        {kind === "channel" ? (
          <Icon name="chat" />
        ) : avatarEmployeeId !== undefined ? (
          <EmployeeAvatar employeeId={avatarEmployeeId} />
        ) : (
          <span className="avatar">{label.trim().slice(0, 1).toUpperCase()}</span>
        )}
        <span className="room-label">
          <span className="room-name">{label}</span>
          {kind === "dm" && employee !== undefined ? <span className="room-role">{employee.role}</span> : null}
        </span>
        {kind === "channel" ? <span className="room-topic">{room.topic.slice(0, 18)}</span> : null}
      </button>
    );
  };

  return (
    <aside className="sidebar">
      <header>
        <div className="workspace-name">{state.app?.workspace.name ?? "Emit"}</div>
        <div className="workspace-user">{state.app?.user.address ?? ""}</div>
      </header>

      <nav className="sidebar-rooms">
        <section>
          <h3>
            {messages.workContexts.selectWork}
            <IconButton
              icon="plus"
              label={messages.workContexts.createWork}
              onClick={() => select("work-contexts")}
            />
          </h3>
          <select
            aria-label={messages.workContexts.selectWork}
            value={state.activeWorkContextId ?? ""}
            disabled={state.workContexts.length === 0}
            style={{ color: "var(--rail-text)", backgroundColor: "var(--rail-hover)", borderColor: "var(--rail-line)" }}
            onChange={(event) =>
              dispatch({
                type: "activeWorkContext",
                workContextId: event.target.value.length > 0 ? event.target.value : undefined,
              })
            }
          >
            {state.workContexts.length === 0 ? <option value="">{messages.workContexts.noWorks}</option> : null}
            {state.workContexts.map((workContext) => (
              <option key={workContext.id} value={workContext.id}>
                {workContext.name}
              </option>
            ))}
          </select>
          {state.workContexts.length > 0 ? (
            <p className="hint" style={{ color: "var(--rail-muted)", whiteSpace: "normal", margin: "8px 4px 0" }}>
              {messages.workContexts.switchWorkHint}
            </p>
          ) : (
            <p className="hint" style={{ color: "var(--rail-muted)", whiteSpace: "normal", margin: "8px 4px 0" }}>
              {messages.sidebar.noWorkSelected}
            </p>
          )}
        </section>
        <section>
          <h3>
            {messages.sidebar.channels}
            <IconButton icon="plus" label={messages.sidebar.newChannel} onClick={() => startCreating("channel")} />
          </h3>
          <div className="room-list">{channels.map((room) => renderRoom(room.id, "channel"))}</div>
        </section>

        <section>
          <h3>
            {messages.sidebar.directs}
            <IconButton icon="plus" label={messages.sidebar.newDirect} onClick={() => startCreating("dm")} />
          </h3>
          <div className="room-list">{directs.map((room) => renderRoom(room.id, "dm"))}</div>
        </section>
      </nav>

      <nav className="sidebar-mail">
        <section>
          <button
            type="button"
            className={state.view === "mail" ? "room active" : "room"}
            aria-current={state.view === "mail" ? "page" : undefined}
            onClick={() => select("mail")}
          >
            <Icon name="mail" />
            <span className="room-name">{messages.sidebar.mailbox}</span>
            {mailUnread > 0 ? <Chip tone="info">{mailUnread}</Chip> : null}
          </button>
        </section>
      </nav>

      {creating !== undefined ? (
        <div className="creator">
          <div className="row">
            <span>{creating === "channel" ? messages.sidebar.creatorChannel : messages.sidebar.creatorDirect}</span>
          </div>
          {creating === "channel" ? (
            <>
              <input
                autoFocus
                aria-label={messages.sidebar.channelPlaceholder}
                placeholder={messages.sidebar.channelPlaceholder}
                value={draftName}
                onChange={(event) => setDraftName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void commit();
                }}
              />
              <label>
                {messages.sidebar.initialMembers}
                <select
                  multiple
                  size={Math.max(2, Math.min(5, state.employees.filter((employee) => employee.enabled).length))}
                  value={draftMembers}
                  aria-label={messages.sidebar.initialMembers}
                  onChange={(event) =>
                    setDraftMembers(Array.from(event.currentTarget.selectedOptions, (option) => option.value))
                  }
                >
                  {state.employees
                    .filter((employee) => employee.enabled)
                    .map((employee) => (
                      <option key={employee.id} value={employee.id}>
                        {employee.name} · {employee.role}
                      </option>
                    ))}
                </select>
              </label>
              <p className="hint" style={{ color: "var(--rail-muted)" }}>
                {messages.sidebar.initialMembersHint}
              </p>
            </>
          ) : (
            <select
              value={draftEmployee}
              aria-label={messages.sidebar.creatorDirect}
              onChange={(event) => setDraftEmployee(event.target.value)}
            >
              {state.employees.filter((employee) => employee.enabled).length === 0 ? (
                <option value="">{messages.sidebar.noEmployees}</option>
              ) : null}
              {state.employees
                .filter((employee) => employee.enabled)
                .map((employee) => (
                  <option key={employee.id} value={employee.id}>
                    {employee.name} · {employee.role}
                  </option>
                ))}
            </select>
          )}
          <div className="row">
            <button
              type="button"
              className="primary"
              disabled={
                creating === "channel"
                  ? draftName.trim().length === 0
                  : !state.employees.some((employee) => employee.enabled)
              }
              onClick={() => void commit()}
            >
              {messages.common.create}
            </button>
            <button type="button" onClick={() => setCreating(undefined)}>
              {messages.common.cancel}
            </button>
          </div>
        </div>
      ) : null}

      <nav className="footer-nav">
        <button
          type="button"
          className={state.view === "approvals" ? "active" : ""}
          aria-current={state.view === "approvals" ? "page" : undefined}
          onClick={() => select("approvals")}
        >
          <Icon name="approval" />
          <span className="label">{messages.app.view.approvals}</span>
          {pendingApprovals > 0 ? <Chip tone="warn">{pendingApprovals}</Chip> : null}
        </button>
        <button
          type="button"
          className={state.view === "work-contexts" ? "active" : ""}
          aria-current={state.view === "work-contexts" ? "page" : undefined}
          onClick={() => select("work-contexts")}
        >
          <Icon name="work" />
          <span className="label">{messages.workContexts.navLabel}</span>
        </button>
        <button
          type="button"
          className={state.view === "work" ? "active" : ""}
          aria-current={state.view === "work" ? "page" : undefined}
          onClick={() => select("work")}
        >
          <Icon name="work" />
          <span className="label">{messages.workContexts.runsLabel}</span>
          {running > 0 ? <Chip tone="info">{running}</Chip> : null}
        </button>
        <button
          type="button"
          className={state.view === "employees" ? "active" : ""}
          aria-current={state.view === "employees" ? "page" : undefined}
          onClick={() => select("employees")}
        >
          <Icon name="employees" />
          <span className="label">{messages.app.view.employees}</span>
        </button>
        <button
          type="button"
          className={state.view === "settings" ? "active" : ""}
          aria-current={state.view === "settings" ? "page" : undefined}
          onClick={() => select("settings")}
        >
          <Icon name="settings" />
          <span className="label">{messages.app.view.settings}</span>
        </button>
        <ThemePicker />
        <LanguagePicker />
      </nav>
    </aside>
  );
}
