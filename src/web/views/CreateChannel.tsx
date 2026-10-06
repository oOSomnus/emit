/**
 * Creating a channel: name, the work it binds to, and a batch member picker.
 *
 * The members panel of an existing channel solves a different problem (draft
 * against a versioned membership), so this panel keeps its own selection state
 * instead of reusing that editor. The dialog is portalled to `document.body`
 * because the narrow-screen rail is transformed and would clip it.
 */

import { useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { RoomDTO } from "../../shared/contracts.ts";
import { errorDisplay, type DisplayText } from "../../shared/i18n.ts";
import { api } from "../api.ts";
import { useI18n } from "../i18n.tsx";
import { useApp } from "../state.tsx";
import {
  EmployeeAvatar,
  EmployeePickerDetails,
  IconButton,
  useDialogFocusRestore,
  useDialogFocusTrap,
  useEmployeePicker,
} from "./ui.tsx";

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
  const restoreFocus = useDialogFocusRestore(nameRef);

  const workContext = state.workContexts.find((entry) => entry.id === workContextId);
  const { enabledEmployees, visible } = useEmployeePicker(state.employees, search);
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

  const handleDialogKeyDown = useDialogFocusTrap(dialogRef, busy, onClose, true);

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
                      <EmployeePickerDetails employee={employee} />
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
