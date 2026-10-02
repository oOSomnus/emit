# 本地数字员工协作 Webapp

## Context
- 用户希望基于 https://earendil.com/posts/pi-durable/ 构建本地运行的 Webapp，界面结合 Slack 与邮箱；支持即时消息和异步邮件与 agent 交流、协作。
- 每个 agent 是独立数字员工，拥有自己的角色、skills、MCP 配置和执行上下文。
- 当前工作目录为空，无既有代码、配置或工具可复用。当前阶段仅规划。
- 原文明确：Pi Durable 使用持久化 conversation/task、checkpoint、requestId 去重与恢复；一个进程拥有 storage；conversation 可 fork 并拥有独立 agent 设置。异步工作必须由本地后台进程执行，不能依赖浏览器保持打开。

## Approach

### 1. 产品范围与本地架构
- 产品名沿用目录名 **Emit**；中文界面、单用户、一个 workspace/数据目录。只做站内消息与模拟邮件，不接 Slack、SMTP/IMAP，不增加多人账号系统。
- Node >=22.19.0 + TypeScript 后端（本机已观察 v22.23.2）；React + Vite 前端；Fastify 提供 HTTP 命令与 SSE 订阅。生产由一个后端进程同时提供静态页面和执行后台，默认仅监听 `127.0.0.1`。
- 一个 Pi Durable harness 独占 `data/emit.sqlite`；复用其模型循环、checkpoint、队列、compaction 和恢复。不使用 Redis、不另建工作流引擎或第二个 agent runtime。
- 后端运行时，关闭网页不停止任务；关闭后端会暂停，下一次启动恢复，不承诺关机期间继续执行。提供 `npm run dev`、`npm run build`、`npm start` 和可指定数据目录的启动方式。
- 首次设置：workspace 名称、用户名称、workspace 默认执行模型与独立审批策略，随后创建员工。供应商/模型目录复用 Pi 的 provider collection，不硬编码 OpenAI/Anthropic 列表；员工选择各自的模型与 effort，审批另选 chat 或 classifier 模型。具体模块契约见下节。连接本地模型可离线运行，连接远程模型会上传相应上下文。
- API key、MCP secret 只保存在服务端环境变量或权限 `0600` 的本地凭据文件；前端只显示已配置状态。没有模型时展示配置入口和明确错误，不提供伪造回复。
- 本地也要拒绝跨站控制：校验 Host/Origin，变更命令使用同源会话令牌，不开放通配 CORS；Markdown 不执行原始 HTML，SSE/DTO 不下发凭据。

### 1.1. 供应商、模型与 effort 模块
- 已核实 Pi `Models` 将 **provider 身份/认证/模型目录** 与 **API 协议实现** 分开；同一 provider 可以混用不同 API，同一个模型可有 chat/classifier 条目。复用 `builtinModels`/`builtinProviders`、`CredentialStore`、`createProvider` 和模型能力查询，不为每个供应商写一套应用请求逻辑。
- `models.ts` 对调用方提供模型目录/能力查询、连接检查和配置解析；内部持有一个 Pi `Models` collection。员工 runtime 与审批 adapters 都复用该 collection，前端只使用 DTO，不导入模型 SDK，也不凭 provider 名称判断能力。
- 内建 provider 从 Pi 的公开目录生成，包括 OpenAI、Anthropic、Google、OpenRouter、TypeSafe 等；按认证状态筛选“已配置可用”，未配置项可进入设置。复用 Pi 的认证描述和 API key/环境变量/已支持 OAuth 流程，不把所有认证压成一个 key 输入框。
- `ProviderConfig` 保存稳定 `id`、内建 provider key 或自定义配置、endpoint/headers 的非敏感部分及凭据引用。自定义 compatible provider 配置声明 model entries（类型、API、上下文/输出限制、reasoning 能力、成本和 compat）；以 `createProvider` 接入 OpenAI Completions、Responses、Anthropic Messages 或 classifier 实现。供应商不是协议，不能把所有新供应商都当作 OpenAI-compatible。
- 新增内建供应商由 Pi 目录和能力查询进入 UI；新增 compatible endpoint 通过配置进入；真正的新协议只在服务端增加 Pi provider/API adapter 并注册，不修改员工、消息、邮件或审批业务。不存在的协议明确报错，不作隐式 fallback；不开放浏览器上传可执行插件。
- 应用引用模型使用 `ModelRef = { kind: "chat" | "classifier", providerId, modelId }`，不能只存裸 modelId。员工只能选具备工具调用能力的 chat 模型；审批可选 chat 或 classifier，图片模型不出现在这两类选择器中。
- 每位员工保存独立 `executionModel: { model: ChatModelRef, effort }`；新建时复制 workspace 默认值，之后不随默认值修改而联动。effort 复用 `getSupportedThinkingLevels(model)`，解析为 durable `thinkingLevel`；不支持 reasoning 的模型禁用该字段。换模型时提示并保存兼容 effort，不静默忽略或把所有模型强制成同一组等级。
- 全局审批配置独立保存 `ApprovalEvaluatorConfig`：`kind: "llm"` 选 chat model + 自己的 effort；`kind: "classifier"` 选 classifier model + 判断阈值，不虚构 effort。员工换模型不改变审批模型；委派到目标员工使用目标配置而非调用者模型。运行记录保存实际配置版本和 model/effort，变更只用于后续请求。
- 模型目录刷新使用 Pi 的显式 `refresh`；模型消失/凭据失败/能力不匹配时显示不可用并阻止新工作，不静默替换模型。“检查连接”按 kind 调用真实 chat/classify 操作，不能拿聊天探测请求检查 Jev。

