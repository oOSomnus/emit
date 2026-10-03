/** The model pickers and the per-model connection probe. */

export const englishModel = {
  searchPlaceholder: "Search models…",
  search: "Search models",
  providerFilter: "Filter by provider",
  allProviders: "All providers",
  select: "Select a model",
  notSet: "(Not set)",
  unavailable: (key: string) => `Model unavailable: ${key}`,
  noMatch: "No matching models",
  selectPrompt: "Select a model",
  credentialUnavailable: " (credential unavailable)",
  filterMismatch: " (current selection, filtered out)",
  matchingModels: (count: number) => `${count} ${count === 1 ? "matching model" : "matching models"}`,
  effortLabel: "Reasoning effort",
  noEfforts: "(No efforts available)",
  costWarning: "Sends a real remote model request that may cost money",
  checking: "Checking…",
  check: "Check connection",
};

export type ModelMessages = typeof englishModel;

export const chineseModel: ModelMessages = {
  searchPlaceholder: "搜索模型…",
  search: "搜索模型",
  providerFilter: "按 Provider 筛选",
  allProviders: "全部 Provider",
  select: "选择模型",
  notSet: "（不设置）",
  unavailable: (key) => `模型不可用：${key}`,
  noMatch: "（没有匹配的模型）",
  selectPrompt: "请选择模型",
  credentialUnavailable: "（当前凭据不可用）",
  filterMismatch: "（当前选择，不匹配筛选）",
  matchingModels: (count) => `${count} 个匹配模型`,
  effortLabel: "推理强度",
  noEfforts: "（无可用强度）",
  costWarning: "会发起一次真实的远程模型请求，可能产生费用",
  checking: "检查中…",
  check: "检查连接",
};
