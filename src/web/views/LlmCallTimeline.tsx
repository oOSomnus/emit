import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { errorDisplay, type DisplayText, type Locale } from "../../shared/i18n.ts";
import type {
  LlmCallDetailDTO,
  LlmCallPageDTO,
  LlmCallStatus,
  LlmCallSummaryDTO,
  LlmContentDTO,
  LlmJsonDTO,
  LlmMessageDTO,
  LlmToolDTO,
} from "../../shared/contracts.ts";
import { api } from "../api.ts";
import { useI18n } from "../i18n.tsx";
import { useApp } from "../state.tsx";
import { Chip } from "./ui.tsx";

const STATUS_TONE: Record<LlmCallStatus, string> = {
  running: "info",
  returned: "ok",
  failed: "error",
  aborted: "muted",
  deferred: "warn",
  interrupted: "warn",
};

type DetailError = { revision: number; message: DisplayText };

function mergeSummaries(current: readonly LlmCallSummaryDTO[], incoming: readonly LlmCallSummaryDTO[]): LlmCallSummaryDTO[] {
  const byId = new Map(current.map((call) => [call.id, call]));
  for (const call of incoming) {
    const existing = byId.get(call.id);
    if (existing === undefined || call.revision >= existing.revision) byId.set(call.id, call);
  }
  return [...byId.values()].sort((left, right) => left.sequence - right.sequence);
}

function formatTime(value: number, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "medium" }).format(value);
}

function formatCount(value: number, locale: Locale): string {
  return new Intl.NumberFormat(locale).format(value);
}

function formatCost(value: number, locale: Locale): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency: "USD", maximumFractionDigits: 6 }).format(value);
}

function Category({
  title,
  count,
  children,
  defaultOpen = false,
}: {
  title: string;
  count?: number;
  children: ReactNode;
  defaultOpen?: boolean;
}): ReactNode {
  return (
    <details className="llm-category" open={defaultOpen}>
      <summary>
        <span>{title}</span>
        {count !== undefined ? <span className="llm-category-count">{count}</span> : null}
      </summary>
      <div className="llm-category-body">{children}</div>
    </details>
  );
}

function JsonTree({ value, depth = 0 }: { value: LlmJsonDTO; depth?: number }): ReactNode {
  const { messages } = useI18n();
  if (value.type === "scalar") {
    return <code className={`llm-json-scalar llm-json-${value.value === null ? "null" : typeof value.value}`}>{JSON.stringify(value.value)}</code>;
  }
  if (value.type === "array") {
    return (
      <details className="llm-json-node" open={depth === 0}>
        <summary>{value.items.length === 0 ? messages.llmCalls.json.emptyArray : messages.llmCalls.json.array(value.items.length)}</summary>
        {value.items.length > 0 ? (
          <ol className="llm-json-list">
            {value.items.map((item, index) => (
              <li key={index}>
                <span className="llm-json-index">{index}</span>
                <JsonTree value={item} depth={depth + 1} />
              </li>
            ))}
          </ol>
        ) : null}
      </details>
    );
  }
  return (
    <details className="llm-json-node" open={depth === 0}>
      <summary>{value.entries.length === 0 ? messages.llmCalls.json.emptyObject : messages.llmCalls.json.object(value.entries.length)}</summary>
      {value.entries.length > 0 ? (
        <ul className="llm-json-list">
          {value.entries.map((entry) => (
            <li key={entry.key}>
              <code className="llm-json-key">{entry.key}</code>
              <JsonTree value={entry.value} depth={depth + 1} />
            </li>
          ))}
        </ul>
      ) : null}
    </details>
  );
}