### 2. Slack + 邮箱页面
- 桌面布局：左侧 workspace/导航栏，中间频道或邮件列表，主内容区，右侧可收起的线程/员工/任务详情。默认浅色、紧凑排版、姓名头像与角色标签；窄屏改为可切换单栏。
- **消息**：频道创建与成员管理、员工私信、`@员工`、线程回复、Markdown、流式答复、工具输出、排队/执行/待审批状态。私信默认唤醒对方；频道仅明确 `@` 才唤醒，支持多员工分别答复。
- 发送期间默认排队；提供明确的“指导当前任务”和“停止本次工作”操作，分别对应 steer 与前台 abort。线程与主频道独立推进，不互相阻塞。
- **邮箱**：收件箱、发件箱、草稿、归档、未读状态、主题、To/CC、正文、回复/全部回复及按邮件线程阅读。To 中的员工执行工作；CC 仅接收副本，不自动启动任务。发给用户只投递，不触发模型。
- 邮件保存并提交后立即显示已投递/排队，不等待模型回复；最终回复作为同线程新邮件投递，任务卡显示运行进度。邮件与消息可通过关联任务跳转，不悄悄混用两者的对话上下文。
- **员工目录**：创建、编辑、停用员工；个人页可独立选择 provider/model + effort，显示邮箱、角色职责、工作目录、skills、MCP、允许工具、当前工作和历史协作；不把“换全局模型”当作员工配置。
- **工作**：任务列表、父子来源链、员工状态、失败原因、用量；任务中的审批卡只显示摘要与跳转入口。
- **审批中心**：独立导航与页面 `/approvals`，参考飞书审批的“待我审批 / 已处理 / 全部记录”、状态筛选与详情流。消息、私信、邮件、委派触发的风险调用都创建同一类审批单，统一在 `/approvals/:id` 裁决，不在聊天气泡或邮件正文放批准按钮。
- 审批详情展示申请员工、关联任务、消息/邮件原文链接、工具/参数、cwd、模型或 classifier 判断证据、配置版本及“提交 → 自动判断 → 人工裁决 → 执行结果”时间线。页内单次批准/拒绝可附意见；返回原消息/邮件时显示已同步状态。
- 审批单状态区分 `evaluating/pending-human/approved/rejected/cancelled/invalidated`，执行状态另记 `not-started/running/succeeded/failed/interrupted`，不能把“批准”显示成“操作成功”。自动批准也可在全部记录查询；重复点击、两个页面同时裁决只接受一个有效状态转换。
- 搜索当前 workspace 的员工、消息和邮件；历史分页，不把全量 transcript 推到浏览器。不填充假消息、假在线状态或假任务。

