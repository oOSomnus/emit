import type { LlmCallKind, LlmCallStatus } from "../../shared/contracts.ts";

export const englishLlmCalls = {
  tab: "LLM calls",
  tokenUnit: "tokens",
  viewOptions: "Execution record view",
  title: "LLM invocation timeline",
  loading: "Loading model calls…",
  loadFailed: "Could not load model calls.",
  detailLoading: "Loading the full call context…",
  detailFailed: "Could not load this call.",
  retry: "Retry",
  loadOlder: "Load earlier calls",
  empty: "No model calls were captured for this work.",
  noPayload: "No captured payload is available.",
  expand: "Show call details",
  collapse: "Hide call details",
  sequence(number: number): string {
    return `Call ${number}`;
  },
  health: {
    active: "Capture active",
    stopped: "Capture stopped",
    failures(count: number): string {
      return `${count} capture ${count === 1 ? "failure" : "failures"}`;
    },
  },
  kind: {
    employee: "Employee model call",
    compaction: "Context compaction",
    "approval-llm": "Approval review",
    "approval-classifier": "Approval classifier",
  } satisfies Record<LlmCallKind, string>,
  status: {
    running: "Running",
    returned: "Returned",
    failed: "Failed",
    aborted: "Aborted",
    deferred: "Deferred",
    interrupted: "Interrupted",
  } satisfies Record<LlmCallStatus, string>,
  metadata: {
    title: "Invocation metadata",
    kind: "Call type",
    callId: "Call ID",
    status: "Status",
    model: "Model",
    employee: "Employee ID",
    conversation: "Conversation ID",
    approval: "Approval ID",
    started: "Started",
    ended: "Ended",
    revision: "Record revision",
    stopReason: "Stop reason",
    reasoning: "Reasoning effort",
    maxTokens: "Maximum output tokens",
    messageCount: "Messages",
    toolCount: "Tools",
    inputBytes: "Captured input size",
    outputBytes: "Captured output size",
    captureBoundary: "Capture boundary",
    redaction: "Secret redaction",
    redactionApplied: "Applied",
    usage: "Token usage",
    inputTokens: "Input",
    outputTokens: "Output",
    cacheRead: "Cache read",
    cacheWrite: "Cache write",
    totalTokens: "Total",
    reasoningTokens: "Reasoning",
    cost: "Cost",
    costInput: "Input cost",
    costOutput: "Output cost",
    costCacheRead: "Cache-read cost",
    costCacheWrite: "Cache-write cost",
    costTotal: "Total cost",
    counts(messageCount: number, toolCount: number): string {
      return `${messageCount} messages · ${toolCount} tools`;
    },
  },
  input: {
    title: "Input",
    system: "System instructions",
    systemSections: "System sections",
    systemUpdates: "System updates",
    systemSnapshot: "Updated system instructions",
    messages: "Conversation messages",
    tools: "Available tool definitions",
    classifier: "Classifier context",
    state: "State",
    questions: "Questions",
    toolsAdded: "Tools added",
    toolsRemoved: "Tools removed",
    sectionRemoved: "Section removed in this update",
    parameters: "Parameter schema",
    constrainedSampling: "Constrained sampling",
    position(number: number): string {
      return `Position ${number}`;
    },
    update(number: number): string {
      return `Update ${number}`;
    },
  },
  output: {
    title: "Output",
    responses: "Model responses",
    noResponses: "The model has not returned a response yet.",
    answers: "Answers",
    diagnostics: "Diagnostics",
    metadata: "Provider metadata",
    error: "Provider error",
    stopReason: "Stop reason",
    received: "Received",
    source: {
      request: "Request response",
      poll: "Deferred response poll",
    },
    type: {
      response: "Response",
      exception: "Exception",
    },
  },
  message: {
    role: {
      user: "User",
      assistant: "Assistant",
      toolResult: "Tool result",
    },
    tool: "Tool",
    toolCallId: "Tool call ID",
    failed: "Failed",
    timestamp: "Timestamp",
  },
  content: {
    text: "Text",
    structured: "Structured JSON",
    thinking: "Thinking",
    toolCall: "Tool call",
    toolArguments: "Arguments",
    image: "Image",
    imageOmitted: "Image payload omitted",
    redacted: "Redacted",
  },
  json: {
    object(count: number): string {
      return `Object · ${count} ${count === 1 ? "field" : "fields"}`;
    },
    array(count: number): string {
      return `Array · ${count} ${count === 1 ? "item" : "items"}`;
    },
    emptyObject: "Empty object",
    emptyArray: "Empty array",
  },
  omission: {
    title: "Omitted payload data",
    input: "Input",
    output: "Output",
    characters(count: number): string {
      return `${count} characters omitted`;
    },
    kind: {
      image: "Image data",
      "opaque-signature": "Opaque provider signature",
      "deferred-data": "Deferred response data",
    },
  },
  recordingError: "Capture error",
  notAvailable: "Not available",
};

