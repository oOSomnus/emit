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
import { useApp } from "../state.tsx";
import { Chip, Icon, IconButton, timeAgo } from "./ui.tsx";
import type { MailboxItemDTO, MessageDTO } from "../../shared/contracts.ts";

/** The user is an address on the envelope but never a recipient who works. */
const USER_ID = "user";

type Folder = "inbox" | "sent" | "drafts" | "archived";

const FOLDERS: { id: Folder; label: string; icon: "inbox" | "send" | "draft" | "archive" }[] = [
  { id: "inbox", label: "收件箱", icon: "inbox" },
  { id: "sent", label: "已发送", icon: "send" },
  { id: "drafts", label: "草稿", icon: "draft" },
  { id: "archived", label: "归档", icon: "archive" },
];

const FOLDER_LABELS: Record<Folder, string> = {
  inbox: "收件箱",
  sent: "已发送",
  drafts: "草稿",
  archived: "归档",
};

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

function recipientNames(message: MessageDTO): string {
  const mail = message.mail;
  if (mail === undefined) return "";
  return [...mail.to, ...mail.cc].map((entry) => entry.name || entry.address).join("、");
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
  to: string[];
  cc: string[];
  extraTo: string;
  extraCc: string;
  subject: string;
  body: string;
  showCc: boolean;
};

function snapshot(compose: Compose): string {
  return JSON.stringify([compose.to, compose.cc, compose.extraTo, compose.extraCc, compose.subject, compose.body]);
}

