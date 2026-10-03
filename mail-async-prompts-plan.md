# 邮件异步体验与模型提示词集中管理

## Context
用户要求邮件不再表现为普通私信，而体现真正的异步通信；同时把所有给模型的提示词从业务代码中收敛出来，便于开发者和检查者阅读。当前邮件发送已不等待最终答案，但发送入口直接启动 work，邮件阅读页显示执行进度并常驻聊天式回复框。

## Approach
### 1. 发信只持久接收，启动交给原生 durable task
当前 `api.ts:wakeMailRecipients` 和 `work.ts:send_mail` 都先独立写信、再同步启动员工；在两者之间崩溃会漏掉唤醒。使用已经安装的 Pi Durable `defineTask`/`tx.createTask`/`Harness.resume()`，不自建轮询 worker，也不加随机等待或外部队列。

- 在 `documents.ts:WorkRecord` 增加必填 `mailDispatchTaskId: string`、`mailResumeTaskId:string`、`awaitedMailWorkIds: string[]`，初值 `""`/`""`/`[]`；状态增加 `"waiting-mail"`。`WorkDoc` 升 version=2，`migrate(value,1)` 仅补这三个字段，保留所有原工作/会话/目录数据；扫描读取也必须走 token.definition.migrate，不能让 `runtime.listFamily` 的原始 materialize 跳过迁移。`WorkDTO` 对应新增 `mailDispatchTaskId?: string`、`mailResumeTaskId?:string`、`awaitedMailWorkIds: string[]`，`WorkStatusDTO` 增同状态；`dto.ts:toWorkDTO`、`ui.tsx:WORK_LABELS/WORK_TONES` 同步，label=`等待回信`。
- 新建 `src/server/mail.ts`。`MailTasks={dispatch:Task<MailDispatchInput,MailDispatchState,MailDispatchResult,object>;resumeTask:Task<MailResumeInput,MailResumeState,MailResumeResult,object>}`；`buildMailTasks(resolve:()=>Resume):MailTasks` 内部 `defineTask` 两个定义，phase 运行时才 `resolve()` 取得含 mcp 的完整 Resume（避免与 work.ts 循环 import/构造次序问题）。`emit.mail-dispatch` input `{workId:string}`、checkpoint `{phase:"start"|"submit"}`、result `{workId:string}`；`emit.mail-resume` input `{parentWorkId:string;childWorkId:string;roomId:string;entryId:string;outcome:"reply"|"failed"|"stopped";error:string}`、checkpoint `{phase:"submit"}`、result `{submitted:boolean}`。version=1、必填 abort handler；每 phase 经 `TaskRuntime.commit` 返回 `{status:"running",checkpoint:{phase:"submit"}}` 或 `{status:"terminal",outcome:{status:"completed"|"failed",...}}`，返回 undefined 不得用于推进。`buildMailExtension(tasks:MailTasks):Extension` 仅 `{name:"emit.mail",tasks:[tasks.dispatch,tasks.resumeTask]}`。已读 `Extension.tasks` 注册后“whichever conversations select”之外全局按名解析，故任务由 `registry.install` 全局可用，员工 extension 不选它。
- `Resume` 类型加 `mail: MailTasks`。`main.ts` 构造 `const resume: Resume = { runtime, mcp, mail: undefined as unknown as MailTasks }; resume.mail = buildMailTasks(() => resume);`，`runtime.registry.install(buildMailExtension(resume.mail))` 放在 `installAllExtensions` 后、`runtime.resume()` 前；`buildServer` 改收共享 `resume: Resume`（删内部 `{runtime,mcp}` 重建），`installEmployeeExtension`/`startWork` 等原签名不变。队列 task 用 `{ownership:{kind:"conversation"},conversationId:mailRoom.conversationId,background:true}`；收件人执行会话仍 ownerless。已投递邮件不因发件人的工作停止而撤回。
- 新接口 `sendQueuedMail(resume: Resume, input: {room:{id:string}|{create:RoomCreateInput}; data:RoomMessageData; parentWorkId?:string; awaitReply?:boolean; retireDraftId?:string; toolTaskId?:string}): Promise<{message:MessageDTO;workIds:string[]}>`：所有已发送邮件入口共用；RoomCreateInput从rooms.ts:createRoom现有init结构命名导出。没有相同现成接口，`appendRoomMessageIn` 是原子写入 seam。事务内重新验证 room/目录版本、信封父 entry 与 To 去重；append sent entry、为每个 To 员工创建 queued WorkDoc 和 dispatch task、保存 taskId，最后同事务退役源 draft。使用发送时的 room directories 快照；后台启动时校验版本，不能偷偷取得后来增加的授权。用户地址/CC 不建 work，纯用户收件 `workIds=[]`；draft 保存仍只落信、不排队。
- 草稿发送在事务内读取具体 entry 与 MailFlagDoc，确认 draft 且 active，否则 409；不能先发再独立 `setMailFlag`。多 To 中员工停用、模型失效等处理故障各自标 failed，其他收件人继续；未知收件人/非法父 entry 等输入错误仍在接收前返回 400，room 缺失404。已持久接收后不因启动失败返回“发送失败”，具体失败由工作状态/详情呈现。
- 员工工具必须安全重放：新增 `MailSendReceiptDoc`（kind=`emit.mail-send-receipt`，family seed `{key:string}`，record `{key:string;roomId:string;entryId:string;workIds:string[]}`），key=`tool:<toolTaskId>`。send_mail执行第一步读receipt，存在就返回原结果，不重新做已经变更的来源/目录校验；发信事务再次查receipt。新entry/works/tasks/receipt同时写入，工具设置 `replay:"safe"`，不靠“先发后 memo”的非原子去重。新session用 `createRoomIn(tx:Tx,init:RoomCreateInput & {directories:RoomDirectoriesRecord}):Promise<RoomRecord>`：`tx.createConversation({ownership:{kind:"ownerless"}})`＋导出的 `configure(tx,conversation.id,{extensions:[]})`＋RoomDoc同事务写，创建前验证/canonicalize目录，事务内不做文件系统网络调用；`createRoom`也改为预验证后commit调用此helper。receipt guard在createRoomIn之前，因此重放无重复session。外部用户新邮件不增加自动重试。
- 用户邮件 POST `/api/rooms/:id/messages`、草稿 POST `mail-send`、员工 `send_mail` 全改为该接口；移除 `wakeMailRecipients` 及邮件路径中的直接 `startWork`。响应保留 `{message,workIds,workId?:workIds[0]}`，这些是 queued work ID，不承诺模型已开始；非邮件发送与 delegation 继续原调用方式。
- 拆分 `work.ts:startWork`：`createQueuedWork(resume:Resume,input:StartWorkInput):Promise<WorkRecord>` 执行原校验/初始写入；`ensureWorkConversation(resume:Resume,workId:string):Promise<Conversation>` 执行原extension/模型/目录校验，复用非零conversationId，否则 `createConversation.init` 在同一事务写 ConversationContextDoc 和 WorkDoc.conversationId（重新读work确认未终态）；`startQueuedWork(resume:Resume,workId:string):Promise<WorkRecord>` 调ensure、构造原mailSource/history输入、以 `requestId=work:<workId>` submit admission，保留settlement watcher，不等待答案。原 `startWork` 组合createQueuedWork+startQueuedWork，继续服务 API 非邮件、send_message、delegate_task。mail-dispatch.start只调ensure并checkpoint→submit；submit调startQueuedWork后终结。不改终态work为running；queued→running在submit之前持久写，期间dispatch仍live，reconcile不会误失败。邮件事务直接初始化queued WorkDoc，复用新私有 `createQueuedWorkIn(tx:Tx,input:StartWorkInput & {id:string;directoryScope:WorkDirectoryScopeRecord;now:number}):Promise<WorkRecord>`，两个创建入口共享其字段赋值，不重复一套record初始化。重放不重复work/conversation或协作预算。原StartWorkInput里未消费的subject/inReplyTo参数删除，send_mail移除subject传参，信封/父关联以sourceEntry为准。
- 目录/员工/模型失败以同一事务结束 dispatch task、置工作 failed、写一次系统 notice；进程关闭/任务上下文取消必须向上传播，不伪装业务失败。`reconcileWorks` 对有非终态 dispatch task 的 queued/running mail 和合法 `waiting-mail` 不标“启动中断”；坏/丢失/失败的 dispatch task 显式失败，其他工作保留原恢复规则。通过持久 task 状态判断，不靠内存队列或重新扫描所有邮件补发。
- `stopWork` 先持久 stopped，再对非终态 dispatch task `abortTask` 并等待其终态，然后 abort 执行会话/取消审批；task abort handler提交终态并不发信、不再 submit。创建 conversation 的 init 与各 phase 再检查 work 终态，关闭“停止后晚到 submit”窗口。原生恢复重新调度非终态 task，不自动重试已 failed 的业务调用。
- 两类 mail task 的创建统一用 `Resume.mail.dispatch`/`Resume.mail.resumeTask` 传给 `tx.createTask`；因此改签名：`buildDeliveryHook(resume:Resume)`、`markFailed(resume:Resume,work,reason)`、`stopWork(resume:Resume,workId)`、`reconcileWorks(resume:Resume)`（原来只收 runtime），调用点 `extensionFor`、`api.ts` 路由、`main.ts`、startQueuedWork 的 settlement watcher 全部传现有 resume 对象；deliverAnswer 经 hook 的 resume 闭包取 tasks。除这些签名外不动其他 runtime 参数。

