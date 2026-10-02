/**
 * The left rail: channels, direct messages, the mailbox, and the work surfaces.
 *
 * Slack's shape and a mailbox's shape are the same list of rooms; mail threads
 * are not listed one by one here — the mailbox owns them and the rail only
 * carries one entry with the unread total.
 */

import { useState, type ReactNode } from "react";
import { api } from "../api.ts";
import { useApp, type View } from "../state.tsx";
import { Chip, Icon, IconButton } from "./ui.tsx";
import { ThemePicker } from "../theme.tsx";

export function Sidebar({ onNavigate }: { onNavigate?: () => void }): ReactNode {
  const { state, dispatch, openRoom, setError } = useApp();
  const [creating, setCreating] = useState<"channel" | "dm" | undefined>(undefined);
  const [draftName, setDraftName] = useState("");
  const [draftEmployee, setDraftEmployee] = useState("");

  const channels = state.rooms.filter((room) => room.kind === "channel");
  const directs = state.rooms.filter((room) => room.kind === "dm");
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
    setCreating(kind);
    setDraftName("");
    setDraftEmployee(state.employees[0]?.id ?? "");
  };

  const commit = async () => {
    if (creating === undefined) return;
    const employee = state.employees.find((entry) => entry.id === draftEmployee);
    const name = draftName.trim().length > 0 ? draftName.trim() : employee?.name ?? "";
    if (name.length === 0) return;
    try {
      const room = await api.createRoom({
        kind: creating,
        name,
        employeeId: creating === "channel" ? undefined : employee?.id,
      });
      setCreating(undefined);
      dispatch({ type: "room", room });
      await openRoom(room.id);
      dispatch({ type: "view", view: "chat" });
      onNavigate?.();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };

  const renderRoom = (roomId: string, kind: "channel" | "dm") => {
    const room = state.rooms.find((entry) => entry.id === roomId);
    if (room === undefined) return null;
    const employee = state.employees.find((entry) => entry.id === room.employeeId);
    const label = room.kind === "dm" ? (employee?.name ?? room.name) : room.name;
    const active = state.activeRoomId === room.id && state.view === "chat";
    return (
      <button
        key={room.id}
        type="button"
        className={active ? "room active" : "room"}
        aria-current={active ? "page" : undefined}
        onClick={() => {
          void openRoom(room.id);
          dispatch({ type: "view", view: "chat" });
          onNavigate?.();
        }}
      >
        <span className="room-name">{label}</span>
        {room.kind === "channel" ? <span className="room-topic">{room.topic.slice(0, 18)}</span> : null}
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
            频道
            <IconButton icon="plus" label="新建频道" onClick={() => startCreating("channel")} />
          </h3>
          {channels.map((room) => renderRoom(room.id, "channel"))}
        </section>

        <section>
          <h3>
            私信
            <IconButton icon="plus" label="开始私信" onClick={() => startCreating("dm")} />
          </h3>
          {directs.map((room) => renderRoom(room.id, "dm"))}
        </section>

        <section>
          <h3>邮箱</h3>
          <button
            type="button"
            className={state.view === "mail" ? "room active" : "room"}
            aria-current={state.view === "mail" ? "page" : undefined}
            onClick={() => select("mail")}
          >
            <Icon name="mail" />
            <span className="room-name">邮箱</span>
            {mailUnread > 0 ? <Chip tone="info">{mailUnread}</Chip> : null}
          </button>
        </section>
      </nav>

      {creating !== undefined ? (
        <div className="creator">
          <div className="row">
            <span>{creating === "channel" ? "新频道" : "开始私信"}</span>
          </div>
          {creating === "channel" ? (
            <input
              autoFocus
              placeholder="频道名称"
              value={draftName}
              onChange={(event) => setDraftName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void commit();
              }}
            />
          ) : (
            <select value={draftEmployee} onChange={(event) => setDraftEmployee(event.target.value)}>
              {state.employees.length === 0 ? <option value="">（还没有员工）</option> : null}
              {state.employees.map((employee) => (
                <option key={employee.id} value={employee.id}>
                  {employee.name} · {employee.role}
                </option>
              ))}
            </select>
          )}
          <div className="row">
            <button type="button" className="primary" onClick={() => void commit()}>
              创建
            </button>
            <button type="button" onClick={() => setCreating(undefined)}>
              取消
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
          <span className="label">审批</span>
          {pendingApprovals > 0 ? <Chip tone="warn">{pendingApprovals}</Chip> : null}
        </button>
        <button
          type="button"
          className={state.view === "work" ? "active" : ""}
          aria-current={state.view === "work" ? "page" : undefined}
          onClick={() => select("work")}
        >
          <Icon name="work" />
          <span className="label">工作</span>
          {running > 0 ? <Chip tone="info">{running}</Chip> : null}
        </button>
        <button
          type="button"
          className={state.view === "employees" ? "active" : ""}
          aria-current={state.view === "employees" ? "page" : undefined}
          onClick={() => select("employees")}
        >
          <Icon name="employees" />
          <span className="label">员工</span>
        </button>
        <button
          type="button"
          className={state.view === "settings" ? "active" : ""}
          aria-current={state.view === "settings" ? "page" : undefined}
          onClick={() => select("settings")}
        >
          <Icon name="settings" />
          <span className="label">设置</span>
        </button>
        <ThemePicker label="外观" />
      </nav>
    </aside>
  );
}
