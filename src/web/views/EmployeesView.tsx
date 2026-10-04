/**
 * The employee roster and the editor that defines one.
 *
 * Everything an employee is — role, instructions, model, skills, MCP servers,
 * allow list, and trusted read-only tools — is edited here. Saving bumps the
 * employee's configuration version, which is part of every approval key, so
 * a later change cannot silently inherit an old grant.
 */

import { useState, type ReactNode } from "react";
import { api } from "../api.ts";
import { errorDisplay } from "../../shared/i18n.ts";
import { useApp } from "../state.tsx";
import { uiText } from "../messages.ts";
import { useI18n } from "../i18n.tsx";
import { Chip, ConnectionCheckButton, EffortPicker, EmployeeAvatar, ModelPicker, modelKey } from "./ui.tsx";
import type { EmployeeDTO } from "../../shared/contracts.ts";

const BUILTIN_TOOLS = ["read_file", "write_file", "edit_file", "run_shell", "load_skill"];

type Draft = {
  name: string;
  role: string;
  instructions: string;
  modelKey: string;
  effort: string;
  skillIds: string[];
  mcpServerIds: string[];
  allowedTools: string[];
  trustedReadOnlyTools: string[];
  generateAddress: boolean;
};

function draftFrom(employee: EmployeeDTO | undefined, models: readonly string[], defaultEffort: string): Draft {
  if (employee === undefined) {
    return {
      name: "",
      role: "",
      instructions: "",
      modelKey: models[0] ?? "",
      effort: defaultEffort,
      skillIds: [],
      mcpServerIds: [],
      allowedTools: [...BUILTIN_TOOLS],
      trustedReadOnlyTools: [],
      generateAddress: true,
    };
  }
  return {
    name: employee.name,
    role: employee.role,
    instructions: employee.instructions,
    modelKey: modelKey(employee.executionModel.model),
    effort: employee.executionModel.effort,
    skillIds: [...employee.skillIds],
    mcpServerIds: [...employee.mcpServerIds],
    allowedTools: [...employee.toolPolicy.allowedTools],
    trustedReadOnlyTools: [...employee.toolPolicy.trustedReadOnlyTools],
    generateAddress: false,
  };
}

function toggle(list: readonly string[], value: string): string[] {
  return list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value];
}

