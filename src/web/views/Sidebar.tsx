/**
 * The left rail: channels, direct messages, the mailbox, and the work surfaces.
 *
 * Slack's shape and a mailbox's shape are the same list of rooms; mail threads
 * are not listed one by one here — the mailbox owns them and the rail only
 * carries one entry with the unread total.
 *
 * The rail carries the two surfaces the user lives in (the current work, the
 * channel and direct-message lists) plus the mailbox. Management destinations
 * — approvals, work, runs, employees, settings, theme, language — open from
 * the workspace menu so they cannot push the frequent entries off the rail.
 */

import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { RoomDTO } from "../../shared/contracts.ts";
import { errorDisplay } from "../../shared/i18n.ts";
import { LanguagePicker, useI18n } from "../i18n.tsx";
import { useApp, type View } from "../state.tsx";
import { Chip, EmployeeAvatar, Icon, IconButton } from "./ui.tsx";
import { CreateChannel } from "./CreateChannel.tsx";
import { StartDirectMessage } from "./StartDirectMessage.tsx";
import { ThemePicker } from "../theme.tsx";

type PopoverToggleEvent = Event & { newState?: "open" | "closed" };

export function Sidebar({ onNavigate, navOpen }: { onNavigate?: () => void; navOpen: boolean }): ReactNode {
  const { state, dispatch, openRoom, setError } = useApp();
  const { messages } = useI18n();
  const [creatingDirectWorkId, setCreatingDirectWorkId] = useState<string | undefined>(undefined);
  const [creatingChannelWorkId, setCreatingChannelWorkId] = useState<string | undefined>(undefined);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuId = useId();
  const workSelectId = useId();
  const menuRef = useRef<HTMLElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const firstMenuItemRef = useRef<HTMLButtonElement | null>(null);

  const channels = state.rooms.filter(
    (room) => room.kind === "channel" && room.workContextId === state.activeWorkContextId,
  );
  const directs = state.rooms.filter((room) => room.kind === "dm" && room.workContextId === state.activeWorkContextId);
  const mailUnread = state.rooms
    .filter((room) => room.kind === "mail")
    .reduce((total, room) => total + room.unread, 0);
  const pendingApprovals = state.approvals.filter((approval) => approval.status === "pending-human").length;
  const running = state.work.filter((work) => work.status === "running" || work.status === "queued").length;
  const workspaceLabel =
    state.view === "chat" || state.view === "mail" ? messages.sidebar.workspaceMenu : messages.app.view[state.view];

  // The popover owns its open state natively; mirror it so `aria-expanded`
  // and the first-entry focus follow every close path, including a click
  // outside the menu.
  useEffect(() => {
    const menu = menuRef.current;
    if (menu === null) return;
    const onToggle = (event: Event): void => {
      setMenuOpen((event as PopoverToggleEvent).newState === "open");
    };
    menu.addEventListener("toggle", onToggle);
    return () => menu.removeEventListener("toggle", onToggle);
  }, []);

  useEffect(() => {
    if (menuOpen) firstMenuItemRef.current?.focus();
  }, [menuOpen]);

  // Closing the narrow-screen drawer must not leave the top-layer menu behind.
  useEffect(() => {
    if (!navOpen) menuRef.current?.hidePopover();
  }, [navOpen]);

  const select = (view: View) => {
    dispatch({ type: "view", view });
    onNavigate?.();
  };

  const toggleMenu = (): void => {
    const menu = menuRef.current;
    if (menu === null) return;
    if (menu.matches(":popover-open")) menu.hidePopover();
    else menu.showPopover();
  };

  const menuSelect = (view: View): void => {
    menuRef.current?.hidePopover();
    select(view);
  };

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.key !== "Escape") return;
    // Close the menu alone: the narrow-screen rail also listens for Escape,
    // and a closed menu must not also close the drawer behind it.
    event.preventDefault();
    event.stopPropagation();
    menuRef.current?.hidePopover();
    triggerRef.current?.focus();
  };

  const startCreating = (kind: "channel" | "dm") => {
    if (state.activeWorkContextId === undefined) {
      select("work-contexts");
      return;
    }
    if (kind === "channel") {
      // The new channel binds to the work selected right now, not to whatever
      // the background selection becomes while the dialog is open.
      setCreatingDirectWorkId(undefined);
      setCreatingChannelWorkId(state.activeWorkContextId);
      return;
    }
    setCreatingChannelWorkId(undefined);
    setCreatingDirectWorkId(state.activeWorkContextId);
  };

  const directOpened = (room: RoomDTO): void => {
    setCreatingDirectWorkId(undefined);
    dispatch({ type: "room", room });
    dispatch({ type: "view", view: "chat" });
    onNavigate?.();
    // A failed read is a global error; the room exists, so it must not look
    // like a failed creation, and the registered room can be refreshed.
    void openRoom(room.id)
      .then(() => {
        requestAnimationFrame(() => {
          // The conversation may have moved on while the read was in flight;
          // only the room that actually opened takes the focus.
          const pane = document.querySelector<HTMLElement>(".chat-pane[data-room-id]");
          if (pane?.dataset.roomId !== room.id) return;
          pane.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus();
        });
      })
      .catch((error) => setError(errorDisplay(error)));
  };

  const channelCreated = (room: RoomDTO): void => {
    setCreatingChannelWorkId(undefined);
    dispatch({ type: "room", room });
    dispatch({ type: "view", view: "chat" });
    onNavigate?.();
    // A failed read is a global error; the room was created, so it must not
    // look like a failed creation.
    void openRoom(room.id).catch((error) => setError(errorDisplay(error)));
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
          {kind === "channel" && room.topic.length > 0 ? (
            <span className="room-topic">{room.topic.slice(0, 18)}</span>
          ) : null}
        </span>
      </button>
    );
  };

  return (
    <aside className="sidebar">
      <header>
        <div className="workspace-name">Emit</div>
        <div className="workspace-user">{state.app?.user.address ?? ""}</div>
      </header>

      <div className="sidebar-work">
        <div className="sidebar-work-head">
          {state.workContexts.length > 0 ? (
            <label className="sidebar-work-label" htmlFor={workSelectId}>
              {messages.sidebar.newConversations}
            </label>
          ) : (
            <span />
          )}
          <span className="sidebar-work-actions">
            <IconButton icon="work" label={messages.workContexts.viewWork} onClick={() => select("work-contexts")} />
            <IconButton icon="plus" label={messages.workContexts.createWork} onClick={() => select("work-contexts")} />
          </span>
        </div>
        <select
          id={workSelectId}
          aria-label={messages.workContexts.selectWork}
          value={state.activeWorkContextId ?? ""}
          disabled={state.workContexts.length === 0}
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
        {state.workContexts.length === 0 ? (
          <p className="hint sidebar-work-hint">{messages.sidebar.noWorkSelected}</p>
        ) : null}
      </div>

      <nav className="sidebar-rooms">
        <section className={channels.length > 0 ? "has-rooms" : undefined}>
          <h3>
            {messages.sidebar.channels}
            <IconButton
              icon="plus"
              label={messages.sidebar.newChannel}
              onClick={() => startCreating("channel")}
            />
          </h3>
          <div className="room-section-body">
            <div className="room-list">{channels.map((room) => renderRoom(room.id, "channel"))}</div>
          </div>
        </section>

        <section className={directs.length > 0 ? "has-rooms" : undefined}>
          <h3>
            {messages.sidebar.directs}
            <IconButton icon="plus" label={messages.sidebar.newDirect} onClick={() => startCreating("dm")} />
          </h3>
          <div className="room-section-body">
            <div className="room-list">{directs.map((room) => renderRoom(room.id, "dm"))}</div>
          </div>
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

      {creatingDirectWorkId !== undefined ? (
        <StartDirectMessage
          key={creatingDirectWorkId}
          workContextId={creatingDirectWorkId}
          onClose={() => setCreatingDirectWorkId(undefined)}
          onOpened={directOpened}
        />
      ) : null}

      {creatingChannelWorkId !== undefined ? (
        <CreateChannel
          key={creatingChannelWorkId}
          workContextId={creatingChannelWorkId}
          onClose={() => setCreatingChannelWorkId(undefined)}
          onCreated={channelCreated}
        />
      ) : null}

      <nav className="footer-nav">
        <div className="workspace-row">
          <button
            type="button"
            ref={triggerRef}
            className="workspace-trigger"
            aria-label={messages.sidebar.workspaceMenu}
            aria-expanded={menuOpen}
            aria-controls={menuId}
            onClick={toggleMenu}
          >
            <Icon name="more" />
            <span className="label">{workspaceLabel}</span>
          </button>
          {pendingApprovals > 0 ? (
            <button
              type="button"
              className="workspace-pending"
              aria-label={messages.sidebar.pendingApprovalLabel(pendingApprovals)}
              title={messages.sidebar.pendingApprovalLabel(pendingApprovals)}
              onClick={() => select("approvals")}
            >
              {pendingApprovals}
            </button>
          ) : null}
        </div>
      </nav>

      <nav
        id={menuId}
        ref={menuRef}
        className="workspace-menu"
        popover="auto"
        aria-label={messages.sidebar.workspaceMenu}
        onKeyDown={onMenuKeyDown}
      >
        <button
          ref={firstMenuItemRef}
          type="button"
          aria-label={messages.app.view.approvals}
          aria-current={state.view === "approvals" ? "page" : undefined}
          onClick={() => menuSelect("approvals")}
        >
          <Icon name="approval" />
          <span className="label">{messages.app.view.approvals}</span>
          {pendingApprovals > 0 ? <Chip tone="warn">{pendingApprovals}</Chip> : null}
        </button>
        <button
          type="button"
          aria-label={messages.workContexts.navLabel}
          aria-current={state.view === "work-contexts" ? "page" : undefined}
          onClick={() => menuSelect("work-contexts")}
        >
          <Icon name="work" />
          <span className="label">{messages.workContexts.navLabel}</span>
        </button>
        <button
          type="button"
          aria-label={messages.workContexts.runsLabel}
          aria-current={state.view === "work" ? "page" : undefined}
          onClick={() => menuSelect("work")}
        >
          <Icon name="work" />
          <span className="label">{messages.workContexts.runsLabel}</span>
          {running > 0 ? <Chip tone="info">{running}</Chip> : null}
        </button>
        <button
          type="button"
          aria-label={messages.app.view.employees}
          aria-current={state.view === "employees" ? "page" : undefined}
          onClick={() => menuSelect("employees")}
        >
          <Icon name="employees" />
          <span className="label">{messages.app.view.employees}</span>
        </button>
        <button
          type="button"
          aria-label={messages.app.view.settings}
          aria-current={state.view === "settings" ? "page" : undefined}
          onClick={() => menuSelect("settings")}
        >
          <Icon name="settings" />
          <span className="label">{messages.app.view.settings}</span>
        </button>
        <hr />
        <ThemePicker />
        <LanguagePicker />
      </nav>
    </aside>
  );
}
