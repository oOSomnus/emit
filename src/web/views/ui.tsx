/** Small shared pieces: icons, chips, model pickers, and time formatting. */

import { useEffect, useId, useMemo, useState, type ReactNode, type Ref } from "react";
import { api } from "../api.ts";
import type { ModelInfoDTO, WorkStatusDTO } from "../../shared/contracts.ts";

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

const WORK_LABELS: Record<WorkStatusDTO, string> = {
  queued: "排队中",
  running: "进行中",
  succeeded: "已完成",
  failed: "失败",
  stopped: "已停止",
  "waiting-approval": "等待审批",
  "waiting-mail": "等待回信",
};

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
  return <Chip tone={WORK_TONES[status]}>{WORK_LABELS[status]}</Chip>;
}

export function timeAgo(value: number): string {
  if (value <= 0) return "";
  const seconds = Math.max(0, Math.round((Date.now() - value) / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return new Date(value).toLocaleDateString("zh-CN");
}

export function modelKey(model: { providerId: string; modelId: string }): string {
  return `${model.providerId}|${model.modelId}`;
}

/**
 * A searchable model picker: a search box, a provider filter, and the model
 * select itself.
 *
 * Filtering never calls `onChange`: narrowing the visible options must not
 * change the selection. The current value keeps its option even when the
 * filter excludes it, so the control never silently jumps to a different
 * model. A model the current credential cannot use is browsable but disabled.
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

  const selected = models.find((model) => modelKey(model) === value);
  const stale = value.length > 0 && selected === undefined;
  const options = selected !== undefined && !filtered.includes(selected) ? [selected, ...filtered] : filtered;

  return (
    <div className="model-picker">
      <input
        id={`${base}-search`}
        type="search"
        value={search}
        placeholder="搜索模型…"
        aria-label="搜索模型"
        onChange={(event) => setSearch(event.target.value)}
      />
      <select
        id={`${base}-provider`}
        value={providerId}
        aria-label="按 Provider 筛选"
        onChange={(event) => setProviderId(event.target.value)}
      >
        <option value="">全部 Provider</option>
        {providers.map((provider) => (
          <option key={provider.id} value={provider.id}>
            {provider.name}
          </option>
        ))}
      </select>
      <select
        id={`${base}-model`}
        value={value}
        aria-label={label ?? "选择模型"}
        onChange={(event) => onChange(event.target.value)}
      >
        {allowEmpty === true ? <option value="">（不设置）</option> : null}
        {stale ? (
          <option value={value} disabled>
            模型不可用：{value}
          </option>
        ) : null}
        {allowEmpty !== true && !stale && options.length === 0 ? (
          <option value="" disabled>
            （没有匹配的模型）
          </option>
        ) : null}
        {allowEmpty !== true &&
        !stale &&
        options.length > 0 &&
        (value.length === 0 || !options.some((model) => modelKey(model) === value)) ? (
          <option value="" disabled>
            请选择模型
          </option>
        ) : null}
        {options.map((model) => (
          <option key={modelKey(model)} value={modelKey(model)} disabled={!model.configured}>
            {model.providerName} · {model.name}
            {model.configured ? "" : "（当前凭据不可用）"}
          </option>
        ))}
      </select>
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
  if (efforts.length === 0) {
    return (
      <select disabled value="" aria-label={label ?? "推理强度"}>
        <option value="">（无可用强度）</option>
      </select>
    );
  }
  return (
    <select value={value} aria-label={label ?? "推理强度"} onChange={(event) => onChange(event.target.value)}>
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
  const [result, setResult] = useState<{ status: "running" | "ok" | "error"; message?: string } | undefined>(
    undefined,
  );
  const key = model === undefined ? "" : modelKey(model);

  useEffect(() => {
    setResult(undefined);
  }, [key, kind]);

  if (model === undefined) return null;
  const run = async (): Promise<void> => {
    setResult({ status: "running" });
    try {
      const outcome = await api.checkModel(model, kind);
      setResult({ status: outcome.ok ? "ok" : "error", message: outcome.message });
    } catch (error) {
      setResult({ status: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };

  return (
    <span className="connection-check">
      <button
        type="button"
        title="会发起一次真实的远程模型请求，可能产生费用"
        disabled={result?.status === "running"}
        onClick={() => void run()}
      >
        {result?.status === "running" ? "检查中…" : "检查连接"}
      </button>
      {result?.message !== undefined ? (
        <span className={result.status === "ok" ? "hint" : "error-text"}>{result.message}</span>
      ) : null}
    </span>
  );
}