### 2. 只有求助回信接续原任务
本步骤依赖步骤 1 的原子发信与两类 task；保留 mail room 的 inReplyTo graph、session 目录、To 执行/CC 不执行语义。

- `send_mail` schema 增 `awaitReply: Type.Optional(Type.Boolean(...))`，默认 false。模型收到的工具说明要求：通知/独立发信 false；当前任务需要对方结果才能完成则 true。true 时同一发送事务将 queued childWorkId 加入 caller.awaitedMailWorkIds；禁止自我等待、目标为 caller 祖先、超过 maxDepth，失败不落信。等待分支 depth=caller.depth+1，使用现有 maxDepth/maxCrossEmployeeWakes；唤醒预算与发信事务一起计数且去重重放不再次计费。非等待主动邮件保留既有 depth/session 语义，不扩展到私信工作流程。
- 原工作可在等信期间完成本地工具/其他协作，不在 send_mail 工具里阻塞等待另一模型；`buildDeliveryHook.onYield` 在最终投递事务内再次读取 awaitedMailWorkIds。非空则只置 waiting-mail、保留模型文本在执行记录，不向用户投递“我在等回复”、不标 succeeded。空时执行原最终答复投递；不能只靠提示词让模型遵守等待。
- `deliverAnswer` 保留完整回复落信+succeeded 的原子事务；若 child.id 存在于 parent.awaitedMailWorkIds，在同一事务创建唯一 mail-resume task，input 含该完整回信 entryId，并把taskId保存到child.mailResumeTaskId。正常最终回复依然不触发新的收件人 work；父关联不匹配、不在等待列表时只投递邮件，避免“谢谢/不客气”循环。failed/stopped child 在其终态事务也创建mail-resume task并保存taskId，传真实失败/停止原因；用终态guard保证只建一次，不造假的成功回信。
- mail-resume phase 用 TaskRuntime 自带 `runtime.conversation(parentWork.conversationId, context)` 取父执行会话 handle（返回 undefined→终态 failed `原任务执行会话不存在`），`submit({type:"input",content:renderMailContinuation(...),whenBusy:"followUp",requestId:"mail-reply:<childWorkId>"})`；不 await 答案，admission 完成即 task terminal `{submitted:true}`。回信含主题/from/to/cc/inReplyTo/entryId/正文或失败事实；必须作为员工/工具不可信证据，不升级成真实用户授权。父 stopped/failed/succeeded、目录版本已失效时不复活；目录失效将父工作明确 failed，回信仍已保存在其 mail room。
- **快回信竞态**：admission 后不能立即删除 awaitedMailWorkIds。`GenerationTask.beforeRequest`（HookApi 只有 snapshot/snapshotAsOf，无 submission 查询）用闭包 `runtime.storage.submissionByRequest(parentConversationId,"mail-reply:<childId>",context)` 查状态；仅 placed/done（followUp 已进入即将发送的模型上下文）才从父 awaitedMailWorkIds 删除 child 并把 waiting-mail 恢复 running。queued/尚未提交仍等待，因而旧一轮提前 onYield 不会抢先完成任务。多个求助逐封续接，只有全部关联回信/失败结果被模型接收后最终答复才可投递。
- `reconcileWorks` 的 waiting-mail 无活动 generation 是正常 idle；等待child非终态就保留，child终态则检查child.mailResumeTaskId及该task状态/`mail-reply:<childId>` submission。非终态resume task交原生恢复，placed/done输入交执行恢复，queued输入仍在followUp队列；坏/丢失task或unanswered submission明确失败，不能永久挂起。新流程child终态与resume task原子，不临时补发猜测结果。
- 审批状态切换不能把 waiting-mail误当 running 或取消刚续接工作的审批；beforeRequest 只恢复 waiting-mail，不覆盖 waiting-approval/stopped。ChatView/WorkView/UI状态穷举、停止按钮和审批等待条件全部接入该状态。