### 3. 数字员工、skills 与 MCP
- 员工持久身份独立于 conversation：`id/name/address/role/instructions/executionModel:{model,effort}/cwd/skillBindings/mcpBindings/toolPolicy/configVersion/enabled`。审批配置独立于员工记录；在线/忙碌等状态由真实任务推导。
- 为用户和员工调用 LLM，根据名称与 workspace 建议 `localpart@workspace-slug.test` 地址；服务端校验保留域、格式和唯一性，冲突添加确定性后缀。地址保存后不随改名漂移，可人工修改；LLM 不可用时显示待生成并允许手填，不能冒充已由模型生成。
- 每个工作 conversation 明确配置员工的 extensions 与 tools 白名单，不继承 harness 的“所有工具”默认值。修改配置影响下一次请求；停用禁止新工作，并允许用户停止已有工作。
- skills 通过显式目录导入、预览、绑定/解绑、重新加载；复用 Pi 的 `loadSkillsFromDir` 与 `formatSkillsForPrompt`，保留格式/重名诊断。system section 仅提供已绑定技能的描述；`load_skill` 按需读正文和定位配套文件，显式技能选择用于强制加载。技能不能扩大工具权限，其脚本执行仍经过审批。
- MCP 复用 `@earendil-works/pi-mcp`；支持 stdio 的 `command/args/env/cwd` 与 Streamable HTTP 的 `url/headers`，提供连接检查、工具发现、启停、错误详情、逐员工工具绑定。不支持的 transport 明确报错；本计划不加入 OAuth 登录或 MCP Apps。
- 每个员工/服务器配置拥有自己的 MCP 连接上下文；stdio 使用员工 cwd，凭据不串用。发现工具适配为 durable `defineTool`，名称加稳定命名空间并处理碰撞，转发取消、进度和 `isError`，采用 `toLlmContent` 转换结果。
- MCP 描述和 annotations 是不可信提示；不能据此自动授予权限或宣告安全重放。未知 MCP 工具默认有风险且 `replay` unsafe；由用户显式信任的只读工具才可放宽。

### 4. Auto mode：可插拔判断模型 + 独立审批中心
- 低风险的应用内读取、绑定 skill 读取和允许目录内文件读取可直接执行；文件写/编辑、全部 Shell 命令、未知/有副作用的 MCP 操作创建审批单，进入独立判断策略。发送站内消息/邮件和交办按协作规则执行，不逐封人工确认。
- 审批不是“调用另一个聊天机器人”的同义词。`Approval` 模块拥有申请、判断、人工等待、授权与执行结果的 durable 状态机；判断实现位于 `ApprovalEvaluator` seam。先实现 **无工具 chat LLM adapter** 与 **Pi classifier adapter（含 Jev）** 两个真实实现，不做只有接口的扩展占位。
- `ApprovalCase` 是版本化结构化输入：`schemaVersion/id/toolTaskId/employeeId/origin/rootWorkId/userIntent/tool:{name,args,argsHash}/cwd/permissions/configVersion/policyVersion/contextEvidence`。origin 包含消息/邮件/委派定位；上下文证据标注来源与信任等级，凭据只传引用不传原文。缺少必要信息时交人工，不凭截断上下文自动批准。
- 判断的最小接口如下；调用者不依赖供应商协议、聊天 transcript 或 classifier 的原始字段：

```typescript
interface ApprovalEvaluator {
  evaluate(
    input: ApprovalCase,
    config: ApprovalEvaluatorConfig,
    context: EvaluationContext, // 取消信号与稳定 evaluationId
  ): Promise<EvaluationOutcome>;
}
type EvaluationOutcome =
  | {
      status: "evaluated";
      recommendation: "approve" | "review" | "deny";
      risk: "low" | "medium" | "high" | "unknown";
      evidence:
        | { kind: "llm"; rationale: string }
        | { kind: "classifier"; criteriaVersion: number; probabilities: Record<string, number> };
      model: ModelRef;
      usage?: ModelUsage;
    }
  | { status: "unavailable"; reason: "configuration" | "provider" | "invalid-output"; message: string };
```