export function MailView(): ReactNode {
  const { state, dispatch, setError } = useApp();
  const [folder, setFolder] = useState<Folder>("inbox");
  const [query, setQuery] = useState("");
  const [mailbox, setMailbox] = useState<MailboxItemDTO[]>([]);
  const [reading, setReading] = useState(false);
  const [reply, setReply] = useState("");
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
      setError(error instanceof Error ? error.message : String(error));
    }
  }, [setError]);

  useEffect(() => {
    void refreshMailbox();
  }, [refreshMailbox]);

  // The unread badge in the rail is server-owned, so it is refetched whenever
  // this page learns that something changed.

  const candidates = useMemo(
    () => [
      { id: USER_ID, name: `${state.app?.user.name ?? "你"}（我）`, address: userAddress },
      ...state.employees.map((employee) => ({ id: employee.id, name: employee.name, address: employee.address })),
    ],
    [state.app?.user.name, userAddress, state.employees],
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
          subject: mail.subject.length > 0 ? mail.subject : "（无主题）",
          who: recipientNames(item.message) || "（无收件人）",
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
        subject: mail.subject.length > 0 ? mail.subject : "（无主题）",
        who: mine ? recipientNames(latest.message) || "（无收件人）" : latest.message.author.name,
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
  }, [mailbox, folder, term, userAddress, state.employees.length]);

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
  const roomWork = state.work.filter(
    (work) => work.roomId === state.activeRoomId && work.status !== "succeeded" && work.status !== "failed" && work.status !== "stopped",
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
        .catch((error: unknown) => setError(error instanceof Error ? error.message : String(error)));
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
          dispatch({ type: "activeRoom", roomId });
          dispatch({ type: "view", view: "mail" });
          dispatch({ type: "messages", messages: payload.messages });
        } catch (error) {
          setError(error instanceof Error ? error.message : String(error));
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
        setError(error instanceof Error ? error.message : String(error));
      }
    })();
  }, [state.activeRoomId, state.messages, reading, userAddress, dispatch, refreshMailbox, setError]);

  const update = (patch: Partial<Compose>) => {
    setCompose((current) => (current === undefined ? current : { ...current, ...patch }));
  };

  const startCompose = () => {
    const next: Compose = {
      roomId: "",
      draftId: "",
      to: state.employees[0] !== undefined ? [state.employees[0].id] : [],
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

  const editDraft = (item: MailboxItemDTO) => {
    const mail = item.message.mail;
    const typed = (entries: { address: string }[] | undefined) =>
      (entries ?? [])
        .map((entry) => entry.address)
        .filter((address) => !state.employees.some((employee) => employee.address === address))
        .join(", ");
    const next: Compose = {
      roomId: item.roomId,
      draftId: item.message.id,
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
  };

  /** The thread a composed mail belongs to: the edited draft's, or a fresh one. */
  const threadForCompose = async (draft: Compose): Promise<string> => {
    if (draft.roomId.length > 0) return draft.roomId;
    const name = draft.subject.trim();
    const created = await api.createRoom({ kind: "mail", name: name.length > 0 ? name : "（无主题）" });
    dispatch({ type: "room", room: created });
    return created.id;
  };

  const saveDraft = async (): Promise<boolean> => {
    if (compose === undefined || busy) return false;
    if (compose.body.trim().length === 0) {
      setError("草稿需要正文");
      return false;
    }
    setBusy(true);
    try {
      const roomId = await threadForCompose(compose);
      await api.sendMessage(roomId, {
        body: compose.body.trim(),
        subject: compose.subject.trim(),
        to: [...compose.to, ...splitAddresses(compose.extraTo)],
        cc: [...compose.cc, ...splitAddresses(compose.extraCc)],
        draft: true,
      });
      // An edited draft is retired, never rewritten: entries are immutable, so
      // the saved draft is a new entry and the old one stops being active.
      if (compose.draftId.length > 0) await api.mailFlag(roomId, compose.draftId, { active: false });
      setCompose(undefined);
      setAskClose(false);
      setFolder("drafts");
      setReading(false);
      await refreshMailbox();
      dispatch({ type: "notice", text: "草稿已保存" });
      return true;
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const sendComposed = async () => {
    if (compose === undefined || busy) return;
    if (compose.body.trim().length === 0) {
      setError("邮件需要正文");
      return;
    }
    setBusy(true);
    try {
      const roomId = await threadForCompose(compose);
      const result = await api.sendMessage(roomId, {
        body: compose.body.trim(),
        subject: compose.subject.trim(),
        to: [...compose.to, ...splitAddresses(compose.extraTo)],
        cc: [...compose.cc, ...splitAddresses(compose.extraCc)],
      });
      if (result.error !== undefined) setError(result.error);
      if (compose.draftId.length > 0) await api.mailFlag(roomId, compose.draftId, { active: false });
      setCompose(undefined);
      setAskClose(false);
      openThread(roomId);
      await refreshMailbox();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const closeCompose = () => {
    if (compose === undefined) return;
    if (snapshot(compose) !== composeBase) {
      setAskClose(true);
      return;
    }
    setCompose(undefined);
  };

  const sendDraftNow = async (item: MailboxItemDTO) => {
    try {
      const result = await api.sendDraft(item.roomId, item.message.id);
      if (result.workIds.length === 0) {
        dispatch({ type: "notice", text: "邮件已发送，没有收件人需要执行" });
      }
      await refreshMailbox();
      setFolder("sent");
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };

  const replyTo = async (all: boolean) => {
    if (room === undefined || reply.trim().length === 0) return;
    const last = [...thread].reverse().find((message) => message.mail !== undefined && message.mail.draft !== true);
    const target = last?.author.id ?? USER_ID;
    const copies =
      all && last?.mail !== undefined
        ? [...new Set([...last.mail.recipients, ...last.mail.copies])].filter((id) => id !== target && id !== USER_ID)
        : [];
    try {
      const result = await api.sendMessage(room.id, { body: reply.trim(), subject: threadSubject, to: [target], cc: copies });
      if (result.error !== undefined) setError(result.error);
      setReply("");
      await refreshMailbox();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };

  const draftItem = (row: Row): MailboxItemDTO | undefined =>
    mailbox.find((item) => item.roomId === row.roomId && item.message.id === row.entryId);

  return (
    <div className="pane">
      <header className="pane-header">
        <div>
          <h2>邮箱</h2>
          <p className="topic">
            {userAddress.length > 0 ? `你的地址：${userAddress} · ` : ""}
            {inboxUnread > 0 ? `${inboxUnread} 封未读` : "没有未读邮件"}
          </p>
        </div>
        <div className="pane-header-actions">
          <input
            className="search"
            type="search"
            value={query}
            placeholder="搜索邮件…"
            aria-label="搜索邮件"
            onChange={(event) => setQuery(event.target.value)}
          />
          <IconButton icon="refresh" label="刷新" onClick={() => void refreshMailbox()} />
          <button type="button" className="primary" onClick={() => (compose === undefined ? startCompose() : closeCompose())}>
            <Icon name="draft" />
            写邮件
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
              <span className="label">{entry.label}</span>
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
                aria-label="文件夹"
                onChange={(event) => {
                  setFolder(event.target.value as Folder);
                  setReading(false);
                }}
              >
                {FOLDERS.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label}
                  </option>
                ))}
              </select>
              <span className="hint">
                {FOLDER_LABELS[folder]} · {rows.length} 封
                {term.length > 0 ? ` · 搜索“${query.trim()}”` : ""}
              </span>
              <span className="spacer" />
            </div>

            <div className="mail-list">
              {rows.length === 0 ? (
                <div className="empty">
                  <h2>{term.length > 0 ? "没有匹配的邮件" : "这个文件夹是空的"}</h2>
                  <p>{term.length > 0 ? "换一个关键词，或清空搜索。" : "写一封邮件，或换一个文件夹看看。"}</p>
                </div>
              ) : null}
              {rows.map((row) => (
                <div
                  key={row.key}
                  className={`mail-row${row.unread ? " unread" : ""}`}
                  onClick={() => {
                    if (!row.draft) openThread(row.roomId);
                  }}
                >
                  <span className="who">
                    <span className="dot" />
                    {row.draft ? <Chip tone="warn">草稿</Chip> : null}
                    {row.who}
                    {row.count > 1 ? <span className="hint">{row.count}</span> : null}
                  </span>
                  <span className="summary">
                    <span className="subject">{row.subject}</span>
                    <span className="snippet">{row.snippet.replace(/\s+/g, " ").slice(0, 200)}</span>
                  </span>
                  <span className="right">
                    <span className="time">{timeAgo(row.at)}</span>
                    <span className="actions">
                      {row.draft ? (
                        <>
                          <IconButton
                            icon="draft"
                            label="编辑草稿"
                            onClick={() => {
                              const item = draftItem(row);
                              if (item !== undefined) editDraft(item);
                            }}
                          />
                          <IconButton
                            icon="send"
                            label="发送草稿"
                            onClick={() => {
                              const item = draftItem(row);
                              if (item !== undefined) void sendDraftNow(item);
                            }}
                          />
                          <IconButton
                            icon="close"
                            label="丢弃草稿"
                            onClick={() => flag(row.roomId, row.entryId, { active: false })}
                          />
                        </>
                      ) : (
                        <>
                          {row.whoIsUser ? null : (
                            <IconButton
                              icon="mail"
                              label={row.read ? "标为未读" : "标为已读"}
                              onClick={() => flag(row.roomId, row.entryId, { read: !row.read })}
                            />
                          )}
                          <IconButton
                            icon="archive"
                            label={row.archived ? "移出归档" : "归档"}
                            onClick={() => flag(row.roomId, row.entryId, { archived: !row.archived })}
                          />
                        </>
                      )}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          </section>

          {reading && room?.kind === "mail" ? (
            <section className="mail-reader">
              <div className="mail-reader-head">
                <IconButton icon="back" label="返回列表" className="mail-back" onClick={() => setReading(false)} />
                <h2>{threadSubject.length > 0 ? threadSubject : "（无主题）"}</h2>
                <IconButton
                  icon="archive"
                  label={newest?.mail?.archived === true ? "移出归档" : "归档"}
                  onClick={() => {
                    if (newest?.mail !== undefined) flag(room.id, newest.id, { archived: !newest.mail.archived });
                  }}
                />
              </div>

              <div className="mail-thread">
                {thread.map((message) => (
                  <article key={message.id} className={`mail-message author-${message.author.type}`}>
                    <span className="avatar">{[...message.author.name.trim()][0] ?? "?"}</span>
                    <div className="envelope">
                      <div className="line">
                        <strong>{message.author.name}</strong>
                        {message.author.address !== undefined && message.author.address.length > 0 ? (
                          <span>{message.author.address}</span>
                        ) : null}
                        <span className="time">{timeAgo(message.createdAt)}</span>
                      </div>
                      {message.mail !== undefined ? (
                        <div className="line">
                          <span>收件人：{message.mail.to.map((entry) => entry.name || entry.address).join("、") || "（无）"}</span>
                          {message.mail.cc.length > 0 ? (
                            <span>抄送：{message.mail.cc.map((entry) => entry.name || entry.address).join("、")}</span>
                          ) : null}
                          {message.mail.draft ? <Chip tone="warn">草稿</Chip> : null}
                          {message.mail.archived ? <Chip tone="muted">已归档</Chip> : null}
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
                              {message.mail?.read ? "标为未读" : "标为已读"}
                            </button>
                          )}
                          <button
                            type="button"
                            className="link"
                            onClick={() => flag(room.id, message.id, { archived: !message.mail!.archived })}
                          >
                            {message.mail.archived ? "移出归档" : "归档"}
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
                              继续编辑
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  </article>
                ))}

                {roomWork.map((work) => (
                  <article key={work.id} className="work-live">
                    <div className="meta">
                      <Chip tone="info">{work.employeeName} 正在处理这封邮件</Chip>
                      {work.status === "waiting-approval" ? <Chip tone="warn">等待审批</Chip> : null}
                      <span className="time" />
                      <IconButton icon="stop" label="停止" onClick={() => void api.stopWork(work.id)} />
                    </div>
                    {work.progressText !== undefined && work.progressText.length > 0 ? (
                      <pre className="stream">{work.progressText}</pre>
                    ) : null}
                  </article>
                ))}
              </div>

              <footer className="composer">
                <textarea
                  value={reply}
                  placeholder="回复…"
                  aria-label="回复内容"
                  onChange={(event) => setReply(event.target.value)}
                />
                <button type="button" className="primary" disabled={reply.trim().length === 0} onClick={() => void replyTo(false)}>
                  <Icon name="reply" />
                  回复
                </button>
                <button type="button" disabled={reply.trim().length === 0} onClick={() => void replyTo(true)}>
                  <Icon name="reply-all" />
                  回复全部
                </button>
              </footer>
            </section>
          ) : null}
        </div>
      </div>

      {compose !== undefined ? (
        <section className="mail-compose" aria-label="写邮件">
          <div className="mail-compose-head">
            <span className="title">{compose.draftId.length > 0 ? "编辑草稿" : "新邮件"}</span>
            <IconButton icon="close" label="关闭" onClick={closeCompose} />
          </div>
          <div className="mail-compose-body">
            <div className="row recipients">
              <span className="hint">收件人</span>
              {candidates.map((candidate) => (
                <button
                  key={candidate.id}
                  type="button"
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
                placeholder="其他地址（逗号分隔，仅记录）"
                aria-label="其他收件人地址"
                value={compose.extraTo}
                onChange={(event) => update({ extraTo: event.target.value })}
              />
            </div>
            <div className="row">
              {compose.showCc ? (
                <div className="row recipients">
                  <span className="hint">抄送</span>
                  {candidates.map((candidate) => (
                    <button
                      key={candidate.id}
                      type="button"
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
                    placeholder="其他抄送地址"
                    aria-label="其他抄送地址"
                    value={compose.extraCc}
                    onChange={(event) => update({ extraCc: event.target.value })}
                  />
                </div>
              ) : (
                <button type="button" className="link" onClick={() => update({ showCc: true })}>
                  添加抄送
                </button>
              )}
            </div>
            <input
              placeholder="主题"
              aria-label="主题"
              value={compose.subject}
              onChange={(event) => update({ subject: event.target.value })}
            />
            <textarea
              placeholder="正文…"
              aria-label="正文"
              value={compose.body}
              onChange={(event) => update({ body: event.target.value })}
            />
          </div>
          <div className="mail-compose-foot">
            {askClose ? (
              <>
                <span className="hint">还有未保存的内容</span>
                <span className="spacer" />
                <button type="button" disabled={busy} onClick={() => void saveDraft()}>
                  保存草稿
                </button>
                <button
                  type="button"
                  className="danger"
                  onClick={() => {
                    setCompose(undefined);
                    setAskClose(false);
                  }}
                >
                  丢弃
                </button>
                <button type="button" onClick={() => setAskClose(false)}>
                  继续编辑
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
                  发送
                </button>
                <button type="button" disabled={busy || compose.body.trim().length === 0} onClick={() => void saveDraft()}>
                  {compose.draftId.length > 0 ? "保存草稿" : "存为草稿"}
                </button>
                {compose.draftId.length > 0 ? <Chip tone="warn">正在编辑草稿</Chip> : null}
                <span className="spacer" />
                <span className="hint">
                  {compose.to.length === 0
                    ? "没有员工收件人时只投递，不会启动工作"
                    : `${compose.to.length} 位收件人会开始处理，抄送不会`}
                </span>
              </>
            )}
          </div>
        </section>
      ) : null}
    </div>
  );
}
