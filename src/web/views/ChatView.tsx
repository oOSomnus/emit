/**
 * The synchronous half: a channel or direct message.
 *
 * A message the user sends starts work, and the running work of this room is
 * shown inline — live text, tool activity, and a stop button — so the wait is
 * visible rather than implied.
 *
 * In a channel, the message body is the only addressing source: an @mention in
 * the text wakes an employee, and a message without one wakes nobody. The
 * picker above the composer is a typing aid for that text, never hidden state.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../api.ts";
import { errorDisplay } from "../../shared/i18n.ts";
import { MessageAddressingError, resolveMessageAddressing } from "../../shared/message-addressing.ts";
import { useI18n } from "../i18n.tsx";
import { useApp } from "../state.tsx";
import { Chip, EmployeeAvatar, Icon, IconButton, timeAgo } from "./ui.tsx";
import { ChannelMembers } from "./ChannelMembers.tsx";
import { MarkdownBody } from "./MarkdownBody.tsx";

type MentionRange = { start: number; end: number; query: string };

type AddressSuggestion = {
  id: string;
  name: string;
  role: string;
  address: string;
  insertion: string;
  mentionAll: boolean;
};

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
  const [mentionInput, setMentionInput] = useState<MentionRange | undefined>(undefined);
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(0);
  const [sending, setSending] = useState(false);
  const [managingMembers, setManagingMembers] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputAreaRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const composingRef = useRef(false);
  const manageMembersRef = useRef<HTMLButtonElement>(null);
  const room = state.rooms.find((entry) => entry.id === state.activeRoomId);

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
        resolved: resolveMessageAddressing(draft, [], false, channelMembers),
        error: undefined,
      };
    } catch (error) {
      return {
        resolved: undefined,
        error: error instanceof MessageAddressingError ? error : undefined,
      };
    }
  }, [room?.kind, draft, channelMembers]);

  const menuOpen = room?.kind === "channel" && mentionInput !== undefined;

  const suggestions = useMemo<AddressSuggestion[]>(() => {
    if (mentionInput === undefined || room?.kind !== "channel") return [];
    const query = mentionInput.query.toLowerCase();
    const enabledAddressable = channelMembers.filter((member) => member.enabled && member.address.length > 0);
    const matching = enabledAddressable.filter(
      (member) =>
        query.length === 0 || member.name.toLowerCase().includes(query) || member.address.toLowerCase().includes(query),
    );
    const options: AddressSuggestion[] = matching.map((member) => {
      // A name is inserted only when the resolver uniquely maps it back to this
      // member; ambiguous or reserved names fall back to the unique address.
      const nameInsertion = `@${member.name} `;
      let insertion = `@${member.address} `;
      try {
        const resolved = resolveMessageAddressing(nameInsertion, [], false, channelMembers);
        if (!resolved.mentionAll && resolved.recipientIds.length === 1 && resolved.recipientIds[0] === member.id) {
          insertion = nameInsertion;
        }
      } catch {
        // Keep the address insertion.
      }
      return {
        id: member.id,
        name: member.name,
        role: state.employees.find((employee) => employee.id === member.id)?.role ?? "",
        address: member.address,
        insertion,
        mentionAll: false,
      };
    });
    const allMatches = query.length === 0 || "all".startsWith(query) || "全体".includes(query);
    if (allMatches && enabledAddressable.length > 0) {
      options.push({
        id: "all",
        name: messages.chat.mentionEveryone,
        role: "",
        address: "",
        insertion: "@all ",
        mentionAll: true,
      });
    }
    return options;
  }, [mentionInput, room?.kind, channelMembers, state.employees, messages.chat.mentionEveryone]);

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

  useEffect(() => {
    if (!menuOpen) return;
    const item = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeSuggestionIndex}"]`);
    item?.scrollIntoView({ block: "nearest" });
  }, [menuOpen, activeSuggestionIndex, suggestions.length]);

  // A pointer outside the input area dismisses the menu; the trigger is
  // exempt because it reopens the menu in the same gesture.
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (inputAreaRef.current?.contains(target) === true) return;
      if (triggerRef.current?.contains(target) === true) return;
      setMentionInput(undefined);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [menuOpen]);

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

  const send = async () => {
    const body = draft.trim();
    if (body.length === 0 || sending || (room.kind === "channel" && addressingError !== undefined)) return;
    setSending(true);
    try {
      const input =
        room.kind === "channel"
          ? { body, ...resolveMessageAddressing(body, [], false, channelMembers) }
          : { body };
      await api.sendRoomMessage(room.id, input);
      setDraft("");
      setMentionInput(undefined);
    } catch (error) {
      setError(errorDisplay(error));
    } finally {
      setSending(false);
    }
  };

  const applySuggestion = (suggestion: AddressSuggestion): void => {
    const input = textareaRef.current;
    if (input === null || mentionInput === undefined) return;
    const caret = input.selectionStart ?? input.value.length;
    const current = mentionRange(input.value, caret);
    if (current === undefined || current.start !== mentionInput.start || current.end !== mentionInput.end) {
      // The caret moved since the range was captured; never replace text the
      // user is no longer editing.
      setMentionInput(undefined);
      return;
    }
    const next = `${input.value.slice(0, mentionInput.start)}${suggestion.insertion}${input.value.slice(mentionInput.end)}`;
    const nextCaret = mentionInput.start + suggestion.insertion.length;
    setDraft(next);
    setMentionInput(undefined);
    setActiveSuggestionIndex(0);
    requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(nextCaret, nextCaret);
    });
  };

  const onDraftChange = (value: string, caret: number): void => {
    setDraft(value);
    setMentionInput(mentionRange(value, caret));
    setActiveSuggestionIndex(0);
  };

  const openMentions = (): void => {
    const input = textareaRef.current;
    if (input === null) return;
    input.focus();
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    const existing = mentionRange(input.value, end);
    if (existing !== undefined) {
      setMentionInput(existing);
      setActiveSuggestionIndex(0);
      return;
    }
    const before = input.value.slice(0, start);
    const needsSpace = before.length > 0 && !/[\s,.;!?，。！？：；、:;()[\]{}]/u.test(before[before.length - 1]!);
    const inserted = `${needsSpace ? " " : ""}@`;
    const next = `${before}${inserted}${input.value.slice(end)}`;
    const caret = start + inserted.length;
    setDraft(next);
    setMentionInput(mentionRange(next, caret));
    setActiveSuggestionIndex(0);
    requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(caret, caret);
    });
  };

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

      <footer className="composer">
        <div className="composer-box">
          <div
            className="composer-input"
            ref={inputAreaRef}
            onBlur={(event) => {
              if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
              setMentionInput(undefined);
            }}
          >
            <textarea
              ref={textareaRef}
              value={draft}
              disabled={sending}
              placeholder={room.kind === "channel" ? messages.chat.channelPlaceholder : messages.chat.directPlaceholder}
              aria-label={messages.chat.messageLabel}
              aria-autocomplete={room.kind === "channel" ? "list" : undefined}
              aria-controls={menuOpen ? "chat-address-suggestions" : undefined}
              aria-expanded={menuOpen}
              aria-activedescendant={
                menuOpen && suggestions.length > 0
                  ? `address-suggestion-${suggestions[activeSuggestionIndex]?.id}`
                  : undefined
              }
              onChange={(event) => onDraftChange(event.currentTarget.value, event.currentTarget.selectionStart)}
              onClick={(event) => {
                if (composingRef.current) return;
                setMentionInput(mentionRange(event.currentTarget.value, event.currentTarget.selectionStart));
              }}
              onKeyUp={(event) => {
                if (
                  event.key === "ArrowLeft" ||
                  event.key === "ArrowRight" ||
                  event.key === "Home" ||
                  event.key === "End"
                ) {
                  setMentionInput(mentionRange(event.currentTarget.value, event.currentTarget.selectionStart));
                }
              }}
              onKeyDown={(event) => {
                if (composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
                if (menuOpen && suggestions.length > 0 && event.key === "ArrowDown") {
                  event.preventDefault();
                  setActiveSuggestionIndex((index) => (index + 1) % suggestions.length);
                  return;
                }
                if (menuOpen && suggestions.length > 0 && event.key === "ArrowUp") {
                  event.preventDefault();
                  setActiveSuggestionIndex((index) => (index + suggestions.length - 1) % suggestions.length);
                  return;
                }
                if (menuOpen && event.key === "Escape") {
                  event.preventDefault();
                  setMentionInput(undefined);
                  return;
                }
                if (menuOpen && suggestions.length > 0 && (event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
                  // Accepting a suggestion never also sends the message.
                  event.preventDefault();
                  applySuggestion(suggestions[activeSuggestionIndex]!);
                  return;
                }
                if (menuOpen && event.key === "Enter" && !event.shiftKey) {
                  // The menu is open without a match: never send a
                  // half-addressed message.
                  event.preventDefault();
                  return;
                }
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
              onCompositionStart={() => {
                composingRef.current = true;
              }}
              onCompositionEnd={(event) => {
                composingRef.current = false;
                setMentionInput(
                  mentionRange(event.currentTarget.value, event.currentTarget.selectionStart ?? event.currentTarget.value.length),
                );
                setActiveSuggestionIndex(0);
              }}
            />
            {menuOpen ? (
              <ul
                id="chat-address-suggestions"
                ref={listRef}
                role="listbox"
                aria-label={messages.workContexts.addressSuggestions}
                className="mention-popover"
              >
                {suggestions.length === 0 ? (
                  <li className="mention-empty">{messages.chat.noMatchingMembers}</li>
                ) : (
                  suggestions.map((suggestion, index) => (
                    <li key={suggestion.id} data-index={index}>
                      <button
                        id={`address-suggestion-${suggestion.id}`}
                        type="button"
                        role="option"
                        aria-selected={index === activeSuggestionIndex}
                        className="mention-option"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => applySuggestion(suggestion)}
                      >
                        {suggestion.id === "all" ? (
                          <span className="avatar" aria-hidden="true">@</span>
                        ) : (
                          <EmployeeAvatar employeeId={suggestion.id} />
                        )}
                        <span className="mention-option-text">
                          <strong>{suggestion.name}</strong>
                          {suggestion.role.length > 0 ? (
                            <span className="mention-option-meta">{suggestion.role}</span>
                          ) : null}
                          {suggestion.address.length > 0 ? (
                            <span className="mention-option-meta">{suggestion.address}</span>
                          ) : null}
                        </span>
                      </button>
                    </li>
                  ))
                )}
              </ul>
            ) : null}
          </div>
          {room.kind === "channel" ? (
            <div className="composer-status">
              <p>{messages.chat.addressingScopeHint}</p>
              {addressingError !== undefined ? (
                <p className="composer-error" role="alert">
                  {addressingError}
                </p>
              ) : addressing.resolved !== undefined ? (
                <p aria-live="polite">
                  {previewNames.length > 0 ? messages.chat.addressedReplies(previewNames) : messages.chat.noOneAddressed}
                </p>
              ) : null}
              {addressing.resolved?.mentionAll && disabledMembers.length > 0 ? (
                <p>
                  {messages.workContexts.skippedDisabled(
                    disabledMembers.map((member) => member.name).join(locale === "zh-CN" ? "、" : ", "),
                  )}
                </p>
              ) : null}
            </div>
          ) : null}
          <div className="composer-toolbar">
            {room.kind === "channel" ? (
              <button
                ref={triggerRef}
                type="button"
                className="mention-trigger"
                aria-label={messages.chat.mentionTrigger}
                disabled={sending}
                onMouseDown={(event) => event.preventDefault()}
                onClick={openMentions}
              >
                @
              </button>
            ) : null}
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