- **LLM adapter**：使用配置的 chat model + 它自己的 effort，创建/复用审批 task-owned conversation，强制 `tools: []`；结构化输出严格校验推荐、风险和简短理由。稳定 evaluationId 关联既有 submission，重启不会为同一评估新建另一条审批聊天。
- **Classifier adapter**：已核实 Pi `models.getModelOfType("classifier", ...)` 与 `models.classify(model, { state, questions })` 可直接接入 TypeSafe `jev-latest`、OpenRouter Jev 等；把 ApprovalCase 放入 state，用版本化 `choice/bool` criteria 判断“请求是否获用户授权 / 操作风险 / approve-review-deny”。消费 typed `choice/probabilities/confidence` 或 bool `probability`，检查 `stopReason`（错误可能返回 error 而非 throw）。
- 分类器只给概率，不假装会写自由文本理由；审批页面展示问题、判据与概率，说明由固定模板描述判据结果，不额外调用 LLM 编造解释。默认只有推荐 approve 且授权、允许执行两项概率均达到可配置阈值（初始 0.99），才自动放行；缺失/不合法概率、冲突、低置信度均为 review。模型概率不等于经过校准的安全保证。
- evaluator 只提供建议，不能颁发执行权限。审批状态机先执行确定性员工工具/目录等硬限制，再将模型建议与当前策略映射为自动批准或人工等待；人工批准不能覆盖员工未授予的能力。增加新的判断协议只实现 evaluator 或 Pi classifier provider，不改通信、审批页面及工具执行模块。
- `beforeTool` 创建/复用审批单与判断任务；approve 才继续，deny/review、无效输出或判断不可用时持久化为 pending-human，通过独立审批中心通知用户，不执行；其他无依赖工作可继续。记录 evaluator 类型、实际 model/effort、判据/策略版本、证据与用量；没有上游用量就显示未知而非 0。
- 用户在审批详情单次批准或拒绝。拒绝通过工具阻止结果反馈给员工；批准仅适用于这一次调用，不成为全局自动许可。停止本次工作会取消其审批，禁用详情页按钮并拒绝迟到批准。
- 审批绑定 `toolTaskId + employeeId + toolName + argsHash + cwd + configVersion + policyVersion`，保存判决来源、意见、时间线与授权消费状态。审批配置/判据版本在创建评估时固定；安全策略收紧令未执行授权失效，不拿旧批准处理新参数。`memo` 只作幂等引用，不把 pending 写成不可修改的最终答案。
- 人工等待使用 durable document + 审批 task 的 `watchDoc`，重启后重新订阅；取消时释放订阅。判断任务在调用 classifier 前存 checkpoint，调用中崩溃可重做只读判断（可能额外计费），不能因此重放实际危险工具；结果落库后不重复评估。
- 授权 hook 放在应用定义的参数规范化之后，不允许后续 hook 改参数；执行适配器仍核验当前权限与绑定的授权，覆盖上游恢复时跳过 `beforeTool` 的路径。配置/参数变化不沿用旧批准。
- 文件读写适配器校验真实路径（含符号链接），写入限制在允许工作目录；skill 可读根单独绑定。Shell 和 stdio MCP 以本机用户权限运行，cwd **不是安全沙箱**，判断模型也不保证安全；启动设置和文档须明确提示这一风险。

### 5. 数据归属、消息路由与恢复
- 同一 SQLite 存储中使用 session documents 保存 workspace、员工目录和模型非敏感配置；keyed document families 保存频道、邮件线程、成员收件状态、工作索引与审批；conversation documents 保存员工工作绑定及协作预算。正文优先不可变 entries，避免一个全局无限增长数组。
- 共享频道/邮件 conversation 保存公共记录，不让多个员工竞争修改同一 conversation 的 agent。员工各有独立执行 conversation；频道线程从对应公共 entry fork，并显式应用当前员工配置。
- 路由向员工提供其可见历史和增量：保存历史水位与消息来源，不带入其他私信/邮件。每个员工-私信/线程上下文串行排队，不同员工与线程并发。
- **投递任务**：一次 commit 写入消息/邮件、收件记录、幂等请求索引并创建 durable delivery task。随后 task 以稳定 requestId 调用员工 submit，等待完成，再以一次 commit 写入最终答复/邮件与终态。崩溃恢复查找既有 submission，不重复生成或投递。
- SSE 传快照与增量，消息/工具使用 `watchEvents`，应用 documents 使用其订阅；重连获取最新快照，按 ID 合并，不能把同一个增量追加两次。浏览器仅展示已提交状态；订阅取消不取消实际工作。
- 邮件可与即时消息并行，且只在用户指定的关联任务处共享信息；默认不复制员工所有其他工作的私有历史。
- 本地数据目录加单实例锁，第二个后端拒绝打开同一库；复用成熟文件锁实现，不自行写竞争协议。
- `harness.resume()` 恢复任务；只读/幂等工具才标 safe。写文件、Shell、未知 MCP 在执行途中崩溃时显示“中断，可能已产生效果”，不自动重放；用户批准也不把危险工具变成 safe。
- SQLite 默认 WAL + synchronous NORMAL 可恢复进程崩溃，但不保证断电不丢最后提交；运行说明明确这一上游限制，不声称所有外部副作用 exactly-once。

### 6. 员工自主协作
- 提供 `list_employees`、`send_message`、`send_mail`、`delegate_task`；身份由后端绑定，不接受模型伪造 sender。通信与交办都出现在用户可见的频道/邮件/任务记录。
- `delegate_task` 创建目标员工专用的 task-owned child conversation，不占用其正在等待父任务的私信 lane；结果以可见报告返回父任务。异步消息/邮件使用 background delivery task，父任务正常停止不撤销已投递邮件；单独提供停止后台工作。
- 保存 `rootWorkId/parentWorkId/sourceMessageId/sourceMailId/participants/depth`。默认最大协作深度 3、每根工作最多 12 次跨员工唤醒、每员工工作最多 40 个模型回合；设置页可调整，计数原子递增，恢复不清零。
- 同步交办拒绝目标已在当前等待祖先链的循环；异步转发也共享根预算。达到限制暂停并提示用户，不偷偷继续、不因为重启绕过。
- 员工回复不会自动唤醒所有频道成员；仅显式员工消息、To 收件人、`@` 和交办启动工作。展示任务树和停止作用范围，避免“所有人互相回复”无限循环。

