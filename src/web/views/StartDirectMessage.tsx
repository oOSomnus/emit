/**
 * Starting a direct message: search the directory and pick one person.
 *
 * The entry point lives beside the direct-message list, and the dialog is
 * bound to the work that was active when it opened. Picking a row opens that
 * person's conversation for that work directly — there is no second selection
 * step and no submit button; the server still owns de-duplication of the room
 * pair. The dialog is portalled to `document.body` because the narrow-screen
 * rail is transformed and would clip it.
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { RoomDTO } from "../../shared/contracts.ts";
import { errorDisplay, type DisplayText } from "../../shared/i18n.ts";
import { api } from "../api.ts";
import { useI18n } from "../i18n.tsx";
import { useApp } from "../state.tsx";
import { EmployeeAvatar, IconButton } from "./ui.tsx";

export function StartDirectMessage({
  workContextId,
  onClose,
  onOpened,
}: {
  workContextId: string;
  onClose: () => void;
  onOpened: (room: RoomDTO) => void;
}): ReactNode {
  const { state } = useApp();
  const { messages, text } = useI18n();
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DisplayText | undefined>(undefined);
  const dialogRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const restoreFocus = useRef(true);
  // The guard is a ref, not `busy`: a double click can fire both handlers
  // before the disabled state is painted.
  const inFlight = useRef(false);

  useEffect(() => {
    const previousFocus = document.activeElement;
    searchRef.current?.focus();
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
  const openable = workContext !== undefined;

  const openDirect = async (employeeId: string): Promise<void> => {
    if (busy || inFlight.current) return;
    // Re-read the directory at click time: an employee disabled since the
    // list rendered must not be started from a stale row.
    const employee = state.employees.find((entry) => entry.id === employeeId && entry.enabled);
    if (employee === undefined || workContext === undefined) return;
    inFlight.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const room = await api.createRoom({
        kind: "dm",
        name: employee.name,
        workContextId,
        memberIds: [],
        employeeId: employee.id,
      });
      // The conversation takes over focus; the entry button must not steal it
      // back when this dialog unmounts.
      restoreFocus.current = false;
      onOpened(room);
    } catch (cause) {
      setError(errorDisplay(cause));
      setBusy(false);
      inFlight.current = false;
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
        className="directory-editor direct-create"
        role="dialog"
        aria-modal="true"
        aria-labelledby="start-direct-title"
        tabIndex={-1}
      >
        <header className="directory-editor-head">
          <div>
            <h2 id="start-direct-title">{messages.sidebar.creatorDirect}</h2>
            <p className="hint">
              {messages.workContexts.currentWorkLabel}: {workContext?.name ?? workContextId}
            </p>
          </div>
          <IconButton icon="close" label={messages.common.close} disabled={busy} onClick={onClose} />
        </header>
        <div className="directory-editor-body">
          {workContext === undefined ? <p className="hint">{messages.sidebar.noWorkSelected}</p> : null}
          <input
            ref={searchRef}
            type="search"
            value={search}
            disabled={busy}
            aria-label={messages.sidebar.searchMembers}
            placeholder={messages.sidebar.searchMembers}
            onChange={(event) => setSearch(event.target.value)}
          />
          {enabledEmployees.length === 0 ? (
            <p className="hint">{messages.sidebar.noDirectEmployees}</p>
          ) : visible.length === 0 ? (
            <p className="hint">{messages.sidebar.noMatchingMembers}</p>
          ) : (
            <ul className="member-picker direct-picker">
              {visible.map((employee) => (
                <li key={employee.id}>
                  <button
                    type="button"
                    className="direct-person"
                    data-employee-id={employee.id}
                    disabled={busy || !openable}
                    onClick={() => void openDirect(employee.id)}
                  >
                    <EmployeeAvatar employeeId={employee.id} />
                    <span className="member-option-text">
                      <strong>{employee.name}</strong>
                      {employee.role.length > 0 ? <span className="member-option-meta">{employee.role}</span> : null}
                      {employee.address.length > 0 ? (
                        <span className="member-option-meta member-option-address">{employee.address}</span>
                      ) : null}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {error !== undefined ? (
            <p className="directory-error" role="alert">
              {text(error)}
            </p>
          ) : null}
        </div>
      </section>
    </div>,
    document.body,
  );
}