### 3. 默认邮件阅读，执行过程另开详情
本步骤可与提示词资源抽取独立进行，但完整等待/错误展示依赖步骤 1–2。

- `MailView` 删除 `reply` state、常驻底部 textarea、roomWork 流式卡片。每封 sent message 提供“回复/回复全部”，调用 `startReply(message:MessageDTO,all:boolean)` 打开既有 Compose；新增 Compose.inReplyTo:string，初始 `""`、回信为所点 message.id，草稿编辑恢复 mail.inReplyTo，snapshot纳入该字段，saveDraft/sendComposed透传。回复绝不默认最近一封，避免并行分支错接。
- 预填当前 roomId/目录/version、`Re: `主题（已 Re: 不重复）、发件人 To，reply-all把原 To/CC中自己和重复地址排除后放 CC，沿用现有收件 ID＋extra 地址表示法。本人发信的回复入口使用其原 To，不把员工当用户自己。不丢弃已打开的脏 Compose：显示既有继续编辑/丢弃确认，再打开目标回复。失败保持文本/roomId/inReplyTo/目录与草稿。
- 接收成功关闭 Compose、回“已发送”列表、提示 `邮件已发送，回复将送达收件箱`，不再 `openThread(roomId)` 进入实时等待。已发送页每封/每线程按相关 work显示简洁状态和“查看执行”；阅读页邮件旁也有此入口，queued/running/waiting-approval/waiting-mail/failed/stopped/succeeded均可看，不只是活跃 work。多 To 分别展示收件员工与状态；无执行收件人显示已发送但没有假步骤。
- 将邮箱刷新接入现有 message/room SSE 状态变化：在 `state.tsx` 的 ServerEvent `message`/`room` 处理分支递增新字段 `State.mailRevision:number`（初值0），MailView `useEffect([state.mailRevision])` 调 `refreshMailbox()`；`message` 事件满足 `message.mail !== undefined && message.author.type === "employee" && message.mail.draft !== true` 时 dispatch notice 文本 `收到新邮件`。无论用户停留 mail/work/chat，收到新的完整员工 mail 只显示该 notice/未读徽标，不强制切页。进入 mailbox 重新取 `/api/mail`；阅读不会在邮件尚未展开时清未读。继续复用房间/邮件flag与当前邮箱可见性规则，不引入系统通知权限。
- 新建 `src/server/work-execution.ts` 的 `readWorkExecution(runtime:EmitRuntime,workId:string,cursor?:string):Promise<WorkExecutionDTO|undefined>`，新 GET `/api/works/:id/execution?cursor=...`，web.api增加同名调用；不存在404，坏cursor400，work.conversationId=0返回 queued状态＋空steps，而不是不存在。现有 WorkView 只有表格，无现成持久步骤详情，因此新增 `src/web/views/WorkExecution.tsx` 可复用弹层。
- `WorkExecutionDTO={work:WorkDTO;steps:WorkExecutionStepDTO[];nextCursor?:string;approvals:ApprovalDTO[]}`；step字段 `{id:string;entryId:string;taskId?:string;kind:"input"|"assistant"|"tool-call"|"tool-result"|"meta";at?:number;text?:string;toolCallId?:string;toolName?:string;arguments?:string;isError?:boolean;truncated?:boolean;taskStatus?:string;taskError?:string}`。读取 `Conversation.entries({},100,cursor,ctx)`，每页按时间正序展示，旧页prepend并按step.id去重。从entry.model提取可见用户/助手文本、toolCall、toolResult，用entry.id+消息/内容序号作为稳定id，callId关联结果；不返回system prompt/private thinking/图像base64。
- taskStatus/error从 entry.byTaskId 的真实 `harness.getTask` 与持久 outcome读取，不拿输出不存在推测成功；实时结果使用 toolResult.isError，保留失败/aborted/faulted/orphaned原始原因。关联审批按workId过滤，展示完整时间线、审批状态、真实execution状态；可从详情跳审批页，停止复用stopWork。参数/文本/错误用既有 redactArguments/redactApprovalText，单项预览≤8000 UTF-8字节并明确truncated；不要把任意执行路径暴露成不经校验的文件下载。
- 邮件执行入口打开上述弹层（可选择多To某个work）；WorkView每行也加“查看执行”。打开时从持久接口加载，work-progress/work/approval事件触发最多每120ms一次刷新详情；queued→conversation建立、结果替换同id、等待回信→恢复、失败/停止都准确更新。刷新页面后仍能看到先前工具调用、结果与错误。关闭/切work取消旧请求应用，空记录明确“尚未开始执行”；请求失败显示错误和手动重载，不能回落成“没有步骤”。

