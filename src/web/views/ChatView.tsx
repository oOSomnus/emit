/**
 * The synchronous half: a channel or direct message.
 *
 * A message the user sends starts work, and the running work of this room is
 * shown inline — live text, tool activity, and a stop button — so the wait is
 * visible rather than implied.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../api.ts";
import { errorDisplay } from "../../shared/i18n.ts";
import { MessageAddressingError, resolveMessageAddressing } from "../../shared/message-addressing.ts";
import { useI18n } from "../i18n.tsx";
import { useApp } from "../state.tsx";
import { Chip, EmployeeAvatar, Icon, IconButton, timeAgo } from "./ui.tsx";
import { ChannelMembers } from "./ChannelMembers.tsx";

type MentionRange = { start: number; end: number; query: string };

type AddressSuggestion =
  | { id: string; name: string; role: string; insertion: string; mentionAll: false }
  | { id: "all"; name: string; role: string; insertion: string; mentionAll: true };

function mentionRange(value: string, caret: number): MentionRange | undefined {
  const start = value.lastIndexOf("@", caret - 1);
  if (start < 0 || (start > 0 && !/[\s,.;!?，。！？：；、:;()[\]{}]/u.test(value[start - 1]!))) return undefined;
  const query = value.slice(start + 1, caret);
  if (/[\s,.;!?，。！？：；、:;()[\]{}@]/u.test(query)) return undefined;
  const remainder = value.slice(caret);
  const delimiter = remainder.search(/[\s,.;!?，。！？：；、:;()[\]{}]/u);
  return { start, end: delimiter < 0 ? value.length : caret + delimiter, query };
}
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
  const { state, dispatch, openRoom, setError } = useApp();
  const { locale, messages, text } = useI18n();
  const [draft, setDraft] = useState("");
  const [selection, setSelection] = useState<{ roomId: string; recipientIds: string[]; mentionAll: boolean }>({
    roomId: "",
    recipientIds: [],
    mentionAll: false,
  });
  const [mentionInput, setMentionInput] = useState<MentionRange | undefined>(undefined);
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(0);
  const [sending, setSending] = useState(false);
  const [managingMembers, setManagingMembers] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const manageMembersRef = useRef<HTMLButtonElement>(null);
  const room = state.rooms.find((entry) => entry.id === state.activeRoomId);
  const recipientIds = room !== undefined && selection.roomId === room.id ? selection.recipientIds : [];
  const mentionAll = room !== undefined && selection.roomId === room.id && selection.mentionAll;

  const channelMembers = useMemo(
    () =>
      room?.kind === "channel"
        ? room.memberIds.map((id) => state.employees.find((employee) => employee.id === id) ?? {
            id,
            name: id,
            address: "",
            enabled: false,
          })
        : [],
    [room, state.employees],
  );

  const addressing = useMemo(() => {
    if (room?.kind !== "channel") return { resolved: undefined, error: undefined };
    try {
      return {
        resolved: resolveMessageAddressing(draft, recipientIds, mentionAll, channelMembers),
        error: undefined,
      };
    } catch (error) {
      return {
        resolved: undefined,
        error: error instanceof MessageAddressingError ? error : undefined,
      };
    }
  }, [room?.kind, draft, recipientIds, mentionAll, channelMembers]);

  const suggestions = useMemo<AddressSuggestion[]>(() => {
    if (mentionInput === undefined || room?.kind !== "channel") return [];
    const query = mentionInput.query.toLowerCase();
    const members: AddressSuggestion[] = channelMembers
      .filter(
        (member) =>
          member.enabled &&
          member.address.length > 0 &&
          (query.length === 0 ||
            member.name.toLowerCase().includes(query) ||
            member.address.toLowerCase().includes(query)),
      )
      .map((member) => ({
        id: member.id,
        name: member.name,
        role: state.employees.find((employee) => employee.id === member.id)?.role ?? "",
        insertion: `@${member.address} `,
        mentionAll: false,
      }));
    const allMatches = query.length === 0 || "all".startsWith(query) || "全体".includes(query);
    if (allMatches) {
      members.push({
        id: "all",
        name: messages.workContexts.mentionAll,
        role: "",
        insertion: "@all ",
        mentionAll: true,
      });
    }
    return members;
  }, [mentionInput, room?.kind, channelMembers, state.employees, messages.workContexts.mentionAll]);

  const addressingError =
    addressing.error === undefined
      ? undefined
      : addressing.error.code === "unknown-mention"
        ? messages.workContexts.unknownMention(`@${addressing.error.token}`)
        : addressing.error.code === "ambiguous-mention"
          ? messages.workContexts.ambiguousMention(`@${addressing.error.token}`)
          : addressing.error.code === "not-member"
            ? messages.workContexts.mentionNotMember(
                state.employees.find((employee) => employee.id === addressing.error?.employeeId)?.name ??
                  addressing.error.token ??
                  addressing.error.employeeId,
              )
            : addressing.error.code === "disabled"
              ? messages.workContexts.mentionDisabled(addressing.error.token)
              : messages.workContexts.mentionEmptyAll;

  const roomWork = useMemo(
    () => state.work.filter((work) => work.roomId === state.activeRoomId && work.status !== "succeeded" && work.status !== "failed" && work.status !== "stopped"),
    [state.work, state.activeRoomId],
  );

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [state.messages.length]);

  useEffect(() => {
    setActiveSuggestionIndex((index) => Math.max(0, Math.min(index, suggestions.length - 1)));
  }, [suggestions.length]);

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
  const previewNames =
    addressing.resolved === undefined
      ? ""
      : addressing.resolved.recipientIds
          .map((id) => state.employees.find((employee) => employee.id === id)?.name ?? id)
          .join(locale === "zh-CN" ? "、" : ", ");
  const disabledMembers = channelMembers.filter((member) => !member.enabled);

  const updateSelection = (nextRecipientIds: string[], nextMentionAll: boolean): void => {
    setSelection({ roomId: room.id, recipientIds: nextRecipientIds, mentionAll: nextMentionAll });
  };

  const send = async () => {
    const body = draft.trim();
    if (body.length === 0 || sending || (room.kind === "channel" && addressingError !== undefined)) return;
    setSending(true);
    try {
      const input =
        room.kind === "channel"
          ? { body, ...resolveMessageAddressing(body, recipientIds, mentionAll, channelMembers) }
          : { body };
      await api.sendRoomMessage(room.id, input);
      setDraft("");
      setMentionInput(undefined);
      updateSelection([], false);
    } catch (error) {
      setError(errorDisplay(error));
    } finally {
      setSending(false);
    }
  };

  const applySuggestion = (suggestion: AddressSuggestion): void => {
    if (mentionInput === undefined) return;
    const next = `${draft.slice(0, mentionInput.start)}${suggestion.insertion}${draft.slice(mentionInput.end)}`;
    const caret = mentionInput.start + suggestion.insertion.length;
    setDraft(next);
    setMentionInput(undefined);
    setActiveSuggestionIndex(0);
    if (suggestion.mentionAll) updateSelection(recipientIds, true);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(caret, caret);
    });
  };

  const onDraftChange = (value: string, caret: number): void => {
    setDraft(value);
    setMentionInput(mentionRange(value, caret));
    setActiveSuggestionIndex(0);
  };

  return (
    <div className="pane">
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
                aria-label={`${messages.workContexts.membersCount(room.memberIds.length)}: ${memberNames.join(locale === "zh-CN" ? "、" : ", ")}`}
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
                  <div className="body">{text(message.bodyLocalized ?? message.body)}</div>
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
                <pre className="stream">{work.progressText}</pre>
              ) : (
                <p className="hint">{messages.chat.startedHint}</p>
              )}
            </article>
          ))}
          <div ref={endRef} />
        </div>
      </div>

      <footer className="composer">
        <div className="composer-box">
          <textarea
            ref={textareaRef}
            value={draft}
            placeholder={room.kind === "channel" ? messages.chat.channelPlaceholder : messages.chat.directPlaceholder}
            aria-label={messages.chat.messageLabel}
            aria-autocomplete={room.kind === "channel" ? "list" : undefined}
            aria-controls={suggestions.length > 0 ? "chat-address-suggestions" : undefined}
            aria-expanded={room.kind === "channel" && suggestions.length > 0}
            aria-activedescendant={
              suggestions.length > 0 ? `address-suggestion-${suggestions[activeSuggestionIndex]?.id}` : undefined
            }
            onChange={(event) => onDraftChange(event.currentTarget.value, event.currentTarget.selectionStart)}
            onClick={(event) => setMentionInput(mentionRange(event.currentTarget.value, event.currentTarget.selectionStart))}
            onKeyUp={(event) => {
              if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "Home" || event.key === "End") {
                setMentionInput(mentionRange(event.currentTarget.value, event.currentTarget.selectionStart));
              }
            }}
            onKeyDown={(event) => {
              if (suggestions.length > 0 && event.key === "ArrowDown") {
                event.preventDefault();
                setActiveSuggestionIndex((index) => (index + 1) % suggestions.length);
                return;
              }
              if (suggestions.length > 0 && event.key === "ArrowUp") {
                event.preventDefault();
                setActiveSuggestionIndex((index) => (index + suggestions.length - 1) % suggestions.length);
                return;
              }
              if (suggestions.length > 0 && event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                applySuggestion(suggestions[activeSuggestionIndex]!);
                return;
              }
              if (event.key === "Escape" && mentionInput !== undefined) {
                event.preventDefault();
                setMentionInput(undefined);
                return;
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
          />
          {suggestions.length > 0 ? (
            <ul
              id="chat-address-suggestions"
              role="listbox"
              aria-label={messages.workContexts.addressSuggestions}
              style={{ listStyle: "none", margin: 0, padding: 4, maxHeight: 180, overflowY: "auto", borderTop: "1px solid var(--line)" }}
            >
              {suggestions.map((suggestion, index) => (
                <li key={suggestion.id}>
                  <button
                    id={`address-suggestion-${suggestion.id}`}
                    type="button"
                    role="option"
                    aria-selected={index === activeSuggestionIndex}
                    className="employee-card"
                    style={{ display: "flex", width: "100%", justifyContent: "space-between", textAlign: "left" }}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => applySuggestion(suggestion)}
                  >
                    <strong>{suggestion.name}</strong>
                    {suggestion.role.length > 0 ? <span className="role">{suggestion.role}</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {room.kind === "channel" ? (
            <>
              <div className="composer-toolbar" style={{ justifyContent: "flex-start", flexWrap: "wrap" }}>
                {channelMembers.map((member) => {
                  const selected = recipientIds.includes(member.id);
                  const role = state.employees.find((employee) => employee.id === member.id)?.role ?? "";
                  return (
                    <button
                      key={member.id}
                      type="button"
                      className={`chip-toggle${selected ? " on" : ""}`}
                      aria-pressed={selected}
                      disabled={!member.enabled && !selected}
                      onClick={() =>
                        updateSelection(
                          selected ? recipientIds.filter((id) => id !== member.id) : [...recipientIds, member.id],
                          mentionAll,
                        )
                      }
                    >
                      {member.name}{role.length > 0 ? ` · ${role}` : ""}
                    </button>
                  );
                })}
                {recipientIds
                  .filter((id) => !channelMembers.some((member) => member.id === id))
                  .map((id) => {
                    const name = state.employees.find((employee) => employee.id === id)?.name ?? id;
                    return (
                      <button
                        key={id}
                        type="button"
                        className="chip-toggle on"
                        aria-pressed="true"
                        onClick={() => updateSelection(recipientIds.filter((memberId) => memberId !== id), mentionAll)}
                      >
                        {messages.workContexts.mentionNotMember(name)}
                      </button>
                    );
                  })}
                <button
                  type="button"
                  className={`chip-toggle${mentionAll ? " on" : ""}`}
                  aria-pressed={mentionAll}
                  onClick={() => updateSelection(recipientIds, !mentionAll)}
                >
                  {messages.workContexts.mentionAll}
                </button>
              </div>
              <p className="hint">{messages.chat.addressingScopeHint}</p>
              {addressingError !== undefined ? (
                <p role="alert" style={{ color: "var(--error)", margin: 0 }}>{addressingError}</p>
              ) : addressing.resolved !== undefined ? (
                <p className="hint" aria-live="polite">
                  {previewNames.length > 0 ? messages.chat.addressedReplies(previewNames) : messages.chat.noOneAddressed}
                </p>
              ) : null}
              {addressing.resolved?.mentionAll && disabledMembers.length > 0 ? (
                <p className="hint">
                  {messages.workContexts.skippedDisabled(
                    disabledMembers.map((member) => member.name).join(locale === "zh-CN" ? "、" : ", "),
                  )}
                </p>
              ) : null}
            </>
          ) : null}
          <div className="composer-toolbar">
            <button
              type="button"
              className="primary"
              disabled={sending || draft.trim().length === 0 || (room.kind === "channel" && addressingError !== undefined)}
              onClick={() => void send()}
            >
              <Icon name="send" />
              {messages.chat.send}
            </button>
          </div>
        </div>
      </footer>
      {managingMembers && room.kind === "channel" ? (
        <ChannelMembers key={room.id} room={room} onClose={() => setManagingMembers(false)} />
      ) : null}
    </div>
  );
}