## Files to modify
当前是空工程，以下路径均计划新建；按职责组织，不预先拆分无行为的抽象层。

| 路径 | 职责 |
|---|---|
| `package.json`, `package-lock.json`, `tsconfig*.json`, `vite.config.ts`, `index.html` | 固定 Pi 1.0.0 依赖、开发/构建/启动/验证命令 |
| `src/shared/contracts.ts` | 员工、通信、工作、审批 DTO 与命令校验 |
| `src/server/main.ts`, `src/server/http.ts` | 单实例启动、静态资源、HTTP 命令、SSE、关闭释放 |
| `src/server/runtime.ts`, `src/server/documents.ts` | Harness/SQLite、typed documents、状态索引与版本迁移 |
| `src/server/workspace.ts`, `src/server/employees.ts` | workspace/用户/邮箱生成、员工配置及权限生效 |
| `src/server/models.ts`, `src/server/providers.ts`, `src/server/credentials.ts` | Pi provider collection、配置驱动目录、能力/effort 解析、认证与按 kind 的真实连接检查 |
| `src/server/communications.ts`, `src/server/work.ts` | 频道/私信/邮件、draft/read/archive、幂等投递与最终答复 |
| `src/server/extensions/{identity,skills,mcp,approval,collaboration}.ts` | 员工上下文、真实技能/MCP、LLM 与人工审批、员工交办 |
| `src/server/approval/{contracts,evaluator,llm,classifier,state}.ts` | 结构化判断 seam、两种实际 adapter、审批单与授权状态机；extension 只挂接工具生命周期 |
| `src/server/tools.ts` | 文件/Shell 执行适配器、恢复时权限/批准校验 |
| `src/web/{main,App}.tsx`, `src/web/lib/client.ts`, `src/web/styles.css` | 页面框架、HTTP/SSE 状态连接、响应式样式 |
| `src/web/components/` | Sidebar、Composer、Markdown、ThreadPanel、工作/审批卡 |
| `src/web/pages/{Messages,Mail,Employees,Work,Approvals,ApprovalDetail,Settings}.tsx` | 独立审批中心/详情、消息邮箱等真实页面、逐员工和独立判断模型配置 |
| `test/{delivery,approval,approval-evaluation,model-selection,collaboration,employee-access}.test.ts` | 投递去重、裁决恢复、阈值边界/无效结果、model+effort 隔离、权限与协作循环 |
| `.gitignore`, `.env.example`, `README.md`, `CHANGELOG.md` | 数据/凭据排除、运行配置、功能与安全限制 |

## Reuse
- 本地：无现有实现。
- 已验证 npm 发布 `@earendil-works/pi-durable@1.0.0`，要求 Node >=22.19.0；与 `pi-ai@1.0.0`、`chord@1.0.0` 固定版本并使用 lockfile。上游声明实验接口，实施前以发布版本而非漂移的 main 为准。
- 上游 README 已核实 SQLite 打开/恢复、工具 hook、每 conversation 配置、快照订阅与重连语义。后端选 Node >=22.19.0 + TypeScript（已观察本机 Node v22.23.2 满足要求），前端选 React + Vite；无需 Redis、外部数据库或云端工作流。
- 已进一步核实 `packages/durable/src/types.ts`：documents 支持 `session`、`conversation`、`task` scope 及 keyed families。员工与 workspace 配置用 session document，各邮件/频道用 keyed document，不需要为全局配置创建虚拟聊天。
- SQLite 默认 WAL + synchronous NORMAL 承诺进程崩溃恢复，不承诺断电不丢最后写入。上游无跨进程锁，应用须加单实例数据目录锁。
- `pi-ai` 支持内建 provider、CredentialStore 与 `createProvider` 的自定义 OpenAI-compatible endpoint，可连接本地 Ollama/LM Studio；本地运行不等同于模型必然离线。
- 已核实 `pi-ai` 的三类 model 分离、动态 `refresh`、`getSupportedThinkingLevels` 与原生 classifier：TypeSafe Jev 不是 chat 模型，使用 `ClassifierContext` 的 state/questions 与 `ClassifierResult` typed answers，直接复用此接口和认证。
- 已发现可独立复用的 `@earendil-works/pi-mcp@1.0.0`：`McpClient`、`StdioTransport`、`StreamableHttpTransport`、`toLlmContent`；无需依赖 coding-agent 的 MCP extension，直接适配为 durable tools。
- skills 复用 coding-agent 根导出的 `loadSkillsFromDir` 和 `formatSkillsForPrompt`；只用资源加载函数，不启用第二个 agent runtime。每位员工仅加载显式绑定的技能目录，保留诊断和按需读取。
- 阅读发布提交的 `packages/durable/src/harness/tool.ts` 发现：工具执行前写入 intent，恢复到 execute 阶段时不再运行 `beforeTool`。因此审批 hook 只负责首次授权，工具执行适配器还必须核验授权绑定、当前员工权限和配置版本；不能把 hook 当作恢复时的唯一权限检查。
- `TaskRuntime` 支持 `watchDoc`、`memo`、`commit`、`waitForTask` 和取消信号。人工待审批保存为 document，审批 task 等待其订阅变化；重启重新挂接订阅，不用内存 Promise 充当唯一记录。
- MCP annotations 只是服务端声明，不足以可信判定自动批准或 `replay: "safe"`；默认未知 MCP 调用须审批且不可自动重放。先支持 stdio 与 Streamable HTTP（环境变量/header 凭据），不擅自增加 OAuth 和外部邮件集成。

