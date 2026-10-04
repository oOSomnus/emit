/**
 * The mailbox.
 *
 * A folder rail on the left, a compact message list, and — once something is
 * opened — the thread itself. The server decides what belongs to the mailbox
 * (`GET /api/mail`); this page only groups that list into threads, filters it
 * by folder and search, and drives the real flags. Compose is a panel pinned to
 * the bottom right, so switching folders never discards a half-written mail.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../api.ts";
import { errorDisplay } from "../../shared/i18n.ts";
import { useI18n } from "../i18n.tsx";
import { chineseMail, englishMail } from "../messages/mail.ts";
import { uiText } from "../messages.ts";
import { useApp } from "../state.tsx";
import { Chip, EmployeeAvatar, Icon, IconButton, WorkStatus, timeAgo } from "./ui.tsx";
import { WorkExecution } from "./WorkExecution.tsx";
import type { MailboxItemDTO, MessageDTO, WorkDTO } from "../../shared/contracts.ts";

/** The user is an address on the envelope but never a recipient who works. */
const USER_ID = "user";

type Folder = "inbox" | "sent" | "drafts" | "archived";

const FOLDERS: { id: Folder; icon: "inbox" | "send" | "draft" | "archive" }[] = [
  { id: "inbox", icon: "inbox" },
  { id: "sent", icon: "send" },
  { id: "drafts", icon: "draft" },
  { id: "archived", icon: "archive" },
];

function inFolder(item: MailboxItemDTO, folder: Folder): boolean {
  const mail = item.message.mail;
  if (mail === undefined) return false;
  const mine = item.message.author.id === USER_ID;
  if (folder === "drafts") return mail.draft;
  if (mail.draft) return false;
  if (folder === "archived") return mail.archived;
  if (mail.archived) return false;
  return folder === "sent" ? mine : !mine;
}

