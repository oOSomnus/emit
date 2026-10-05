/**
 * The chat composer: the channel or direct-message editor.
 *
 * The message text is content. In a channel, who gets woken comes only from
 * the explicit selection — the reply control and the @ suggestions record
 * employees, and the recipient chips above the toolbar show and remove that
 * selection. Accepting a suggestion never sends the message, and plain text
 * never selects anyone.
 *
 * The suggestion list is a top-layer popover: the pane clips its overflow, so
 * it is positioned against the visible viewport.
 */

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { RoomDTO } from "../../shared/contracts.ts";
import { errorDisplay } from "../../shared/i18n.ts";
import { MessageAddressingError, resolveMessageAddressing } from "../../shared/message-addressing.ts";
import { api } from "../api.ts";
import { useI18n } from "../i18n.tsx";
import { useApp } from "../state.tsx";
import { EmployeeAvatar, Icon } from "./ui.tsx";

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

/**
 * Position a top-layer popover against its anchor inside the visible
 * viewport: above the anchor when it fits, otherwise below, clamped to the
 * visual viewport so the on-screen keyboard cannot hide it.
 */
function placeComposerPopover(popover: HTMLElement, anchor: HTMLElement): void {
  const viewport = window.visualViewport;
  const viewLeft = viewport?.offsetLeft ?? 0;
  const viewTop = viewport?.offsetTop ?? 0;
  const viewWidth = viewport?.width ?? window.innerWidth;
  const viewHeight = viewport?.height ?? window.innerHeight;
  const rect = anchor.getBoundingClientRect();
  const margin = 12;
  const gap = 8;
  const width = Math.max(0, Math.min(360, rect.width, viewWidth - margin * 2));
  const left = Math.min(Math.max(rect.left, viewLeft + margin), viewLeft + viewWidth - margin - width);
  const spaceAbove = rect.top - gap - (viewTop + margin);
  const spaceBelow = viewTop + viewHeight - margin - gap - rect.bottom;
  const below = spaceAbove < 280 && spaceBelow > spaceAbove;
  const space = Math.max(0, below ? spaceBelow : spaceAbove);
  const maxHeight = Math.min(Math.max(96, Math.min(280, space)), Math.max(0, viewHeight - margin * 2));
  popover.style.position = "fixed";
  popover.style.inset = "auto";
  popover.style.margin = "0";
  popover.style.left = `${left}px`;
  popover.style.width = `${width}px`;
  popover.style.maxHeight = `${maxHeight}px`;
  const height = popover.getBoundingClientRect().height;
  const top = below
    ? Math.min(rect.bottom + gap, viewTop + viewHeight - margin - height)
    : Math.max(viewTop + margin, rect.top - gap - height);
  popover.style.top = `${Math.max(viewTop + margin, top)}px`;
  popover.style.bottom = "auto";
}

export type ChatComposerProps = {
  /** The room being edited; only the fields composing itself reads. */
  room: Pick<RoomDTO, "id" | "kind" | "memberIds">;
};

