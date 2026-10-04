# 开发指南

[English](development.md) | [简体中文](development.zh-CN.md) · [项目主页](../README.zh-CN.md)

脚本、依赖补丁、提示词资源与技术栈。安装与 CLI 选项见 [运行维护](operations.zh-CN.md)；用户可见行为见 [使用指南](usage.zh-CN.md)。

## 命令

```bash
make install         # 按 lockfile 安装依赖
make dev             # 构建前端，然后用 tsx watch 启动 src/server/main.ts
make typecheck       # 分别检查服务端、前端、浏览器测试三个 TypeScript 环境
make build           # typecheck + vite build
make test            # 日常 Vitest：core、integration、api、e2e 四个 project
make                 # 原生单文件构建（dist/emit，Node SEA）
make smoke           # 重新构建并运行原生二进制冒烟测试
make e2e             # 隔离真实进程测试（npm run test:e2e）
make mock            # 从真实配置复制出的临时工作区，用真实模型运行
```

`make help` 列出全部目标；运行时参数通过 `ARGS` 传递，例如 `make test ARGS='test/mock.test.ts'` 或 `make start ARGS='--port 8787'`。npm scripts 仍是这些目标的内部实现。

`make e2e` 构建前端后运行 `e2e` project，使用真实 Emit 进程与 `test/fixtures/` 下的本地协议假服务。每个场景独占临时 data、HOME、work/outside 根目录、随机回环端口及子进程组；不清空仓库 scratch 目录、不读取真实 provider 凭据。测试专用 fetch 预载拒绝未登记的 origin；OpenCode Go 只重写到显式登记的本地 provider。

`make mock` 是另一种取舍：它通过只读 SQLite backup 读取真实数据目录（默认 `~/.emit`、`EMIT_DATA_DIR` 或 `--source-data-dir`）的已提交状态（含 WAL），复制 provider 凭据（绝不复制保存的 OAuth 登录，以免使真实登录失效），在全新的私有临时目录里创建 `Alice`/`Bob`/`Carol`、两个频道与一个工作上下文，并在其上启动真实服务端，因此破坏性改动不再需要手工重建测试场景。初始化不调用模型；在启动的工作区里发消息会调用已配置的真实模型并可能产生费用。服务退出时会删除临时根目录，源工作区也绝不会被当作 runtime 打开。

日常层可分别运行 `npm run test:unit`、`test:integration`、`test:api`、`test:e2e`；`test:coverage` 统计服务端/共享逻辑及纯前端 helper。`npm run test:gate` 顺序执行 build、日常覆盖率、两个 Chromium project、原生构建及原生 smoke，保留每个可运行层的退出码。`npm run test:fault` 与 `npm run test:stress` 必须手动启动，不混入 `npm test` 或 watch。压力默认 8 并发、500 次操作或 60 秒、最多 3 次重启；更重的负载需要显式设置 `EMIT_TEST_*`。

### 分层测试矩阵

| 层 | 入口 | 行为边界 |
| --- | --- | --- |
| L1：规格与性质 | `npm run test:unit` | 地址解析、审批策略、目录规范化、执行记录、国际化、种子固定的随机输入及边界值 |
| L2：真实运行时 | `npm run test:integration` | SQLite 持久化、审批状态机、并发竞争、历史分页、任务上限、目录替换后的权限失效 |
| L3：HTTP/SSE | `npm run test:api` | 非法输入不能落库、事件与最终状态一致、邮件投递、执行记录脱敏、原生认证与刷新 |
| L4：进程与原生 | `npm run test:e2e` / `test:native` | SIGKILL 恢复、独占锁、唯一回复、协作图、目录隔离、实际 shell/MCP、OpenCode Go 会话、无 checkout 原生启动 |
| L5：浏览器 | `npm run test:browser` | 真实 UI 上手、聊天、审批、邮件、设置、移动导航、主题/语言、断线恢复 |
| L6：故障注入 | `npm run test:fault` | 上游错误、损坏或截断流、MCP 异常、SSE 生命周期、进程中断后的安全收敛 |
| L7：压力与状态模型 | `npm run test:stress` | 并发负载、历史与事件扇出、随机操作序列、重复重启；输出实际延迟、错误和内存测量 |

