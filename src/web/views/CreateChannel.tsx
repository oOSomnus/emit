/**
 * Creating a channel: name, the work it binds to, and a batch member picker.
 *
 * The members panel of an existing channel solves a different problem (draft
 * against a versioned membership), so this panel keeps its own selection state
 * instead of reusing that editor. The dialog is portalled to `document.body`
 * because the narrow-screen rail is transformed and would clip it.
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { RoomDTO } from "../../shared/contracts.ts";
import { errorDisplay, type DisplayText } from "../../shared/i18n.ts";
import { api } from "../api.ts";
import { useI18n } from "../i18n.tsx";
import { useApp } from "../state.tsx";
import { EmployeeAvatar, IconButton } from "./ui.tsx";

export function CreateChannel({
  workContextId,
  onClose,
  onCreated,
}: {
  workContextId: string;
  onClose: () => void;
  onCreated: (room: RoomDTO) => void;
}): ReactNode {
  const { state } = useApp();
  const { messages, text } = useI18n();
  const [name, setName] = useState("");
  const [search, setSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DisplayText | undefined>(undefined);
  const dialogRef = useRef<HTMLElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const restoreFocus = useRef(true);

  useEffect(() => {
    const previousFocus = document.activeElement;
    nameRef.current?.focus();
    return () => {
      if (restoreFocus.current && previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus();
      }
    };
  }, []);

  const workContext = state.workContexts.find((entry) => entry.id === workContextId);
  const enabledEmployees = state.employees.filter((employee) => employee.enabled);
  const query = search.trim().toLowerCase();
  const visible = useMemo(
    () =>
      enabledEmployees.filter(
        (employee) =>
          query.length === 0 ||
          employee.name.toLowerCase().includes(query) ||
          employee.role.toLowerCase().includes(query) ||
          employee.address.toLowerCase().includes(query),
      ),
    [enabledEmployees, query],
  );
  const unavailableSelectedIds = selectedIds.filter((id) => {
    const employee = state.employees.find((entry) => entry.id === id);
    return employee === undefined || !employee.enabled;
  });
  const canSubmit =
    !busy && name.trim().length > 0 && workContext !== undefined && unavailableSelectedIds.length === 0;

  const toggle = (employeeId: string): void => {
    const next = selectedIds.includes(employeeId)
      ? selectedIds.filter((id) => id !== employeeId)
      : [...selectedIds, employeeId];
    setSelectedIds(next);
  };

  const selectVisible = (): void => {
    const additions = visible.map((employee) => employee.id).filter((id) => !selectedIds.includes(id));
    setSelectedIds([...selectedIds, ...additions]);
  };

  const submit = async (): Promise<void> => {
    if (!canSubmit) return;
    setBusy(true);
    setError(undefined);
    try {
      const room = await api.createRoom({
        kind: "channel",
        name: name.trim(),
        workContextId,
        memberIds: selectedIds,
      });
      restoreFocus.current = false;
      onCreated(room);
    } catch (cause) {
      setError(errorDisplay(cause));
      setBusy(false);
    }
  };

  const handleDialogKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      // The narrow-screen rail also listens for Escape; a closed dialog must
      // not also close the navigation behind it.
      event.stopPropagation();
      if (!busy) onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
      "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])",
    );
    if (focusable === undefined || focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div className="directory-editor-backdrop" onKeyDown={handleDialogKeyDown}>
      <section
        ref={dialogRef}
        className="directory-editor channel-create"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-channel-title"
        tabIndex={-1}
      >
        <header className="directory-editor-head">
          <div>
            <h2 id="create-channel-title">{messages.sidebar.creatorChannel}</h2>
            <p className="hint">
              {messages.workContexts.currentWorkLabel}: {workContext?.name ?? workContextId}
            </p>
          </div>
          <IconButton icon="close" label={messages.common.close} disabled={busy} onClick={onClose} />
        </header>
        <div className="directory-editor-body">
          {workContext === undefined ? <p className="hint">{messages.sidebar.noWorkSelected}</p> : null}
          <label className="channel-create-field">
            {messages.sidebar.channelPlaceholder}
            <input
              ref={nameRef}
              value={name}
              disabled={busy}
              aria-label={messages.sidebar.channelPlaceholder}
              placeholder={messages.sidebar.channelPlaceholder}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing && event.keyCode !== 229) void submit();
              }}
            />
          </label>
          <section className="channel-create-members" aria-labelledby="create-channel-members-title">
            <h3 id="create-channel-members-title">{messages.sidebar.initialMembers}</h3>
            <input
              type="search"
              value={search}
              disabled={busy}
              aria-label={messages.sidebar.searchMembers}
              placeholder={messages.sidebar.searchMembers}
              onChange={(event) => setSearch(event.target.value)}
            />
            <div className="channel-create-actions">
              <button type="button" disabled={busy || visible.length === 0} onClick={selectVisible}>
                {messages.sidebar.selectVisibleMembers}
              </button>
              <button type="button" disabled={busy || selectedIds.length === 0} onClick={() => setSelectedIds([])}>
                {messages.sidebar.clearSelectedMembers}
              </button>
              <span className="hint">{messages.sidebar.selectedMembers(selectedIds.length)}</span>
            </div>
            {unavailableSelectedIds.length > 0 ? (
              <p className="directory-error" role="alert">
                {messages.sidebar.unavailableSelectedMembers}
              </p>
            ) : null}
            {enabledEmployees.length === 0 ? (
              <p className="hint">{messages.sidebar.noEmployees}</p>
            ) : visible.length === 0 && unavailableSelectedIds.length === 0 ? (
              <p className="hint">{messages.sidebar.noMatchingMembers}</p>
            ) : (
              <ul className="member-picker">
                {visible.map((employee) => (
                  <li key={employee.id}>
                    <label className="member-option">
                      <input
                        type="checkbox"
                        checked={selectedIds.includes(employee.id)}
                        disabled={busy}
                        onChange={() => toggle(employee.id)}
                      />
                      <EmployeeAvatar employeeId={employee.id} />
                      <span className="member-option-text">
                        <strong>{employee.name}</strong>
                        {employee.role.length > 0 ? <span className="member-option-meta">{employee.role}</span> : null}
                        {employee.address.length > 0 ? (
                          <span className="member-option-meta member-option-address">{employee.address}</span>
                        ) : null}
                      </span>
                    </label>
                  </li>
                ))}
                {unavailableSelectedIds.map((id) => {
                  const employee = state.employees.find((entry) => entry.id === id);
                  return (
                    <li key={`unavailable-${id}`}>
                      <label className="member-option unavailable">
                        <input type="checkbox" checked disabled={busy} onChange={() => toggle(id)} />
                        <EmployeeAvatar employeeId={id} />
                        <span className="member-option-text">
                          <strong>{employee?.name ?? id}</strong>
                          {employee !== undefined && !employee.enabled ? (
                            <span className="member-option-meta">{messages.employees.disabled}</span>
                          ) : null}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="hint">{messages.sidebar.initialMembersHint}</p>
          </section>
          {error !== undefined ? (
            <p className="directory-error" role="alert">
              {text(error)}
            </p>
          ) : null}
        </div>
        <footer className="directory-editor-foot">
          <button type="button" disabled={busy} onClick={onClose}>
            {messages.common.cancel}
          </button>
          <button type="button" className="primary" disabled={!canSubmit} onClick={() => void submit()}>
            {messages.common.create}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
