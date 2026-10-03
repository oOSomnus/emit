/** First run: name the workspace, connect providers, pick the models, and open the door. */

import { useEffect, useState, type ReactNode } from "react";
import { api } from "../api.ts";
import { errorDisplay } from "../../shared/i18n.ts";
import { LanguagePicker, useI18n } from "../i18n.tsx";
import { uiText } from "../messages.ts";
import { useApp } from "../state.tsx";
import { ConnectionCheckButton, EffortPicker, ModelPicker, modelKey } from "./ui.tsx";
import { ProviderManager } from "./ProviderManager.tsx";
import { ThemePicker } from "../theme.tsx";
import type { ApprovalEvaluatorConfigDTO, ModelInfoDTO } from "../../shared/contracts.ts";

export function Onboarding(): ReactNode {
  const { state, reload, setError } = useApp();
  const { messages } = useI18n();
  // An untouched workspace name follows the interface language; any edit —
  // including clearing the field — pins the value so a switch cannot overwrite
  // what the user typed.
  const [workspaceName, setWorkspaceName] = useState("");
  const [workspaceNameEdited, setWorkspaceNameEdited] = useState(false);
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
      setError(uiText((m) => m.onboarding.errorName));
      return;
    }
    if (selectedChat === undefined || !selectedChat.configured) {
      setError(uiText((m) => m.onboarding.errorChatModel));
      return;
    }
    if (selectedApproval === undefined || !selectedApproval.configured) {
      setError(uiText((m) => m.onboarding.errorJudgeModel));
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const approval: ApprovalEvaluatorConfigDTO =
        approvalKind === "llm"
          ? {
              kind: "llm",
              model: { providerId: selectedApproval.providerId, modelId: selectedApproval.modelId },
              effort: selectedApproval.efforts[0] ?? "off",
              criteriaVersion: 3,
            }
          : {
              kind: "classifier",
              model: { providerId: selectedApproval.providerId, modelId: selectedApproval.modelId },
              criteriaVersion: 3,
            };
      await api.setup({
        workspaceName:
          workspaceName.trim().length > 0 ? workspaceName.trim() : messages.onboarding.defaultWorkspace,
        userName: userName.trim(),
        defaultExecutionModel: {
          model: { providerId: selectedChat.providerId, modelId: selectedChat.modelId },
          effort,
        },
        approval,
      });
      await reload();
    } catch (error) {
      setError(errorDisplay(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="onboarding">
      <h1>Emit</h1>
      <p className="lede">{messages.onboarding.lede}</p>

      <fieldset>
        <legend>{messages.onboarding.appearanceLegend}</legend>
        <ThemePicker label={messages.onboarding.themeLabel} />
        <LanguagePicker />
        <p className="hint">{messages.onboarding.appearanceHint}</p>
      </fieldset>

      <div className="field-grid">
        <label>
          {messages.onboarding.workspaceNameLabel}
          <input
            value={workspaceNameEdited ? workspaceName : messages.onboarding.defaultWorkspace}
            onChange={(event) => {
              setWorkspaceName(event.target.value);
              setWorkspaceNameEdited(true);
            }}
          />
        </label>

        <label>
          {messages.onboarding.userNameLabel}
          <input
            value={userName}
            onChange={(event) => setUserName(event.target.value)}
            placeholder={messages.onboarding.userNamePlaceholder}
          />
        </label>
      </div>
      <ProviderManager />

      <div className="field-grid field-grid-three">
        <label>
          {messages.onboarding.defaultModelLabel}
          <ModelPicker models={chatModels} value={chatModel} onChange={selectChat} label={messages.onboarding.defaultModelLabel} />
        </label>
        <label>
          {messages.model.effortLabel}
          <EffortPicker
            efforts={selectedChat?.efforts ?? []}
            value={effort}
            onChange={setEffort}
            label={messages.onboarding.defaultEffortLabel}
          />
        </label>
        <ConnectionCheckButton model={selectedChat} kind="chat" />
      </div>

      <fieldset>
        <legend>{messages.onboarding.approvalLegend}</legend>
        <p className="hint">{messages.onboarding.approvalRiskHint}</p>
        <p className="hint">{messages.onboarding.approvalModelHint}</p>
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
            {messages.onboarding.llmJudge}
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
            {messages.onboarding.classifierJudge}
          </label>
        </div>
        <label>
          {messages.onboarding.judgeModelLabel}
          <ModelPicker
            models={approvalModels}
            value={approvalModel}
            onChange={setApprovalModel}
            label={messages.onboarding.judgeModelPickerLabel}
          />
        </label>
        {approvalModels.length === 0 ? (
          <p className="hint">{messages.onboarding.noModels(approvalKind === "llm" ? "chat" : "classifier")}</p>
        ) : null}
      </fieldset>

      <div className="row">
        <button type="button" className="primary" disabled={busy} onClick={() => void submit()}>
          {busy ? messages.onboarding.busyButton : messages.onboarding.enterButton}
        </button>
        {state.providers.some((provider) => provider.configured) ? null : (
          <span className="hint">{messages.onboarding.noCredentialsHint}</span>
        )}
      </div>
    </div>
  );
}
