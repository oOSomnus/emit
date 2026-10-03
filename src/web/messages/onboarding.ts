/**
 * First-run setup.
 *
 * Every key the view uses lives here in both languages; the workspace-name
 * default is a seed value, so it is a dictionary entry rather than a literal
 * in the component. Validation errors are short sentences the app authors,
 * captured as pairs with `uiText` at the moment they are raised.
 */

export const englishOnboarding = {
  defaultWorkspace: "My digital team",
  lede: "A digital-employee workspace that runs entirely locally. Employees collaborate over instant messages and deliver over email; every tool call, approval, and reply is stored durably and resumes after a restart.",
  appearanceLegend: "Appearance",
  themeLabel: "Theme",
  appearanceHint: "You can switch light, dark, or system at any time from the bottom of the sidebar.",
  workspaceNameLabel: "Workspace name",
  userNameLabel: "Your name",
  userNamePlaceholder: "Used to generate your email address",
  defaultModelLabel: "Default employee model",
  defaultEffortLabel: "Default model reasoning effort",
  approvalLegend: "Approval judge",
  approvalRiskHint: "Low- and medium-risk actions pass automatically, high risk goes to a human decision, forbidden actions are rejected, and a failed judgment blocks execution.",
  approvalModelHint: "Choose a separate available model for the automatic review; the employee's model is not reused automatically.",
  llmJudge: "LLM judge",
  classifierJudge: "Classifier (requires a model with a classifier interface)",
  judgeModelLabel: "Judge model",
  judgeModelPickerLabel: "Approval judge model",
  noModels: (kind: "chat" | "classifier"): string =>
    kind === "chat"
      ? "No chat model is available; configure a working provider and a judge model to continue."
      : "No classifier model is available; configure a working provider and a judge model to continue.",
  busyButton: "Creating…",
  enterButton: "Enter workspace",
  noCredentialsHint: "No provider credentials yet: pick a provider in the list above and complete sign-in.",
  errorName: "Please enter your name",
  errorChatModel: "Please pick an available chat model (first complete sign-in in the provider list above)",
  errorJudgeModel: "Please pick an available approval judge model",
};

export type OnboardingMessages = typeof englishOnboarding;

export const chineseOnboarding: OnboardingMessages = {
  defaultWorkspace: "我的数字团队",
  lede: "一个只在本地运行的数字员工工作台。员工用消息即时协作，用邮件异步交付；每一次工具调用、审批和回复都持久保存，进程重启后可以继续。",
  appearanceLegend: "外观",
  themeLabel: "主题",
  appearanceHint: "可以随时在左侧栏底部切换浅色、深色或跟随系统。",
  workspaceNameLabel: "工作区名称",
  userNameLabel: "你的名字",
  userNamePlaceholder: "用于生成你的邮箱地址",
  defaultModelLabel: "员工默认模型",
  defaultEffortLabel: "默认模型推理强度",
  approvalLegend: "审批判断者",
  approvalRiskHint: "低/中风险自动通过，高风险转人工裁决，禁止动作自动拒绝，判断失败阻止执行。",
  approvalModelHint: "请为自动审查单独选择一个可用模型，不会自动沿用员工模型。",
  llmJudge: "LLM 判断",
  classifierJudge: "分类器（需要模型支持 classifier 接口）",
  judgeModelLabel: "判断模型",
  judgeModelPickerLabel: "审批判断模型",
  noModels: (kind) =>
    kind === "chat"
      ? "没有对话模型可用；请先配置一个可用的 Provider 和判断模型，才能继续。"
      : "没有分类模型可用；请先配置一个可用的 Provider 和判断模型，才能继续。",
  busyButton: "正在创建…",
  enterButton: "进入工作台",
  noCredentialsHint: "还没有可用的 Provider 凭据：在上面的列表中选择 Provider 并完成认证。",
  errorName: "请填写你的名字",
  errorChatModel: "请选择一个可用的对话模型（先在上面的 Provider 列表中完成认证）",
  errorJudgeModel: "请选择一个可用的审批判断模型",
};
