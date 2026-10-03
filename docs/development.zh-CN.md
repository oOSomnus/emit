# 开发指南

[English](development.md) | [简体中文](development.zh-CN.md) · [项目主页](../README.zh-CN.md)

脚本、依赖补丁、提示词资源与技术栈。安装与 CLI 选项见 [运行维护](operations.zh-CN.md)；用户可见行为见 [使用指南](usage.zh-CN.md)。

## 命令

```bash
npm run dev          # 构建前端，然后用 tsx watch 启动 src/server/main.ts
npm run typecheck    # 服务端与前端两个 tsconfig 的类型检查
npm run build        # typecheck + vite build
npm test             # vitest run
node tmp/smoke.mjs   # 端到端冒烟测试
```

`node tmp/smoke.mjs` 用假 provider 驱动真实 harness，覆盖审批、人工裁决、拒绝、停止、邮件与 SIGKILL 恢复。它会清空并重建 `tmp/smoke-data`、`tmp/smoke-work`、`tmp/smoke-outside`，并占用 8898（服务端）与 8899（假 provider）两个端口。它不是普通的快速开始命令：仅在这些目录与端口空闲时运行。`tmp/fake-provider.mjs` 是它使用的 OpenAI-compatible 假模型。

## Web 界面

[`DESIGN.md`](../DESIGN.md) 记录已落地的双语议程式团队工作台；`.impeccable/design.json` 提供设计面板预览。`src/web/styles.css` 是语义颜色、字体、间距和响应式规则的唯一来源。浅深主题与中英语言继续使用现有偏好 provider，不增加第二套主题机制或远程字体。

消息与邮件共享员工身份元信息和阅读排版，但保留各自的同步与异步工作流。邮件线程打开按钮与同级的已读、归档、草稿操作是独立的键盘和触控目标，操作按钮不得同时打开线程。文件夹与线程布局根据邮件面板可用宽度变化；粗指针控件的目标不小于 44px，窄屏保留现有导航抽屉。

界面冒烟检查使用独立临时数据目录和空闲端口运行应用与假 provider，不将真实工作区或破坏性 smoke 脚本的目录用于截图。检查两种沟通表面、辅助页面、主题、语言及触控和键盘操作；验证执行记录分页时使用真实 harness 记录。

## 依赖补丁

`npm install` 会运行 `postinstall`，用 [`patch-package`](https://github.com/ds300/patch-package) 把 `patches/@earendil-works+pi-durable+1.0.0.patch` 应用到 `node_modules`。补丁只给 pi-durable 的生成与压缩请求补上 OpenCode Go 必需的每会话标识；补丁应用失败时安装会以非零状态退出，不会带着未打补丁的依赖继续。

## 提示词资源

所有应用自有的模型提示词都是 `src/server/prompts/` 下可审阅的文本资源：`employee.md`（员工身份与准则骨架）、`work-input.md`（任务输入）、`context.md`（历史与压缩）、`approval-system.md` / `approval-user.md`（审查者）、`tool-results.md`、`skills.md`、`continuations.md`、`address-*.md` 等，另有 `tools.json` 与 `classifier.json` 保存工具说明与判断规则。loader 只加载一次，typed renderer 负责填充参数；代码只组装参数，不内嵌大段提示词文本。片段缺失或重复会直接产生明确的配置错误，不会回退到旧的 inline 文本。员工指令、技能正文与远程 MCP 描述仍是动态来源，编辑方式不变。

## 技术栈

- 后端：Node >= 22.19、TypeScript、Fastify、`@earendil-works/pi-durable` / `pi-ai` / `pi-mcp` / `chord`。
- 前端：React 19 + Vite；一个 SSE 通道推送全部实时更新。
- 存储：SQLite（由 pi-durable 的 storage 打开）。