### 4. 所有自有模型指令成为可独立阅读的资源
不只迁移system prompt。已盘点身份/context、work输入、skills包装、协作续接、LLM/classifier审查、工具/参数说明、操作指导、地址建议和连接探针，均纳入；员工instructions/技能正文/远端MCP描述及schema是动态来源，不固化，也不改其编辑方式。

- 新建 `src/server/prompts/index.ts` 为唯一typed renderer/public resource入口、`loader.ts` 为私有加载器；业务模块只能调用renderer/引用资源字段。新资源文件固定为 `employee.md`、`context.md`、`skills.md`、`work-input.md`、`continuations.md`、`tool-results.md`、`approval-system.md`、`approval-user.md`、`approval-context.md`、`address-system.md`、`address-user.md`、`tools.json`、`classifier.json`、`probes.json`。多片段文件用 `## <fragment-id>` 标题切片，标题不进入最终prompt；单整篇system/user文件为原正文。工具JSON按8个实际工具名保存description与parameters各说明，不在资源里重复TypeBox结构或业务校验；classifier JSON保留outcome/risk/read_only/authorized的instruction/type/criteria与evidenceTrust。
- loader用 `readFileSync(new URL("./<filename>",import.meta.url),"utf8")` 在模块初始化仅加载一次，JSON严格校验，命名fragment重复/缺失、未知变量、缺失变量抛带路径/fragment的配置错误；绝不静默fallback到空prompt/旧内联字符串。文件路径来自固定清单，不受模型/用户输入控制。`{{variable}}` 单次replace，插入内容不递归解释模板，因此用户正文中的 `{{...}}`/Markdown/XML 保持原文；不用eval、模板执行语言、Vite ?raw、新包或每轮磁盘读取。当前后端tsx源码运行/noEmit，资源放源码相邻即可，Vite仍只构建web；变更需重启后端生效，不增加热更新后台。
- 在 index.ts 导出精确接口，业务模块不再自拼自然语言：`renderEmployeeIdentity(input:{name:string;address:string;role:string;instructions:string}):string`；`renderEmployeeContext(input:{workspaceName:string;workspaceSlug:string;maxDepth:number;maxCrossEmployeeWakes:number;roomLabel:"频道"|"私信"|"邮件会话"|null;roomName:string;directoryVersion:number;paths:readonly string[];defaultPath:string;workKind:"room"|"delegation"}):string`；`renderSkillSection(skills:readonly SkillRecord[],selectedIds:readonly string[]):string`（保留原两参和空串语义）；`renderWorkInput(history:readonly MessageDTO[],intent:string,kind:WorkKind,mailSource?:{entryId:string;message:RoomMessageData}):string`（原 buildPrompt 四参原样，含原 throw 条件）；`renderDelegationContinuation(employeeName:string,text:string):string`；`renderMailContinuation(input:{subject:string;from:{name:string;address:string};to:readonly MailAddress[];cc:readonly MailAddress[];inReplyTo:string;entryId:string;outcome:"reply"|"failed"|"stopped";body:string;error:string}):string`；`renderToolResult(fragment:ToolResultFragment,input:Record<string,string|number>):string`（fragment 为 tools.ts/work.ts 各结果/操作指导的字面量联合）；`renderApprovalContext(label:ApprovalContextLabel,input:Record<string,string|number>):string`（label 同理覆盖 state.ts 的压缩/重置/工具调用/结果/来源）；`renderApprovalSystem():string`、`renderApprovalUser(caseJson:string):string`；`renderAddressSystem():string`、`renderAddressUser(input:{workspaceSlug:string;name:string;role:string}):string`；资源常量 `toolTextResources:Record<BuiltinToolName,{description:string;parameters:Record<string,string>}>`（BuiltinToolName="read_file"|"write_file"|"edit_file"|"run_shell"|"load_skill"|"send_message"|"send_mail"|"delegate_task"）、`classifierQuestions():ClassifierQuestions`（原签名/结构保留）、`classifierEvidenceTrust:string`、`probeResources:{classifier:{state:string;instructions:string;criteria:{true:string;false:string}};chat:string}`。业务条件分支保留在调用代码，只选择 fragment/组合 renderer；自然语言句子全部在资源文件。没有既有模板实现，新增 loader 只承担这个小 seam。
- **完整切换调用清单**：`agents.ts`身份/context/skills sections；`work.ts`buildPrompt调用、deliverToParent、send_message/send_mail/delegate_task描述/参数/结果；`skills.ts`删除renderSkillSection实现并让agents直接从prompts导入；`tools.ts`五工具schema及read过大/edit歧义/skill目录说明等操作指导；`workspace.ts:suggestLocalPart`；`models.ts:check`的chat+classifier探针；`approval/evaluators.ts`llmSystemPrompt/llmUserPrompt/classifierQuestions和classifierState.evidence_trust；`approval/state.ts:approvalContext`的压缩/重置/工具证据/来源信任标签。精确搜索 `buildPrompt|renderSkillSection|llmSystemPrompt|llmUserPrompt|classifierQuestions|description:|instructions:|criteria:|completeText\\(|completeSimple\\(|section\\(`（src/server）重新核对全部自有入口，删除旧实现/旧文本/转发导出，不留第二套约定。
- 保持员工/技能动态原文、历史40条/正文2000字符、脱敏、审批预算/输出字段/模型选择等现有行为；本次审批语义不变，criteriaVersion保持3。只更新邮件规则：完整最终答复自动投递，send_mail用于主动分支；需要回信的求助设awaitReply=true，等待时不编造结果/自行重复回复；回信/失败续接明确来源且非用户授权。资源文本原样迁移其他用途，不顺手改写为另一套策略。界面普通文案/日志/纯错误事实不是模型行为指令，留原模块；错误中的行动指导从tool-results取。