function splitAddresses(value: string): string[] {
  return value
    .split(/[,，;；\s]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function matches(item: MailboxItemDTO, term: string): boolean {
  if (term.length === 0) return true;
  const mail = item.message.mail;
  const parts = [
    item.message.author.name,
    item.message.author.address ?? "",
    item.message.body,
    mail?.subject ?? "",
    ...(mail?.to ?? []).flatMap((entry) => [entry.name, entry.address]),
    ...(mail?.cc ?? []).flatMap((entry) => [entry.name, entry.address]),
    item.roomName,
  ];
  return parts.join("\n").toLowerCase().includes(term);
}

function addressedToUser(message: MessageDTO, userAddress: string): boolean {
  const mail = message.mail;
  if (mail === undefined || userAddress.length === 0) return false;
  return [...mail.to, ...mail.cc].some((entry) => entry.address === userAddress);
}

function recipientNames(message: MessageDTO, separator: string): string {
  const mail = message.mail;
  if (mail === undefined) return "";
  return [...mail.to, ...mail.cc].map((entry) => entry.name || entry.address).join(separator);
}

/** One row of the list: a whole thread, or one draft. */
type Row = {
  key: string;
  roomId: string;
  entryId: string;
  subject: string;
  who: string;
  snippet: string;
  at: number;
  count: number;
  unread: boolean;
  draft: boolean;
  archived: boolean;
  read: boolean;
  /** Sent mail has no read state of its own. */
  whoIsUser: boolean;
};

type Compose = {
  /** The thread a draft is edited in; empty for a new mail. */
  roomId: string;
  /** The draft entry being edited, when editing. */
  draftId: string;
  /** The source mail and its fixed work context. */
  inReplyTo: string;
  workContextId: string;
  to: string[];
  cc: string[];
  extraTo: string;
  extraCc: string;
  subject: string;
  body: string;
  showCc: boolean;
};

function snapshot(compose: Compose): string {
  return JSON.stringify([
    compose.to,
    compose.cc,
    compose.extraTo,
    compose.extraCc,
    compose.subject,
    compose.body,
    compose.workContextId,
    compose.inReplyTo,
  ]);
}

export function MailView(): ReactNode {
  const { state, dispatch, setError } = useApp();
  const { messages, locale } = useI18n();
  const namesSeparator = (locale === "zh-CN" ? chineseMail : englishMail).namesSeparator;
  /** The room name a new mail with no subject gets; it is record data from then on. */
  const noSubjectRoomName = (locale === "zh-CN" ? chineseMail : englishMail).noSubject;
  const [folder, setFolder] = useState<Folder>("inbox");
  const [query, setQuery] = useState("");
  const [mailbox, setMailbox] = useState<MailboxItemDTO[]>([]);
  const [reading, setReading] = useState(false);
  const [executionWorkId, setExecutionWorkId] = useState<string | undefined>(undefined);
  /** A reply the user asked for while a dirty compose was still open. */
  const [pendingReply, setPendingReply] = useState<{ message: MessageDTO; all: boolean } | undefined>(undefined);
  const [compose, setCompose] = useState<Compose | undefined>(undefined);
  const [composeBase, setComposeBase] = useState("");
  const [askClose, setAskClose] = useState(false);
  const [busy, setBusy] = useState(false);
  const requestSeq = useRef(0);
  const autoRead = useRef<Set<string>>(new Set());

  const userAddress = state.app?.user.address ?? "";
  const term = query.trim().toLowerCase();

  const refreshMailbox = useCallback(async () => {
    try {
      setMailbox((await api.mailbox()).items);
    } catch (error) {
      setError(errorDisplay(error));
    }
  }, [setError]);

  useEffect(() => {
    void refreshMailbox();
  }, [refreshMailbox, state.mailRevision]);

  // The unread badge in the rail is server-owned, so it is refetched whenever
  // this page learns that something changed.

  const candidates = useMemo(
    () => [
      { id: USER_ID, name: messages.mail.selfName(state.app?.user.name), address: userAddress },
      ...state.employees.map((employee) => ({ id: employee.id, name: employee.name, address: employee.address })),
    ],
    [state.app?.user.name, userAddress, state.employees, messages],
  );

  /**
   * Threads and drafts for the current folder.
   *
   * Non-drafts are grouped by room and sorted by their newest matching message;
   * drafts stay one row per entry, because a thread can hold several
   * independent drafts and each must be reachable on its own.
   */
  const rows = useMemo<Row[]>(() => {
    const drafts: Row[] = [];
    const threads = new Map<string, MailboxItemDTO[]>();
    for (const item of mailbox) {
      const mail = item.message.mail;
      if (mail === undefined) continue;
      if (!inFolder(item, folder) || !matches(item, term)) continue;
      if (mail.draft) {
        drafts.push({
          key: `${item.roomId}|${item.message.id}`,
          roomId: item.roomId,
          entryId: item.message.id,
          subject: mail.subject.length > 0 ? mail.subject : messages.mail.noSubject,
          who: recipientNames(item.message, namesSeparator) || messages.mail.noRecipients,
          snippet: item.message.body,
          at: item.message.createdAt,
          count: 1,
          unread: false,
          draft: true,
          archived: mail.archived,
          read: true,
          whoIsUser: true,
        });
        continue;
      }
      const list = threads.get(item.roomId) ?? [];
      list.push(item);
      threads.set(item.roomId, list);
    }

    const grouped: Row[] = [];
    for (const [roomId, items] of threads) {
      items.sort((a, b) => a.message.createdAt - b.message.createdAt);
      const latest = items[items.length - 1]!;
      const mail = latest.message.mail!;
      const mine = latest.message.author.id === USER_ID;
      grouped.push({
        key: roomId,
        roomId,
        entryId: latest.message.id,
        subject: mail.subject.length > 0 ? mail.subject : messages.mail.noSubject,
        who: mine
          ? recipientNames(latest.message, namesSeparator) || messages.mail.noRecipients
          : latest.message.author.name,
        snippet: latest.message.body,
        at: latest.message.createdAt,
        count: items.length,
        unread: !mine && items.some((item) => item.message.mail?.read !== true),
        draft: false,
        archived: mail.archived,
        read: mail.read,
        whoIsUser: mine,
      });
    }
    return [...grouped, ...drafts].sort((a, b) => b.at - a.at);
  }, [mailbox, folder, term, userAddress, state.employees.length, namesSeparator, messages]);

  const inboxUnread = useMemo(
    () => mailbox.filter((item) => inFolder(item, "inbox") && item.message.mail?.read !== true).length,
    [mailbox],
  );

  const room = state.rooms.find((entry) => entry.id === state.activeRoomId);
  const thread = useMemo(() => state.messages.filter((message) => message.mail !== undefined), [state.messages]);
  const threadSubject =
    thread.find((message) => message.mail?.draft !== true)?.mail?.subject ?? thread[0]?.mail?.subject ?? room?.name ?? "";
  /** The message the reader's thread-level action acts on. */
  const newest = thread[thread.length - 1];
  /** Works this specific mail started (its To recipients) or carried (an answer). */
  const relatedWorks = useCallback(
    (message: MessageDTO): WorkDTO[] =>
      state.work.filter(
        (work) => work.roomId === state.activeRoomId && (work.sourceEntryId === message.id || work.id === message.workId),
      ),
    [state.activeRoomId, state.work],
  );

  const flag = useCallback(
    (roomId: string, entryId: string, change: { read?: boolean; archived?: boolean; active?: boolean }) => {
      void api
        .mailFlag(roomId, entryId, change)
        .then((payload) => {
          if (payload.room !== undefined) dispatch({ type: "room", room: payload.room });
          if (roomId === state.activeRoomId) dispatch({ type: "messages", messages: payload.messages });
          return refreshMailbox();
        })
        .catch((error: unknown) => setError(errorDisplay(error)));
    },
    [dispatch, refreshMailbox, setError, state.activeRoomId],
  );

  /**
   * Open one thread.
   *
   * A response from a thread the user already left is dropped, so a slow fetch
   * can never replace the thread that is on screen now.
   */
  const openThread = useCallback(
    (roomId: string) => {
      const seq = ++requestSeq.current;
      setReading(true);
      void (async () => {
        try {
          const payload = await api.messages(roomId);
          if (seq !== requestSeq.current) return;
          dispatch({ type: "room", room: payload.room });
          dispatch({ type: "activeRoom", roomId });
          dispatch({ type: "view", view: "mail" });
          dispatch({ type: "messages", messages: payload.messages });
        } catch (error) {
          setError(errorDisplay(error));
        }
      })();
    },
    [dispatch, setError],
  );

  // Opening a thread marks the mails the user received as read, once per thread
  // per session: manually marking one unread again is not fought by this effect.
  useEffect(() => {
    const roomId = state.activeRoomId;
    if (roomId === undefined || !reading) return;
    if (autoRead.current.has(roomId)) return;
    const unread = state.messages.filter(
      (message) =>
        message.mail !== undefined &&
        message.mail.draft !== true &&
        message.mail.read !== true &&
        message.author.id !== USER_ID &&
        addressedToUser(message, userAddress),
    );
    if (unread.length === 0) return;
    autoRead.current.add(roomId);
    void (async () => {
      try {
        for (const message of unread) {
          const payload = await api.mailFlag(roomId, message.id, { read: true });
          if (roomId === state.activeRoomId) dispatch({ type: "messages", messages: payload.messages });
          if (payload.room !== undefined) dispatch({ type: "room", room: payload.room });
        }
        await refreshMailbox();
      } catch (error) {
        setError(errorDisplay(error));
      }
    })();
  }, [state.activeRoomId, state.messages, reading, userAddress, dispatch, refreshMailbox, setError]);

  const update = (patch: Partial<Compose>) => {
    setCompose((current) => (current === undefined ? current : { ...current, ...patch }));
  };

  const startCompose = () => {
    if (state.activeWorkContextId === undefined) {
      setError(uiText((m) => m.mail.selectWorkFirst));
      return;
    }
    const firstEmployee = state.employees.find((employee) => employee.enabled);
    const next: Compose = {
      roomId: "",
      draftId: "",
      inReplyTo: "",
      workContextId: state.activeWorkContextId,
      to: firstEmployee !== undefined ? [firstEmployee.id] : [],
      cc: [],
      extraTo: "",
      extraCc: "",
      subject: "",
      body: "",
      showCc: false,
    };
    setCompose(next);
    setComposeBase(snapshot(next));
    setAskClose(false);
  };

  const editDraft = async (item: MailboxItemDTO): Promise<void> => {
    let draftRoom = state.rooms.find((entry) => entry.id === item.roomId);
    try {
      if (draftRoom === undefined) {
        draftRoom = (await api.messages(item.roomId)).room;
        dispatch({ type: "room", room: draftRoom });
      }
      const mail = item.message.mail;
      const typed = (entries: { address: string }[] | undefined) =>
        (entries ?? [])
          .map((entry) => entry.address)
          .filter((address) => !state.employees.some((employee) => employee.address === address))
          .join(", ");
      const next: Compose = {
        roomId: item.roomId,
        draftId: item.message.id,
        inReplyTo: mail?.inReplyTo ?? "",
        workContextId: draftRoom.workContextId,
        to: [...(mail?.recipients ?? [])],
        cc: [...(mail?.copies ?? [])],
        extraTo: typed(mail?.to),
        extraCc: typed(mail?.cc),
        subject: mail?.subject ?? "",
        body: item.message.body,
        showCc: (mail?.copies.length ?? 0) > 0 || (mail?.cc.length ?? 0) > 0,
      };
      setCompose(next);
      setComposeBase(snapshot(next));
      setAskClose(false);
    } catch (error) {
      setError(errorDisplay(error));
    }
  };

  /** Create a mail thread under its captured work context, then keep that binding. */
  const threadForCompose = async (draft: Compose): Promise<string> => {
    if (draft.roomId.length > 0) return draft.roomId;
    const name = draft.subject.trim();
    const created = await api.createRoom({
      kind: "mail",
      name: name.length > 0 ? name : noSubjectRoomName,
      workContextId: draft.workContextId,
      memberIds: [...new Set([...draft.to, ...draft.cc].filter(
        (id) => id !== USER_ID && state.employees.some((employee) => employee.id === id),
      ))],
    });
    dispatch({ type: "room", room: created });
    setCompose((current) =>
      current !== undefined && snapshot(current) === snapshot(draft) && current.roomId === draft.roomId
        ? { ...current, roomId: created.id }
        : current,
    );
    return created.id;
  };

  const saveDraft = async (): Promise<boolean> => {
    if (compose === undefined || busy) return false;
    if (compose.body.trim().length === 0) {
      setError(uiText((m) => m.mail.draftNeedsBody));
      return false;
    }
    setBusy(true);
    try {
      const roomId = await threadForCompose(compose);
      await api.sendMail(roomId, {
        body: compose.body.trim(),
        subject: compose.subject.trim(),
        to: [...compose.to, ...splitAddresses(compose.extraTo)],
        cc: [...compose.cc, ...splitAddresses(compose.extraCc)],
        draft: true,
        ...(compose.inReplyTo.length > 0 ? { inReplyTo: compose.inReplyTo } : {}),
      });
      // An edited draft is retired, never rewritten: entries are immutable, so
      // the saved draft is a new entry and the old one stops being active.
      if (compose.draftId.length > 0) await api.mailFlag(roomId, compose.draftId, { active: false });
      setCompose(undefined);
      setAskClose(false);
      setFolder("drafts");
      setReading(false);
      await refreshMailbox();
      dispatch({ type: "notice", text: uiText((m) => m.mail.draftSavedNotice) });
      return true;
    } catch (error) {
      setError(errorDisplay(error));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const sendComposed = async () => {
    if (compose === undefined || busy) return;
    if (compose.body.trim().length === 0) {
      setError(uiText((m) => m.mail.mailNeedsBody));
      return;
    }
    setBusy(true);
    try {
      const roomId = await threadForCompose(compose);
      await api.sendMail(roomId, {
        body: compose.body.trim(),
        subject: compose.subject.trim(),
        to: [...compose.to, ...splitAddresses(compose.extraTo)],
        cc: [...compose.cc, ...splitAddresses(compose.extraCc)],
        ...(compose.inReplyTo.length > 0 ? { inReplyTo: compose.inReplyTo } : {}),
      });
      if (compose.draftId.length > 0) await api.mailFlag(roomId, compose.draftId, { active: false });
      setCompose(undefined);
      setAskClose(false);
      // Sending is the end of composing: the reply lands in the inbox, so the
      // user is not dropped into a live wait.
      setReading(false);
      setFolder("sent");
      dispatch({ type: "notice", text: uiText((m) => m.mail.sentNotice) });
      await refreshMailbox();
    } catch (error) {
      setError(errorDisplay(error));
    } finally {
      setBusy(false);
    }
  };

  const closeCompose = () => {
    if (busy || compose === undefined) return;
    if (snapshot(compose) !== composeBase) {
      setAskClose(true);
      return;
    }
    setCompose(undefined);
  };

  const sendDraftNow = async (item: MailboxItemDTO) => {
    try {
      const result = await api.sendDraft(item.roomId, { entryId: item.message.id });
      if (result.workIds.length === 0) {
        dispatch({ type: "notice", text: uiText((m) => m.mail.sentNoWorkNotice) });
      }
      await refreshMailbox();
      setFolder("sent");
    } catch (error) {
      setError(errorDisplay(error));
    }
  };

  /**
   * Open the composer as a reply to one specific message.
   *
   * The reply never defaults to "the newest mail": parallel branches in one
   * thread would silently attach to the wrong parent, so the parent is always
   * the message the user clicked.
   */
  const startReply = (message: MessageDTO, all: boolean): void => {
    if (room?.kind !== "mail" || message.mail === undefined) return;
    const mine = message.author.id === USER_ID;
    // Answering my own sent mail answers its recipients; answering someone
    // else answers that sender.
    const to = mine ? [...message.mail.recipients] : message.author.id === USER_ID ? [] : [message.author.id];
    const mail = message.mail;
    const others = [...new Set([...mail.recipients, ...mail.copies])].filter(
      (id) => id !== USER_ID && !to.includes(id),
    );
    const employeeAddresses = new Set(state.employees.map((employee) => employee.address));
    const external = (entries: { address: string }[] | undefined): string =>
      (entries ?? [])
        .map((entry) => entry.address)
        .filter((address) => address.length > 0 && !employeeAddresses.has(address) && address !== userAddress)
        .join(", ");
    const next: Compose = {
      roomId: room.id,
      draftId: "",
      inReplyTo: message.id,
      workContextId: room.workContextId,
      to,
      cc: all ? others : [],
      extraTo: external(mine ? mail.to : undefined),
      extraCc: external(all ? mail.cc : undefined),
      subject: mail.subject.startsWith("Re: ") ? mail.subject : `Re: ${mail.subject.length > 0 ? mail.subject : room.name}`,
      body: "",
      showCc: all && others.length > 0,
    };
    if (compose !== undefined && snapshot(compose) !== composeBase) {
      // A dirty compose is never thrown away silently: the user decides.
      setPendingReply({ message, all });
      setAskClose(true);
      return;
    }
    setCompose(next);
    setComposeBase(snapshot(next));
    setAskClose(false);
  };

  /** Continue the reply the user asked for once the dirty compose is settled. */
  const openPendingReply = (): void => {
    const pending = pendingReply;
    setPendingReply(undefined);
    setCompose(undefined);
    setAskClose(false);
    if (pending === undefined) return;
    // Rebuild from the message, not from the discarded compose.
    setTimeout(() => startReply(pending.message, pending.all), 0);
  };

  const draftItem = (row: Row): MailboxItemDTO | undefined =>
    mailbox.find((item) => item.roomId === row.roomId && item.message.id === row.entryId);

  const workContextName = (workContextId: string | undefined): string =>
    workContextId === undefined || workContextId.length === 0
      ? ""
      : state.workContexts.find((workContext) => workContext.id === workContextId)?.name ?? workContextId;
  return (
    <div className="pane">
      <header className="pane-header">
        <div>
          <h2>{messages.mail.title}</h2>
          <p className="topic">
            {userAddress.length > 0 ? messages.mail.yourAddress(userAddress) : ""}
            {inboxUnread > 0 ? messages.mail.unreadCount(inboxUnread) : messages.mail.noUnread}
          </p>
        </div>
        <div className="pane-header-actions">
          <input
            className="search"
            type="search"
            value={query}
            placeholder={messages.mail.searchPlaceholder}
            aria-label={messages.mail.searchLabel}
            onChange={(event) => setQuery(event.target.value)}
          />
          <IconButton icon="refresh" label={messages.common.refresh} onClick={() => void refreshMailbox()} />
          <button type="button" className="primary" disabled={busy} onClick={() => (compose === undefined ? startCompose() : closeCompose())}>
            <Icon name="draft" />
            {messages.mail.compose}
          </button>
        </div>
      </header>

      <div className="mail-layout">
        <nav className="mail-folders">
          {FOLDERS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={`mail-folder${folder === entry.id ? " active" : ""}`}
              aria-current={folder === entry.id ? "true" : undefined}
              onClick={() => {
                setFolder(entry.id);
                setReading(false);
              }}
            >
              <Icon name={entry.icon} />
              <span className="label">{messages.mail.folders[entry.id]}</span>
              {entry.id === "inbox" && inboxUnread > 0 ? <span className="count">{inboxUnread}</span> : null}
            </button>
          ))}
        </nav>

        <div className={`mail-main${reading && room?.kind === "mail" ? " has-reader" : ""}`}>
          <section className="mail-list-panel">
            <div className="mail-toolbar">
              <select
                className="mail-folder-select"
                value={folder}
                aria-label={messages.mail.folderSelectLabel}
                onChange={(event) => {
                  setFolder(event.target.value as Folder);
                  setReading(false);
                }}
              >
                {FOLDERS.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {messages.mail.folders[entry.id]}
                  </option>
                ))}
              </select>
              <span className="hint">
                {messages.mail.toolbarSummary(folder, rows.length, term.length > 0 ? query.trim() : undefined)}
              </span>
              <span className="spacer" />
            </div>

            <div className="mail-list">
              {rows.length === 0 ? (
                <div className="empty">
                  <h2>{term.length > 0 ? messages.mail.noMatchTitle : messages.mail.emptyTitle}</h2>
                  <p>{term.length > 0 ? messages.mail.noMatchHint : messages.mail.emptyHint}</p>
                </div>
              ) : null}
              {rows.map((row) => {
                const selected = reading && state.activeRoomId === row.roomId && !row.draft;
                const rowRoom = state.rooms.find((entry) => entry.id === row.roomId);
                const rowWorkName = workContextName(rowRoom?.workContextId);
                const RowContent = row.draft ? "div" : "button";
                return (
                <div key={row.key} className={`mail-row${row.unread ? " unread" : ""}${selected ? " selected" : ""}`}>
                  <RowContent
                    className="mail-row-open"
                    type={row.draft ? undefined : "button"}
                    aria-current={selected ? "true" : undefined}
                    onClick={row.draft ? undefined : () => openThread(row.roomId)}
                  >
                    <span className="who">
                      <span className="dot" />
                      {row.draft ? <Chip tone="warn">{messages.mail.draftChip}</Chip> : null}
                      {row.who}
                      {row.count > 1 ? <span className="hint">{row.count}</span> : null}
                    </span>
                    <span className="summary">
                      <span className="subject">{row.subject}</span>
                      <span className="snippet">{row.snippet.replace(/\s+/g, " ").slice(0, 200)}</span>
                      {rowWorkName.length > 0 ? (
                        <span className="hint">{messages.workContexts.currentWorkLabel}: {rowWorkName}</span>
                      ) : null}
                    </span>
                  </RowContent>
                  <span className="right">
                    <span className="time">{timeAgo(row.at, locale)}</span>
                    <span className="actions">
                      {row.draft ? (
                        <>
                          <IconButton
                            icon="draft"
                            label={messages.mail.editDraftLabel}
                            onClick={() => {
                              const item = draftItem(row);
                              if (item !== undefined) editDraft(item);
                            }}
                          />
                          <IconButton
                            icon="send"
                            label={messages.mail.sendDraftLabel}
                            onClick={() => {
                              const item = draftItem(row);
                              if (item !== undefined) void sendDraftNow(item);
                            }}
                          />
                          <IconButton
                            icon="close"
                            label={messages.mail.discardDraftLabel}
                            onClick={() => flag(row.roomId, row.entryId, { active: false })}
                          />
                        </>
                      ) : (
                        <>
                          {row.whoIsUser ? null : (
                            <IconButton
                              icon="mail"
                              label={row.read ? messages.mail.markUnread : messages.mail.markRead}
                              onClick={() => flag(row.roomId, row.entryId, { read: !row.read })}
                            />
                          )}
                          <IconButton
                            icon="archive"
                            label={row.archived ? messages.mail.unarchive : messages.mail.archive}
                            onClick={() => flag(row.roomId, row.entryId, { archived: !row.archived })}
                          />
                        </>
                      )}
                    </span>
                  </span>
                </div>
                );
              })}
            </div>
          </section>

          {reading && room?.kind === "mail" ? (
            <section className="mail-reader">
              <div className="mail-reader-head">
                <IconButton icon="back" label={messages.mail.backToList} className="mail-back" onClick={() => setReading(false)} />
                <div style={{ gridColumn: 2, minWidth: 0 }}>
                  <h2>{threadSubject.length > 0 ? threadSubject : messages.mail.noSubject}</h2>
                  <p className="topic" style={{ margin: "4px 0 0" }}>
                    {messages.workContexts.currentWorkLabel}: {workContextName(room.workContextId)}
                  </p>
                </div>
                <select
                  className="mail-folder-select mail-reader-folder-select"
                  value={folder}
                  aria-label={messages.mail.folderSelectLabel}
                  onChange={(event) => {
                    setFolder(event.target.value as Folder);
                    setReading(false);
                  }}
                >
                  {FOLDERS.map((entry) => (
                    <option key={entry.id} value={entry.id}>{messages.mail.folders[entry.id]}</option>
                  ))}
                </select>
                <div className="mail-reader-actions">
                <IconButton
                  icon="archive"
                  label={newest?.mail?.archived === true ? messages.mail.unarchive : messages.mail.archive}
                  onClick={() => {
                    if (newest?.mail !== undefined) flag(room.id, newest.id, { archived: !newest.mail.archived });
                  }}
                />
                </div>
              </div>

              <div className="mail-thread">
                {thread.map((message) => {
                  const employee = message.author.type === "employee" ? state.employees.find((entry) => entry.id === message.author.id) : undefined;
                  return (
                  <article key={message.id} className={`mail-message identity author-${message.author.type}`}>
                    {message.author.type === "employee" ? (
                      <EmployeeAvatar employeeId={message.author.id} />
                    ) : (
                      <span className="avatar">{[...message.author.name.trim()][0] ?? "?"}</span>
                    )}
                    <div className="envelope">
                      <div className="line identity-meta">
                        <strong>{message.author.name}</strong>
                        {employee !== undefined ? <span>{employee.role}</span> : null}
                        {message.author.address !== undefined && message.author.address.length > 0 ? (
                          <span>{message.author.address}</span>
                        ) : null}
                        <span className="time">{timeAgo(message.createdAt, locale)}</span>
                      </div>
                      {message.mail !== undefined ? (
                        <div className="line">
                          <span>
                            {messages.mail.toLine(
                              message.mail.to.map((entry) => entry.name || entry.address).join(namesSeparator) ||
                                messages.mail.toNone,
                            )}
                          </span>
                          {message.mail.cc.length > 0 ? (
                            <span>
                              {messages.mail.ccLine(
                                message.mail.cc.map((entry) => entry.name || entry.address).join(namesSeparator),
                              )}
                            </span>
                          ) : null}
                          {message.mail.draft ? <Chip tone="warn">{messages.mail.draftChip}</Chip> : null}
                          {message.mail.archived ? <Chip tone="muted">{messages.mail.archivedChip}</Chip> : null}
                        </div>
                      ) : null}
                      <div className="content">{message.body}</div>
                      {message.mail !== undefined ? (
                        <div className="row">
                          {message.author.id === USER_ID ? null : (
                            <button
                              type="button"
                              className="link"
                              onClick={() => flag(room.id, message.id, { read: message.mail?.read !== true })}
                            >
                              {message.mail?.read ? messages.mail.markUnread : messages.mail.markRead}
                            </button>
                          )}
                          <button
                            type="button"
                            className="link"
                            onClick={() => flag(room.id, message.id, { archived: !message.mail!.archived })}
                          >
                            {message.mail.archived ? messages.mail.unarchive : messages.mail.archive}
                          </button>
                          {message.mail.draft ? (
                            <button
                              type="button"
                              className="link"
                              onClick={() => {
                                const item = mailbox.find(
                                  (entry) => entry.roomId === room.id && entry.message.id === message.id,
                                );
                                if (item !== undefined) editDraft(item);
                              }}
                            >
                              {messages.mail.continueEditing}
                            </button>
                          ) : (
                            <>
                              <button type="button" onClick={() => startReply(message, false)}>
                                <Icon name="reply" />
                                {messages.mail.reply}
                              </button>
                              <button type="button" onClick={() => startReply(message, true)}>
                                <Icon name="reply-all" />
                                {messages.mail.replyAll}
                              </button>
                            </>
                          )}
                        </div>
                      ) : null}
                      {/* Work this message started or carried: the mail itself
                          stays a mail, the execution is one click away. */}
                      {relatedWorks(message).length > 0 ? (
                        <div className="row mail-work">
                          {relatedWorks(message).map((work) => (
                            <span key={work.id} className="mail-work-item">
                              <WorkStatus status={work.status} />
                              <span className="hint">{work.employeeName}</span>
                              <button type="button" className="link" onClick={() => setExecutionWorkId(work.id)}>
                                {messages.mail.viewExecution}
                              </button>
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </article>
                  );
                })}
              </div>
            </section>
          ) : null}
        </div>
      </div>

      {compose !== undefined ? (
        <section className="mail-compose" aria-label={messages.mail.compose}>
          <div className="mail-compose-head">
            <span className="title">
              {compose.draftId.length > 0
                ? messages.mail.editDraftTitle
                : compose.inReplyTo.length > 0
                  ? messages.mail.replyTitle
                  : messages.mail.newTitle}
            </span>
            <IconButton icon="close" label={messages.common.close} disabled={busy} onClick={closeCompose} />
          </div>
          <div className="mail-compose-body">
            <p className="hint">
              {messages.workContexts.currentWorkLabel}: {workContextName(compose.workContextId)}
            </p>
            <div className="row recipients">
              <span className="hint">{messages.mail.toHint}</span>
              {candidates.map((candidate) => (
                <button
                  key={candidate.id}
                  type="button"
                  disabled={busy}
                  className={`chip-toggle${compose.to.includes(candidate.id) ? " on" : ""}`}
                  title={candidate.address}
                  onClick={() =>
                    update({
                      to: compose.to.includes(candidate.id)
                        ? compose.to.filter((id) => id !== candidate.id)
                        : [...compose.to, candidate.id],
                    })
                  }
                >
                  {candidate.name}
                </button>
              ))}
              <input
                placeholder={messages.mail.extraToPlaceholder}
                aria-label={messages.mail.extraToAria}
                disabled={busy}
                value={compose.extraTo}
                onChange={(event) => update({ extraTo: event.target.value })}
              />
            </div>
            <div className="row">
              {compose.showCc ? (
                <div className="row recipients">
                  <span className="hint">{messages.mail.ccHint}</span>
                  {candidates.map((candidate) => (
                    <button
                      key={candidate.id}
                      type="button"
                      disabled={busy}
                      className={`chip-toggle${compose.cc.includes(candidate.id) ? " on" : ""}`}
                      title={candidate.address}
                      onClick={() =>
                        update({
                          cc: compose.cc.includes(candidate.id)
                            ? compose.cc.filter((id) => id !== candidate.id)
                            : [...compose.cc, candidate.id],
                        })
                      }
                    >
                      {candidate.name}
                    </button>
                  ))}
                  <input
                    placeholder={messages.mail.extraCcPlaceholder}
                    aria-label={messages.mail.extraCcAria}
                    disabled={busy}
                    value={compose.extraCc}
                    onChange={(event) => update({ extraCc: event.target.value })}
                  />
                </div>
              ) : (
                <button type="button" className="link" disabled={busy} onClick={() => update({ showCc: true })}>
                  {messages.mail.addCc}
                </button>
              )}
            </div>
            <input
              placeholder={messages.mail.subjectPlaceholder}
              aria-label={messages.mail.subjectAria}
              disabled={busy}
              value={compose.subject}
              onChange={(event) => update({ subject: event.target.value })}
            />
            <textarea
              placeholder={messages.mail.bodyPlaceholder}
              aria-label={messages.mail.bodyAria}
              disabled={busy}
              value={compose.body}
              onChange={(event) => update({ body: event.target.value })}
            />
          </div>
          <div className="mail-compose-foot">
            {askClose ? (
              <>
                <span className="hint">
                  {pendingReply !== undefined ? messages.mail.unsavedReplyHint : messages.mail.unsavedHint}
                </span>
                <span className="spacer" />
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    void saveDraft().then((saved) => {
                      if (saved && pendingReply !== undefined) openPendingReply();
                    });
                  }}
                >
                  {messages.mail.saveDraftLabel}
                </button>
                <button
                  type="button"
                  className="danger"
                  disabled={busy}
                  onClick={() => {
                    if (pendingReply !== undefined) {
                      openPendingReply();
                      return;
                    }
                    setCompose(undefined);
                    setAskClose(false);
                  }}
                >
                  {messages.mail.discard}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setPendingReply(undefined);
                    setAskClose(false);
                  }}
                >
                  {messages.mail.continueEditing}
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="primary"
                  disabled={busy || compose.body.trim().length === 0}
                  onClick={() => void sendComposed()}
                >
                  <Icon name="send" />
                  {messages.mail.send}
                </button>
                <button type="button" disabled={busy || compose.body.trim().length === 0} onClick={() => void saveDraft()}>
                  {compose.draftId.length > 0 ? messages.mail.saveDraftLabel : messages.mail.saveAsDraft}
                </button>
                {compose.draftId.length > 0 ? <Chip tone="warn">{messages.mail.editingDraftChip}</Chip> : null}
                <span className="spacer" />
                <span className="hint">
                  {compose.to.length === 0
                    ? messages.mail.noRecipientHint
                    : messages.mail.recipientsWork(compose.to.length)}
                </span>
              </>
            )}
          </div>
        </section>
      ) : null}
      {executionWorkId !== undefined ? (
        <WorkExecution workId={executionWorkId} onClose={() => setExecutionWorkId(undefined)} />
      ) : null}
    </div>
  );
}
