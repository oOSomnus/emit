/**
 * The Settings page.
 *
 * Provider management is rendered by `ProviderManager` inside this page; its
 * wording lives in the providers group, not here.
 */

export const englishSettings = {
  title: "Settings",
  dataDirectory: "Data directory: ",
  sections: "Settings sections",
  sectionPicker: "Settings section",
  localData: "Local data",

  // Workspace: identity, appearance, and interface language.
  workspace: "Workspace",
  yourName: "Your name",
  yourAddress: "Your mail address: ",

  // Default model.
  defaultModel: "Default model",
  defaultExecutionModel: "Default execution model",
  defaultModelEffort: "Default model effort",
  defaultModelHint: "Used for new employees; checking the connection may incur charges.",

  // Approval judge.
  approvalJudge: "Approval judge",
  approvalRules: "Approval rules",
  policyVersionHint: (version: number) =>
    `Policy v${version}; changes invalidate approvals that have not executed.`,
  riskPolicyHint:
    "Low and medium risk calls pass automatically, high risk goes to a human decision, forbidden actions are " +
    "rejected automatically, and a failed judgment blocks execution.",
  separateJudgeHint:
    "The approval judge model is configured separately; it does not follow the employee model automatically.",
  llmJudge: "LLM judge",
  classifier: "Classifier",
  judgeModel: "Approval judge model",
  judgeEffort: "Judge model effort",
  noJudgeHint:
    "No approval judge is configured: automatic review is unavailable, and risky calls are blocked from executing.",
  noLlmJudge: "No chat model is available to serve as the LLM judge. Configure a provider first.",
  noClassifier: "No classifier model is available. Configure a provider that supports the classifier interface first.",

  // Collaboration limits.
  collaboration: "Collaboration limits",
  delegationDepth: "Delegation depth",
  crossEmployeeWakes: "Cross-employee wake-ups",
  modelTurns: "Model turns",

  // Skills.
  skills: "Skills",
  noSkills: "No skills yet.",
  skillDirPlaceholder: "Directory containing SKILL.md, e.g. ~/.claude/skills",
  importSkill: "Import",

  // MCP servers.
  mcp: "MCP servers",
  mcpTools: (count: number) => `${count} ${count === 1 ? "tool" : "tools"}`,
  mcpConnectionFailed: "Connection failed",
  mcpNotConnected: "Not connected",
  mcpConnect: "Connect",
  noMcpServers: "No MCP servers yet.",
  serverNamePlaceholder: "Name",
  serverCommandPlaceholder: "Command, e.g. npx",
  serverArgsPlaceholder: "Arguments, space-separated",
  addServer: "Add server",
};

export type SettingsMessages = typeof englishSettings;

export const chineseSettings: SettingsMessages = {
  title: "设置",
  dataDirectory: "数据目录：",
  sections: "设置分区",
  sectionPicker: "设置分区",
  localData: "本地数据",

  workspace: "工作台",
  yourName: "你的名字",
  yourAddress: "你的邮箱地址：",

  defaultModel: "默认模型",
  defaultExecutionModel: "默认执行模型",
  defaultModelEffort: "默认模型推理强度",
  defaultModelHint: "新员工默认使用；检查连接可能产生费用。",

  approvalJudge: "审批判断者",
  approvalRules: "审批规则",
  policyVersionHint: (version) => `策略 v${version}；更改配置会使尚未执行的旧审批失效。`,
  riskPolicyHint: "低/中风险自动通过，高风险转人工裁决，禁止动作自动拒绝，判断失败阻止执行。",
  separateJudgeHint: "审批判断模型单独配置；不会自动沿用员工模型。",
  llmJudge: "LLM 判断",
  classifier: "分类器",
  judgeModel: "审批判断模型",
  judgeEffort: "判断模型推理强度",
  noJudgeHint: "未配置审批判断者：自动审查不可用，有风险的调用会被阻止执行。",
  noLlmJudge: "没有可用的对话模型作为 LLM 判断者，请先配置 Provider。",
  noClassifier: "没有可用的分类模型，请先配置支持 classifier 接口的 Provider。",

  collaboration: "协作上限",
  delegationDepth: "交办层数",
  crossEmployeeWakes: "跨员工唤醒次数",
  modelTurns: "模型轮次",

  skills: "技能",
  noSkills: "还没有技能。",
  skillDirPlaceholder: "包含 SKILL.md 的目录，例如 ~/.claude/skills",
  importSkill: "导入",

  mcp: "MCP 服务",
  mcpTools: (count) => `${count} 个工具`,
  mcpConnectionFailed: "连接失败",
  mcpNotConnected: "未连接",
  mcpConnect: "连接",
  noMcpServers: "还没有 MCP 服务。",
  serverNamePlaceholder: "名称",
  serverCommandPlaceholder: "命令，例如 npx",
  serverArgsPlaceholder: "参数，空格分隔",
  addServer: "添加服务",
};