function TextSections({
  title,
  content,
  sections,
}: {
  title: string;
  content: string;
  sections: readonly { key: string; text: string | null }[];
}): ReactNode {
  const { messages } = useI18n();
  const sectionText = sections.flatMap((section) => section.text === null ? [] : [section.text]).join("");
  const showFullText = sections.length === 0 || sectionText !== content;
  return (
    <div className="llm-system-content">
      {sections.length > 0 ? (
        <dl className="llm-system-sections" aria-label={messages.llmCalls.input.systemSections}>
          {sections.map((section, index) => (
            <div key={`${section.key}-${index}`}>
              <dt><code>{section.key}</code></dt>
              <dd>{section.text === null ? <span className="hint">{messages.llmCalls.input.sectionRemoved}</span> : <pre>{section.text}</pre>}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {showFullText && content.length > 0 ? (
        <details className="llm-full-text">
          <summary>{title}</summary>
          <pre>{content}</pre>
        </details>
      ) : null}
    </div>
  );
}

function ToolDefinition({ tool }: { tool: LlmToolDTO }): ReactNode {
  const { messages } = useI18n();
  return (
    <article className="llm-tool-definition">
      <header>
        <code>{tool.name}</code>
        {tool.description.length > 0 ? <p>{tool.description}</p> : null}
      </header>
      <Category title={messages.llmCalls.input.parameters}>
        <JsonTree value={tool.parameters} />
      </Category>
      {tool.constrainedSampling !== undefined ? (
        <Category title={messages.llmCalls.input.constrainedSampling}>
          <JsonTree value={tool.constrainedSampling} />
        </Category>
      ) : null}
    </article>
  );
}

function ContentPart({ part }: { part: LlmContentDTO }): ReactNode {
  const { messages } = useI18n();
  if (part.type === "text") {
    return (
      <article className="llm-content-part">
        <h5>{part.structured === undefined ? messages.llmCalls.content.text : messages.llmCalls.content.structured}</h5>
        {part.structured === undefined ? <pre>{part.text}</pre> : <JsonTree value={part.structured} />}
      </article>
    );
  }
  if (part.type === "thinking") {
    return (
      <article className="llm-content-part llm-thinking">
        <h5>{messages.llmCalls.content.thinking}</h5>
        {part.redacted === true ? <Chip tone="muted">{messages.llmCalls.content.redacted}</Chip> : null}
        {part.text.length > 0 ? <pre>{part.text}</pre> : null}
      </article>
    );
  }
  if (part.type === "toolCall") {
    return (
      <article className="llm-content-part llm-tool-call">
        <h5>{messages.llmCalls.content.toolCall}</h5>
        <dl className="llm-fields">
          <div><dt>{messages.llmCalls.message.tool}</dt><dd><code>{part.name}</code></dd></div>
          <div><dt>{messages.llmCalls.message.toolCallId}</dt><dd><code>{part.id}</code></dd></div>
        </dl>
        <Category title={messages.llmCalls.content.toolArguments}>
          <JsonTree value={part.arguments} />
        </Category>
      </article>
    );
  }
  return (
    <article className="llm-content-part llm-image-omission">
      <h5>{messages.llmCalls.content.image}</h5>
      <code>{part.mimeType}</code>
      <span className="hint">{messages.llmCalls.content.imageOmitted}</span>
    </article>
  );
}

function MessageCard({ message }: { message: LlmMessageDTO }): ReactNode {
  const { messages, locale } = useI18n();
  return (
    <li className="llm-message-card">
      <header>
        <Chip tone={message.isError === true ? "error" : "muted"}>{messages.llmCalls.message.role[message.role]}</Chip>
        {message.toolName !== undefined ? <code>{message.toolName}</code> : null}
        {message.toolCallId !== undefined ? <span className="hint">{messages.llmCalls.message.toolCallId}: {message.toolCallId}</span> : null}
        {message.isError === true ? <Chip tone="error">{messages.llmCalls.message.failed}</Chip> : null}
        {message.timestamp !== undefined ? <time className="hint">{formatTime(message.timestamp, locale)}</time> : null}
      </header>
      <div className="llm-content-list">
        {message.content.map((part, index) => <ContentPart key={`${message.position}-${index}`} part={part} />)}
      </div>
    </li>
  );
}

function UsageView({ usage }: { usage: NonNullable<LlmCallSummaryDTO["usage"]> }): ReactNode {
  const { messages, locale } = useI18n();
  return (
    <section className="llm-usage" aria-label={messages.llmCalls.metadata.usage}>
      <dl className="llm-fields">
        <div><dt>{messages.llmCalls.metadata.inputTokens}</dt><dd>{formatCount(usage.input, locale)}</dd></div>
        <div><dt>{messages.llmCalls.metadata.outputTokens}</dt><dd>{formatCount(usage.output, locale)}</dd></div>
        <div><dt>{messages.llmCalls.metadata.cacheRead}</dt><dd>{formatCount(usage.cacheRead, locale)}</dd></div>
        <div><dt>{messages.llmCalls.metadata.cacheWrite}</dt><dd>{formatCount(usage.cacheWrite, locale)}</dd></div>
        <div><dt>{messages.llmCalls.metadata.totalTokens}</dt><dd>{formatCount(usage.totalTokens, locale)}</dd></div>
        {usage.reasoning !== undefined ? <div><dt>{messages.llmCalls.metadata.reasoningTokens}</dt><dd>{formatCount(usage.reasoning, locale)}</dd></div> : null}
        {usage.cost !== undefined ? (
          <div className="llm-usage-cost">
            <dt>{messages.llmCalls.metadata.cost}</dt>
            <dd>
              <dl>
                <div><dt>{messages.llmCalls.metadata.costInput}</dt><dd>{formatCost(usage.cost.input, locale)}</dd></div>
                <div><dt>{messages.llmCalls.metadata.costOutput}</dt><dd>{formatCost(usage.cost.output, locale)}</dd></div>
                <div><dt>{messages.llmCalls.metadata.costCacheRead}</dt><dd>{formatCost(usage.cost.cacheRead, locale)}</dd></div>
                <div><dt>{messages.llmCalls.metadata.costCacheWrite}</dt><dd>{formatCost(usage.cost.cacheWrite, locale)}</dd></div>
                <div><dt>{messages.llmCalls.metadata.costTotal}</dt><dd>{formatCost(usage.cost.total, locale)}</dd></div>
              </dl>
            </dd>
          </div>
        ) : null}
      </dl>
    </section>
  );
}

function ToolChange({ added, removed }: { added: readonly LlmToolDTO[]; removed: readonly string[] }): ReactNode {
  const { messages } = useI18n();
  if (added.length === 0 && removed.length === 0) return null;
  return (
    <div className="llm-tool-changes">
      {added.length > 0 ? (
        <Category title={messages.llmCalls.input.toolsAdded} count={added.length}>
          {added.map((tool, index) => <ToolDefinition key={`${tool.name}-${index}`} tool={tool} />)}
        </Category>
      ) : null}
      {removed.length > 0 ? (
        <Category title={messages.llmCalls.input.toolsRemoved} count={removed.length}>
          <ul className="llm-name-list">{removed.map((name, index) => <li key={`${name}-${index}`}><code>{name}</code></li>)}</ul>
        </Category>
      ) : null}
    </div>
  );
}

function SystemUpdates({ updates }: { updates: LlmCallDetailDTO["input"]["systemUpdates"] }): ReactNode {
  const { messages, locale } = useI18n();
  if (updates.length === 0) return null;
  return (
    <Category title={messages.llmCalls.input.systemUpdates} count={updates.length}>
      <div className="llm-system-updates">
        {updates.map((update, index) => (
          <article className="llm-system-update" key={`${update.position}-${index}`}>
            <header>
              <h4>{messages.llmCalls.input.update(index + 1)}</h4>
              <span className="hint">{messages.llmCalls.input.position(update.position)}</span>
              {update.timestamp !== undefined ? <time className="hint">{formatTime(update.timestamp, locale)}</time> : null}
            </header>
            <TextSections title={messages.llmCalls.input.systemSnapshot} content={update.content} sections={update.sections} />
            <ToolChange added={update.toolsAdded} removed={update.toolsRemoved} />
          </article>
        ))}
      </div>
    </Category>
  );
}

function OmissionList({
  omissions,
  side,
}: {
  omissions: LlmCallDetailDTO["omitted"];
  side: "input" | "output";
}): ReactNode {
  const { messages } = useI18n();
  const items = omissions.filter((item) => item.side === side);
  if (items.length === 0) return null;
  return (
    <Category title={messages.llmCalls.omission.title} count={items.length}>
      <ul className="llm-omissions">
        {items.map((item, index) => (
          <li key={`${item.path}-${index}`}>
            <Chip tone="muted">{messages.llmCalls.omission.kind[item.kind]}</Chip>
            <code>{item.path}</code>
            <span className="hint">{messages.llmCalls.omission.characters(item.characters)}</span>
          </li>
        ))}
      </ul>
    </Category>
  );
}

function InputView({ detail }: { detail: LlmCallDetailDTO }): ReactNode {
  const { messages, locale } = useI18n();
  const { input } = detail;
  const latestUpdate = input.systemUpdates.at(-1);
  const latestMatchesSystem = input.system !== undefined && latestUpdate?.content === input.system.content;
  const historicalUpdates = latestMatchesSystem ? input.systemUpdates.slice(0, -1) : input.systemUpdates;
  const currentUpdateChanges = latestMatchesSystem ? latestUpdate : undefined;
  const changedSections = currentUpdateChanges?.sections.filter((section) => {
    if (section.text === null) return true;
    return input.system?.sections.find((current) => current.key === section.key)?.text !== section.text;
  }) ?? [];

  return (
    <section className="llm-io-panel llm-input-panel" aria-labelledby={`llm-input-${detail.id}`}>
      <h3 id={`llm-input-${detail.id}`}>{messages.llmCalls.input.title}</h3>
      {input.system !== undefined ? (
        <Category title={messages.llmCalls.input.system}>
          <TextSections title={messages.llmCalls.input.system} content={input.system.content} sections={input.system.sections} />
          {currentUpdateChanges !== undefined ? (
            <>
              <dl className="llm-fields llm-update-meta">
                <div><dt>{messages.llmCalls.input.update(input.systemUpdates.length)}</dt><dd>{messages.llmCalls.input.position(currentUpdateChanges.position)}</dd></div>
                {currentUpdateChanges.timestamp !== undefined ? <div><dt>{messages.llmCalls.message.timestamp}</dt><dd>{formatTime(currentUpdateChanges.timestamp, locale)}</dd></div> : null}
              </dl>
              {changedSections.length > 0 ? (
                <dl className="llm-system-sections">
                  {changedSections.map((section, index) => (
                    <div key={`${section.key}-${index}`}>
                      <dt><code>{section.key}</code></dt>
                      <dd>{section.text === null ? <span className="hint">{messages.llmCalls.input.sectionRemoved}</span> : <pre>{section.text}</pre>}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}
              <ToolChange added={currentUpdateChanges.toolsAdded} removed={currentUpdateChanges.toolsRemoved} />
            </>
          ) : null}
        </Category>
      ) : null}
      <SystemUpdates updates={historicalUpdates} />
      {input.messages.length > 0 ? (
        <Category title={messages.llmCalls.input.messages} count={input.messages.length} defaultOpen>
          <ol className="llm-message-list">
            {input.messages.map((message) => <MessageCard key={message.position} message={message} />)}
          </ol>
        </Category>
      ) : null}
      {input.tools.length > 0 ? (
        <Category title={messages.llmCalls.input.tools} count={input.tools.length}>
          <div className="llm-tool-list">{input.tools.map((tool, index) => <ToolDefinition key={`${tool.name}-${index}`} tool={tool} />)}</div>
        </Category>
      ) : null}
      {input.classifier !== undefined ? (
        <Category title={messages.llmCalls.input.classifier} defaultOpen>
          <div className="llm-classifier-grid">
            <Category title={messages.llmCalls.input.state}><JsonTree value={input.classifier.state} /></Category>
            <Category title={messages.llmCalls.input.questions}><JsonTree value={input.classifier.questions} /></Category>
          </div>
        </Category>
      ) : null}
      <OmissionList omissions={detail.omitted} side="input" />
      {input.system === undefined && historicalUpdates.length === 0 && input.messages.length === 0 && input.tools.length === 0 && input.classifier === undefined ? (
        <p className="hint">{messages.llmCalls.noPayload}</p>
      ) : null}
    </section>
  );
}

function ResponseCard({ response, index }: { response: LlmCallDetailDTO["responses"][number]; index: number }): ReactNode {
  const { messages, locale } = useI18n();
  return (
    <article className={`llm-response-card llm-response-${response.type}`}>
      <header>
        <Chip tone={response.type === "exception" ? "error" : "muted"}>{messages.llmCalls.output.type[response.type]}</Chip>
        <Chip tone="muted">{messages.llmCalls.output.source[response.source]}</Chip>
        <span className="hint">{messages.llmCalls.output.received}: {formatTime(response.receivedAt, locale)}</span>
        {response.stopReason !== undefined ? <span className="hint">{messages.llmCalls.output.stopReason}: <code>{response.stopReason}</code></span> : null}
      </header>
      {response.errorMessage !== undefined ? (
        <div className="llm-provider-error">
          <h5>{messages.llmCalls.output.error}</h5>
          <pre>{response.errorMessage}</pre>
        </div>
      ) : null}
      {response.content.length > 0 ? (
        <div className="llm-content-list">
          {response.content.map((part, partIndex) => <ContentPart key={`${index}-${partIndex}`} part={part} />)}
        </div>
      ) : null}
      {response.answers !== undefined ? <Category title={messages.llmCalls.output.answers}><JsonTree value={response.answers} /></Category> : null}
      {response.diagnostics !== undefined ? <Category title={messages.llmCalls.output.diagnostics}><JsonTree value={response.diagnostics} /></Category> : null}
      {response.metadata !== undefined ? <Category title={messages.llmCalls.output.metadata}><JsonTree value={response.metadata} /></Category> : null}
      {response.usage !== undefined ? <UsageView usage={response.usage} /> : null}
    </article>
  );
}

function OutputView({ detail }: { detail: LlmCallDetailDTO }): ReactNode {
  const { messages } = useI18n();
  return (
    <section className="llm-io-panel llm-output-panel" aria-labelledby={`llm-output-${detail.id}`}>
      <h3 id={`llm-output-${detail.id}`}>{messages.llmCalls.output.title}</h3>
      {detail.recordingError !== undefined ? (
        <p className="error-text"><Chip tone="error">{messages.llmCalls.recordingError}</Chip> {detail.recordingError}</p>
      ) : null}
      {detail.responses.length === 0 ? (
        <p className="hint">{messages.llmCalls.output.noResponses}</p>
      ) : (
        <Category title={messages.llmCalls.output.responses} count={detail.responses.length} defaultOpen>
          <div className="llm-response-list">
            {detail.responses.map((response, index) => <ResponseCard key={`${response.receivedAt}-${index}`} response={response} index={index} />)}
          </div>
        </Category>
      )}
      <OmissionList omissions={detail.omitted} side="output" />
    </section>
  );
}

function CallMetadata({ call }: { call: LlmCallDetailDTO }): ReactNode {
  const { messages, locale } = useI18n();
  return (
    <Category title={messages.llmCalls.metadata.title}>
      <dl className="llm-fields llm-call-metadata">
        <div><dt>{messages.llmCalls.metadata.kind}</dt><dd>{messages.llmCalls.kind[call.kind]}</dd></div>
        <div><dt>{messages.llmCalls.metadata.callId}</dt><dd><code>{call.id}</code></dd></div>
        <div><dt>{messages.llmCalls.metadata.status}</dt><dd><Chip tone={STATUS_TONE[call.status]}>{messages.llmCalls.status[call.status]}</Chip></dd></div>
        <div><dt>{messages.llmCalls.metadata.model}</dt><dd><code>{call.model.providerId}/{call.model.modelId}</code></dd></div>
        <div><dt>{messages.llmCalls.metadata.employee}</dt><dd><code>{call.employeeId}</code></dd></div>
        {call.conversationId !== undefined ? <div><dt>{messages.llmCalls.metadata.conversation}</dt><dd><code>{call.conversationId}</code></dd></div> : null}
        {call.approvalId !== undefined ? <div><dt>{messages.llmCalls.metadata.approval}</dt><dd><code>{call.approvalId}</code></dd></div> : null}
        <div><dt>{messages.llmCalls.metadata.started}</dt><dd>{formatTime(call.startedAt, locale)}</dd></div>
        {call.endedAt !== undefined ? <div><dt>{messages.llmCalls.metadata.ended}</dt><dd>{formatTime(call.endedAt, locale)}</dd></div> : null}
        <div><dt>{messages.llmCalls.metadata.revision}</dt><dd>{formatCount(call.revision, locale)}</dd></div>
        {call.stopReason !== undefined ? <div><dt>{messages.llmCalls.metadata.stopReason}</dt><dd><code>{call.stopReason}</code></dd></div> : null}
        <div><dt>{messages.llmCalls.metadata.reasoning}</dt><dd>{call.reasoning || messages.llmCalls.notAvailable}</dd></div>
        {call.maxTokens !== undefined ? <div><dt>{messages.llmCalls.metadata.maxTokens}</dt><dd>{formatCount(call.maxTokens, locale)}</dd></div> : null}
        <div><dt>{messages.llmCalls.metadata.messageCount}</dt><dd>{formatCount(call.messageCount, locale)}</dd></div>
        <div><dt>{messages.llmCalls.metadata.toolCount}</dt><dd>{formatCount(call.toolCount, locale)}</dd></div>
        <div><dt>{messages.llmCalls.metadata.inputBytes}</dt><dd>{formatCount(call.inputBytes, locale)}</dd></div>
        {call.outputBytes !== undefined ? <div><dt>{messages.llmCalls.metadata.outputBytes}</dt><dd>{formatCount(call.outputBytes, locale)}</dd></div> : null}
        <div><dt>{messages.llmCalls.metadata.captureBoundary}</dt><dd><code>{call.captureBoundary}</code></dd></div>
        <div><dt>{messages.llmCalls.metadata.redaction}</dt><dd>{messages.llmCalls.metadata.redactionApplied}</dd></div>
      </dl>
      {call.usage !== undefined ? <UsageView usage={call.usage} /> : null}
    </Category>
  );
}

function CallDetail({ detail, loading, error, onRetry }: {
  detail: LlmCallDetailDTO | undefined;
  loading: boolean;
  error: DisplayText | undefined;
  onRetry: () => void;
}): ReactNode {
  const { messages, text } = useI18n();
  if (loading && detail === undefined) return <p className="hint llm-detail-loading">{messages.llmCalls.detailLoading}</p>;
  if (error !== undefined && detail === undefined) {
    return (
      <p className="error-text llm-detail-error">
        <Chip tone="error">{messages.llmCalls.detailFailed}</Chip> {text(error)}
        <button type="button" className="link" onClick={onRetry}>{messages.llmCalls.retry}</button>
      </p>
    );
  }
  if (detail === undefined) return <p className="hint">{messages.llmCalls.noPayload}</p>;
  return (
    <div className="llm-call-expanded">
      <CallMetadata call={detail} />
      <div className="llm-io-grid">
        <InputView detail={detail} />
        <OutputView detail={detail} />
      </div>
    </div>
  );
}

function CaptureHealth({ captureHealth }: { captureHealth: LlmCallPageDTO["captureHealth"] | undefined }): ReactNode {
  const { messages } = useI18n();
  if (captureHealth === undefined) return null;
  return (
    <div className="llm-capture-health" aria-live="polite">
      <Chip tone={captureHealth.accepting ? "ok" : "muted"}>
        {captureHealth.accepting ? messages.llmCalls.health.active : messages.llmCalls.health.stopped}
      </Chip>
      {captureHealth.failedCount > 0 ? <Chip tone="error">{messages.llmCalls.health.failures(captureHealth.failedCount)}</Chip> : null}
    </div>
  );
}

export function LlmCallTimeline({ workId }: { workId: string }): ReactNode {
  const { state } = useApp();
  const { messages, text, locale } = useI18n();
  const [calls, setCalls] = useState<LlmCallSummaryDTO[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [captureHealth, setCaptureHealth] = useState<LlmCallPageDTO["captureHealth"] | undefined>(undefined);
  const [listLoading, setListLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [listError, setListError] = useState<DisplayText>("");
  const [details, setDetails] = useState<Record<string, LlmCallDetailDTO | undefined>>({});
  const [detailLoading, setDetailLoading] = useState<Record<string, boolean | undefined>>({});
  const [detailErrors, setDetailErrors] = useState<Record<string, DetailError | undefined>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const latestRequest = useRef(0);
  const olderRequest = useRef(0);
  const olderLoaded = useRef(false);
  const detailRequests = useRef(new Set<string>());
  const initialExpanded = useRef(false);
  const workIdRef = useRef(workId);
  workIdRef.current = workId;
  const revision = state.llmCallRevisionByWorkId[workId] ?? 0;

  const loadLatest = useCallback(async () => {
    const requestId = ++latestRequest.current;
    setListLoading(true);
    try {
      const page = await api.workLlmCalls(workId);
      if (requestId !== latestRequest.current || workIdRef.current !== workId) return;
      setCalls((current) => mergeSummaries(current, page.items));
      if (!olderLoaded.current) setNextCursor(page.nextCursor);
      setCaptureHealth(page.captureHealth);
      setListError("");
    } catch (cause) {
      if (requestId !== latestRequest.current || workIdRef.current !== workId) return;
      setListError(errorDisplay(cause));
    } finally {
      if (requestId === latestRequest.current && workIdRef.current === workId) setListLoading(false);
    }
  }, [workId]);

  useEffect(() => {
    latestRequest.current += 1;
    olderRequest.current += 1;
    olderLoaded.current = false;
    setCalls([]);
    setNextCursor(undefined);
    setCaptureHealth(undefined);
    setListLoading(true);
    setLoadingOlder(false);
    setListError("");
    setDetails({});
    setDetailLoading({});
    setDetailErrors({});
    setExpanded(new Set());
    initialExpanded.current = false;
    detailRequests.current.clear();
  }, [workId]);

  useEffect(() => {
    void loadLatest();
  }, [loadLatest, revision, state.connected]);

  useEffect(() => {
    if (calls.length === 0 || initialExpanded.current) return;
    initialExpanded.current = true;
    setExpanded(new Set([calls[calls.length - 1]!.id]));
  }, [calls]);

  const loadDetail = useCallback(async (callId: string, callRevision: number) => {
    const requestKey = `${workId}:${callId}`;
    if (detailRequests.current.has(requestKey)) return;
    detailRequests.current.add(requestKey);
    setDetailLoading((current) => ({ ...current, [callId]: true }));
    setDetailErrors((current) => ({ ...current, [callId]: undefined }));
    try {
      const detail = await api.workLlmCall(workId, callId);
      if (workIdRef.current !== workId) return;
      setDetails((current) => ({ ...current, [callId]: detail }));
      setDetailErrors((current) => ({ ...current, [callId]: undefined }));
      if (detail.revision < callRevision) {
        // The next index event supplies the durable revision; avoid treating an
        // older payload as the current value if the response raced a commit.
        setDetails((current) => ({ ...current, [callId]: undefined }));
      }
    } catch (cause) {
      if (workIdRef.current !== workId) return;
      setDetailErrors((current) => ({ ...current, [callId]: { revision: callRevision, message: errorDisplay(cause) } }));
    } finally {
      detailRequests.current.delete(requestKey);
      if (workIdRef.current === workId) setDetailLoading((current) => ({ ...current, [callId]: false }));
    }
  }, [workId]);

  useEffect(() => {
    for (const callId of expanded) {
      const summary = calls.find((call) => call.id === callId);
      if (summary === undefined || detailLoading[callId] === true) continue;
      if ((details[callId]?.revision ?? -1) >= summary.revision) continue;
      if (detailErrors[callId]?.revision === summary.revision) continue;
      void loadDetail(callId, summary.revision);
    }
  }, [calls, expanded, details, detailErrors, detailLoading, loadDetail]);

  const loadOlder = async (): Promise<void> => {
    if (nextCursor === undefined || loadingOlder) return;
    const requestId = ++olderRequest.current;
    setLoadingOlder(true);
    try {
      const page = await api.workLlmCalls(workId, nextCursor);
      if (requestId !== olderRequest.current || workIdRef.current !== workId) return;
      olderLoaded.current = true;
      setCalls((current) => mergeSummaries(current, page.items));
      setNextCursor(page.nextCursor);
      setListError("");
    } catch (cause) {
      if (requestId !== olderRequest.current || workIdRef.current !== workId) return;
      setListError(errorDisplay(cause));
    } finally {
      if (requestId === olderRequest.current && workIdRef.current === workId) setLoadingOlder(false);
    }
  };

  const toggleExpanded = (callId: string): void => {
    if (!expanded.has(callId)) setDetailErrors((errors) => ({ ...errors, [callId]: undefined }));
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(callId)) next.delete(callId);
      else next.add(callId);
      return next;
    });
  };

  const retryDetail = (call: LlmCallSummaryDTO): void => {
    setDetailErrors((current) => ({ ...current, [call.id]: undefined }));
    void loadDetail(call.id, call.revision);
  };

  return (
    <section className="llm-call-timeline" aria-label={messages.llmCalls.title}>
      <header className="llm-timeline-head">
        <h3>{messages.llmCalls.title}</h3>
        <CaptureHealth captureHealth={captureHealth} />
      </header>
      {listError !== "" ? (
        <p className="error-text llm-list-error">
          <Chip tone="error">{messages.llmCalls.loadFailed}</Chip> {text(listError)}
          <button type="button" className="link" onClick={() => void loadLatest()}>{messages.llmCalls.retry}</button>
        </p>
      ) : null}
      {calls.length === 0 && listLoading ? <p className="hint">{messages.llmCalls.loading}</p> : null}
      {calls.length === 0 && !listLoading && listError === "" ? <p className="hint llm-empty">{messages.llmCalls.empty}</p> : null}
      {calls.length > 0 ? (
        <ol className="llm-timeline-list">
          {calls.map((call) => {
            const isExpanded = expanded.has(call.id);
            const detailError = detailErrors[call.id];
            return (
              <li className={`llm-timeline-entry status-${call.status}`} key={call.id}>
                <button
                  type="button"
                  className="llm-timeline-trigger"
                  aria-expanded={isExpanded}
                  aria-controls={`llm-detail-${call.id}`}
                  aria-label={`${isExpanded ? messages.llmCalls.collapse : messages.llmCalls.expand}: ${messages.llmCalls.sequence(call.sequence)}, ${messages.llmCalls.kind[call.kind]}, ${messages.llmCalls.status[call.status]}`}
                  onClick={() => toggleExpanded(call.id)}
                >
                  <span className="llm-call-sequence">{String(call.sequence).padStart(2, "0")}</span>
                  <span className="llm-call-summary">
                    <span className="llm-call-title">
                      <strong>{messages.llmCalls.kind[call.kind]}</strong>
                      <code>{call.model.providerId}/{call.model.modelId}</code>
                    </span>
                    <span className="llm-call-facts">
                      <Chip tone={STATUS_TONE[call.status]}>{messages.llmCalls.status[call.status]}</Chip>
                      <span>{messages.llmCalls.metadata.counts(call.messageCount, call.toolCount)}</span>
                      <time>{formatTime(call.startedAt, locale)}</time>
                      {call.usage !== undefined ? <span>{formatCount(call.usage.input, locale)} → {formatCount(call.usage.output, locale)} {messages.llmCalls.tokenUnit}</span> : null}
                    </span>
                  </span>
                  <span className="llm-call-chevron" aria-hidden="true">{isExpanded ? "−" : "+"}</span>
                </button>
                {isExpanded ? (
                  <section className="llm-call-detail" id={`llm-detail-${call.id}`} aria-label={messages.llmCalls.sequence(call.sequence)}>
                    <CallDetail
                      detail={(details[call.id]?.revision ?? -1) >= call.revision ? details[call.id] : undefined}
                      loading={detailLoading[call.id] === true || (details[call.id] === undefined && detailError === undefined)}
                      error={detailError?.revision === call.revision ? detailError.message : undefined}
                      onRetry={() => retryDetail(call)}
                    />
                  </section>
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : null}
      {nextCursor !== undefined ? (
        <button type="button" className="link llm-load-older" disabled={loadingOlder} onClick={() => void loadOlder()}>
          {loadingOlder ? messages.common.loading : messages.llmCalls.loadOlder}
        </button>
      ) : null}
    </section>
  );
}