## Files to modify
- `src/server/work.ts`：startWork拆分、onYield/beforeRequest、终态与等待关联；重读相关函数后实施，不改非邮件的交办答复语义。
- `src/server/runtime.ts:listFamily`：WorkDoc版本迁移不能被原始扫描绕过；仅在stored.version落后时调用token迁移，缺少迁移显式报错，不丢掉旧工作记录。
- `src/server/rooms.ts:createRoom`：目前名字虽声称原子，实际createConversation与RoomDoc是两次commit；为工具邮件新session抽出createRoomIn，并保留RoomDoc更新/信封归属。
- `src/server/progress.ts`：实时数据是优化，不是详情真相；新详情刷新需兼容现有120ms事件合并与原toolResult.isError。
- `src/web/views/MailView.tsx`：draft/compose/reply父节点与目录配置不得混到另一个reader；完整资源与调用清单见Approach，不重复列机械编辑。

## Reuse
- `rooms.ts:appendRoomMessageIn`、`mailEnvelope`、`isSentMailEntry`：信封/graph保留，原子发信组合不调用自带commit的appendRoomMessage。
- Pi Durable `defineTask`、`TaskRuntime.commit`、`Tx.createTask`、`registry.install`、`Harness.resume`：已有原生调度、phase恢复/abort；没有相同的Emit邮件task，新增两个用途明确的task。
- `work.ts:startWork/buildDeliveryHook/deliverToParent`：现有独立conversation、模型选择、目录绑定、usage及requestId去重，邮件续接原conversation而非新runner。
- `Conversation.entries`、`harness.getTask`、`storage.submissionByRequest`：持久步骤、真实任务失败与续接admission；SSE progress仅用于及时刷新。
- `MailView:Compose/editDraft/threadForCompose`、`WorkView`、`ui.tsx:WorkStatus`：保留草稿/目录/停止逻辑，共用真实执行详情与状态展示。
- `approval/evaluators.ts:redactArguments/redactApprovalText`：详情与评审共用敏感数据擦除；审批判定与budget算法留原模块。

