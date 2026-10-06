/**
 * Settings: the workspace, the approval judge, the collaboration budget,
 * providers and credentials, skills, and MCP servers.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { errorDisplay } from "../../shared/i18n.ts";
import { api } from "../api.ts";
import { useApp } from "../state.tsx";
import { LanguagePicker, useI18n } from "../i18n.tsx";
import { uiText } from "../messages.ts";
import { Chip, ConnectionCheckButton, EffortPicker, ModelPicker, modelKey } from "./ui.tsx";
import { ProviderManager } from "./ProviderManager.tsx";
import { ThemePicker } from "../theme.tsx";
import type { ApprovalEvaluatorConfigDTO, ModelInfoDTO } from "../../shared/contracts.ts";

/** The settings sections; each renders one panel at a time. */
type SettingsSectionId = "workspace" | "providers" | "model" | "approval" | "collaboration" | "skills" | "mcp";

const SETTINGS_SECTIONS: readonly SettingsSectionId[] = [
  "workspace",
  "providers",
  "model",
  "approval",
  "collaboration",
  "skills",
  "mcp",
];

/** Move a selection's effort to the first level the new model supports. */
function effortForModel(models: readonly ModelInfoDTO[], key: string, current: string): string {
  const efforts = models.find((model) => modelKey(model) === key)?.efforts ?? [];
  return efforts.includes(current) ? current : efforts[0] ?? "off";
}

