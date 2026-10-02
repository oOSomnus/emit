import { useId, useState, type ReactNode } from "react";
import { api } from "../api.ts";
import { useApp } from "../state.tsx";
import { IconButton } from "./ui.tsx";
import type { RoomDirectoryDraftDTO, RoomDTO } from "../../shared/contracts.ts";

export function DirectoryFields({
  value,
  onChange,
  disabled = false,
}: {
  value: RoomDirectoryDraftDTO;
  onChange: (value: RoomDirectoryDraftDTO) => void;
  disabled?: boolean;
}): ReactNode {
  const defaultGroup = useId();
  const changePath = (index: number, path: string): void => {
    const paths = [...value.paths];
    const previous = paths[index] ?? "";
    paths[index] = path;
    const defaultPath =
      value.defaultPath !== previous
        ? value.defaultPath
        : path.trim().length > 0
          ? path
          : paths.find((candidate, position) => position !== index && candidate.trim().length > 0) ?? "";
    onChange({ paths, defaultPath });
  };

  const removePath = (index: number): void => {
    const removed = value.paths[index];
    const paths = value.paths.filter((_, position) => position !== index);
    const defaultPath =
      value.defaultPath === removed ? paths.find((path) => path.trim().length > 0) ?? "" : value.defaultPath;
    onChange({ paths, defaultPath });
  };

  return (
    <div className="directory-fields">
      <div className="directory-paths">
        {value.paths.map((path, index) => (
          <div className="directory-path-row" key={index}>
            <label className="directory-path-input">
              <input
                type="text"
                aria-label={`工作目录路径 ${index + 1}`}
                value={path}
                disabled={disabled}
                placeholder="服务器本地绝对路径"
                onChange={(event) => changePath(index, event.target.value)}
              />
            </label>
            <label className="directory-default" title="默认执行目录">
              <input
                type="radio"
                name={`default-work-directory-${defaultGroup}`}
                aria-label={`将 ${path || `工作目录 ${index + 1}`} 设为默认执行目录`}
                checked={path.length > 0 && value.defaultPath === path}
                disabled={disabled || path.length === 0}
                onChange={() => onChange({ ...value, defaultPath: path })}
              />
              <span>默认</span>
            </label>
            <IconButton
              icon="close"
              label={`移除工作目录 ${index + 1}`}
              disabled={disabled}
              onClick={() => removePath(index)}
            />
          </div>
        ))}
      </div>
      <button type="button" disabled={disabled} onClick={() => onChange({ ...value, paths: [...value.paths, ""] })}>
        添加目录
      </button>
      <p className="hint">路径必须是服务器上已存在、可访问的目录。默认目录用于未指定工作路径的执行。</p>
    </div>
  );
}

export function RoomDirectoryEditor({ room, onClose }: { room: RoomDTO; onClose: () => void }): ReactNode {
  const { dispatch } = useApp();
  const [draft, setDraft] = useState<RoomDirectoryDraftDTO>(() => ({
    paths: [...room.directories.paths],
    defaultPath: room.directories.defaultPath,
  }));
  const [initialDirectories, setInitialDirectories] = useState<RoomDirectoryDraftDTO>(() => ({
    paths: [...room.directories.paths],
    defaultPath: room.directories.defaultPath,
  }));
  const [expectedVersion, setExpectedVersion] = useState(room.directories.version);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [askClose, setAskClose] = useState(false);
  const dirty =
    draft.defaultPath !== initialDirectories.defaultPath ||
    draft.paths.length !== initialDirectories.paths.length ||
    draft.paths.some((path, index) => path !== initialDirectories.paths[index]);
  const description =
    room.kind === "channel"
      ? "本频道员工共享。"
      : room.kind === "dm"
        ? "仅当前私信对话。"
        : "同一邮件会话内共享，回复链与分支共用。";

  const close = (): void => {
    if (busy) return;
    if (dirty) {
      setAskClose(true);
      return;
    }
    onClose();
  };

  const save = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError("");
    setConflict(false);
    try {
      const updated = await api.updateRoomDirectories(room.id, {
        ...draft,
        expectedVersion,
      });
      dispatch({ type: "room", room: updated });
      onClose();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      if (typeof cause === "object" && cause !== null && "status" in cause && cause.status === 409) {
        setConflict(true);
      }
    } finally {
      setBusy(false);
    }
  };

  const reload = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const latest = (await api.rooms()).find((entry) => entry.id === room.id);
      if (latest === undefined) throw new Error("会话不存在，无法重新载入目录配置");
      dispatch({ type: "room", room: latest });
      const latestDirectories = {
        paths: [...latest.directories.paths],
        defaultPath: latest.directories.defaultPath,
      };
      setDraft(latestDirectories);
      setInitialDirectories(latestDirectories);
      setExpectedVersion(latest.directories.version);
      setConflict(false);
      setAskClose(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="directory-editor-backdrop">
      <section className="directory-editor" role="dialog" aria-modal="true" aria-labelledby="directory-editor-title">
        <header className="directory-editor-head">
          <div>
            <h2 id="directory-editor-title">本会话授权的工作目录</h2>
            <p className="hint">{description} 这不是操作系统沙箱。</p>
          </div>
          <IconButton icon="close" label="关闭目录设置" disabled={busy} onClick={close} />
        </header>
        <div className="directory-editor-body">
          <DirectoryFields value={draft} onChange={setDraft} disabled={busy} />
          {error.length > 0 ? <p className="directory-error" role="alert">{error}</p> : null}
          {conflict ? (
            <div className="directory-conflict">
              <p>目录配置已被其他操作更新。你的草稿仍保留；重新载入后会以服务器当前配置替换它。</p>
              <button type="button" disabled={busy} onClick={() => void reload()}>重新载入</button>
            </div>
          ) : null}
          {askClose ? (
            <div className="directory-close-confirm" role="group" aria-label="未保存的目录修改">
              <span className="hint">有未保存的修改</span>
              <button type="button" className="danger" disabled={busy} onClick={onClose}>丢弃修改</button>
              <button type="button" disabled={busy} onClick={() => setAskClose(false)}>继续编辑</button>
            </div>
          ) : null}
        </div>
        {!askClose ? (
          <footer className="directory-editor-foot">
            <button type="button" disabled={busy} onClick={close}>取消</button>
            <button type="button" className="primary" disabled={busy || !dirty} onClick={() => void save()}>
              {busy ? "正在保存…" : "保存目录"}
            </button>
          </footer>
        ) : null}
      </section>
    </div>
  );
}
