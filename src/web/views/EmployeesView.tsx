/**
 * The employee roster and the editor that defines one.
 *
 * Everything an employee is — role, instructions, model, working directory,
 * skills, MCP servers, allow list, and trusted read-only tools — is edited
 * here. Saving bumps the employee's configuration version, which is part of
 * every approval key, so a later change cannot silently inherit an old grant.
 */

import { useState, type ReactNode } from "react";
import { api } from "../api.ts";
import { useApp } from "../state.tsx";
import { Chip, ConnectionCheckButton, EffortPicker, ModelPicker, modelKey } from "./ui.tsx";
import type { EmployeeDTO } from "../../shared/contracts.ts";

const BUILTIN_TOOLS = ["read_file", "write_file", "edit_file", "run_shell", "load_skill"];

type Draft = {
  name: string;
  role: string;
  instructions: string;
  modelKey: string;
  effort: string;
  cwd: string;
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
      cwd: "",
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
    cwd: employee.cwd,
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
      setError("请填写员工的名字与角色");
      return;
    }
    const [providerId, modelId] = draft.modelKey.split("|");
    if (providerId === undefined || modelId === undefined) {
      setError("请选择员工的模型");
      return;
    }
    setBusy(true);
    try {
      const payload = {
        name: draft.name.trim(),
        role: draft.role.trim(),
        instructions: draft.instructions,
        executionModel: { model: { providerId, modelId }, effort: draft.effort },
        cwd: draft.cwd.trim(),
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
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pane">
      <header className="pane-header">
        <div>
          <h2>员工</h2>
          <p className="topic">{state.employees.length} 位数字员工 · 每位拥有独立的角色、技能、MCP 与工具权限</p>
        </div>
        <button type="button" className="primary" onClick={openNew}>
          新建员工
        </button>
      </header>

      <div className="scroll split employees-layout">
        <div className="list">
          {state.employees.length === 0 ? <p className="hint">还没有员工。先创建一位，给他一个角色和一份技能。</p> : null}
          {state.employees.map((employee) => (
            <button
              key={employee.id}
              type="button"
              className={editing === employee.id ? "employee-card active" : "employee-card"}
              onClick={() => openEdit(employee)}
            >
              <strong>{employee.name}</strong>
              <span className="address">{employee.address}</span>
              <span className="role">{employee.role}</span>
              <span className="tags">
                {employee.enabled ? <Chip tone="ok">启用</Chip> : <Chip tone="muted">停用</Chip>}
                {employee.skillIds.length > 0 ? <Chip tone="info">{employee.skillIds.length} 技能</Chip> : null}
                {employee.mcpServerIds.length > 0 ? <Chip tone="info">{employee.mcpServerIds.length} MCP</Chip> : null}
                <Chip tone="muted">v{employee.configVersion}</Chip>
              </span>
            </button>
          ))}
        </div>

        {editing !== undefined ? (
          <section className="editor">
            <h3>{editing === "new" ? "新员工" : "编辑员工"}</h3>
            <label>
              名字
              <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
            </label>
            <label>
              角色
              <input
                value={draft.role}
                placeholder="例如：前端工程师 / 研究助理"
                onChange={(event) => setDraft({ ...draft, role: event.target.value })}
              />
            </label>
            <label>
              工作准则
              <textarea
                value={draft.instructions}
                placeholder="这个员工长期遵循的做事方式、输出格式、禁忌。"
                onChange={(event) => setDraft({ ...draft, instructions: event.target.value })}
              />
            </label>
            <fieldset>
              <legend>模型与推理强度</legend>
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
                label="员工模型"
              />
              <EffortPicker
                efforts={selectedModel?.efforts ?? []}
                value={draft.effort}
                onChange={(effort) => setDraft({ ...draft, effort })}
                label="员工模型推理强度"
              />
              <ConnectionCheckButton model={selectedModel} kind="chat" />
              </div>
            </fieldset>
            <fieldset>
              <legend>工作目录</legend>
            <label>
              工作目录
              <input
                value={draft.cwd}
                placeholder="留空表示不能读写文件；填写后文件与命令都限制在该目录内"
                onChange={(event) => setDraft({ ...draft, cwd: event.target.value })}
              />
            </label>
            </fieldset>
            {editing === "new" ? (
              <label className="inline">
                <input
                  type="checkbox"
                  checked={draft.generateAddress}
                  onChange={(event) => setDraft({ ...draft, generateAddress: event.target.checked })}
                />
                让模型根据名字与工作区生成邮箱地址
              </label>
            ) : null}

            <fieldset>
              <legend>技能</legend>
              {state.skills.length === 0 ? <p className="hint">还没有导入技能，可在设置页导入 Skills 目录。</p> : null}
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
              <legend>MCP 服务</legend>
              {state.mcpServers.length === 0 ? <p className="hint">还没有 MCP 服务。</p> : null}
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
                    {server.connection.state === "connected" ? `${server.tools.length} 个工具` : server.connection.message ?? "未连接"}
                  </span>
                </label>
              ))}
            </fieldset>

            <fieldset>
              <legend>允许的工具</legend>
              <p className="hint">未列出的内置工具会被直接拒绝，不会进入审批流程。协作工具（发消息、发邮件、交办）始终可用。</p>
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
              <legend>信任为只读的 MCP 工具</legend>
              <p className="hint">只读信任是你给出的判断；未被信任的 MCP 调用同样会进入审批。</p>
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
                        {tool.readOnly ? <span className="hint">服务声明只读</span> : null}
                      </label>
                    );
                  }),
                )}
            </fieldset>

            <div className="row">
              <button type="button" className="primary" disabled={busy} onClick={() => void save()}>
                {busy ? "保存中…" : "保存"}
              </button>
              <button type="button" onClick={() => setEditing(undefined)}>
                取消
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
                      .catch((error: unknown) => setError(error instanceof Error ? error.message : String(error)));
                  }}
                >
                  删除
                </button>
              ) : null}
            </div>
          </section>
        ) : (
          <section className="editor">
            <p className="hint">选择一位员工来编辑，或新建一位。</p>
          </section>
        )}
      </div>
    </div>
  );
}
