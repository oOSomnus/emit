# 开发指南

[English](development.md) | [简体中文](development.zh-CN.md) · [项目主页](../README.zh-CN.md)

脚本、依赖补丁、提示词资源与技术栈。安装与 CLI 选项见 [运行维护](operations.zh-CN.md)；用户可见行为见 [使用指南](usage.zh-CN.md)。

## 命令

```bash
make install         # 按 lockfile 安装依赖
make dev             # 构建前端，然后用 tsx watch 启动 src/server/main.ts
make typecheck       # 服务端与前端两个 tsconfig 的类型检查
make build           # typecheck + vite build
make test            # vitest run
make                 # 原生单文件构建（dist/emit，Node SEA）
make smoke           # 重新构建并运行原生二进制冒烟测试
make e2e             # 端到端冒烟测试（运行 node tmp/smoke.mjs）
make mock            # 从真实配置复制出的临时工作区，用真实模型运行
```

`make help` 列出全部目标；运行时参数通过 `ARGS` 传递，例如 `make test ARGS='test/mock.test.ts'` 或 `make start ARGS='--port 8787'`。npm scripts 仍是这些目标的内部实现。

`make e2e`（运行 `node tmp/smoke.mjs`）用假 provider 驱动真实 harness，覆盖审批、人工裁决、拒绝、停止、邮件与 SIGKILL 恢复；其 fixture 会先创建工作上下文再创建房间，并覆盖频道成员与点名路由。它会清空并重建 `tmp/smoke-data`、`tmp/smoke-work`、`tmp/smoke-outside`，并占用 8898（服务端）与 8899（假 provider）两个端口。它不是普通的快速开始命令：仅在这些目录与端口空闲时运行。`tmp/fake-provider.mjs` 是它使用的 OpenAI-compatible 假模型。

`make mock` 是另一种取舍：它通过只读 SQLite backup 读取真实数据目录（默认 `~/.emit`、`EMIT_DATA_DIR` 或 `--source-data-dir`）的已提交状态（含 WAL），复制 provider 凭据（绝不复制保存的 OAuth 登录，以免使真实登录失效），在全新的私有临时目录里创建 `Alice`/`Bob`/`Carol`、两个频道与一个工作上下文，并在其上启动真实服务端，因此破坏性改动不再需要手工重建测试场景。初始化不调用模型；在启动的工作区里发消息会调用已配置的真实模型并可能产生费用。服务退出时会删除临时根目录，源工作区也绝不会被当作 runtime 打开。

## Web 界面

[`DESIGN.md`](../DESIGN.md) 记录已落地的双语议程式团队工作台；`.impeccable/design.json` 提供设计面板预览。`src/web/styles.css` 是语义颜色、字体、间距和响应式规则的唯一来源。浅深主题与中英语言继续使用现有偏好 provider，不增加第二套主题机制或远程字体。

消息与邮件共享员工身份元信息和阅读排版，但保留各自的同步与异步工作流。邮件线程打开按钮与同级的已读、归档、草稿操作是独立的键盘和触控目标，操作按钮不得同时打开线程。文件夹与线程布局根据邮件面板可用宽度变化；粗指针控件的目标不小于 44px，窄屏保留现有导航抽屉。

界面冒烟检查使用独立临时数据目录和空闲端口运行应用与假 provider，不将真实工作区或破坏性 smoke 脚本的目录用于截图。检查两种沟通表面、辅助页面、主题、语言及触控和键盘操作；验证执行记录分页时使用真实 harness 记录。

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
