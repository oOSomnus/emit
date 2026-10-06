import { useEffect, useRef, useState, type ReactNode } from "react";
import type { RoomDTO } from "../../shared/contracts.ts";
import { errorDisplay, type DisplayText } from "../../shared/i18n.ts";
import { ApiError, api } from "../api.ts";
import { useI18n } from "../i18n.tsx";
import { useApp } from "../state.tsx";
import { EmployeeAvatar, IconButton, useDialogFocusTrap } from "./ui.tsx";

export function ChannelMembers({ room, onClose }: { room: RoomDTO; onClose: () => void }): ReactNode {
  const { state, dispatch } = useApp();
  const { messages, text } = useI18n();
  const [baseMemberIds, setBaseMemberIds] = useState(() => [...room.memberIds]);
  const [draftMemberIds, setDraftMemberIds] = useState(() => [...room.memberIds]);
  const [expectedVersion, setExpectedVersion] = useState(room.membershipVersion);
  const [latestRoom, setLatestRoom] = useState<RoomDTO | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DisplayText | undefined>(undefined);
  const [conflict, setConflict] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  const handleDialogKeyDown = useDialogFocusTrap(dialogRef, busy, onClose, false);
  const dirty =
    draftMemberIds.length !== baseMemberIds.length || baseMemberIds.some((id) => !draftMemberIds.includes(id));
  const available = state.employees.filter(
    (employee) => employee.enabled && !draftMemberIds.includes(employee.id),
  );
  const draftMembers = draftMemberIds.map((id) => state.employees.find((employee) => employee.id === id));
  const latestVersion = Math.max(room.membershipVersion, latestRoom?.membershipVersion ?? 0);
  const hasConflict = conflict || latestVersion !== expectedVersion;

  useEffect(() => {
    const previousFocus = document.activeElement;
    dialogRef.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
    return () => {
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);

  const toggleMember = (employeeId: string): void => {
    setDraftMemberIds((current) =>
      current.includes(employeeId) ? current.filter((id) => id !== employeeId) : [...current, employeeId],
    );
  };

  const save = async (): Promise<void> => {
    if (busy || !dirty) return;
    setBusy(true);
    setError(undefined);
    try {
      const updated = await api.patchRoomMembers(room.id, {
        memberIds: draftMemberIds,
        expectedVersion,
      });
      dispatch({ type: "room", room: updated });
      onClose();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        setConflict(true);
        setError(messages.workContexts.membersConflict);
        try {
          const latest = (await api.rooms()).find((entry) => entry.id === room.id);
          if (latest !== undefined) {
            setLatestRoom(latest);
            dispatch({ type: "room", room: latest });
          }
        } catch (refreshError) {
          setError(errorDisplay(refreshError));
        }
      } else {
        setError(errorDisplay(cause));
      }
    } finally {
      setBusy(false);
    }
  };

  const reload = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const latest = (await api.rooms()).find((entry) => entry.id === room.id);
      if (latest === undefined) {
        setConflict(true);
        setError(messages.workContexts.membersConflict);
        return;
      }
      const additions = draftMemberIds.filter((id) => !baseMemberIds.includes(id));
      const removals = baseMemberIds.filter((id) => !draftMemberIds.includes(id));
      const rebasedMembers = latest.memberIds.filter((id) => !removals.includes(id));
      for (const id of additions) {
        if (!rebasedMembers.includes(id)) rebasedMembers.push(id);
      }
      setBaseMemberIds([...latest.memberIds]);
      setDraftMemberIds(rebasedMembers);
      setExpectedVersion(latest.membershipVersion);
      setLatestRoom(undefined);
      setConflict(false);
      dispatch({ type: "room", room: latest });
    } catch (cause) {
      setError(errorDisplay(cause));
    } finally {
      setBusy(false);
    }
  };


  return (
    <div className="directory-editor-backdrop" onKeyDown={handleDialogKeyDown}>
      <section
        ref={dialogRef}
        className="directory-editor"
        role="dialog"
        aria-modal="true"
        aria-labelledby="channel-members-title"
        tabIndex={-1}
      >
        <header className="directory-editor-head">
          <div>
            <h2 id="channel-members-title">{messages.workContexts.membersTitle}</h2>
            <p className="hint">{messages.workContexts.membersCount(draftMemberIds.length)}</p>
          </div>
          <IconButton icon="close" label={messages.workContexts.close} disabled={busy} onClick={onClose} />
        </header>
        <div className="directory-editor-body">
          <section aria-labelledby="channel-members-current">
            <h3 id="channel-members-current">{messages.workContexts.membersJoined}</h3>
            {draftMembers.length === 0 ? <p className="hint">{messages.workContexts.membersEmpty}</p> : null}
            <ul className="plain">
              {draftMemberIds.map((id, index) => {
                const employee = draftMembers[index];
                return (
                  <li key={id} className="row" style={{ alignItems: "center", justifyContent: "space-between" }}>
                    <span className="identity">
                      <EmployeeAvatar employeeId={id} />
                      <span className="identity-meta">
                        <strong>{employee?.name ?? id}</strong>
                        <span className="role">{employee?.role ?? ""}</span>
                        {employee?.enabled === false ? <span className="hint">{messages.employees.disabled}</span> : null}
                      </span>
                    </span>
                    <button type="button" disabled={busy} onClick={() => toggleMember(id)}>
                      {messages.workContexts.remove}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
          <section aria-labelledby="channel-members-available">
            <h3 id="channel-members-available">{messages.workContexts.membersAvailable}</h3>
            {available.length === 0 ? (
              <p className="hint">{messages.workContexts.membersNoneAvailable}</p>
            ) : (
              <ul className="plain">
                {available.map((employee) => (
                  <li key={employee.id} className="row" style={{ alignItems: "center", justifyContent: "space-between" }}>
                    <span className="identity">
                      <EmployeeAvatar employeeId={employee.id} />
                      <span className="identity-meta">
                        <strong>{employee.name}</strong>
                        <span className="role">{employee.role}</span>
                      </span>
                    </span>
                    <button type="button" disabled={busy} onClick={() => toggleMember(employee.id)}>
                      {messages.workContexts.invite}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          {error !== undefined ? <p role="alert" className="directory-error">{text(error)}</p> : null}
          {hasConflict ? (
            <div className="directory-conflict">
              <p>
                {messages.workContexts.membersConflict} {messages.chat.latestMembersVersion(latestVersion)}
              </p>
              <button type="button" disabled={busy} onClick={() => void reload()}>
                {messages.workContexts.reloadMembers}
              </button>
            </div>
          ) : null}
        </div>
        <footer className="directory-editor-foot">
          <button type="button" disabled={busy} onClick={onClose}>{messages.common.cancel}</button>
          <button type="button" className="primary" disabled={busy || !dirty} onClick={() => void save()}>
            {busy ? messages.chat.savingMembers : messages.chat.saveMembers}
          </button>
        </footer>
      </section>
    </div>
  );
}