## Steps
- [x] 确认单人使用、站内模拟邮箱、LLM 地址生成、Auto mode 与人工兜底、自主员工协作。
- [x] 核实发布的 Pi 1.0.0、document scope、hooks/恢复语义、skills 导出与独立 MCP 客户端。
- [x] 建立 TypeScript/React 工程和本地启动命令，固定 Pi 版本；验证发布包类型与 Node SQLite 实际可用。
- [x] 实现 Pi provider registry、动态模型目录、认证与自定义 provider 配置；逐员工 model+effort、独立 LLM/classifier 审批配置及按模型类型的连接检查。
- [x] 实现单实例 harness、documents 与首次设置；创建用户与员工，真实生成并持久化模拟地址（无模型时回退为确定性本地部分）。
- [x] 实现员工配置、skills 导入与 MCP 连接/工具映射，保证逐员工白名单与真实执行上下文。
- [x] 实现 ApprovalEvaluator 的 LLM 与 classifier 两种 adapter、持久化裁决状态机；接入 `beforeTool` 授权与 `execute` 复核。
- [x] 实现频道/私信/邮件、durable 投递、幂等 requestId 与 SSE 重连。
- [x] 实现自主通信/交办、来源链、协作预算、停止语义与用量展示。
- [x] 完成消息/邮箱界面、员工目录、独立审批中心、工作与设置页。
- [x] 端到端冒烟（假 provider + 真实 harness）：只读路径、需人工批准路径、SIGKILL 后恢复、授权执行、回写会话。
- [x] 补齐 README 的运行/恢复/凭据/非沙箱限制说明。

## 实施后的结构（与计划表的差异）
- 服务端模块按实现落地为：`runtime.ts`（单实例与文档读写）、`documents.ts`（typed documents）、`agents.ts`（员工 extension）、`tools.ts`（内置工具与授权复核）、`work.ts`（工作与投递）、`rooms.ts`（房间与邮件）、`api.ts`（HTTP/SSE）、`progress.ts`（提交流式进度）、`approval/{contracts,evaluators,state}.ts`。
- 前端按职责落地为 `src/web/{main,App,api,state}.tsx` 与 `src/web/views/*`，未拆分出独立 `components/` 目录（组件数量不足以支撑该层）。
- 审批判断不新建 task-owned conversation：`completeText`/`classify` 直接调用模型集合，稳定 `evaluationId` 用于日志与审计；理由是最小实现已经覆盖“不依赖聊天 transcript”的要求。
- `delegate_task` 的父子链通过 WorkDoc 的 `rootWorkId/parentWorkId` 与传入父 conversation 的 `deliver:<workId>` 幂等提交实现，不额外建 child conversation 的独立 lane。

## Verification

