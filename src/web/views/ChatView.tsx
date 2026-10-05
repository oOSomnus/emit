/**
 * The synchronous half: a channel or direct message.
 *
 * A message the user sends starts work, and the running work of this room is
 * shown inline — live text, tool activity, and a stop button — so the wait is
 * visible rather than implied.
 *
 * The composer itself is `ChatComposer`; this view lays out the room around it.
 * In a channel, routing comes only from the explicit selection the composer
 * records — the message text never selects recipients, no matter what it
 * contains.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../api.ts";
import { useI18n } from "../i18n.tsx";
import { useSessionExport } from "../session-export.ts";
import { useApp } from "../state.tsx";
import { Chip, EmployeeAvatar, IconButton, timeAgo } from "./ui.tsx";
import { ChannelMembers } from "./ChannelMembers.tsx";
import { ChatComposer } from "./ChatComposer.tsx";
import { MarkdownBody } from "./MarkdownBody.tsx";

/** How a live work's chip is toned; the wording comes from the work statuses. */
const LIVE_WORK_TONES: Record<string, "info" | "warn" | "muted" | undefined> = {
  queued: "muted",
  running: "info",
  "waiting-approval": "warn",
  "waiting-mail": "warn",
};

/** The avatar initial: one grapheme, so a Chinese name does not render half a pair. */
function initial(name: string): string {
  return [...name.trim()][0] ?? "?";
}

export function ChatView(): ReactNode {
  const { state, dispatch, openRoom } = useApp();
  const { locale, messages, text } = useI18n();
  const exportSession = useSessionExport();
  const [managingMembers, setManagingMembers] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const manageMembersRef = useRef<HTMLButtonElement>(null);
  const room = state.rooms.find((entry) => entry.id === state.activeRoomId);

  const roomWork = useMemo(
    () => state.work.filter((work) => work.roomId === state.activeRoomId && work.status !== "succeeded" && work.status !== "failed" && work.status !== "stopped"),
    [state.work, state.activeRoomId],
  );

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [state.messages.length]);

  if (room === undefined) {
    return (
      <div className="empty">
        <h2>{messages.chat.emptyTitle}</h2>
        <p>{messages.chat.emptyBody}</p>
      </div>
    );
  }

  const workContext = state.workContexts.find((entry) => entry.id === room.workContextId);
  const memberNames = room.kind === "channel"
    ? room.memberIds.map((id) => state.employees.find((employee) => employee.id === id)?.name ?? id)
    : [];

  return (
    <div className="pane chat-pane">
      <header className="pane-header">
        <div>
          <h2>{room.kind === "channel" ? `# ${room.name}` : state.employees.find((e) => e.id === room.employeeId)?.name ?? room.name}</h2>
          <p className="topic">
            {messages.workContexts.currentWorkLabel}: {workContext?.name ?? room.workContextId}
          </p>
          {room.topic.length > 0 ? <p className="topic">{room.topic}</p> : null}
        </div>
        <div className="pane-header-actions">
          <button
            type="button"
            onClick={() => {
              dispatch({ type: "activeWorkContext", workContextId: room.workContextId });
              dispatch({ type: "view", view: "work-contexts" });
            }}
          >
            {messages.workContexts.viewWork}
          </button>
          {room.kind === "channel" ? (
            <>
              <span
                className="channel-member-stack"
                role="group"
                aria-label={`${messages.workContexts.membersCount(room.memberIds.length)}: ${memberNames.join(messages.common.namesSeparator)}`}
                style={{ display: "inline-flex", alignItems: "center" }}
              >
                {room.memberIds.slice(0, 4).map((id, index) => (
                  <span key={id} style={{ marginInlineStart: index === 0 ? 0 : -8, border: "2px solid var(--bg-soft)", borderRadius: "50%", lineHeight: 0 }}>
                    <EmployeeAvatar employeeId={id} size={24} />
                  </span>
                ))}
                {room.memberIds.length > 4 ? <Chip tone="muted">+{room.memberIds.length - 4}</Chip> : null}
              </span>
              <span className="hint">{messages.workContexts.membersCount(room.memberIds.length)}</span>
              <button ref={manageMembersRef} type="button" onClick={() => setManagingMembers(true)}>
                {messages.workContexts.manageMembers}
              </button>
            </>
          ) : null}
          <IconButton
            icon="download"
            label={messages.common.exportSession}
            onClick={() => void exportSession({ roomId: room.id })}
          />
          <IconButton icon="refresh" label={messages.common.refresh} onClick={() => void openRoom(room.id)} />
        </div>
      </header>

      <div className="messages">
        <div className="conversation-content">
          {state.messages.map((message) => {
            const employee =
              message.author.type === "employee"
                ? state.employees.find((entry) => entry.id === message.author.id)
                : undefined;
            return (
              <article key={message.id} className={`message identity ${message.author.type} ${message.notice === true ? "notice" : ""}`}>
                {message.notice === true ? null : message.author.type === "employee" ? (
                  <EmployeeAvatar employeeId={message.author.id} />
                ) : (
                  <span className="avatar">{initial(message.author.name)}</span>
                )}
                <div className="message-content">
                  <div className={message.notice === true ? "meta" : "meta identity-meta"}>
                    <strong>{text(message.author.nameLocalized ?? message.author.name)}</strong>
                    {employee !== undefined ? <span className="role">{employee.role}</span> : null}
                    {message.author.address !== undefined && message.author.address.length > 0 ? (
                      <span className="address">{message.author.address}</span>
                    ) : null}
                    <span className="time">{timeAgo(message.createdAt, locale)}</span>
                  </div>
                  {message.notice !== true && message.author.type === "employee" ? (
                    <MarkdownBody body={text(message.bodyLocalized ?? message.body)} className="body" />
                  ) : (
                    <div className="body">{text(message.bodyLocalized ?? message.body)}</div>
                  )}
                </div>
              </article>
            );
          })}
          {roomWork.map((work) => (
            <article key={work.id} className="work-live">
              <div className="meta">
                <Chip tone="info">{messages.chat.working(work.employeeName)}</Chip>
                <Chip tone={LIVE_WORK_TONES[work.status] ?? "info"}>{messages.work.status[work.status]}</Chip>
                <span className="time" />
                <IconButton icon="close" label={messages.chat.stop} onClick={() => void api.stopWork(work.id)} />
              </div>
              {work.tools !== undefined && work.tools.length > 0 ? (
                <ul className="tools">
                  {work.tools.map((tool) => (
                    <li key={tool.callId}>
                      <Chip tone={tool.status === "done" ? "ok" : "info"}>{messages.chat.toolStatus[tool.status]}</Chip>
                      <code>{tool.name}</code>
                      {tool.output !== undefined ? <pre>{tool.output.slice(0, 400)}</pre> : null}
                    </li>
                  ))}
                </ul>
              ) : null}
              {work.progressText !== undefined && work.progressText.length > 0 ? (
                <MarkdownBody body={work.progressText} className="stream" />
              ) : (
                <p className="hint">{messages.chat.startedHint}</p>
              )}
            </article>
          ))}
          <div ref={endRef} />
        </div>
      </div>

      <ChatComposer room={room} />
      {managingMembers && room.kind === "channel" ? (
        <ChannelMembers key={room.id} room={room} onClose={() => setManagingMembers(false)} />
      ) : null}
    </div>
  );
}
