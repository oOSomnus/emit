/**
 * The synchronous half: a channel or direct message.
 *
 * The pane shows the conversation itself. Work started by a message is not
 * rendered here: while a run is queued or generating, the room shows who is
 * typing above the composer, and the run's streamed progress and tool activity
 * live in its execution record (Runs → View execution).
 *
 * The composer itself is `ChatComposer`; this view lays out the room around it.
 * In a channel, routing comes only from the explicit selection the composer
 * records — the message text never selects recipients, no matter what it
 * contains.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useI18n } from "../i18n.tsx";
import { useSessionExport } from "../session-export.ts";
import { useApp } from "../state.tsx";
import { Chip, EmployeeAvatar, Icon, IconButton, timeAgo } from "./ui.tsx";
import { ChannelMembers } from "./ChannelMembers.tsx";
import { ChatComposer } from "./ChatComposer.tsx";
import { MarkdownBody } from "./MarkdownBody.tsx";

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

  // Typing is a projection of the live work states of this room, not a wire
  // event: a run that is queued or generating is "typing"; one that waits for
  // an approval or a reply is not, and reappears if it resumes.
  const typingNames = useMemo(() => {
    const active = state.work.filter(
      (work) => work.roomId === state.activeRoomId && (work.status === "queued" || work.status === "running"),
    );
    const ordered = [...active].sort(
      (left, right) => left.startedAt - right.startedAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    );
    const seen = new Set<string>();
    const names: string[] = [];
    for (const work of ordered) {
      if (seen.has(work.employeeId)) continue;
      seen.add(work.employeeId);
      names.push(state.employees.find((employee) => employee.id === work.employeeId)?.name ?? work.employeeName);
    }
    return names;
  }, [state.work, state.activeRoomId, state.employees]);
  const typingText =
    typingNames.length === 0
      ? undefined
      : typingNames.length === 1
        ? messages.chat.typingOne(typingNames[0]!)
        : messages.chat.typingMany(typingNames.join(messages.common.namesSeparator));

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
  const workName = workContext?.name ?? room.workContextId;
  const memberNames = room.kind === "channel"
    ? room.memberIds.map((id) => state.employees.find((employee) => employee.id === id)?.name ?? id)
    : [];

  return (
    <div className="pane chat-pane" data-room-id={room.id}>
      <header className="pane-header">
        <div>
          <h2>{room.kind === "channel" ? `# ${room.name}` : state.employees.find((e) => e.id === room.employeeId)?.name ?? room.name}</h2>
          <p className="topic session-work" aria-label={`${messages.chat.sessionWorkLabel}: ${workName}`}>
            <Icon name="work" size={14} />
            <span>{workName}</span>
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
          <div ref={endRef} />
        </div>
      </div>

      <div className="chat-composer-region">
        {typingText !== undefined ? (
          <div className="chat-typing-row">
            <p className="chat-typing" role="status" aria-live="polite" aria-atomic="true" title={typingText}>
              {typingText}
            </p>
          </div>
        ) : null}
        <ChatComposer room={room} />
      </div>
      {managingMembers && room.kind === "channel" ? (
        <ChannelMembers key={room.id} room={room} onClose={() => setManagingMembers(false)} />
      ) : null}
    </div>
  );
}