export type LlmCallsMessages = typeof englishLlmCalls;

export const chineseLlmCalls: LlmCallsMessages = {
  tab: "LLM 调用",
  tokenUnit: "token",
  viewOptions: "执行记录视图",
  title: "LLM 调用时间线",
  loading: "正在读取模型调用…",
  loadFailed: "读取模型调用失败。",
  detailLoading: "正在读取完整调用上下文…",
  detailFailed: "读取此调用失败。",
  retry: "重试",
  loadOlder: "加载更早的调用",
  empty: "此工作没有记录到模型调用。",
  noPayload: "没有可用的调用载荷。",
  expand: "显示调用详情",
  collapse: "隐藏调用详情",
  sequence(number) {
    return `调用 ${number}`;
  },
  health: {
    active: "记录已启用",
    stopped: "记录已停止",
    failures(count) {
      return `记录失败 ${count} 次`;
    },
  },
  kind: {
    employee: "员工模型调用",
    compaction: "上下文压缩",
    "approval-llm": "审批审查",
    "approval-classifier": "审批分类器",
  },
  status: {
    running: "运行中",
    returned: "已返回",
    failed: "失败",
    aborted: "已中止",
    deferred: "等待延迟响应",
    interrupted: "已中断",
  },
  metadata: {
    title: "调用元数据",
    kind: "调用类型",
    callId: "调用 ID",
    status: "状态",
    model: "模型",
    employee: "员工 ID",
    conversation: "会话 ID",
    approval: "审批 ID",
    started: "开始时间",
    ended: "结束时间",
    revision: "记录版本",
    stopReason: "停止原因",
    reasoning: "推理强度",
    maxTokens: "最大输出 token 数",
    messageCount: "消息数",
    toolCount: "工具数",
    inputBytes: "输入记录大小",
    outputBytes: "输出记录大小",
    captureBoundary: "捕获边界",
    redaction: "密钥脱敏",
    redactionApplied: "已应用",
    usage: "Token 用量",
    inputTokens: "输入",
    outputTokens: "输出",
    cacheRead: "缓存读取",
    cacheWrite: "缓存写入",
    totalTokens: "总计",
    reasoningTokens: "推理",
    cost: "费用",
    costInput: "输入费用",
    costOutput: "输出费用",
    costCacheRead: "缓存读取费用",
    costCacheWrite: "缓存写入费用",
    costTotal: "总费用",
    counts(messageCount, toolCount) {
      return `${messageCount} 条消息 · ${toolCount} 个工具`;
    },
  },
  input: {
    title: "输入",
    system: "系统指令",
    systemSections: "系统内容分段",
    systemUpdates: "系统指令更新",
    systemSnapshot: "更新后的系统指令",
    messages: "对话消息",
    tools: "可用工具定义",
    classifier: "分类器上下文",
    state: "状态",
    questions: "问题",
    toolsAdded: "新增工具",
    toolsRemoved: "移除工具",
    sectionRemoved: "此更新中已移除该分段",
    parameters: "参数结构",
    constrainedSampling: "受约束采样",
    position(number) {
      return `位置 ${number}`;
    },
    update(number) {
      return `更新 ${number}`;
    },
  },
  output: {
    title: "输出",
    responses: "模型响应",
    noResponses: "模型尚未返回响应。",
    answers: "答案",
    diagnostics: "诊断信息",
    metadata: "提供方元数据",
    error: "提供方错误",
    stopReason: "停止原因",
    received: "接收时间",
    source: {
      request: "请求响应",
      poll: "延迟响应轮询",
    },
    type: {
      response: "响应",
      exception: "异常",
    },
  },
  message: {
    role: {
      user: "用户",
      assistant: "助手",
      toolResult: "工具结果",
    },
    tool: "工具",
    toolCallId: "工具调用 ID",
    failed: "失败",
    timestamp: "时间戳",
  },
  content: {
    text: "文本",
    structured: "结构化 JSON",
    thinking: "思考过程",
    toolCall: "工具调用",
    toolArguments: "参数",
    image: "图像",
    imageOmitted: "图像载荷已省略",
    redacted: "已脱敏",
  },
  json: {
    object(count) {
      return `对象 · ${count} 个字段`;
    },
    array(count) {
      return `数组 · ${count} 项`;
    },
    emptyObject: "空对象",
    emptyArray: "空数组",
  },
  omission: {
    title: "省略的载荷数据",
    input: "输入",
    output: "输出",
    characters(count) {
      return `已省略 ${count} 个字符`;
    },
    kind: {
      image: "图像数据",
      "opaque-signature": "提供方不透明签名",
      "deferred-data": "延迟响应数据",
    },
  },
  recordingError: "捕获错误",
  notAvailable: "不可用",
};