### 验证现状（滚动更新）
已跑通并有证据：
- `npm run typecheck`、`npm test`（28 例）、`npm run build`；`npm start` 以生产入口提供 `dist/web`，`/assets/*` 与 `/api/*` 404 行为正确。
- `tmp/smoke.mjs`（真实 harness + 假 OpenAI-compatible provider + `tmp/fake-mcp.mjs` 协议桩）：首次设置、员工创建与地址生成、私信只读工具路径、需人工裁决的写路径、LLM 判断依据、SSE 进度/审批事件、SIGKILL 后真实重启与锁接管、重启后同一审批单继续等待、批准后工具真执行与授权复核、执行状态与时间线、拒绝不执行且不消费授权、停止等待中的工作会取消审批、重复裁决 409。
- 邮件：草稿保存不投递、编辑草稿只留最新一版、发送草稿后 To 每人各起一份工作、两位收件人分别答复同一线程并保留其他收件人、已读/归档、CC 只记录不唤醒、发给用户自己的邮件只投递、恢复后每项工作只投递一次回答。
- 邮箱文件夹与地址：`/api/mail` 只汇总用户自己参与或有权限的邮件（含草稿与自发件），收件箱/发件箱/草稿/归档四类都由该列表派生；目录之外的地址按原样记录且不唤醒任何人；无效收件人被 400 拒绝。
- 模型校验：不存在或非 chat 的模型、以及模型不支持的推理强度，在保存员工时被 400 拒绝；凭据变更后 provider 集合整体替换（删除的 provider 及其模型立即不可解析），模型不可用时启动工作明确报错且不产生假回答。
- 硬权限：允许列表之外的工具被直接阻止（没有审批、没有副作用），被阻止的结果会回到模型。
- 技能：导入 -> 绑定 -> `load_skill` 读取正文的全链路可用，未绑定的技能不会出现在提示里。
- 协作：交办形成 `parentWorkId/rootWorkId` 父子链并带层数；跨员工唤醒上限、交办层数上限、以及“交办回上级”的循环都在真正的边界处停下，交办结果回到发起会话，`/api/works` 能看到最终回答。
- MCP：与 stdio server 完成连接、工具发现（2 个工具）、逐员工绑定、受信任工具直接调用、未受信任工具经审批（人工批准后真正执行并回填执行状态）、无法启动的 server 记录为 error 并保留原因。
- 第二实例在同一数据目录：等待 20 秒后以“数据目录已被另一个 Emit 进程占用”退出（不抢占仍存活的锁）。
- 浏览器实测（真实后端 + 假 provider）：首屏载入记录、审批中心历史、工作列表、聊天内实时工作块与“等待审批/停止”、停止后审批转为已取消；邮件页的 To/CC 选择、草稿区（保存→发送）、线程 To/CC 标记与回复全部、文件夹切换与未读数量。

仍未验证（环境缺凭据/服务）：
- 真实 chat 模型与真实 classifier（如 Jev）：判断阈值、概率、以及 classifier 的 error/缺字段路径。纯判定逻辑（LLM 的 approve/high 规则、classifier 的阈值等于/低于边界、缺失授权概率）现在有单元测试覆盖，但 wire 协议与真实分类输出仍未经真实 provider 执行。
- 真实第三方 MCP server：客户端、映射与审批路径已与自建协议桩跑通，但没有连过别人的 server（HTTP 传输同样只经代码审查）。
- plan 文本的剩余差距：无。

以下是实施验收，不是已通过的结果。

### 工程与确定性行为
- 工程提供并运行 `npm run typecheck`、`npm test`、`npm run build`；以生产 `npm start` 启动最终产物，不只观察开发页。
- 永久测试只覆盖消费者可见不变量：重复消息/邮件不重复执行与投递、裁决取消/迟到/重启/并发、旧批准不授权新参数、classifier 概率阈值的等于/低于边界与 error/缺失回答、不兼容 model kind/effort 的拒绝、不同员工权限、协作预算和祖先循环。使用受控判断结果与临时库，不调用付费模型；不测试模型字段机械转发。
- 不新增按钮文案/源码字符串/字段转发等实现细节测试；浏览器直接验收实际 UI。

