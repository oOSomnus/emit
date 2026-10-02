/**
 * The synchronous half: a channel or direct message.
 *
 * A message the user sends starts work, and the running work of this room is
 * shown inline — live text, tool activity, and a stop button — so the wait is
 * visible rather than implied.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../api.ts";
import { useApp } from "../state.tsx";
import { Chip, Icon, IconButton, timeAgo } from "./ui.tsx";
import { RoomDirectoryEditor } from "./RoomDirectories.tsx";

/** The avatar initial: one grapheme, so a Chinese name does not render half a pair. */
function initial(name: string): string {
  return [...name.trim()][0] ?? "?";
}

export function ChatView(): ReactNode {
  const { state, openRoom, setError } = useApp();
  const [draft, setDraft] = useState("");
  const [target, setTarget] = useState("");
  const [sending, setSending] = useState(false);
  const [editingDirectories, setEditingDirectories] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const room = state.rooms.find((entry) => entry.id === state.activeRoomId);

  useEffect(() => {
    if (room !== undefined && room.kind === "channel") {
      setTarget((current) => (current.length > 0 ? current : state.employees[0]?.id ?? ""));
    }
  }, [room, state.employees]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [state.messages.length]);

  const roomWork = useMemo(
    () => state.work.filter((work) => work.roomId === state.activeRoomId && work.status !== "succeeded" && work.status !== "failed" && work.status !== "stopped"),
    [state.work, state.activeRoomId],
  );

  if (room === undefined) {
    return (
      <div className="empty">
        <h2>还没有会话</h2>
        <p>在左侧创建一个频道，或在“员工”页创建你的第一位数字员工。</p>
      </div>
    );
  }

  const send = async () => {
    const body = draft.trim();
    if (body.length === 0 || sending) return;
    setSending(true);
    try {
      const result = await api.sendMessage(room.id, {
        body,
        ...(room.kind === "channel" && target.length > 0 ? { employeeId: target } : {}),
      });
      if (result.error !== undefined) setError(result.error);
      setDraft("");
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="pane">
      <header className="pane-header">
        <div>
          <h2>{room.kind === "channel" ? `# ${room.name}` : state.employees.find((e) => e.id === room.employeeId)?.name ?? room.name}</h2>
          {room.topic.length > 0 ? <p className="topic">{room.topic}</p> : null}
        </div>
        <div className="pane-header-actions">
          <button type="button" onClick={() => setEditingDirectories(true)}>
            工作目录（{room.directories.paths.length}）
          </button>
          <IconButton icon="refresh" label="刷新" onClick={() => void openRoom(room.id)} />
        </div>
      </header>

      <div className="messages">
        {state.messages.map((message) => (
          <article key={message.id} className={`message ${message.author.type} ${message.notice === true ? "notice" : ""}`}>
            {message.notice === true ? null : <span className="avatar">{initial(message.author.name)}</span>}
            <div className="message-content">
              <div className="meta">
                <strong>{message.author.name}</strong>
                {message.author.address !== undefined && message.author.address.length > 0 ? (
                  <span className="address">{message.author.address}</span>
                ) : null}
                <span className="time">{timeAgo(message.createdAt)}</span>
              </div>
              <div className="body">{message.body}</div>
            </div>
          </article>
        ))}
        {roomWork.map((work) => (
          <article key={work.id} className="work-live">
            <div className="meta">
              <Chip tone="info">{work.employeeName} 正在工作</Chip>
              <Chip tone={work.status === "waiting-approval" ? "warn" : "info"}>{work.status === "waiting-approval" ? "等待审批" : "进行中"}</Chip>
              <span className="time" />
              <IconButton icon="close" label="停止" onClick={() => void api.stopWork(work.id)} />
            </div>
            {work.tools !== undefined && work.tools.length > 0 ? (
              <ul className="tools">
                {work.tools.map((tool) => (
                  <li key={tool.callId}>
                    <Chip tone={tool.status === "done" ? "ok" : "info"}>{tool.status}</Chip>
                    <code>{tool.name}</code>
                    {tool.output !== undefined ? <pre>{tool.output.slice(0, 400)}</pre> : null}
                  </li>
                ))}
              </ul>
            ) : null}
            {work.progressText !== undefined && work.progressText.length > 0 ? (
              <pre className="stream">{work.progressText}</pre>
            ) : (
              <p className="hint">已开始处理，输出会实时出现在这里。</p>
            )}
          </article>
        ))}
        <div ref={endRef} />
      </div>

      <footer className="composer">
        {room.kind === "channel" ? (
          <select value={target} onChange={(event) => setTarget(event.target.value)} aria-label="指派员工">
            <option value="">（只记录，不指派员工）</option>
            {state.employees.map((employee) => (
              <option key={employee.id} value={employee.id}>
                @{employee.name} · {employee.role}
              </option>
            ))}
          </select>
        ) : null}
        <textarea
          value={draft}
          placeholder={room.kind === "channel" ? "写点什么，选中一位员工让他跟进…" : "发消息给这位员工…"}
          aria-label="消息内容"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <button type="button" className="primary" disabled={sending || draft.trim().length === 0} onClick={() => void send()}>
          <Icon name="send" />
          发送
        </button>
      </footer>
      {editingDirectories ? (
        <RoomDirectoryEditor key={room.id} room={room} onClose={() => setEditingDirectories(false)} />
      ) : null}
    </div>
  );
}