export function ChatComposer({ room }: ChatComposerProps): ReactNode {
  const { state, setError } = useApp();
  const { messages } = useI18n();
  const [draft, setDraft] = useState("");
  const [recipientIds, setRecipientIds] = useState<string[]>([]);
  const [mentionAll, setMentionAll] = useState(false);
  const [mentionInput, setMentionInput] = useState<MentionRange | undefined>(undefined);
  const [manualPickerOpen, setManualPickerOpen] = useState(false);
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(0);
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputAreaRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const composingRef = useRef(false);
  const liveRegionId = useId();

  const channelMembers = useMemo(
    () =>
      room.kind === "channel"
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
    if (room.kind !== "channel") return { resolved: undefined, error: undefined };
    try {
      return {
        resolved: resolveMessageAddressing(recipientIds, mentionAll, channelMembers),
        error: undefined,
      };
    } catch (error) {
      return {
        resolved: undefined,
        error: error instanceof MessageAddressingError ? error : undefined,
      };
    }
  }, [room.kind, recipientIds, mentionAll, channelMembers]);

  const menuOpen = room.kind === "channel" && (manualPickerOpen || mentionInput !== undefined);

  const suggestions = useMemo<AddressSuggestion[]>(() => {
    if (room.kind !== "channel" || (!manualPickerOpen && mentionInput === undefined)) return [];
    const query = (manualPickerOpen ? "" : mentionInput!.query).toLowerCase();
    const enabledAddressable = channelMembers.filter((member) => member.enabled && member.address.length > 0);
    const matching = enabledAddressable.filter(
      (member) =>
        query.length === 0 || member.name.toLowerCase().includes(query) || member.address.toLowerCase().includes(query),
    );
    const options: AddressSuggestion[] = matching.map((member) => {
      // Display text only: the bare name when it is non-empty, unique among the
      // channel's members, and not the reserved broadcast word; the unique
      // address otherwise. Accepting the suggestion always selects this
      // employee's id, never text.
      const nameKey = member.name.toLowerCase();
      const nameCount = channelMembers.filter((candidate) => candidate.name.toLowerCase() === nameKey).length;
      const uniqueName =
        member.name.length > 0 && nameCount === 1 && nameKey !== "all" && nameKey !== "全体";
      return {
        id: member.id,
        name: member.name,
        role: state.employees.find((employee) => employee.id === member.id)?.role ?? "",
        address: member.address,
        insertion: `@${uniqueName ? member.name : member.address} `,
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
  }, [manualPickerOpen, mentionInput, room.kind, channelMembers, state.employees, messages.chat.mentionEveryone]);

  const addressingError =
    addressing.error === undefined
      ? undefined
      : addressing.error.code === "not-member"
        ? messages.workContexts.mentionNotMember(
            state.employees.find((employee) => employee.id === addressing.error?.employeeId)?.name ??
              addressing.error.token ??
              addressing.error.employeeId,
          )
        : addressing.error.code === "disabled"
          ? messages.workContexts.mentionDisabled(addressing.error.token)
          : messages.workContexts.mentionEmptyAll;

  useEffect(() => {
    setActiveSuggestionIndex((index) => Math.max(0, Math.min(index, suggestions.length - 1)));
  }, [suggestions.length]);

  useEffect(() => {
    if (!menuOpen) return;
    const item = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeSuggestionIndex}"]`);
    item?.scrollIntoView({ block: "nearest" });
  }, [menuOpen, activeSuggestionIndex, suggestions.length]);

  // The textarea follows its content: auto height first, CSS clamps it.
  const resizeInput = useCallback((): void => {
    const input = textareaRef.current;
    if (input === null) return;
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
  }, []);

  useLayoutEffect(() => {
    resizeInput();
  }, [draft, resizeInput]);

  // Re-measure only when the composer's width changes; typing never rebuilds
  // the observer.
  useEffect(() => {
    const box = boxRef.current;
    if (box === null) return;
    let width = box.getBoundingClientRect().width;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width ?? box.getBoundingClientRect().width;
      if (Math.abs(next - width) < 0.5) return;
      width = next;
      resizeInput();
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, [resizeInput]);

  // The suggestion list lives in the top layer so the pane cannot clip it.
  useLayoutEffect(() => {
    if (!menuOpen) return;
    const popover = listRef.current;
    const anchor = textareaRef.current;
    if (popover === null || anchor === null) return;
    if (!popover.matches(":popover-open")) popover.showPopover();
    const place = (): void => placeComposerPopover(popover, anchor);
    place();
    window.addEventListener("resize", place);
    window.visualViewport?.addEventListener("resize", place);
    window.visualViewport?.addEventListener("scroll", place);
    const observer = new ResizeObserver(place);
    observer.observe(anchor);
    return () => {
      window.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("scroll", place);
      observer.disconnect();
    };
  }, [menuOpen]);

  // A pointer outside the input area dismisses the suggestion list; the reply
  // trigger is exempt because it toggles its own state in the same gesture.
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (inputAreaRef.current?.contains(target) === true) return;
      if (triggerRef.current?.contains(target) === true) return;
      setMentionInput(undefined);
      setManualPickerOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [menuOpen]);

  const previewNames =
    addressing.resolved === undefined
      ? ""
      : addressing.resolved.recipientIds
          .map((id) => state.employees.find((employee) => employee.id === id)?.name ?? id)
          .join(messages.common.namesSeparator);
  const disabledMembers = channelMembers.filter((member) => !member.enabled);

  const closeMenu = (): void => {
    setMentionInput(undefined);
    setManualPickerOpen(false);
  };

  const send = async () => {
    const body = draft.trim();
    if (body.length === 0 || sending || (room.kind === "channel" && addressingError !== undefined)) return;
    setSending(true);
    try {
      const input = room.kind === "channel" ? { body, recipientIds, mentionAll } : { body };
      await api.sendRoomMessage(room.id, input);
      setDraft("");
      setRecipientIds([]);
      setMentionAll(false);
      closeMenu();
      setActiveSuggestionIndex(0);
    } catch (error) {
      setError(errorDisplay(error));
    } finally {
      setSending(false);
    }
  };

  const applySuggestion = (suggestion: AddressSuggestion): void => {
    if (manualPickerOpen) {
      // Manual picking never touches the text or the caret.
      if (suggestion.mentionAll) {
        setMentionAll(true);
        setRecipientIds([]);
      } else {
        setMentionAll(false);
        setRecipientIds((ids) => (ids.includes(suggestion.id) ? ids : [...ids, suggestion.id]));
      }
      closeMenu();
      setActiveSuggestionIndex(0);
      requestAnimationFrame(() => textareaRef.current?.focus());
      return;
    }
    const input = textareaRef.current;
    if (input === null || mentionInput === undefined) return;
    const caret = input.selectionStart ?? input.value.length;
    const current = mentionRange(input.value, caret);
    if (current === undefined || current.start !== mentionInput.start || current.end !== mentionInput.end) {
      // The caret moved since the range was captured; never replace text the
      // user is no longer editing.
      closeMenu();
      return;
    }
    const next = `${input.value.slice(0, mentionInput.start)}${suggestion.insertion}${input.value.slice(mentionInput.end)}`;
    const nextCaret = mentionInput.start + suggestion.insertion.length;
    if (suggestion.mentionAll) {
      setMentionAll(true);
      setRecipientIds([]);
    } else {
      setMentionAll(false);
      setRecipientIds((ids) => (ids.includes(suggestion.id) ? ids : [...ids, suggestion.id]));
    }
    setDraft(next);
    closeMenu();
    setActiveSuggestionIndex(0);
    requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(nextCaret, nextCaret);
    });
  };

  const onDraftChange = (value: string, caret: number): void => {
    setManualPickerOpen(false);
    setDraft(value);
    setMentionInput(mentionRange(value, caret));
    setActiveSuggestionIndex(0);
  };

  const openMentions = (): void => {
    const input = textareaRef.current;
    if (input === null) return;
    setMentionInput(undefined);
    setManualPickerOpen(true);
    setActiveSuggestionIndex(0);
    input.focus();
  };

  return (
    <footer className="composer">
      <div className="composer-box" ref={boxRef}>
        <div
          className="composer-input"
          ref={inputAreaRef}
          onBlur={(event) => {
            if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
            closeMenu();
          }}
        >
          <textarea
            ref={textareaRef}
            rows={2}
            value={draft}
            disabled={sending}
            placeholder={room.kind === "channel" ? messages.chat.channelPlaceholder : messages.chat.directPlaceholder}
            aria-label={messages.chat.messageLabel}
            aria-describedby={room.kind === "channel" ? liveRegionId : undefined}
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
              setManualPickerOpen(false);
              setMentionInput(mentionRange(event.currentTarget.value, event.currentTarget.selectionStart));
            }}
            onKeyUp={(event) => {
              if (
                event.key === "ArrowLeft" ||
                event.key === "ArrowRight" ||
                event.key === "Home" ||
                event.key === "End"
              ) {
                setManualPickerOpen(false);
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
                event.stopPropagation();
                closeMenu();
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
              popover="manual"
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

        {room.kind === "channel" && (recipientIds.length > 0 || mentionAll) ? (
          <div className="composer-recipients">
            {mentionAll ? (
              <button
                type="button"
                className="chip-toggle on"
                disabled={sending}
                title={messages.chat.mentionEveryone}
                aria-label={messages.chat.removeRecipient(messages.chat.mentionEveryone)}
                onClick={() => setMentionAll(false)}
              >
                {messages.chat.mentionEveryone}
                <Icon name="close" size={14} />
              </button>
            ) : null}
            {recipientIds.map((id) => {
              const employee = state.employees.find((entry) => entry.id === id);
              const name = employee?.name ?? id;
              return (
                <button
                  key={id}
                  type="button"
                  className="chip-toggle on"
                  disabled={sending}
                  title={employee?.address ?? id}
                  aria-label={messages.chat.removeRecipient(name)}
                  onClick={() => setRecipientIds((ids) => ids.filter((entry) => entry !== id))}
                >
                  {name}
                  <Icon name="close" size={14} />
                </button>
              );
            })}
          </div>
        ) : null}

        {room.kind === "channel" && addressingError !== undefined ? (
          <p className="composer-error" role="alert">
            {addressingError}
          </p>
        ) : null}

        {room.kind === "channel" && addressing.resolved?.mentionAll && disabledMembers.length > 0 ? (
          <p className="composer-notice">
            {messages.workContexts.skippedDisabled(
              disabledMembers.map((member) => member.name).join(messages.common.namesSeparator),
            )}
          </p>
        ) : null}

        {room.kind === "channel" ? (
          <span className="visually-hidden" id={liveRegionId} aria-live="polite">
            {addressing.resolved === undefined
              ? ""
              : previewNames.length > 0
                ? messages.chat.addressedReplies(previewNames)
                : messages.chat.noOneAddressed}
          </span>
        ) : null}

        <div className="composer-toolbar">
          {room.kind === "channel" ? (
            <button
              ref={triggerRef}
              type="button"
              className="mention-trigger"
              aria-label={messages.chat.mentionTrigger}
              aria-haspopup="listbox"
              aria-expanded={menuOpen}
              aria-controls={menuOpen ? "chat-address-suggestions" : undefined}
              disabled={sending}
              onMouseDown={(event) => event.preventDefault()}
              onClick={openMentions}
            >
              <Icon name="reply" size={16} />
              <span className="toolbar-label">{messages.chat.replyPicker}</span>
            </button>
          ) : null}
          <button
            type="button"
            className="primary"
            disabled={sending || draft.trim().length === 0 || (room.kind === "channel" && addressingError !== undefined)}
            onClick={() => void send()}
          >
            <Icon name="send" />
            {room.kind === "channel" && recipientIds.length === 0 && !mentionAll
              ? messages.chat.post
              : messages.chat.send}
          </button>
        </div>
      </div>
    </footer>
  );
}