## Steps
- [x] 先抽取只改变位置的提示词资源，迁移全部已列入口，保留v3审查协议；既有执行/审批/mail行为smoke仍应通过。邮件新说明随步骤3–4切换，不先承诺未实现功能。
- [ ] 实现WorkDoc v2迁移、createRoomIn与queued work/原子发信接口，注册mail-dispatch原生task，切三个发送入口，更新停止/恢复与draft退役。证明先持久接收后运行、重启不漏投/不重复。
- [ ] 实现awaitReply等待关联、mail-resume任务与beforeRequest消费守卫；fake provider增加真实求助与续接场景，证明晚回/快回/多分支/失败/停止/恢复均不提前结束或乒乓。
- [ ] 接持久执行详情接口/弹层与全部状态；移除邮件聊天式流式阅读、改Compose回复、接新邮件刷新/通知，证明邮箱默认完整邮件，执行入口可追踪工具/审批/错误。
- [ ] 按Verification运行统一行为回归与真实浏览器验收。提示词搬迁可独立，邮件步骤必须按上述依赖顺序，不能仅做UI掩盖发送/恢复窗口。

## Verification
计划阶段只读，未运行应用/测试；以下全是实施验收，不引用此前smoke当本次证明。仓库根执行，Node≥22.19.0，使用已有node_modules；真实SQLite/harness＋本地fake provider，不使用~/.emit或真实凭据，不调用SMTP。

