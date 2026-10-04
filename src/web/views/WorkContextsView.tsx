import { useEffect, useRef, useState, type ReactNode } from "react";
import type { DirectoryDraftDTO, WorkContextDTO, WorkResourceDraftDTO } from "../../shared/contracts.ts";
import { errorDisplay, type DisplayText } from "../../shared/i18n.ts";
import { ApiError, api } from "../api.ts";
import { useI18n } from "../i18n.tsx";
import { useApp } from "../state.tsx";
import { WorkDirectoryEditor, DirectoryFields } from "./WorkDirectories.tsx";
import { IconButton, timeAgo } from "./ui.tsx";

interface WorkEditorDraft {
  name: string;
  goal: string;
  instructions: string;
  directories: DirectoryDraftDTO;
  resources: WorkResourceDraftDTO[];
}

const EMPTY_WORK_DRAFT: WorkEditorDraft = {
  name: "",
  goal: "",
  instructions: "",
  directories: { paths: [], defaultPath: "" },
  resources: [],
};

function workDraftFrom(workContext: WorkContextDTO): WorkEditorDraft {
  return {
    name: workContext.name,
    goal: workContext.goal,
    instructions: workContext.instructions,
    directories: {
      paths: [...workContext.directories.paths],
      defaultPath: workContext.directories.defaultPath,
    },
    resources: workContext.resources.map((resource) => ({ ...resource })),
  };
}

