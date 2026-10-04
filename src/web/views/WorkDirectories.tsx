import { useId, useState, type ReactNode } from "react";
import { errorDisplay, type DisplayText } from "../../shared/i18n.ts";
import { ApiError, api } from "../api.ts";
import { useApp } from "../state.tsx";
import { useI18n } from "../i18n.tsx";
import { IconButton } from "./ui.tsx";
import type { DirectoryDraftDTO, WorkContextDTO } from "../../shared/contracts.ts";

export function DirectoryFields({
  value,
  onChange,
  disabled = false,
}: {
  value: DirectoryDraftDTO;
  onChange: (value: DirectoryDraftDTO) => void;
  disabled?: boolean;
}): ReactNode {
  const { messages } = useI18n();
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
                aria-label={messages.directories.pathInput(index + 1)}
                value={path}
                disabled={disabled}
                placeholder={messages.directories.pathPlaceholder}
                onChange={(event) => changePath(index, event.target.value)}
              />
            </label>
            <label className="directory-default" title={messages.directories.defaultDirectoryTitle}>
              <input
                type="radio"
                name={`default-work-directory-${defaultGroup}`}
                aria-label={messages.directories.setDefault(
                  path.length > 0 ? path : messages.directories.defaultDirectory(index + 1),
                )}
                checked={path.length > 0 && value.defaultPath === path}
                disabled={disabled || path.length === 0}
                onChange={() => onChange({ ...value, defaultPath: path })}
              />
              <span>{messages.directories.defaultMark}</span>
            </label>
            <IconButton
              icon="close"
              label={messages.directories.removeDirectory(index + 1)}
              disabled={disabled}
              onClick={() => removePath(index)}
            />
          </div>
        ))}
      </div>
      <button type="button" disabled={disabled} onClick={() => onChange({ ...value, paths: [...value.paths, ""] })}>
        {messages.directories.addDirectory}
      </button>
      <p className="hint">{messages.directories.pathsHint}</p>
    </div>
  );
}

export function WorkDirectoryEditor({
  workContext,
  onClose,
  onSaved,
}: {
  workContext: WorkContextDTO;
  onClose: () => void;
  onSaved?: (workContext: WorkContextDTO) => void;
}): ReactNode {
  const { dispatch } = useApp();
  const { messages, text } = useI18n();
  const [draft, setDraft] = useState<DirectoryDraftDTO>(() => ({
    paths: [...workContext.directories.paths],
    defaultPath: workContext.directories.defaultPath,
  }));
  const [initialDirectories, setInitialDirectories] = useState<DirectoryDraftDTO>(() => ({
    paths: [...workContext.directories.paths],
    defaultPath: workContext.directories.defaultPath,
  }));
  const [expectedVersion, setExpectedVersion] = useState(workContext.version);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DisplayText>("");
  const [conflict, setConflict] = useState(false);
  const [askClose, setAskClose] = useState(false);
  const dirty =
    draft.defaultPath !== initialDirectories.defaultPath ||
    draft.paths.length !== initialDirectories.paths.length ||
    draft.paths.some((path, index) => path !== initialDirectories.paths[index]);

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
      const updated = await api.patchWorkContext(workContext.id, {
        directories: draft,
        expectedVersion,
      });
      dispatch({ type: "workContext", workContext: updated });
      onSaved?.(updated);
      onClose();
    } catch (cause) {
      setError(errorDisplay(cause));
      if (cause instanceof ApiError && cause.status === 409) {
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
      const latest = await api.getWorkContext(workContext.id);
      dispatch({ type: "workContext", workContext: latest });
      onSaved?.(latest);
      const latestDirectories = {
        paths: [...latest.directories.paths],
        defaultPath: latest.directories.defaultPath,
      };
      setDraft(latestDirectories);
      setInitialDirectories(latestDirectories);
      setExpectedVersion(latest.version);
      setConflict(false);
      setAskClose(false);
    } catch (cause) {
      setError(errorDisplay(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="directory-editor-backdrop">
      <section className="directory-editor" role="dialog" aria-modal="true" aria-labelledby="directory-editor-title">
        <header className="directory-editor-head">
          <div>
            <h2 id="directory-editor-title">{messages.workContexts.directoriesTitle}</h2>
            <p className="hint">{messages.workContexts.directoriesHint}</p>
          </div>
          <IconButton icon="close" label={messages.directories.closeEditor} disabled={busy} onClick={close} />
        </header>
        <div className="directory-editor-body">
          <DirectoryFields value={draft} onChange={setDraft} disabled={busy} />
          {error ? (
            <p className="directory-error" role="alert">
              {text(error)}
            </p>
          ) : null}
          {conflict ? (
            <div className="directory-conflict">
              <p>{messages.workContexts.conflict}</p>
              <button type="button" disabled={busy} onClick={() => void reload()}>
                {messages.workContexts.reload}
              </button>
            </div>
          ) : null}
          {askClose ? (
            <div className="directory-close-confirm" role="group" aria-label={messages.directories.unsavedGroup}>
              <span className="hint">{messages.directories.unsavedHint}</span>
              <button type="button" className="danger" disabled={busy} onClick={onClose}>
                {messages.directories.discard}
              </button>
              <button type="button" disabled={busy} onClick={() => setAskClose(false)}>
                {messages.directories.keepEditing}
              </button>
            </div>
          ) : null}
        </div>
        {!askClose ? (
          <footer className="directory-editor-foot">
            <button type="button" disabled={busy} onClick={close}>
              {messages.common.cancel}
            </button>
            <button type="button" className="primary" disabled={busy || !dirty} onClick={() => void save()}>
              {busy ? messages.directories.savingDirectories : messages.directories.saveDirectories}
            </button>
          </footer>
        ) : null}
      </section>
    </div>
  );
}