export function SettingsView(): ReactNode {
  const { state, dispatch, setError } = useApp();
  const { messages, text } = useI18n();
  const [userName, setUserName] = useState(state.app?.user.name ?? "");
  const [activeSection, setActiveSection] = useState<SettingsSectionId>("workspace");
  const contentRef = useRef<HTMLDivElement>(null);
  const [skillDir, setSkillDir] = useState("");
  const [skillDiagnostics, setSkillDiagnostics] = useState<{ severity: string; message: string; path: string }[]>([]);
  const [serverDraft, setServerDraft] = useState({
    name: "",
    transport: "stdio" as "stdio" | "http",
    command: "",
    args: "",
    url: "",
    description: "",
  });

  useEffect(() => {
    setUserName(state.app?.user.name ?? "");
  }, [state.app?.user.name]);

  const app = state.app;
  if (app === undefined) return <div className="boot">{messages.common.loading}</div>;

  const chatModels = state.models.filter((model) => model.kind === "chat");
  const approval = app.approval;
  const approvalModels = state.models.filter((model) =>
    (approval?.kind ?? "llm") === "llm" ? model.kind === "chat" : model.kind === "classifier",
  );

  // Saving an app config must not reopen the first room, so the response is
  // folded straight into state instead of going through `reload`.
  const saveApproval = async (next: ApprovalEvaluatorConfigDTO) => {
    try {
      dispatch({ type: "app", app: await api.updateApp({ approval: next }) });
    } catch (error) {
      setError(errorDisplay(error));
    }
  };

  const sectionLabel = (id: SettingsSectionId): string => {
    switch (id) {
      case "workspace":
        return messages.settings.workspace;
      case "providers":
        return messages.providers.legend;
      case "model":
        return messages.settings.defaultModel;
      case "approval":
        return messages.settings.approvalJudge;
      case "collaboration":
        return messages.settings.collaboration;
      case "skills":
        return messages.settings.skills;
      case "mcp":
        return messages.settings.mcp;
    }
  };

  // Switching sections only changes what is visible; every panel stays
  // mounted so drafts and in-progress authentication survive the switch.
  const selectSection = (id: SettingsSectionId): void => {
    setActiveSection(id);
    if (contentRef.current !== null) contentRef.current.scrollTop = 0;
  };

  return (
    <div className="pane settings-pane">
      <header className="pane-header">
        <div>
          <h2>{messages.settings.title}</h2>
        </div>
      </header>

      <div className="settings-layout">
        <nav className="settings-nav" aria-label={messages.settings.sections}>
          {SETTINGS_SECTIONS.map((id) => (
            <button
              key={id}
              type="button"
              id={`settings-nav-${id}`}
              aria-controls={`settings-panel-${id}`}
              aria-current={activeSection === id ? "page" : undefined}
              onClick={() => selectSection(id)}
            >
              {sectionLabel(id)}
            </button>
          ))}
        </nav>

        <div className="settings-main">
          <label className="settings-section-picker">
            {messages.settings.sectionPicker}
            <select
              aria-label={messages.settings.sectionPicker}
              value={activeSection}
              onChange={(event) => selectSection(event.target.value as SettingsSectionId)}
            >
              {SETTINGS_SECTIONS.map((id) => (
                <option key={id} value={id}>
                  {sectionLabel(id)}
                </option>
              ))}
            </select>
          </label>

          <div className="scroll settings-content" ref={contentRef}>
            <section
              className="settings-panel"
              id="settings-panel-workspace"
              aria-labelledby="settings-nav-workspace"
              hidden={activeSection !== "workspace"}
            >
              <div className="section-head">
                <h3>{messages.settings.workspace}</h3>
              </div>
          <div className="field-grid">
            <label>
              {messages.settings.yourName}
              <input value={userName} onChange={(event) => setUserName(event.target.value)} />
            </label>
          </div>
          <p className="hint">
            {messages.settings.yourAddress}
            {app.user.address}
          </p>
          <div className="row">
            <ThemePicker />
            <LanguagePicker />
          </div>
          <div className="row">
            <button
              type="button"
              className="primary"
              onClick={() => {
                void api
                  .updateApp({ userName })
                  .then((next) => dispatch({ type: "app", app: next }))
                  .catch((error: unknown) => setError(errorDisplay(error)));
              }}
            >
              {messages.common.save}
            </button>
          </div>
          <details>
            <summary>{messages.settings.localData}</summary>
            <p className="hint settings-data-path">
              {messages.settings.dataDirectory}
              <code>{state.storagePath}</code>
            </p>
          </details>
            </section>

        <section
          className="settings-panel"
          id="settings-panel-model"
          aria-labelledby="settings-nav-model"
          hidden={activeSection !== "model"}
        >
          <div className="section-head">
            <h3>{messages.settings.defaultModel}</h3>
          </div>
          <div className="row">
            <ModelPicker
              models={chatModels}
              value={app.defaultExecutionModel === null ? "" : modelKey(app.defaultExecutionModel.model)}
              onChange={(key) => {
                if (key === "") {
                  void api
                    .updateApp({ defaultExecutionModel: null })
                    .then((next) => dispatch({ type: "app", app: next }))
                    .catch((error: unknown) => setError(errorDisplay(error)));
                  return;
                }
                const [providerId, modelId] = key.split("|");
                if (providerId === undefined || modelId === undefined) return;
                const effort = effortForModel(state.models, key, app.defaultExecutionModel?.effort ?? "off");
                void api
                  .updateApp({ defaultExecutionModel: { model: { providerId, modelId }, effort } })
                  .then((next) => dispatch({ type: "app", app: next }))
                  .catch((error: unknown) => setError(errorDisplay(error)));
              }}
              allowEmpty
              label={messages.settings.defaultExecutionModel}
            />
            {app.defaultExecutionModel !== null ? (
              <EffortPicker
                efforts={
                  state.models.find((model) => modelKey(model) === modelKey(app.defaultExecutionModel!.model))
                    ?.efforts ?? []
                }
                value={app.defaultExecutionModel.effort}
                onChange={(effort) => {
                  void api
                    .updateApp({ defaultExecutionModel: { model: app.defaultExecutionModel!.model, effort } })
                    .then((next) => dispatch({ type: "app", app: next }))
                    .catch((error: unknown) => setError(errorDisplay(error)));
                }}
                label={messages.settings.defaultModelEffort}
              />
            ) : null}
            <ConnectionCheckButton model={app.defaultExecutionModel?.model} kind="chat" />
          </div>
          <p className="hint">{messages.settings.defaultModelHint}</p>
        </section>

        <section
          className="settings-panel"
          id="settings-panel-approval"
          aria-labelledby="settings-nav-approval"
          hidden={activeSection !== "approval"}
        >
          <div className="section-head">
            <h3>{messages.settings.approvalJudge}</h3>
          </div>
          <p className="hint">{messages.settings.policyVersionHint(app.policyVersion)}</p>
          <details>
            <summary>{messages.settings.approvalRules}</summary>
            <p className="hint">{messages.settings.riskPolicyHint}</p>
            <p className="hint">{messages.settings.separateJudgeHint}</p>
          </details>
          <div className="row">
            <label className="inline">
              <input
                type="radio"
                checked={approval?.kind !== "classifier"}
                onChange={() => {
                  const first = chatModels.find((model) => model.configured);
                  if (first === undefined) {
                    setError(uiText((m) => m.settings.noLlmJudge));
                    return;
                  }
                  void saveApproval({
                    kind: "llm",
                    model: { providerId: first.providerId, modelId: first.modelId },
                    effort: first.efforts[0] ?? "off",
                    criteriaVersion: 3,
                  });
                }}
              />
              {messages.settings.llmJudge}
            </label>
            <label className="inline">
              <input
                type="radio"
                checked={approval?.kind === "classifier"}
                onChange={() => {
                  const first = state.models.find((model) => model.kind === "classifier" && model.configured);
                  if (first === undefined) {
                    setError(uiText((m) => m.settings.noClassifier));
                    return;
                  }
                  void saveApproval({
                    kind: "classifier",
                    model: { providerId: first.providerId, modelId: first.modelId },
                    criteriaVersion: 3,
                  });
                }}
              />
              {messages.settings.classifier}
            </label>
          </div>
          {approval !== null && approval !== undefined ? (
            <>
              <div className="row">
                <ModelPicker
                  models={approvalModels}
                  value={modelKey(approval.model)}
                  onChange={(key) => {
                    const [providerId, modelId] = key.split("|");
                    if (providerId === undefined || modelId === undefined) return;
                    if (approval.kind === "llm") {
                      void saveApproval({
                        ...approval,
                        model: { providerId, modelId },
                        effort: effortForModel(state.models, key, approval.effort),
                      });
                    } else {
                      void saveApproval({ ...approval, model: { providerId, modelId } });
                    }
                  }}
                  label={messages.settings.judgeModel}
                />
                {approval.kind === "llm" ? (
                  <EffortPicker
                    efforts={
                      state.models.find((model) => modelKey(model) === modelKey(approval.model))?.efforts ?? []
                    }
                    value={approval.effort}
                    onChange={(effort) => void saveApproval({ ...approval, effort })}
                    label={messages.settings.judgeEffort}
                  />
                ) : null}
                <ConnectionCheckButton model={approval.model} kind={approval.kind === "llm" ? "chat" : "classifier"} />
              </div>
            </>
          ) : (
            <p className="hint">{messages.settings.noJudgeHint}</p>
          )}
        </section>

        <section
          className="settings-panel"
          id="settings-panel-collaboration"
          aria-labelledby="settings-nav-collaboration"
          hidden={activeSection !== "collaboration"}
        >
          <div className="section-head">
            <h3>{messages.settings.collaboration}</h3>
          </div>
          <div className="field-grid field-grid-three">
            <label>
              {messages.settings.delegationDepth}
              <input
                type="number"
                min="1"
                value={app.collaboration.maxDepth}
                onChange={(event) =>
                  void api
                    .updateApp({ collaboration: { ...app.collaboration, maxDepth: Number(event.target.value) } })
                    .then((next) => dispatch({ type: "app", app: next }))
                }
              />
            </label>
            <label>
              {messages.settings.crossEmployeeWakes}
              <input
                type="number"
                min="1"
                value={app.collaboration.maxCrossEmployeeWakes}
                onChange={(event) =>
                  void api
                    .updateApp({
                      collaboration: { ...app.collaboration, maxCrossEmployeeWakes: Number(event.target.value) },
                    })
                    .then((next) => dispatch({ type: "app", app: next }))
                }
              />
            </label>
            <label>
              {messages.settings.modelTurns}
              <input
                type="number"
                min="1"
                value={app.collaboration.maxModelTurns}
                onChange={(event) =>
                  void api
                    .updateApp({ collaboration: { ...app.collaboration, maxModelTurns: Number(event.target.value) } })
                    .then((next) => dispatch({ type: "app", app: next }))
                }
              />
            </label>
          </div>
        </section>

        <section
          className="settings-panel"
          id="settings-panel-providers"
          aria-labelledby="settings-nav-providers"
          hidden={activeSection !== "providers"}
        >
          <ProviderManager />
        </section>

        <section
          className="settings-panel"
          id="settings-panel-skills"
          aria-labelledby="settings-nav-skills"
          hidden={activeSection !== "skills"}
        >
          <div className="section-head">
            <h3>{messages.settings.skills}</h3>
          </div>
          <ul className="plain">
            {state.skills.map((skill) => (
              <li key={skill.id}>
                <strong>{skill.name}</strong> <span className="hint">{skill.description}</span>
                <code>{skill.filePath}</code>
                <button
                  type="button"
                  onClick={() => {
                    void api
                      .deleteSkill(skill.id)
                      .catch((error: unknown) => setError(errorDisplay(error)));
                  }}
                >
                  {messages.common.remove}
                </button>
              </li>
            ))}
            {state.skills.length === 0 ? <li className="hint">{messages.settings.noSkills}</li> : null}
          </ul>
          <div className="row">
            <input
              placeholder={messages.settings.skillDirPlaceholder}
              value={skillDir}
              onChange={(event) => setSkillDir(event.target.value)}
            />
            <button
              type="button"
              onClick={() => {
                void api
                  .importSkill(skillDir)
                  .then((result) => {
                    setSkillDiagnostics(result.diagnostics);
                    setSkillDir("");
                  })
                  .catch((error: unknown) => setError(errorDisplay(error)));
              }}
            >
              {messages.settings.importSkill}
            </button>
          </div>
          {skillDiagnostics.map((diagnostic) => (
            <p key={`${diagnostic.path}-${diagnostic.message}`} className="hint">
              [{diagnostic.severity}] {diagnostic.path}: {diagnostic.message}
            </p>
          ))}
        </section>

        <section
          className="settings-panel"
          id="settings-panel-mcp"
          aria-labelledby="settings-nav-mcp"
          hidden={activeSection !== "mcp"}
        >
          <div className="section-head">
            <h3>{messages.settings.mcp}</h3>
          </div>
          <ul className="plain">
            {state.mcpServers.map((server) => (
              <li key={server.id}>
                <strong>{server.name}</strong>{" "}
                {server.connection.state === "connected" ? (
                  <Chip tone="ok">{messages.settings.mcpTools(server.tools.length)}</Chip>
                ) : server.connection.state === "error" ? (
                  <Chip tone="error">{text(server.connection.message ?? messages.settings.mcpConnectionFailed)}</Chip>
                ) : (
                  <Chip tone="muted">{messages.settings.mcpNotConnected}</Chip>
                )}
                <code>{server.target}</code>
                <button
                  type="button"
                  onClick={() => {
                    void api
                      .connectMcpServer(server.id)
                      .then(() => api.mcpServers())
                      .then((payload) => dispatch({ type: "mcp", servers: payload.servers }))
                      .catch((error: unknown) => setError(errorDisplay(error)));
                  }}
                >
                  {messages.settings.mcpConnect}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void api
                      .deleteMcpServer(server.id)
                      .catch((error: unknown) => setError(errorDisplay(error)));
                  }}
                >
                  {messages.common.delete}
                </button>
              </li>
            ))}
            {state.mcpServers.length === 0 ? <li className="hint">{messages.settings.noMcpServers}</li> : null}
          </ul>
          <div className="row">
            <input placeholder={messages.settings.serverNamePlaceholder} value={serverDraft.name} onChange={(event) => setServerDraft({ ...serverDraft, name: event.target.value })} />
            <select
              value={serverDraft.transport}
              onChange={(event) => setServerDraft({ ...serverDraft, transport: event.target.value as "stdio" | "http" })}
            >
              <option value="stdio">stdio</option>
              <option value="http">http</option>
            </select>
          </div>
          {serverDraft.transport === "stdio" ? (
            <div className="row">
              <input
                placeholder={messages.settings.serverCommandPlaceholder}
                value={serverDraft.command}
                onChange={(event) => setServerDraft({ ...serverDraft, command: event.target.value })}
              />
              <input
                placeholder={messages.settings.serverArgsPlaceholder}
                value={serverDraft.args}
                onChange={(event) => setServerDraft({ ...serverDraft, args: event.target.value })}
              />
            </div>
          ) : (
            <input placeholder="URL" value={serverDraft.url} onChange={(event) => setServerDraft({ ...serverDraft, url: event.target.value })} />
          )}
          <button
            type="button"
            className="primary"
            onClick={() => {
              void api
                .saveMcpServer({
                  name: serverDraft.name,
                  transport: serverDraft.transport,
                  command: serverDraft.command,
                  args: serverDraft.args.split(" ").filter((part) => part.length > 0),
                  url: serverDraft.url,
                  description: serverDraft.description,
                })
                .then(() => api.mcpServers())
                .then((payload) => {
                  dispatch({ type: "mcp", servers: payload.servers });
                  setServerDraft({ name: "", transport: "stdio", command: "", args: "", url: "", description: "" });
                })
                .catch((error: unknown) => setError(errorDisplay(error)));
            }}
          >
            {messages.settings.addServer}
          </button>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
