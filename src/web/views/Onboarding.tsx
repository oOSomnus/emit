/** First run: name the workspace, connect providers, pick the models, and open the door. */

import { useEffect, useState, type ReactNode } from "react";
import { api } from "../api.ts";
import { useApp } from "../state.tsx";
import { ConnectionCheckButton, EffortPicker, ModelPicker, modelKey } from "./ui.tsx";
import { ProviderManager } from "./ProviderManager.tsx";
import { ThemePicker } from "../theme.tsx";
import type { ApprovalEvaluatorConfigDTO, ModelInfoDTO } from "../../shared/contracts.ts";

export function Onboarding(): ReactNode {
  const { state, reload, setError } = useApp();
  const [workspaceName, setWorkspaceName] = useState("我的数字团队");
  const [userName, setUserName] = useState("");
  const [chatModel, setChatModel] = useState<string>("");
  const [effort, setEffort] = useState("off");
  const [approvalKind, setApprovalKind] = useState<"llm" | "classifier">("llm");
  const [approvalModel, setApprovalModel] = useState<string>("");
  const [busy, setBusy] = useState(false);

  const chatModels = state.models.filter((model) => model.kind === "chat");
  const approvalModels = state.models.filter((model) =>
    approvalKind === "llm" ? model.kind === "chat" : model.kind === "classifier",
  );
  const selectedChat = state.models.find((model) => modelKey(model) === chatModel);
  const selectedApproval = approvalModels.find((model) => modelKey(model) === approvalModel);

  // Only seed a draft that is still empty, and only from a configured model:
  // never overwrite a deliberate choice with the first catalog entry.
  useEffect(() => {
    if (chatModel.length > 0) return;
    const first = chatModels.find((model) => model.configured);
    if (first !== undefined) setChatModel(modelKey(first));
  }, [chatModel, chatModels]);

  useEffect(() => {
    if (approvalModel.length > 0) return;
    const first = approvalModels.find((model) => model.configured);
    if (first !== undefined) setApprovalModel(modelKey(first));
  }, [approvalModel, approvalModels]);

  const selectChat = (key: string): void => {
    setChatModel(key);
    const model: ModelInfoDTO | undefined = state.models.find((entry) => modelKey(entry) === key);
    const efforts = model?.efforts ?? [];
    setEffort(efforts.includes(effort) ? effort : efforts[0] ?? "off");
  };

  const submit = async (): Promise<void> => {
    if (userName.trim().length === 0) {
      setError("请填写你的名字");
      return;
    }
    if (selectedChat === undefined || !selectedChat.configured) {
      setError("请选择一个可用的对话模型（先在上面的 Provider 列表中完成认证）");
      return;
    }
    if (approvalModel.length > 0 && (selectedApproval === undefined || !selectedApproval.configured)) {
      setError("审批判断模型不可用，请重新选择或清空");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const approval: ApprovalEvaluatorConfigDTO | null =
        selectedApproval === undefined
          ? null
          : approvalKind === "llm"
            ? {
                kind: "llm",
                model: { providerId: selectedApproval.providerId, modelId: selectedApproval.modelId },
                effort: selectedApproval.efforts[0] ?? "off",
                criteriaVersion: 2,
              }
            : {
                kind: "classifier",
                model: { providerId: selectedApproval.providerId, modelId: selectedApproval.modelId },
                criteriaVersion: 2,
                minApproveProbability: 0.85,
                minAuthorizedProbability: 0.8,
                requireAuthorized: true,
              };
      await api.setup({
        workspaceName: workspaceName.trim().length > 0 ? workspaceName.trim() : "我的数字团队",
        userName: userName.trim(),
        defaultExecutionModel: {
          model: { providerId: selectedChat.providerId, modelId: selectedChat.modelId },
          effort,
        },
        approval,
      });
      await reload();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="onboarding">
      <h1>Emit</h1>
      <p className="lede">
        一个只在本地运行的数字员工工作台。员工用消息即时协作，用邮件异步交付；每一次工具调用、审批和回复都持久保存，进程重启后可以继续。
      </p>

      <fieldset>
        <legend>外观</legend>
        <ThemePicker label="主题" />
        <p className="hint">可以随时在左侧栏底部切换浅色、深色或跟随系统。</p>
      </fieldset>

      <label>
        工作区名称
        <input value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} />
      </label>

      <label>
        你的名字
        <input value={userName} onChange={(event) => setUserName(event.target.value)} placeholder="用于生成你的邮箱地址" />
      </label>

      <ProviderManager />

      <div className="row">
        <label>
          员工默认模型
          <ModelPicker models={chatModels} value={chatModel} onChange={selectChat} label="员工默认模型" />
        </label>
        <label>
          推理强度
          <EffortPicker
            efforts={selectedChat?.efforts ?? []}
            value={effort}
            onChange={setEffort}
            label="默认模型推理强度"
          />
        </label>
        <ConnectionCheckButton model={selectedChat} kind="chat" />
      </div>

      <fieldset>
        <legend>审批判断者</legend>
        <p className="hint">有风险的工具调用（写文件、执行命令、MCP 调用）先由它判断；它拿不准时转给你人工裁决。</p>
        <div className="row">
          <label className="inline">
            <input
              type="radio"
              checked={approvalKind === "llm"}
              onChange={() => {
                setApprovalKind("llm");
                setApprovalModel("");
              }}
            />
            LLM 判断
          </label>
          <label className="inline">
            <input
              type="radio"
              checked={approvalKind === "classifier"}
              onChange={() => {
                setApprovalKind("classifier");
                setApprovalModel("");
              }}
            />
            分类器（需要模型支持 classifier 接口）
          </label>
        </div>
        <label>
          判断模型
          <ModelPicker
            models={approvalModels}
            value={approvalModel}
            onChange={setApprovalModel}
            allowEmpty
            label="审批判断模型"
          />
        </label>
        {approvalModels.length === 0 ? (
          <p className="hint">
            没有{approvalKind === "llm" ? "对话" : "分类"}模型可用；可以先不设置审批判断者，之后在设置页补充。
          </p>
        ) : null}
      </fieldset>

      <div className="row">
        <button type="button" className="primary" disabled={busy} onClick={() => void submit()}>
          {busy ? "正在创建…" : "进入工作台"}
        </button>
        {state.providers.some((provider) => provider.configured) ? null : (
          <span className="hint">还没有可用的 Provider 凭据：在上面的列表中选择 Provider 并完成认证。</span>
        )}
      </div>
    </div>
  );
}