export function EmployeesView(): ReactNode {
  const { state, refreshEmployees, setError } = useApp();
  const { messages } = useI18n();
  // The full chat catalog is offered; the shared picker disables models the
  // current credential cannot use instead of hiding them.
  const chatModels = state.models.filter((model) => model.kind === "chat");
  const [editing, setEditing] = useState<string | "new" | undefined>(undefined);
  const [draft, setDraft] = useState<Draft>(() => draftFrom(undefined, [], "off"));
  const [busy, setBusy] = useState(false);

  const openNew = () => {
    const first = chatModels.find((model) => model.configured) ?? chatModels[0];
    const fallback = state.app?.defaultExecutionModel?.effort ?? "off";
    const effort = first === undefined ? "off" : first.efforts.includes(fallback) ? fallback : first.efforts[0] ?? "off";
    setDraft(draftFrom(undefined, first === undefined ? [] : [modelKey(first)], effort));
    setEditing("new");
  };

  const openEdit = (employee: EmployeeDTO) => {
    setDraft(draftFrom(employee, [], "off"));
    setEditing(employee.id);
  };

  const selectedModel = state.models.find((model) => modelKey(model) === draft.modelKey);

  const save = async (): Promise<void> => {
    if (draft.name.trim().length === 0 || draft.role.trim().length === 0) {
      setError(uiText((messages) => messages.employees.nameRoleRequired));
      return;
    }
    const [providerId, modelId] = draft.modelKey.split("|");
    if (providerId === undefined || modelId === undefined) {
      setError(uiText((messages) => messages.employees.modelRequired));
      return;
    }
    setBusy(true);
    try {
      const payload = {
        name: draft.name.trim(),
        role: draft.role.trim(),
        instructions: draft.instructions,
        executionModel: { model: { providerId, modelId }, effort: draft.effort },
        skillIds: draft.skillIds,
        mcpServerIds: draft.mcpServerIds,
        toolPolicy: { allowedTools: draft.allowedTools, trustedReadOnlyTools: draft.trustedReadOnlyTools },
      };
      if (editing === "new") {
        await api.createEmployee({ ...payload, generateAddress: draft.generateAddress });
      } else if (editing !== undefined) {
        await api.updateEmployee(editing, payload);
      }
      await refreshEmployees();
      setEditing(undefined);
    } catch (error) {
      setError(errorDisplay(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pane">
      <header className="pane-header">
        <div>
          <h2>{messages.employees.title}</h2>
          <p className="topic">{messages.employees.summary(state.employees.length)}</p>
        </div>
        <button type="button" className="primary" onClick={openNew}>
          {messages.employees.newEmployee}
        </button>
      </header>

      <div className="scroll split employees-layout">
        <div className="list">
          {state.employees.length === 0 ? <p className="hint">{messages.employees.empty}</p> : null}
          {state.employees.map((employee) => (
            <button
              key={employee.id}
              type="button"
              className={editing === employee.id ? "employee-card active" : "employee-card"}
              onClick={() => openEdit(employee)}
            >
              <span className="identity">
                <EmployeeAvatar employeeId={employee.id} />
                <span className="identity-meta">
                  <strong>{employee.name}</strong>
                  <span className="role">{employee.role}</span>
                  <span className="address">{employee.address}</span>
                </span>
              </span>
              <span className="tags">
                {employee.enabled ? <Chip tone="ok">{messages.employees.enabled}</Chip> : <Chip tone="muted">{messages.employees.disabled}</Chip>}
                {employee.skillIds.length > 0 ? <Chip tone="info">{messages.employees.skillCount(employee.skillIds.length)}</Chip> : null}
                {employee.mcpServerIds.length > 0 ? <Chip tone="info">{messages.employees.mcpCount(employee.mcpServerIds.length)}</Chip> : null}
                <Chip tone="muted">v{employee.configVersion}</Chip>
              </span>
            </button>
          ))}
        </div>

        {editing !== undefined ? (
          <section className="editor">
            <h3>{editing === "new" ? messages.employees.newTitle : messages.employees.editTitle}</h3>
            <div className="field-grid">
              <label>
                {messages.employees.nameLabel}
                <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
              </label>
              <label>
                {messages.employees.roleLabel}
                <input
                  value={draft.role}
                  placeholder={messages.employees.rolePlaceholder}
                  onChange={(event) => setDraft({ ...draft, role: event.target.value })}
                />
              </label>
            </div>
            <label>
              {messages.employees.instructionsLabel}
              <textarea
                value={draft.instructions}
                placeholder={messages.employees.instructionsPlaceholder}
                onChange={(event) => setDraft({ ...draft, instructions: event.target.value })}
              />
            </label>
            <fieldset>
              <legend>{messages.employees.modelSection}</legend>
              <div className="row">
              <ModelPicker
                models={chatModels}
                value={draft.modelKey}
                onChange={(key) => {
                  const efforts = chatModels.find((model) => modelKey(model) === key)?.efforts ?? [];
                  setDraft({
                    ...draft,
                    modelKey: key,
                    effort: efforts.includes(draft.effort) ? draft.effort : efforts[0] ?? "off",
                  });
                }}
                label={messages.employees.modelLabel}
              />
              <EffortPicker
                efforts={selectedModel?.efforts ?? []}
                value={draft.effort}
                onChange={(effort) => setDraft({ ...draft, effort })}
                label={messages.employees.effortLabel}
              />
              <ConnectionCheckButton model={selectedModel} kind="chat" />
              </div>
            </fieldset>
            {editing === "new" ? (
              <label className="inline">
                <input
                  type="checkbox"
                  checked={draft.generateAddress}
                  onChange={(event) => setDraft({ ...draft, generateAddress: event.target.checked })}
                />
                {messages.employees.generateAddress}
              </label>
            ) : null}

            <fieldset>
              <legend>{messages.employees.skillsSection}</legend>
              {state.skills.length === 0 ? <p className="hint">{messages.employees.skillsEmpty}</p> : null}
              {state.skills.map((skill) => (
                <label key={skill.id} className="inline">
                  <input
                    type="checkbox"
                    checked={draft.skillIds.includes(skill.id)}
                    onChange={() => setDraft({ ...draft, skillIds: toggle(draft.skillIds, skill.id) })}
                  />
                  {skill.name}
                  <span className="hint">{skill.description}</span>
                </label>
              ))}
            </fieldset>

            <fieldset>
              <legend>{messages.employees.mcpSection}</legend>
              {state.mcpServers.length === 0 ? <p className="hint">{messages.employees.mcpEmpty}</p> : null}
              {state.mcpServers.map((server) => (
                <label key={server.id} className="inline">
                  <input
                    type="checkbox"
                    checked={draft.mcpServerIds.includes(server.id)}
                    onChange={() => {
                      const next = toggle(draft.mcpServerIds, server.id);
                      setDraft({
                        ...draft,
                        mcpServerIds: next,
                        trustedReadOnlyTools: draft.trustedReadOnlyTools.filter((reference) => reference.startsWith(`${server.id}/`) === next.includes(server.id)),
                      });
                    }}
                  />
                  {server.name}
                  <span className="hint">
                    {server.connection.state === "connected"
                      ? messages.employees.toolCount(server.tools.length)
                      : server.connection.message ?? messages.employees.notConnected}
                  </span>
                </label>
              ))}
            </fieldset>

            <fieldset>
              <legend>{messages.employees.allowedToolsSection}</legend>
              <p className="hint">{messages.employees.allowedToolsHint}</p>
              {BUILTIN_TOOLS.map((tool) => (
                <label key={tool} className="inline">
                  <input
                    type="checkbox"
                    checked={draft.allowedTools.includes(tool)}
                    onChange={() => setDraft({ ...draft, allowedTools: toggle(draft.allowedTools, tool) })}
                  />
                  {tool}
                </label>
              ))}
            </fieldset>

            <fieldset>
              <legend>{messages.employees.trustedReadOnlySection}</legend>
              <p className="hint">{messages.employees.trustedReadOnlyHint}</p>
              {state.mcpServers
                .filter((server) => draft.mcpServerIds.includes(server.id))
                .flatMap((server) =>
                  server.tools.map((tool) => {
                    const reference = `${server.id}/${tool.name}`;
                    return (
                      <label key={reference} className="inline">
                        <input
                          type="checkbox"
                          checked={draft.trustedReadOnlyTools.includes(reference)}
                          onChange={() =>
                            setDraft({ ...draft, trustedReadOnlyTools: toggle(draft.trustedReadOnlyTools, reference) })
                          }
                        />
                        <code>{reference}</code>
                        {tool.readOnly ? <span className="hint">{messages.employees.declaredReadOnly}</span> : null}
                      </label>
                    );
                  }),
                )}
            </fieldset>

            <div className="row editor-actions">
              <button type="button" className="primary" disabled={busy} onClick={() => void save()}>
                {busy ? messages.employees.saving : messages.employees.save}
              </button>
              <button type="button" onClick={() => setEditing(undefined)}>
                {messages.employees.cancel}
              </button>
              {editing !== "new" ? (
                <button
                  type="button"
                  className="danger"
                  onClick={() => {
                    void api
                      .deleteEmployee(editing)
                      .then(() => refreshEmployees())
                      .then(() => setEditing(undefined))
                      .catch((error: unknown) => setError(errorDisplay(error)));
                  }}
                >
                  {messages.employees.delete}
                </button>
              ) : null}
            </div>
          </section>
        ) : (
          <section className="editor">
            <p className="hint">{messages.employees.emptyEditor}</p>
          </section>
        )}
      </div>
    </div>
  );
}
