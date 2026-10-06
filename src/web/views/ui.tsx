/** Small shared pieces: icons, chips, model pickers, and time formatting. */

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type Ref, type RefObject } from "react";
import { api } from "../api.ts";
import type { CheckResultDTO, EmployeeDTO, ModelInfoDTO, WorkStatusDTO } from "../../shared/contracts.ts";
import { errorDisplay, type DisplayText, type Locale } from "../../shared/i18n.ts";
import { useI18n } from "../i18n.tsx";
import { messagesFor } from "../messages.ts";
import { generateEmployeeAvatar } from "../avatar.ts";
import { useTheme } from "../theme.tsx";

const EMPLOYEE_AVATAR_PALETTES = [
  { light: ["#efe8f5", "#795397", "#aa86bc"], dark: ["#33263e", "#c1a3da", "#9573af"] },
  { light: ["#e7edf7", "#4e6995", "#91a8c7"], dark: ["#253144", "#a4bddb", "#7798bf"] },
  { light: ["#e3f0ef", "#477d78", "#83aaa4"], dark: ["#223936", "#9acac0", "#6fa598"] },
  { light: ["#f6e8ec", "#9a6075", "#c394a5"], dark: ["#3d2932", "#ddb0c0", "#b98198"] },
  { light: ["#f5edde", "#967545", "#bfa776"], dark: ["#3d3325", "#d7c091", "#b29a64"] },
  { light: ["#e8efdf", "#647c50", "#9bad83"], dark: ["#2e3727", "#bdcea0", "#8fa777"] },
] as const;

/** A local, stable employee image; user and system authors keep the initials avatar. */
export function EmployeeAvatar({ employeeId, size = 32 }: { employeeId: string; size?: number }): ReactNode {
  const avatar = useMemo(() => generateEmployeeAvatar(employeeId), [employeeId]);
  const { resolved } = useTheme();
  const colors = EMPLOYEE_AVATAR_PALETTES[avatar.palette]![resolved];
  return (
    <svg
      className="employee-avatar"
      viewBox="0 0 96 96"
      width={size}
      height={size}
      style={{ display: "block", flex: "none" }}
      aria-hidden="true"
      focusable="false"
    >
      <rect width="96" height="96" rx="22" fill={colors[0]} />
      {avatar.cells.map((cell) => (
        <rect
          key={`${cell.x}-${cell.y}`}
          x={14 + cell.x * 14}
          y={14 + cell.y * 14}
          width="12"
          height="12"
          rx="3"
          fill={cell.tone === 0 ? colors[1] : colors[2]}
        />
      ))}
    </svg>
  );
}

/** Search enabled employees by name, role, or address for directory pickers. */
export function useEmployeePicker(employees: readonly EmployeeDTO[], search: string): {
  enabledEmployees: EmployeeDTO[];
  visible: EmployeeDTO[];
} {
  const enabledEmployees = employees.filter((employee) => employee.enabled);
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
  return { enabledEmployees, visible };
}

/** Focus a dialog's initial control and restore the opener unless navigation takes over. */
export function useDialogFocusRestore<T extends HTMLElement>(target: RefObject<T | null>): RefObject<boolean> {
  const restoreFocus = useRef(true);
  useEffect(() => {
    const previousFocus = document.activeElement;
    target.current?.focus();
    return () => {
      if (restoreFocus.current && previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus();
      }
    };
  }, []);
  return restoreFocus;
}