### 实际浏览器与真实模型场景
1. 首次配置 workspace/用户；从 Pi 目录配置至少两个 provider 或一个内建 provider 加自定义 endpoint，观察模型目录与按 kind 的真实连接检查。新增 compatible provider 不改业务代码即可选择；LLM 给用户/员工生成地址，刷新/改名保持身份稳定。
2. 员工 A 与 B 选择不同 model + 支持的 effort，审批独立选择第三份配置；改变 workspace 默认值不覆盖已配置员工，A 交办 B 使用 B 的配置，执行期间变更只作用于后续请求。切换到非 reasoning 模型时 UI 不再提供无效 effort。导入技能后未绑定员工不可见。
3. 在频道 `@` 两位员工，观察分别流式回复、真实工具输出和任务卡；打开线程后继续频道工作，观察互不阻塞。私信执行期间分别试排队、steer 与停止。
4. 通过 stdio/HTTP 接入至少一个真实 MCP server，发现并调用其实际工具；验证同名工具映射和逐员工禁用。失败连接显示真实错误，不伪报成功。
5. 从邮箱写带主题的邮件、存草稿、发送/回复/归档；To 员工收到异步任务，CC 不执行，最终收到同线程答复。关闭浏览器期间后端继续，重新打开可见结果。
6. 员工 A 自主交办 B，B 使用自己的技能/工具并汇报；观察父子关系与通信记录。触发循环/预算限制后暂停，重启不重置预算。
7. 分别从私信和邮件触发需要确认但没有违反硬权限的操作；两者跳到同一个独立审批中心，详情可回到正确原文。拒绝时无副作用，新调用单次批准后才执行；审批时间线与实际执行结果一致，刷新/两个标签页并发点击不重复裁决。硬越权操作始终被阻止，不能用人工按钮覆盖。
8. 同一类可控工具调用分别使用 LLM 与真实 Jev classifier 审批：LLM 显示 rationale，Jev 显示 criteria 与 probabilities，不要求 classifier 输出文本理由。观察自动批准、低置信度人工等待、判断服务失败待裁决；切换审批策略不影响员工模型，停止任务后旧批准不能复活它。

### 持久性与失败场景
- 在模型流式回答、邮件投递、审批评估、人工等待时停止/重启后端；分别观察已存历史、任务恢复、审批中心可继续裁决、最终邮件只有一封。已存判断不重评，未完成 classifier 判断允许重做但不执行危险操作；安全策略版本变化使旧未执行授权失效。
- 用可观察的受控副作用场景验证工具 intent 后中断：unsafe 不重放；safe 重放仍必须通过执行适配器权限复核。该故障注入用临时验证程序，不在用户文件上试验破坏性命令。
- 重复 requestId、断开/重连 SSE、第二个浏览器页面进入进行中的任务：无重复消息，快照包含当前工具输出与排队工作。
- 无模型凭据、模型失败、MCP 不可用、审批失败时均显示准确失败/待裁决状态，无假回答、静默放行或无限 spinner。
- 第二个后端打开同一数据目录必须拒绝；记录真实浏览器截图、执行输出和恢复前后状态作为交付证据。
- 真实端到端需要用户实际可用的 chat 模型、classifier（如 Jev）凭据/服务及 MCP server；若环境缺失，完成所有可运行验证并逐项指出哪条真实场景未验证，不能称两个判断 adapter 或集成都已验收。

## Sources
- [Pi Durable 原文](https://earendil.com/posts/pi-durable/)：产品方向和 durable 运行原则。
- [Pi Durable README](https://github.com/earendil-works/pi/blob/a13d35a742c6ef8462812a28fbe1d8c8b7431c32/packages/durable/README.md)、[类型契约](https://github.com/earendil-works/pi/blob/a13d35a742c6ef8462812a28fbe1d8c8b7431c32/packages/durable/src/types.ts)、[工具恢复实现](https://github.com/earendil-works/pi/blob/a13d35a742c6ef8462812a28fbe1d8c8b7431c32/packages/durable/src/harness/tool.ts)。
- [pi-ai provider/凭据文档](https://github.com/earendil-works/pi/blob/a13d35a742c6ef8462812a28fbe1d8c8b7431c32/packages/ai/README.md)。
- [Pi classifier 文档（含 Jev）](https://github.com/earendil-works/pi/blob/a13d35a742c6ef8462812a28fbe1d8c8b7431c32/packages/ai/README.md#classification)、[模型与分类结果类型](https://github.com/earendil-works/pi/blob/a13d35a742c6ef8462812a28fbe1d8c8b7431c32/packages/ai/src/types.ts)：本次扩展设计依据，已阅读并确认。
- [独立 MCP 客户端](https://github.com/earendil-works/pi/blob/a13d35a742c6ef8462812a28fbe1d8c8b7431c32/packages/mcp/README.md)、[skills 格式](https://github.com/earendil-works/pi/blob/a13d35a742c6ef8462812a28fbe1d8c8b7431c32/packages/coding-agent/docs/skills.md)、[skills 公共导出](https://github.com/earendil-works/pi/blob/a13d35a742c6ef8462812a28fbe1d8c8b7431c32/packages/coding-agent/src/index.ts)。
- [durable npm 1.0.0](https://registry.npmjs.org/@earendil-works%2Fpi-durable/1.0.0)、[MCP npm 1.0.0](https://registry.npmjs.org/@earendil-works%2Fpi-mcp/1.0.0)。