日常门禁不遇错即停：节点层失败仍继续浏览器和原生层；构建前提失败则明确记录 blocked，最终非零退出。节点层摘要在 `test-results/<project>/summary.json`，统一门禁摘要在 `test-results/gate/results.json`；覆盖率在 `coverage/`，浏览器 JUnit、失败截图/trace/video 与 HTML 在 `test-results/browser/` 和 `playwright-report/`。红色断言表示仍存在的行为缺陷，不允许用 skip、自动重试或反向钉住当前错误来变绿。

断言失败也会生成覆盖率报告。各 project 摘要分别记录本层的 `status` 和整次调用的 `runReason`；某一层变红不能把其他已通过层误报为失败。

原生场景结果另存为 `test-results/native/summary.json`，包括独立执行的启动故障，以及前提失败时尚未执行的场景数。

压力测量另存于 `test-results/stress/{public-runtime-load,execution-pagination,public-command-model,owned-process-recovery}.json`：保留旋钮/seed、实际请求与观察错误、延迟分位数和拥有的服务端进程 RSS 采样。这些是实测结果，不是性能承诺，也不是连续采样的内存峰值。

### 显式重负载与重放

只接受下列测试旋钮，未知 `EMIT_TEST_*` 或越界/非整数值直接失败：

| 变量 | 默认 | 允许范围/用途 |
| --- | --- | --- |
| `EMIT_TEST_SEED` | `20261004` | 有符号 32 位整数；固定随机序列 |
| `EMIT_TEST_PROPERTY_RUNS` | `200` | `1..100000`；随机性质次数 |
| `EMIT_TEST_CONCURRENCY` | `8` | `1..128`；并发客户端/工作 |
| `EMIT_TEST_OPERATIONS` | `500` | `1..100000`；操作数 |
| `EMIT_TEST_DURATION_MS` | `60000` | `1000..3600000`；负载时间上界 |
| `EMIT_TEST_RESTARTS` | `3` | `0..100`；拥有进程的重启次数 |
| `EMIT_TEST_PATH` | 未设置 | fast-check 失败报告中的收缩路径 |

```bash
# 随机性质的重负载；不是日常门禁默认值。
EMIT_TEST_PROPERTY_RUNS=10000 npm run test:unit
# 32 客户端，再按需要显式提升到 128；不可对真实工作区运行。
EMIT_TEST_CONCURRENCY=32 EMIT_TEST_OPERATIONS=1000 npm run test:stress
EMIT_TEST_CONCURRENCY=128 EMIT_TEST_OPERATIONS=10000 EMIT_TEST_RESTARTS=20 npm run test:stress
# 用失败报告的 seed/path 重放；同时指定原始文件或 test name。
EMIT_TEST_SEED=20261004 EMIT_TEST_PATH='0:1:2' npm run test:unit -- test/core/properties.test.ts
```

`EMIT_TEST_OAUTH_URL` 仅用于已登记的回环 HTTP 认证服务编排；不是可指向公网的压力目标。测试账户、凭据、文件内容均为本地虚构数据。故障和负载测试只能终止自身创建的进程组；不删除锁文件、不扫描并终止其他进程、不清理用户 scratch 数据。

## Web 界面

[`DESIGN.md`](../DESIGN.md) 记录已落地的双语议程式团队工作台；`.impeccable/design.json` 提供设计面板预览。`src/web/styles.css` 是语义颜色、字体、间距和响应式规则的唯一来源。浅深主题与中英语言继续使用现有偏好 provider，不增加第二套主题机制或远程字体。

消息与邮件共享员工身份元信息和阅读排版，但保留各自的同步与异步工作流。邮件线程打开按钮与同级的已读、归档、草稿操作是独立的键盘和触控目标，操作按钮不得同时打开线程。文件夹与线程布局根据邮件面板可用宽度变化；粗指针控件的目标不小于 44px，窄屏保留现有导航抽屉。

