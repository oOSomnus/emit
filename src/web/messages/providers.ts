/**
 * Provider management, model catalog maintenance, and the native login flow.
 *
 * Provider and model names, `authSource` values, and every prompt, event, and
 * error that comes from a provider's own login flow are native text and pass
 * through unchanged; only the surrounding interface words live here.
 */

export const englishProviders = {
  legend: "Model providers",
  intro: (count: number) =>
    `Lists all ${count} Pi-native providers. Authentication is stored only in the local data directory; ` +
    `"Configured" only means a credential is ready — it does not mean the connection was verified. ` +
    `Use "Check connection" next to a model to verify it for real.`,
  searchPlaceholder: "Search providers…",
  search: "Search providers",
  configuredOnly: "Configured only",
  addCustom: "Add custom provider",
  activeSession: (name: string) => `An authentication session is in progress: ${name}`,
  view: "View",
  chipCustom: "Custom",
  authSourceConfigured: "Configured",
  notConfigured: "Not configured",
  noMatch: "No matching providers.",
  selectHint: "Select a provider on the left to see details.",

  // Login session status: the keys are the data (`AuthSessionStatusDTO`).
  status: {
    running: "In progress",
    waiting: "Waiting for input",
    succeeded: "Saved",
    failed: "Failed",
    cancelled: "Cancelled",
  },

  // The inserted values are the raw `authSource` text or a dictionary word.
  credentialSource: (source: string) => `Credential source: ${source}`,
  storedAuth: (stored: string) => `Stored authentication: ${stored}`,
  authCheckError: (detail: string) => `Auth check error: ${detail}`,
  loginSubscription: (label: string) => `Subscription sign-in: ${label}`,
  login: (label: string) => `Sign-in: ${label}`,
  setupKey: (label: string) => `Set up ${label}`,
  removeCredential: "Remove saved credential",
  refreshCatalog: "Refresh model catalog",
  editConfig: "Edit configuration",
  deleteProvider: "Delete provider",
  authInteractionError: (detail: string) => `Authentication interaction error: ${detail}`,

  modelsHeading: (count: number) => `Models (${count})`,
  contextHint: (tokens: number) => `Context ${tokens}`,
  modelAvailable: "Available",
  modelCredentialUnavailable: "Not available with the current credential",
  noModels: "This provider has no browsable chat or classifier models.",

  authStatus: (label: string) => `Authentication status: ${label}`,
  submit: "Submit",
  cancelAuth: "Cancel authentication",
  openAuthPage: "Open authorization page",

  // The device-code event wraps a native verification URL: one fragment before
  // it and one after it, in each language's own word order.
  deviceCode: "Device code",
  deviceCodeAt: ", enter it at ",
  deviceCodeEnter: "",
  deviceCodeExpiry: (minutes: number) => ` (valid for ${minutes} minutes)`,

  credentialRemoved: "Removed the saved credential",
  savedKeepKey: "Configuration saved; the stored API key is unchanged",
  savedNoCredential: "Configuration saved (no credential needed)",
  deleteConfirm: (id: string) => `Delete custom provider ${id}?`,
  deleteReferencesNote: (references: string[]) =>
    `\n\nThe following configurations still reference it, so those models will stop working after deletion ` +
    `(the references are not rewritten):\n${references.join("\n")}`,
  referenceDefaultModel: (modelId: string) => `Default model: ${modelId}`,
  referenceApprovalModel: (modelId: string) => `Approval judge model: ${modelId}`,
  referenceEmployee: (name: string, modelId: string) => `Employee ${name}: ${modelId}`,

  editCustomTitle: (id: string) => `Edit custom provider ${id}`,
  idPlaceholder: "e.g. my-gateway",
  nameLabel: "Name",
  apiLabel: "API",
  authModeKey: "Requires an API key",
  authModeNone: "No credential needed",
  apiKeyEnvLabel: "Environment variable name (advanced; the default is fine)",
  modelsLegend: "Models",
  addModel: "Add model",
  saveConfig: "Save configuration",
};

export type ProvidersMessages = typeof englishProviders;

export const chineseProviders: ProvidersMessages = {
  legend: "模型 Provider",
  intro: (count) =>
    `这里列出 Pi 原生的全部 ${count} 个 Provider。认证只保存在本机数据目录； ` +
    `「已配置认证」只表示凭据就绪，不代表连接已验证——用模型旁的「检查连接」实际验证。`,
  searchPlaceholder: "搜索 Provider…",
  search: "搜索 Provider",
  configuredOnly: "只看已配置",
  addCustom: "添加自定义接口",
  activeSession: (name) => `有进行中的认证会话：${name}`,
  view: "查看",
  chipCustom: "自定义",
  authSourceConfigured: "已配置",
  notConfigured: "未配置",
  noMatch: "没有匹配的 Provider。",
  selectHint: "选择左侧的 Provider 查看详情。",

  status: {
    running: "进行中",
    waiting: "等待输入",
    succeeded: "已保存",
    failed: "失败",
    cancelled: "已取消",
  },

  credentialSource: (source) => `凭据来源：${source}`,
  storedAuth: (stored) => `已保存认证：${stored}`,
  authCheckError: (detail) => `认证检查错误：${detail}`,
  loginSubscription: (label) => `订阅登录：${label}`,
  login: (label) => `登录：${label}`,
  setupKey: (label) => `设置 ${label}`,
  removeCredential: "移除已保存凭据",
  refreshCatalog: "刷新模型目录",
  editConfig: "编辑配置",
  deleteProvider: "删除接口",
  authInteractionError: (detail) => `认证交互错误：${detail}`,

  modelsHeading: (count) => `模型（${count}）`,
  contextHint: (tokens) => `上下文 ${tokens}`,
  modelAvailable: "可用",
  modelCredentialUnavailable: "当前凭据不可用",
  noModels: "该 Provider 没有可浏览的对话或分类模型。",

  authStatus: (label) => `认证状态：${label}`,
  submit: "提交",
  cancelAuth: "取消认证",
  openAuthPage: "打开授权页面",

  deviceCode: "设备码",
  deviceCodeAt: "，在 ",
  deviceCodeEnter: " 输入",
  deviceCodeExpiry: (minutes) => `（${minutes} 分钟内有效）`,

  credentialRemoved: "已移除保存的凭据",
  savedKeepKey: "配置已保存，已保存的 API Key 保持不变",
  savedNoCredential: "配置已保存（无需凭据）",
  deleteConfirm: (id) => `确定删除自定义接口 ${id}？`,
  deleteReferencesNote: (references) =>
    `\n\n以下配置仍引用它，删除后这些模型将不可用（引用不会被改写）：\n${references.join("\n")}`,
  referenceDefaultModel: (modelId) => `默认模型：${modelId}`,
  referenceApprovalModel: (modelId) => `审批判断模型：${modelId}`,
  referenceEmployee: (name, modelId) => `员工 ${name}：${modelId}`,

  editCustomTitle: (id) => `编辑自定义接口 ${id}`,
  idPlaceholder: "例如 my-gateway",
  nameLabel: "名称",
  apiLabel: "接口协议",
  authModeKey: "需要 API Key",
  authModeNone: "无需凭据",
  apiKeyEnvLabel: "环境变量名（高级，可留默认）",
  modelsLegend: "模型",
  addModel: "添加模型",
  saveConfig: "保存配置",
};