export function WorkContextsView(): ReactNode {
  const { state, dispatch } = useApp();
  const { messages, text, locale } = useI18n();
  const workContext = state.workContexts.find((item) => item.id === state.activeWorkContextId);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<WorkEditorDraft>(EMPTY_WORK_DRAFT);
  const [initialDraft, setInitialDraft] = useState<WorkEditorDraft>(EMPTY_WORK_DRAFT);
  const [expectedVersion, setExpectedVersion] = useState<number>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<DisplayText>("");
  const [conflict, setConflict] = useState(false);
  const [editingDirectories, setEditingDirectories] = useState(false);
  const [newResource, setNewResource] = useState<WorkResourceDraftDTO>({ kind: "file", name: "", location: "" });
  const [activeNoteId, setActiveNoteId] = useState<string>();
  const [noteDraft, setNoteDraft] = useState({ title: "", body: "" });
  const [noteLoading, setNoteLoading] = useState(false);
  const [noteSaving, setNoteSaving] = useState(false);
  const [noteError, setNoteError] = useState<DisplayText>("");
  const [noteConflict, setNoteConflict] = useState(false);
  const [noteExpectedVersion, setNoteExpectedVersion] = useState<number>();
  const noteRequestId = useRef(0);
  const workFormKey = useRef<string | undefined>(undefined);

  const isDirty = JSON.stringify(draft) !== JSON.stringify(initialDraft);
  const isNewNote = activeNoteId === "__new__";
  const selectedNote = workContext?.notes.find((note) => note.id === activeNoteId);
  const eligibleToEdit = creating || workContext !== undefined;

  useEffect(() => {
    const nextFormKey = creating ? "__new__" : workContext?.id;
    if (workFormKey.current === nextFormKey) return;
    workFormKey.current = nextFormKey;
    noteRequestId.current += 1;
    setEditingDirectories(false);
    setNoteLoading(false);
    setActiveNoteId(undefined);
    setNoteDraft({ title: "", body: "" });
    setNoteError("");
    setNoteExpectedVersion(undefined);
    setNoteConflict(false);
    setNewResource({ kind: "file", name: "", location: "" });
    if (creating) {
      setDraft(EMPTY_WORK_DRAFT);
      setInitialDraft(EMPTY_WORK_DRAFT);
      setExpectedVersion(undefined);
      setError("");
      setConflict(false);
      return;
    }
    if (workContext === undefined) {
      setDraft(EMPTY_WORK_DRAFT);
      setInitialDraft(EMPTY_WORK_DRAFT);
      setExpectedVersion(undefined);
      setError("");
      setConflict(false);
      return;
    }
    const next = workDraftFrom(workContext);
    setDraft(next);
    setInitialDraft(next);
    setExpectedVersion(workContext.version);
    setError("");
    setConflict(false);
  }, [workContext, creating]);

  const startCreating = (): void => {
    setEditingDirectories(false);
    setCreating(true);
    setNewResource({ kind: "file", name: "", location: "" });
    setDraft(EMPTY_WORK_DRAFT);
    setInitialDraft(EMPTY_WORK_DRAFT);
    setExpectedVersion(undefined);
    setError("");
    setConflict(false);
    setActiveNoteId(undefined);
    setNoteDraft({ title: "", body: "" });
  };

  const selectWork = (id: string): void => {
    setEditingDirectories(false);
    setCreating(false);
    dispatch({ type: "activeWorkContext", workContextId: id });
  };

  const saveWork = async (): Promise<void> => {
    if (saving || draft.name.trim().length === 0) return;
    setSaving(true);
    setError("");
    setConflict(false);
    try {
      let updated: WorkContextDTO;
      if (creating) {
        updated = await api.createWorkContext({
          name: draft.name.trim(),
          goal: draft.goal,
          instructions: draft.instructions,
          directories: draft.directories,
          resources: draft.resources,
        });
        setCreating(false);
        dispatch({ type: "activeWorkContext", workContextId: updated.id });
      } else {
        if (workContext === undefined || expectedVersion === undefined) return;
        updated = await api.patchWorkContext(workContext.id, {
          name: draft.name.trim(),
          goal: draft.goal,
          instructions: draft.instructions,
          resources: draft.resources,
          expectedVersion,
        });
      }
      dispatch({ type: "workContext", workContext: updated });
      const next = workDraftFrom(updated);
      setDraft(next);
      setInitialDraft(next);
      setExpectedVersion(updated.version);
    } catch (cause) {
      setError(errorDisplay(cause));
      if (cause instanceof ApiError && cause.status === 409) setConflict(true);
    } finally {
      setSaving(false);
    }
  };

  const reloadWork = async (): Promise<void> => {
    if (saving || workContext === undefined) return;
    setSaving(true);
    setError("");
    try {
      const latest = await api.getWorkContext(workContext.id);
      dispatch({ type: "workContext", workContext: latest });
      const next = workDraftFrom(latest);
      setDraft(next);
      setInitialDraft(next);
      setExpectedVersion(latest.version);
      setConflict(false);
    } catch (cause) {
      setError(errorDisplay(cause));
    } finally {
      setSaving(false);
    }
  };

  const selectNote = async (noteId: string): Promise<void> => {
    const contextId = workContext?.id;
    const contextVersion = workContext?.version;
    if (contextId === undefined || contextVersion === undefined) return;
    const requestId = ++noteRequestId.current;
    setActiveNoteId(noteId);
    setNoteExpectedVersion(contextVersion);
    setNoteDraft({ title: "", body: "" });
    setNoteError("");
    setNoteConflict(false);
    setNoteLoading(true);
    try {
      const note = await api.getWorkContextNote(contextId, noteId);
      if (requestId === noteRequestId.current) {
        setNoteDraft({ title: note.title, body: note.body });
        setNoteExpectedVersion(contextVersion);
      }
    } catch (cause) {
      if (requestId === noteRequestId.current) setNoteError(errorDisplay(cause));
    } finally {
      if (requestId === noteRequestId.current) setNoteLoading(false);
    }
  };

  const startNewNote = (): void => {
    noteRequestId.current += 1;
    setActiveNoteId("__new__");
    setNoteDraft({ title: "", body: "" });
    setNoteError("");
    setNoteExpectedVersion(workContext?.version);
    setNoteConflict(false);
    setNoteLoading(false);
  };

  const saveNote = async (): Promise<void> => {
    if (
      workContext === undefined ||
      noteSaving ||
      noteExpectedVersion === undefined ||
      noteDraft.title.trim().length === 0 ||
      noteDraft.body.trim().length === 0
    ) {
      return;
    }
    const formVersion = expectedVersion;
    setNoteSaving(true);
    setNoteError("");
    setNoteConflict(false);
    try {
      const input = {
        title: noteDraft.title.trim(),
        body: noteDraft.body,
        expectedVersion: noteExpectedVersion,
      };
      const result = isNewNote
        ? await api.createWorkContextNote(workContext.id, input)
        : activeNoteId !== undefined
          ? await api.patchWorkContextNote(workContext.id, activeNoteId, input)
          : undefined;
      if (result === undefined) return;
      dispatch({ type: "workContext", workContext: result.workContext });
      setActiveNoteId(result.note.id);
      setNoteDraft({ title: result.note.title, body: result.note.body });
      setNoteExpectedVersion(result.workContext.version);
      setNoteError(messages.workContexts.noteSavedNotice);
      if (formVersion === workContext.version) setExpectedVersion(result.workContext.version);
    } catch (cause) {
      setNoteError(errorDisplay(cause));
      if (cause instanceof ApiError && cause.status === 409) setNoteConflict(true);
    } finally {
      setNoteSaving(false);
    }
  };

  const deleteNote = async (): Promise<void> => {
    if (
      workContext === undefined ||
      activeNoteId === undefined ||
      isNewNote ||
      noteSaving ||
      noteExpectedVersion === undefined
    ) {
      return;
    }
    const formVersion = expectedVersion;
    setNoteSaving(true);
    setNoteError("");
    setNoteConflict(false);
    try {
      const updated = await api.deleteWorkContextNote(workContext.id, activeNoteId, {
        expectedVersion: noteExpectedVersion,
      });
      dispatch({ type: "workContext", workContext: updated });
      setActiveNoteId(undefined);
      setNoteDraft({ title: "", body: "" });
      setNoteError(messages.workContexts.noteDeleted);
      setNoteExpectedVersion(undefined);
      if (formVersion === workContext.version) setExpectedVersion(updated.version);
    } catch (cause) {
      setNoteError(errorDisplay(cause));
      if (cause instanceof ApiError && cause.status === 409) setNoteConflict(true);
    } finally {
      setNoteSaving(false);
    }
  };

  const reloadNoteVersion = async (): Promise<void> => {
    if (workContext === undefined || noteSaving) return;
    const formVersion = expectedVersion;
    setNoteSaving(true);
    setNoteError("");
    try {
      const latest = await api.getWorkContext(workContext.id);
      dispatch({ type: "workContext", workContext: latest });
      if (activeNoteId !== undefined && activeNoteId !== "__new__") {
        const note = await api.getWorkContextNote(latest.id, activeNoteId);
        setNoteDraft({ title: note.title, body: note.body });
      }
      setNoteExpectedVersion(latest.version);
      setNoteConflict(false);
      if (formVersion === workContext.version) setExpectedVersion(latest.version);
    } catch (cause) {
      setNoteError(errorDisplay(cause));
    } finally {
      setNoteSaving(false);
    }
  };

  const updateResource = (index: number, patch: Partial<WorkResourceDraftDTO>): void => {
    const resources = [...draft.resources];
    const current = resources[index];
    if (current === undefined) return;
    resources[index] = { ...current, ...patch };
    setDraft({ ...draft, resources });
  };

  const removeResource = (index: number): void => {
    setDraft({ ...draft, resources: draft.resources.filter((_, position) => position !== index) });
  };

  const addResource = (): void => {
    if (newResource.name.trim().length === 0 || newResource.location.trim().length === 0) return;
    setDraft({ ...draft, resources: [...draft.resources, { ...newResource, name: newResource.name.trim(), location: newResource.location.trim() }] });
    setNewResource({ kind: "file", name: "", location: "" });
  };

  return (
    <div className="pane">
      <header className="pane-header">
        <div>
          <h2>{messages.workContexts.title}</h2>
          <p className="topic">{messages.workContexts.subtitle}</p>
        </div>
        <div className="pane-header-actions">
          <button type="button" className="primary" onClick={startCreating}>
            {messages.workContexts.createWork}
          </button>
        </div>
      </header>
      <div
        className="scroll split"
        style={{
          gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 280px), 1fr))",
          alignContent: "start",
          gap: 20,
        }}
      >
        <div className="list">
          {state.workContexts.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`employee-card${!creating && item.id === state.activeWorkContextId ? " active" : ""}`}
              aria-pressed={!creating && item.id === state.activeWorkContextId}
              onClick={() => selectWork(item.id)}
            >
              <span className="identity-meta">
                <strong>{item.name}</strong>
                <span className="role">{messages.workContexts.updated(timeAgo(item.updatedAt, locale))}</span>
              </span>
            </button>
          ))}
          {state.workContexts.length === 0 ? <p className="hint">{messages.workContexts.noWorks}</p> : null}
        </div>

        {eligibleToEdit ? (
          <div className="settings work-context-editor">
            <section>
              <div className="section-head">
                <h3>{creating ? messages.workContexts.createTitle : messages.workContexts.editorTitle(workContext?.name ?? "")}</h3>
                {!creating && workContext !== undefined ? (
                  <button type="button" onClick={() => setEditingDirectories(true)}>
                    {messages.workContexts.directoriesTitle} · {workContext.directories.paths.length}
                  </button>
                ) : null}
              </div>
              <p className="hint">{messages.workContexts.switchWorkHint}</p>
              {!creating && workContext?.directories.paths.length === 0 ? (
                <p className="hint">{messages.workContexts.directoriesEmpty}</p>
              ) : null}
              <form
                className="editor"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveWork();
                }}
              >
                <label>
                  {messages.workContexts.nameLabel}
                  <input
                    required
                    maxLength={120}
                    value={draft.name}
                    placeholder={messages.workContexts.namePlaceholder}
                    disabled={saving}
                    onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  />
                </label>
                <label>
                  {messages.workContexts.goalLabel}
                  <textarea
                    maxLength={2000}
                    value={draft.goal}
                    placeholder={messages.workContexts.goalPlaceholder}
                    disabled={saving}
                    onChange={(event) => setDraft({ ...draft, goal: event.target.value })}
                  />
                </label>
                <label>
                  {messages.workContexts.instructionsLabel}
                  <textarea
                    maxLength={4000}
                    value={draft.instructions}
                    placeholder={messages.workContexts.instructionsPlaceholder}
                    disabled={saving}
                    onChange={(event) => setDraft({ ...draft, instructions: event.target.value })}
                  />
                </label>

                {creating ? (
                  <fieldset>
                    <legend>{messages.workContexts.directoriesTitle}</legend>
                    <p className="hint">{messages.workContexts.directoriesHint}</p>
                    <DirectoryFields
                      value={draft.directories}
                      disabled={saving}
                      onChange={(directories) => setDraft({ ...draft, directories })}
                    />
                  </fieldset>
                ) : null}

                <fieldset>
                  <legend>{messages.workContexts.resourcesTitle}</legend>
                  <p className="hint">{messages.workContexts.resourcesHint}</p>
                  {draft.resources.length > 0 ? (
                    <ul className="plain">
                      {draft.resources.map((resource, index) => (
                        <li key={resource.id ?? `new-${index}`}>
                          <div className="row">
                            <label>
                              {messages.workContexts.resourceName}
                              <input
                                maxLength={120}
                                value={resource.name}
                                disabled={saving}
                                onChange={(event) => updateResource(index, { name: event.target.value })}
                              />
                            </label>
                            <label>
                              {messages.workContexts.resourceKindLabel}
                              <select
                                value={resource.kind}
                                disabled={saving}
                                onChange={(event) => updateResource(index, { kind: event.target.value as "file" | "url" })}
                              >
                                <option value="file">{messages.workContexts.resourceFile}</option>
                                <option value="url">{messages.workContexts.resourceUrl}</option>
                              </select>
                            </label>
                            <IconButton
                              icon="close"
                              label={messages.workContexts.removeResource(resource.name)}
                              disabled={saving}
                              onClick={() => removeResource(index)}
                            />
                          </div>
                          <label>
                            {messages.workContexts.resourceLocation}
                            <input
                              maxLength={2048}
                              value={resource.location}
                              disabled={saving}
                              onChange={(event) => updateResource(index, { location: event.target.value })}
                            />
                          </label>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <div className="row">
                    <label>
                      {messages.workContexts.resourceName}
                      <input
                        maxLength={120}
                        value={newResource.name ?? ""}
                        placeholder={messages.workContexts.resourceNamePlaceholder}
                        disabled={saving}
                        onChange={(event) => setNewResource({ ...newResource, name: event.target.value })}
                      />
                    </label>
                    <label>
                      {messages.workContexts.resourceKindLabel}
                      <select
                        value={newResource.kind}
                        disabled={saving}
                        onChange={(event) => setNewResource({ ...newResource, kind: event.target.value as "file" | "url" })}
                      >
                        <option value="file">{messages.workContexts.resourceFile}</option>
                        <option value="url">{messages.workContexts.resourceUrl}</option>
                      </select>
                    </label>
                    <button
                      type="button"
                      disabled={saving || newResource.name.trim().length === 0 || newResource.location.trim().length === 0}
                      onClick={addResource}
                    >
                      {messages.workContexts.addResource}
                    </button>
                  </div>
                  <label>
                    {messages.workContexts.resourceLocation}
                    <input
                      maxLength={2048}
                      value={newResource.location ?? ""}
                      placeholder={messages.workContexts.resourceLocation}
                      disabled={saving}
                      onChange={(event) => setNewResource({ ...newResource, location: event.target.value })}
                    />
                  </label>
                </fieldset>

                {error ? <p className="directory-error" role="alert">{text(error)}</p> : null}
                {conflict ? (
                  <div className="directory-conflict" role="group">
                    <p>{messages.workContexts.conflict}</p>
                    <button type="button" disabled={saving} onClick={() => void reloadWork()}>
                      {messages.workContexts.reload}
                    </button>
                  </div>
                ) : null}
                <div className="editor-actions">
                  <button
                    type="submit"
                    className="primary"
                    disabled={saving || (!creating && expectedVersion === undefined) || !isDirty || draft.name.trim().length === 0}
                  >
                    {saving ? messages.workContexts.saving : messages.workContexts.save}
                  </button>
                  {creating ? (
                    <button type="button" disabled={saving} onClick={() => setCreating(false)}>
                      {messages.common.cancel}
                    </button>
                  ) : null}
                </div>
              </form>
            </section>

            {!creating && workContext !== undefined ? (
              <section>
                <div className="section-head">
                  <h3>{messages.workContexts.notesTitle}</h3>
                  <button type="button" onClick={startNewNote}>
                    {messages.workContexts.newNote}
                  </button>
                </div>
                <p className="hint">{messages.workContexts.notesHint}</p>
                <p className="hint">{messages.workContexts.noteSharedWarning}</p>
                <div
                  className="scroll split"
                  style={{
                    padding: 0,
                    gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 280px), 1fr))",
                  }}
                >
                  <div className="list">
                    {workContext.notes.map((note) => (
                      <button
                        key={note.id}
                        type="button"
                        className={`employee-card${note.id === activeNoteId ? " active" : ""}`}
                        aria-pressed={note.id === activeNoteId}
                        onClick={() => void selectNote(note.id)}
                      >
                        <span className="identity-meta">
                          <strong>{note.title}</strong>
                          <span className="role">
                            {note.authorId === "user"
                              ? messages.workContexts.noteAuthorYou
                              : state.employees.find((employee) => employee.id === note.authorId)?.name ?? note.authorId}
                            {" · "}
                            {timeAgo(note.updatedAt, locale)}
                          </span>
                        </span>
                      </button>
                    ))}
                    {workContext.notes.length === 0 ? <p className="hint">{messages.workContexts.notesEmpty}</p> : null}
                  </div>
                  <div className="editor">
                    {activeNoteId === undefined ? <p className="hint">{messages.workContexts.notePick}</p> : null}
                    {activeNoteId !== undefined ? (
                      <>
                        {selectedNote !== undefined && selectedNote.sourceRoomId.length > 0 ? (
                          <p className="hint">
                            {messages.workContexts.noteSource(
                              state.rooms.find((room) => room.id === selectedNote.sourceRoomId)?.name ?? selectedNote.sourceRoomId,
                              selectedNote.sourceEntryId,
                            )}
                          </p>
                        ) : null}
                        <label>
                          {messages.workContexts.noteTitle}
                          <input
                            maxLength={120}
                            value={noteDraft.title}
                            disabled={noteLoading || noteSaving}
                            onChange={(event) => setNoteDraft({ ...noteDraft, title: event.target.value })}
                          />
                        </label>
                        <label>
                          {messages.workContexts.noteBody}
                          <textarea
                            maxLength={16000}
                            value={noteDraft.body}
                            disabled={noteLoading || noteSaving}
                            onChange={(event) => setNoteDraft({ ...noteDraft, body: event.target.value })}
                          />
                        </label>
                        {noteError ? <p className={noteConflict ? "directory-error" : "hint"} role={noteConflict ? "alert" : "status"}>{text(noteError)}</p> : null}
                        {noteConflict ? (
                          <div className="directory-conflict" role="group">
                            <p>{messages.workContexts.conflict}</p>
                            <button type="button" disabled={noteSaving} onClick={() => void reloadNoteVersion()}>
                              {messages.workContexts.reload}
                            </button>
                          </div>
                        ) : null}
                        <div className="row-actions">
                          <button
                            type="button"
                            className="primary"
                            disabled={noteLoading || noteSaving || noteDraft.title.trim().length === 0 || noteDraft.body.trim().length === 0}
                            onClick={() => void saveNote()}
                          >
                            {messages.workContexts.saveNote}
                          </button>
                          {!isNewNote ? (
                            <button type="button" className="danger" disabled={noteLoading || noteSaving} onClick={() => void deleteNote()}>
                              {messages.workContexts.deleteNote}
                            </button>
                          ) : null}
                        </div>
                      </>
                    ) : null}
                  </div>
                </div>
              </section>
            ) : null}
          </div>
        ) : (
          <div className="empty">
            <h2>{messages.workContexts.emptyTitle}</h2>
            <p>{messages.workContexts.emptyBody}</p>
            <button type="button" className="primary" onClick={startCreating}>
              {messages.workContexts.createWork}
            </button>
          </div>
        )}
      </div>
      {editingDirectories && !creating && workContext !== undefined ? (
        <WorkDirectoryEditor
          key={workContext.id}
          workContext={workContext}
          onClose={() => setEditingDirectories(false)}
          onSaved={(updated) => {
            if (expectedVersion === workContext.version) setExpectedVersion(updated.version);
          }}
        />
      ) : null}
    </div>
  );
}