### 消费者可见的永久回归
- 新建 `test/mail.test.ts`，沿用 `test/opencode-session.test.ts` 的本地provider/真实harness模式，临时目录隔离SQLite。调度未resume时发一封To=A/B、CC=C：邮件/两queued work/两dispatch task已持久，模型无请求；关runtime重开、先注册extensions后resume，最终A/B各一封完整reply、source/inReplyTo精确，C无work。不使用计时阈值判断异步。
- 草稿两次并发发送只有一次sent entry/一组To工作、另一请求409；工具safe replay相同toolTaskId得到同entry/work/session，协作预算只计一次。停止queued收件人后无模型请求/回信，其余To正常。一个停用/无模型To失败不影响可用To，详情准确错误。
- awaitReply=true：A给B求助，B用门闩延后，A原work为waiting-mail且无给用户的提前答案；放行B后原A conversation收到完整B结果，A最终只投递一次、无新的“回复B”work。awaitReply=false仅落B回复不唤醒A。快回信在A仍busy时入followUp，A旧回答不能完成；两求助先后到达，最后答复包含两份不同结果；失败/停止子工作被A收到为失败事实，不永久waiting、不伪造成功。父stopped/目录改版后回信不复活旧任务。
- 步骤详情：真实调用 `read_file` 与一个受控失败tool，HTTP详情显示精确toolCall参数/对应callId结果、isError/持久task错误；应用重启/页面刷新后仍存在。超过100个entry用cursor读取无重复/无丢步骤；敏感参数/输出擦除、无thinking/base64泄露。
- 保留现有原生classifier、审批风险边界与OpenCode session测试；删除 `test/opencode-session.test.ts:398` 措辞断言，不重新pin。永久测试不验证模板复制、文件文案或UI wiring；模板正文含 `{{name}}`、Markdown/XML的用户数据在模型输入中保持原文的边界，可通过本地provider实际请求验证。