界面检查先构建前端，再运行 `npm run test:browser`（Chromium 桌面/移动）；`npm run test:browser:all` 显式加入 Firefox/WebKit。引擎安装：`npx playwright install chromium firefox webkit`；缺系统库时运行 `npx playwright install-deps chromium firefox webkit`。场景使用私有工作区与真实 HTTP/SSE，不使用 DOM 或 REST mock。缺少浏览器前提按失败报告，不跳过后宣称成功。

## 依赖补丁

`npm install` 会运行 `postinstall`，执行 `scripts/apply-pi-durable-patch.mjs` 作用于已安装的 `@earendil-works/pi-durable`。补丁只给 pi-durable 的生成与压缩请求补上 OpenCode Go 必需的每会话标识。脚本会校验包名/版本，每个文件只接受"未打补丁锚点恰好一次"或"已打补丁"，其他状态（包括依赖版本变化）都会带着目标路径以非零状态退出，因此重装不会带着未打补丁或只打了一半的依赖继续。`node scripts/apply-pi-durable-patch.mjs` 可手动应用或校验，且是幂等的。构建脚本（`scripts/build-binary.mjs`）在打包前调用同一个函数，保证二进制不会内嵌未打补丁的依赖。

## 原生单文件

`make` 为当前 OS/架构生成 `dist/emit`（Windows 为 `dist/emit.exe`）——不做交叉编译，也没有发布矩阵。`scripts/build-binary.mjs` 用 esbuild 打包 `src/server/main.ts`（`platform: node`、`format: cjs`，除 Node 内建模块外全部内嵌），把 `import.meta.url`/`import.meta.dirname` 重写为可执行文件路径，只把 `@earendil-works/pi-coding-agent` 映射到技能加载器，并把该包自身的元数据固化进它的 config，使二进制不会去读自己旁边的 `package.json`。随后把 `src/server/prompts/**` 与 `dist/web` 的文件清单作为 SEA 资源嵌入，用与被复制进产物的同一个 `node` 生成 blob，再用 postject 注入。`src/server/pi-modules.ts` 在启动时注册 pi-ai 的静态 OAuth flow 与 Bedrock 模块，因为它们的变量说明符导入无法被打包。构建需要 Node >= 22.19（SEA 与内建 SQLite）和 GNU make；缺少前提会直接失败，而不是产出残缺产物。

`test/native-binary.smoke.mjs`（由 `make smoke` 运行）在隔离环境中验证真实可执行文件：`--help`、默认与显式端口分配（含端口被占用）、内嵌前端与 SPA 回退、重启后的持久化与缓存修复、经打包 Pi loader 的技能导入、SSE 关闭，以及 `--web-root` 覆盖。它绝不触碰真实数据目录。

## 提示词资源

所有应用自有的模型提示词都是 `src/server/prompts/` 下可审阅的文本资源：`employee.md`（员工身份与准则骨架）、`work-input.md`（任务输入）、`context.md`（历史与压缩）、`approval-system.md` / `approval-user.md`（审查者）、`tool-results.md`、`skills.md`、`continuations.md`、`address-*.md` 等，另有 `tools.json` 与 `classifier.json` 保存工具说明与判断规则。loader 只加载一次，typed renderer 负责填充参数；代码只组装参数，不内嵌大段提示词文本。片段缺失或重复会直接产生明确的配置错误，不会回退到旧的 inline 文本。员工指令、技能正文与远程 MCP 描述仍是动态来源，编辑方式不变。

## 技术栈

- 后端：Node >= 22.19、TypeScript、Fastify、`@earendil-works/pi-durable` / `pi-ai` / `pi-mcp` / `chord`。
- 前端：React 19 + Vite；一个 SSE 通道推送全部实时更新。
- 存储：SQLite（由 pi-durable 的 storage 打开）。
