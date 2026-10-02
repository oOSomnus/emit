/**
 * Settings: the workspace, the approval judge, the collaboration budget,
 * providers and credentials, skills, and MCP servers.
 */

import { useEffect, useState, type ReactNode } from "react";
import { api } from "../api.ts";
import { useApp } from "../state.tsx";
import { Chip, ConnectionCheckButton, EffortPicker, ModelPicker, modelKey } from "./ui.tsx";
import { ProviderManager } from "./ProviderManager.tsx";
import { ThemePicker } from "../theme.tsx";
import type { ApprovalEvaluatorConfigDTO, ModelInfoDTO } from "../../shared/contracts.ts";

/** Move a selection's effort to the first level the new model supports. */
function effortForModel(models: readonly ModelInfoDTO[], key: string, current: string): string {
  const efforts = models.find((model) => modelKey(model) === key)?.efforts ?? [];
  return efforts.includes(current) ? current : efforts[0] ?? "off";
}

export function SettingsView(): ReactNode {
  const { state, dispatch, setError } = useApp();
  const [workspaceName, setWorkspaceName] = useState(state.app?.workspace.name ?? "");
  const [userName, setUserName] = useState(state.app?.user.name ?? "");
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
    setWorkspaceName(state.app?.workspace.name ?? "");
    setUserName(state.app?.user.name ?? "");
  }, [state.app?.workspace.name, state.app?.user.name]);

  const app = state.app;
  if (app === undefined) return <div className="boot">载入中…</div>;

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
      setError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="pane">
      <header className="pane-header">
        <div>
          <h2>设置</h2>
          <p className="topic">
            数据目录：<code>{state.storagePath}</code>
          </p>
        </div>
      </header>

      <div className="scroll settings">
        <section>
          <h3>工作台</h3>
          <div className="row">
            <label>
              工作区名称
              <input value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} />
            </label>
            <label>
              你的名字
              <input value={userName} onChange={(event) => setUserName(event.target.value)} />
            </label>
          </div>
          <p className="hint">你的邮箱地址：{app.user.address}</p>
          <ThemePicker label="外观主题" />
          <div className="row">
            <button
              type="button"
              className="primary"
              onClick={() => {
                void api
                  .updateApp({ workspaceName, userName })
                  .then((next) => dispatch({ type: "app", app: next }))
                  .catch((error: unknown) => setError(error instanceof Error ? error.message : String(error)));
              }}
            >
              保存
            </button>
          </div>
        </section>

        <section>
          <h3>默认模型</h3>
          <div className="row">
            <ModelPicker
              models={chatModels}
              value={app.defaultExecutionModel === null ? "" : modelKey(app.defaultExecutionModel.model)}
              onChange={(key) => {
                if (key === "") {
                  void api
                    .updateApp({ defaultExecutionModel: null })
                    .then((next) => dispatch({ type: "app", app: next }))
                    .catch((error: unknown) => setError(error instanceof Error ? error.message : String(error)));
                  return;
                }
                const [providerId, modelId] = key.split("|");
                if (providerId === undefined || modelId === undefined) return;
                const effort = effortForModel(state.models, key, app.defaultExecutionModel?.effort ?? "off");
                void api
                  .updateApp({ defaultExecutionModel: { model: { providerId, modelId }, effort } })
                  .then((next) => dispatch({ type: "app", app: next }))
                  .catch((error: unknown) => setError(error instanceof Error ? error.message : String(error)));
              }}
              allowEmpty
              label="默认执行模型"
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
                    .catch((error: unknown) => setError(error instanceof Error ? error.message : String(error)));
                }}
                label="默认模型推理强度"
              />
            ) : null}
            <ConnectionCheckButton model={app.defaultExecutionModel?.model} kind="chat" />
          </div>
          <p className="hint">新建员工时默认使用这个模型。「检查连接」会发起一次真实请求，可能产生费用。</p>
        </section>

        <section>
          <h3>审批判断者</h3>
          <p className="hint">
            修改审批配置会提升策略版本（当前 v{app.policyVersion}），此前获批但未执行的调用会失效，需要重新请求。
          </p>
          <p className="hint">低/中风险自动通过，高风险转人工裁决，禁止动作自动拒绝，判断失败阻止执行。</p>
          <p className="hint">审批判断模型单独配置；不会自动沿用员工模型。</p>
          <div className="row">
            <label className="inline">
              <input
                type="radio"
                checked={approval?.kind !== "classifier"}
                onChange={() => {
                  const first = chatModels.find((model) => model.configured);
                  if (first === undefined) {
                    setError("没有可用的对话模型作为 LLM 判断者，请先配置 Provider。");
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
              LLM 判断
            </label>
            <label className="inline">
              <input
                type="radio"
                checked={approval?.kind === "classifier"}
                onChange={() => {
                  const first = state.models.find((model) => model.kind === "classifier" && model.configured);
                  if (first === undefined) {
                    setError("没有可用的分类模型，请先配置支持 classifier 接口的 Provider。");
                    return;
                  }
                  void saveApproval({
                    kind: "classifier",
                    model: { providerId: first.providerId, modelId: first.modelId },
                    criteriaVersion: 3,
                  });
                }}
              />
              分类器
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
                  label="审批判断模型"
                />
                {approval.kind === "llm" ? (
                  <EffortPicker
                    efforts={
                      state.models.find((model) => modelKey(model) === modelKey(approval.model))?.efforts ?? []
                    }
                    value={approval.effort}
                    onChange={(effort) => void saveApproval({ ...approval, effort })}
                    label="判断模型推理强度"
                  />
                ) : null}
                <ConnectionCheckButton model={approval.model} kind={approval.kind === "llm" ? "chat" : "classifier"} />
              </div>
            </>
          ) : (
            <p className="hint">未配置审批判断者：自动审查不可用，有风险的调用会被阻止执行。</p>
          )}
        </section>

        <section>
          <h3>协作上限</h3>
          <div className="row">
            <label>
              交办层数
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
              跨员工唤醒次数
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
              模型轮次
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

        <ProviderManager />

        <section>
          <h3>技能</h3>
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
                      .catch((error: unknown) => setError(error instanceof Error ? error.message : String(error)));
                  }}
                >
                  移除
                </button>
              </li>
            ))}
            {state.skills.length === 0 ? <li className="hint">还没有技能。</li> : null}
          </ul>
          <div className="row">
            <input
              placeholder="包含 SKILL.md 的目录，例如 ~/.claude/skills"
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
                  .catch((error: unknown) => setError(error instanceof Error ? error.message : String(error)));
              }}
            >
              导入
            </button>
          </div>
          {skillDiagnostics.map((diagnostic) => (
            <p key={`${diagnostic.path}-${diagnostic.message}`} className="hint">
              [{diagnostic.severity}] {diagnostic.path}: {diagnostic.message}
            </p>
          ))}
        </section>

        <section>
          <h3>MCP 服务</h3>
          <ul className="plain">
            {state.mcpServers.map((server) => (
              <li key={server.id}>
                <strong>{server.name}</strong>{" "}
                {server.connection.state === "connected" ? (
                  <Chip tone="ok">{server.tools.length} 个工具</Chip>
                ) : server.connection.state === "error" ? (
                  <Chip tone="error">{server.connection.message ?? "连接失败"}</Chip>
                ) : (
                  <Chip tone="muted">未连接</Chip>
                )}
                <code>{server.target}</code>
                <button
                  type="button"
                  onClick={() => {
                    void api
                      .connectMcpServer(server.id)
                      .then(() => api.mcpServers())
                      .then((payload) => dispatch({ type: "mcp", servers: payload.servers }))
                      .catch((error: unknown) => setError(error instanceof Error ? error.message : String(error)));
                  }}
                >
                  连接
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void api
                      .deleteMcpServer(server.id)
                      .catch((error: unknown) => setError(error instanceof Error ? error.message : String(error)));
                  }}
                >
                  删除
                </button>
              </li>
            ))}
            {state.mcpServers.length === 0 ? <li className="hint">还没有 MCP 服务。</li> : null}
          </ul>
          <div className="row">
            <input placeholder="名称" value={serverDraft.name} onChange={(event) => setServerDraft({ ...serverDraft, name: event.target.value })} />
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
                placeholder="命令，例如 npx"
                value={serverDraft.command}
                onChange={(event) => setServerDraft({ ...serverDraft, command: event.target.value })}
              />
              <input
                placeholder="参数，空格分隔"
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
                .catch((error: unknown) => setError(error instanceof Error ? error.message : String(error)));
            }}
          >
            添加服务
          </button>
        </section>
      </div>
    </div>
  );
}