/** Keep keyboard focus inside a dialog and apply its Escape-key behavior. */
export function useDialogFocusTrap<T extends HTMLElement>(
  dialogRef: RefObject<T | null>,
  busy: boolean,
  onClose: () => void,
  stopPropagationOnEscape: boolean,
): (event: KeyboardEvent<HTMLElement>) => void {
  return (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      if (stopPropagationOnEscape) event.stopPropagation();
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
}

/** Render the employee identity shared by member directory rows. */
export function EmployeePickerDetails({ employee }: { employee: EmployeeDTO }): ReactNode {
  return (
    <>
      <EmployeeAvatar employeeId={employee.id} />
      <span className="member-option-text">
        <strong>{employee.name}</strong>
        {employee.role.length > 0 ? <span className="member-option-meta">{employee.role}</span> : null}
        {employee.address.length > 0 ? (
          <span className="member-option-meta member-option-address">{employee.address}</span>
        ) : null}
      </span>
    </>
  );
}

export type IconName =
  | "mail"
  | "chat"
  | "approval"
  | "work"
  | "employees"
  | "settings"
  | "menu"
  | "inbox"
  | "send"
  | "draft"
  | "archive"
  | "search"
  | "refresh"
  | "close"
  | "back"
  | "plus"
  | "check"
  | "alert"
  | "check-circle"
  | "user"
  | "sun"
  | "moon"
  | "monitor"
  | "paperclip"
  | "reply"
  | "reply-all"
  | "download"
  | "more";

/**
 * A stroked 24×24 icon drawn in `currentColor`.
 *
 * Icons inherit the text colour of their button and never carry meaning on
 * their own, so they are hidden from assistive technology; the button that
 * wraps one always names itself.
 */
const ICONS: Record<IconName, string[]> = {
  mail: ["M4 5.5h16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1Z", "m3.6 6.6 8.4 6 8.4-6"],
  chat: ["M4.5 4.5h15a1 1 0 0 1 1 1v9.5a1 1 0 0 1-1 1H9.5l-5 4V5.5a1 1 0 0 1 1-1Z"],
  approval: ["M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17Z", "m8.4 12.4 2.4 2.4 4.8-5"],
  work: ["M9 5.5h6a1 1 0 0 1 1 1v1h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h3v-1a1 1 0 0 1 1-1Z", "M4 12.5h16"],
  employees: ["M9.5 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z", "M3.5 20c0-3 2.7-5 6-5s6 2 6 5", "M16 11.5a3 3 0 1 0 0-6.4", "M17 15.2c2.3.5 3.8 2.1 3.8 4.8"],
  settings: ["M4 6.5h9M18.5 6.5H20M4 12h2.5M11 12h9M4 17.5h9M18.5 17.5H20", "M15.5 5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z", "M8 10.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z", "M15.5 16a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z"],
  menu: ["M4 6.5h16M4 12h16M4 17.5h16"],
  inbox: ["M4 5.5h16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1Z", "M3 13.5h5.5l1.3 2.2h4.4l1.3-2.2H21"],
  send: ["M20 4 4.5 11.4l6.4 2.1 2.1 6.5L20 4Z", "m10.9 13.5 4-4"],
  draft: ["M6.5 3.5h7.5l4.5 4.5v5.5", "M6.5 3.5a1 1 0 0 0-1 1v15a1 1 0 0 0 1 1h4", "m18.6 12.4 1.9 1.9-5.6 5.6h-1.9v-1.9l5.6-5.6Z"],
  archive: ["M3.5 4.5h17v4h-17z", "M5.5 8.5v10a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-10", "M10 12.5h4"],
  search: ["M11 4.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Z", "m15.9 15.9 4.1 4.1"],
  refresh: ["M5 12a7 7 0 0 1 11.9-5L20 9.5", "M19 12a7 7 0 0 1-11.9 5L5 14.5", "M20 5.5v4h-4M4 18.5v-4h4"],
  close: ["M6.5 6.5l11 11M17.5 6.5l-11 11"],
  back: ["M14.5 5.5 8 12l6.5 6.5"],
  plus: ["M12 5.5v13M5.5 12h13"],
  check: ["m5.5 12.5 4.5 4.5 8.5-9.5"],
  alert: ["M12 4.5 21 20H3l9-15.5Z", "M12 10v4.5M12 17.2v.6"],
  "check-circle": ["M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17Z", "m8.4 12.4 2.4 2.4 4.8-5"],
  user: ["M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z", "M4.5 20c0-3.4 3.4-5.8 7.5-5.8s7.5 2.4 7.5 5.8"],
  sun: ["M12 7.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9Z", "M12 2.5v2.5M12 19v2.5M4.3 4.3l1.8 1.8M17.9 17.9l1.8 1.8M2.5 12H5M19 12h2.5M4.3 19.7l1.8-1.8M17.9 6.1l1.8-1.8"],
  moon: ["M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z"],
  monitor: ["M3.5 5.5h17v10h-17z", "M9 19.5h6M12 15.5v4"],
  paperclip: ["M17.5 8.5 9.9 16a2.5 2.5 0 0 1-3.5-3.5l7.6-7.6a4 4 0 0 1 5.6 5.6l-7.6 7.6a5.5 5.5 0 0 1-7.8-7.8l7-7"],
  reply: ["M9.5 5.5 4 11l5.5 5.5", "M4 11h9.5a6 6 0 0 1 6 6v1.5"],
  "reply-all": ["M8.5 5.5 3 11l5.5 5.5", "M14 5.5 8.5 11l5.5 5.5", "M8.5 11H15a6 6 0 0 1 6 6v1.5"],
  download: ["M12 4v10.5", "m7.8 10.3 4.2 4.2 4.2-4.2", "M4.5 19.5h15"],
  more: ["M6 12v.01M12 12v.01M18 12v.01"],
};

export function Icon({ name, size = 18 }: { name: IconName; size?: number }): ReactNode {
  return (
    <svg className="icon" viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {ICONS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

/** An icon-only button; the label is exposed as both title and accessible name. */
export function IconButton({
  icon,
  label,
  onClick,
  disabled,
  className,
  ref,
}: {
  icon: IconName;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
  ref?: Ref<HTMLButtonElement>;
}): ReactNode {
  return (
    <button
      ref={ref}
      type="button"
      className={`icon-button${className !== undefined ? ` ${className}` : ""}`}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name={icon} />
    </button>
  );
}

export function Chip({ tone, children }: { tone?: string; children: ReactNode }): ReactNode {
  return <span className={`chip ${tone ?? ""}`}>{children}</span>;
}

const WORK_TONES: Record<WorkStatusDTO, string> = {
  queued: "muted",
  running: "info",
  succeeded: "ok",
  failed: "error",
  stopped: "muted",
  "waiting-approval": "warn",
  "waiting-mail": "info",
};

export function WorkStatus({ status }: { status: WorkStatusDTO }): ReactNode {
  const { messages } = useI18n();
  return <Chip tone={WORK_TONES[status]}>{messages.work.status[status]}</Chip>;
}

export function timeAgo(value: number, locale: Locale): string {
  if (value <= 0) return "";
  const messages = messagesFor(locale);
  const seconds = Math.max(0, Math.round((Date.now() - value) / 1000));
  if (seconds < 60) return messages.common.secondsAgo(seconds);
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return messages.common.minutesAgo(minutes);
  const hours = Math.round(minutes / 60);
  if (hours < 24) return messages.common.hoursAgo(hours);
  return new Date(value).toLocaleDateString(locale);
}

export function modelKey(model: { providerId: string; modelId: string }): string {
  return `${model.providerId}|${model.modelId}`;
}

/**
 * A searchable model picker: a search box, a provider filter, and the model
 * select itself.
 *
 * Filtering never calls `onChange`: narrowing the visible options must not
 * change the selection. While a search term or provider filter is active the
 * native select expands to six visible rows so the matches are actually
 * readable, and a status line reports the match count or that nothing
 * matched. The current value keeps its option even when the filter excludes
 * it, marked as the unmatched current selection, so the control never
 * silently jumps to a different model. A model the current credential cannot
 * use is browsable but disabled.
 */
export function ModelPicker({
  models,
  value,
  onChange,
  allowEmpty,
  label,
}: {
  models: readonly ModelInfoDTO[];
  value: string;
  onChange: (key: string) => void;
  allowEmpty?: boolean;
  label?: string;
}): ReactNode {
  const base = useId();
  const { messages } = useI18n();
  const [search, setSearch] = useState("");
  const [providerId, setProviderId] = useState("");

  const providers = useMemo(() => {
    const seen = new Map<string, string>();
    for (const model of models) if (!seen.has(model.providerId)) seen.set(model.providerId, model.providerName);
    return [...seen.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [models]);

  const term = search.trim().toLowerCase();
  const filtered = models.filter((model) => {
    if (providerId.length > 0 && model.providerId !== providerId) return false;
    if (term.length === 0) return true;
    return `${model.name} ${model.modelId} ${model.providerName} ${model.providerId}`.toLowerCase().includes(term);
  });

  const filtering = term.length > 0 || providerId.length > 0;
  const selected = models.find((model) => modelKey(model) === value);
  const stale = value.length > 0 && selected === undefined;
  const options = selected !== undefined && !filtered.includes(selected) ? [selected, ...filtered] : filtered;

  return (
    <div className="model-picker">
      <input
        id={`${base}-search`}
        type="search"
        value={search}
        placeholder={messages.model.searchPlaceholder}
        aria-label={messages.model.search}
        onChange={(event) => setSearch(event.target.value)}
      />
      <select
        id={`${base}-provider`}
        value={providerId}
        aria-label={messages.model.providerFilter}
        onChange={(event) => setProviderId(event.target.value)}
      >
        <option value="">{messages.model.allProviders}</option>
        {providers.map((provider) => (
          <option key={provider.id} value={provider.id}>
            {provider.name}
          </option>
        ))}
      </select>
      <select
        id={`${base}-model`}
        value={value}
        size={filtering ? 6 : undefined}
        aria-label={label ?? messages.model.select}
        aria-describedby={filtering ? `${base}-results` : undefined}
        onChange={(event) => onChange(event.target.value)}
      >
        {allowEmpty === true ? <option value="">{messages.model.notSet}</option> : null}
        {stale ? (
          <option value={value} disabled>
            {messages.model.unavailable(value)}
          </option>
        ) : null}
        {allowEmpty !== true && !stale && options.length === 0 ? (
          <option value="" disabled>
            {messages.model.noMatch}
          </option>
        ) : null}
        {allowEmpty !== true &&
        !stale &&
        options.length > 0 &&
        (value.length === 0 || !options.some((model) => modelKey(model) === value)) ? (
          <option value="" disabled>
            {messages.model.selectPrompt}
          </option>
        ) : null}
        {options.map((model) => (
          <option key={modelKey(model)} value={modelKey(model)} disabled={!model.configured}>
            {model.providerName} · {model.name}
            {model.configured ? "" : messages.model.credentialUnavailable}
            {filtering && modelKey(model) === value && !filtered.includes(model) ? messages.model.filterMismatch : ""}
          </option>
        ))}
      </select>
      {filtering ? (
        <p id={`${base}-results`} className="hint model-picker-results" role="status">
          {filtered.length === 0 ? messages.model.noMatch : messages.model.matchingModels(filtered.length)}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Reasoning efforts for the chosen model, in the catalog's native order.
 *
 * The list already begins with `off` when the model can reason and contains
 * only `off` when it cannot, so nothing is inserted here. No model means no
 * valid effort, which is shown as a disabled empty state.
 */
export function EffortPicker({
  efforts,
  value,
  onChange,
  label,
}: {
  efforts: readonly string[];
  value: string;
  onChange: (value: string) => void;
  label?: string;
}): ReactNode {
  const { messages } = useI18n();
  if (efforts.length === 0) {
    return (
      <select disabled value="" aria-label={label ?? messages.model.effortLabel}>
        <option value="">{messages.model.noEfforts}</option>
      </select>
    );
  }
  return (
    <select value={value} aria-label={label ?? messages.model.effortLabel} onChange={(event) => onChange(event.target.value)}>
      {efforts.map((level) => (
        <option key={level} value={level}>
          {level}
        </option>
      ))}
    </select>
  );
}
/**
 * A real connection probe for one model.
 *
 * This sends an actual request to the provider, which may cost money, so it
 * only runs when the user asks. The previous result is cleared whenever the
 * selected model changes, so a stale success can never vouch for a new model.
 */
export function ConnectionCheckButton({
  model,
  kind,
}: {
  model: { providerId: string; modelId: string } | undefined;
  kind: "chat" | "classifier";
}): ReactNode {
  const [result, setResult] = useState<{ status: "running" | "ok" | "error"; message?: DisplayText } | undefined>(
    undefined,
  );
  const { messages, text } = useI18n();
  const key = model === undefined ? "" : modelKey(model);

  useEffect(() => {
    setResult(undefined);
  }, [key, kind]);

  if (model === undefined) return null;
  const run = async (): Promise<void> => {
    setResult({ status: "running" });
    try {
      const outcome: CheckResultDTO = await api.checkModel(model, kind);
      setResult({ status: outcome.ok ? "ok" : "error", message: outcome.messageLocalized ?? outcome.message });
    } catch (error) {
      setResult({ status: "error", message: errorDisplay(error) });
    }
  };

  return (
    <span className="connection-check">
      <button
        type="button"
        title={messages.model.costWarning}
        disabled={result?.status === "running"}
        onClick={() => void run()}
      >
        {result?.status === "running" ? messages.model.checking : messages.model.check}
      </button>
      {result?.message !== undefined ? (
        <span className={result.status === "ok" ? "hint" : "error-text"}>{text(result.message)}</span>
      ) : null}
    </span>
  );
}