### 真实运行/崩溃证据
- 扩展已有 `tmp/smoke.mjs`/`tmp/fake-provider.mjs`：保留草稿/多To/CC/用户只投递、同session双分支、delegation邮件、目录失效、新session空目录、审批/恢复场景，改异步预期为返回queued IDs并等最终状态，不把“HTTP返回时running”钉死。新增求助门闩与两份独立结果，验证用户最终邮件内容真的使用回信，而非仅观察submit调用。
- 使用测试子进程＋ `harness.subscribeCommits` 精确门闩，在①mail+queued work/task commit后、②createConversation/init commit后submit前、③child回复+resume task commit后、④resume admission后task终结前分别SIGKILL本测试进程；重启同临时数据目录。每次原work/conversation/reply数量精确不变、待处理收件人继续、原任务使用结果完成；不在生产代码加入故障env开关或人工延时。只有当前测试进程可被kill。
- 从仓库根统一执行 `npm run build`、`npm test`、`node tmp/smoke.mjs`，记录实际输出/测试数。现有smoke固定8898/8899并会清自己的tmp fixture，先确认这些隔离目录不是用户数据；端口占用则该脚本改随机空闲端口并同步provider/client，不能杀不明服务。
- 模板加载实际smoke：从另一cwd以项目入口绝对路径启动，所有资源仍能加载；在自建临时副本中漏掉一个必需模板，启动明确报对应资源路径且不请求模型。正常启动捕获员工请求/审批/探针/地址建议，确认动态员工instructions、skills/MCP信息与工作目录仍到达正确上下文；v3 verdict和工具schema行为不变，不声称fake验证真实模型所有决策。

### 浏览器默认体验与执行入口
- 启动隔离实例：`FAKE_PORT=8902 node tmp/fake-provider.mjs`；`FAKE_API_KEY=smoke node --import tsx src/server/main.ts --data-dir tmp/mail-async-ui-data --port 8901`，UI临时custom provider=`http://127.0.0.1:8902/v1`，执行与审批均明确选择fake模型。如果端口占用选同组可用端口，使用全新自己创建的数据目录。
- 1280×900与390×844、浅/深主题：发信后关闭Compose并回已发送，阅读区没有流式过程/常驻聊天框；切别页后收完整回信，未读增加但不抢焦点；回复较早一封与并行另一分支的inReplyTo各自准确，存草稿/编辑/发送保留关联与session目录，已有脏Compose需确认而不是丢失。
- 新邮件/已发送/阅读页点“查看执行”：多To各自queued→running→waiting-approval/waiting-mail→最终态可追踪；真实工具参数/结果、审批与错误可见；停止queued/等待任务有效，刷新仍保留步骤；长输出/敏感值正确截断和脱敏，慢请求不串到另一工作。截图并观察console，无横向溢出；失败入口不能显示为已成功。

## Assumptions & contingencies
- 已确认默认持久后台投递＋邮件式交互，并保留执行排查入口；不人为推迟处理，不做定时批量收信。
- 已确认回信按需续接原任务；awaitReply由员工依任务选择，后台等待与终态守卫强制保证不是仅提示词约定。没有任务请求的正常回信只落邮箱。
- 站内邮箱，不增加SMTP/IMAP、外部通知权限或用户自动重试；程序纯诊断不是提示词，内置模型行为文字和工具操作指导必须全部进入资源。
- 发现旧WorkDoc缺新增字段时按已指定v1→v2迁移，不清数据库；已有终态邮件不历史补唤醒。缺资源/损坏关联/不可用模型明确失败，无旧提示词fallback；已有审批策略不因集中化改判。
- 当前工具层阻止了语言服务器status查询，未确认可用LSP。实施时先查询LSP；可用则对导出改动跑references，否则执行Approach列出的精确源码调用检索并迁移全部命中。

