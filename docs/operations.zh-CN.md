# 运行维护

[English](operations.md) | [简体中文](operations.zh-CN.md) · [项目主页](../README.zh-CN.md)

单进程 Emit 的 CLI 选项、环境变量、数据文件、凭据、锁与崩溃恢复。使用行为见 [使用指南](usage.zh-CN.md)；审批规则见 [安全与审批](security.zh-CN.md)。

## 命令行

`npm run dev` 会构建前端并用 `tsx watch` 启动后端。`npm start` 运行 TypeScript 服务端，要求已有构建好的 `dist/web`。

| 选项 | 含义 | 默认值 | 环境变量 |
| --- | --- | --- | --- |
| `--data-dir <目录>` | 存放数据库、凭据与锁的目录 | `~/.emit` | `EMIT_DATA_DIR` |
| `--host <地址>` | 监听地址 | `127.0.0.1` | `EMIT_HOST` |
| `--port <端口>` | 监听端口 | `8787` | `EMIT_PORT` |
| `--web-root <目录>` | 前端构建产物目录 | 从源码树解析 `dist/web` | — |
| `--help`、`-h` | 打印用法并退出 | — | — |

data-dir、host、port 三项命令行参数优先于对应环境变量。示例（data-dir 路径请替换成自己的目录）：

```bash
npm start -- --data-dir /absolute/path/to/data --port 8787
```

`.env.example` 只是变量名称与示例——Emit 不会自动加载 `.env`。请在 shell 中 export，或在界面里配置 provider。

## 数据文件

- `<数据目录>/emit.sqlite` —— 所有会话、文档、任务与审批。
- `<数据目录>/credentials.json`（写入时权限 0600）—— 原生 provider 凭据、自定义 provider 端点、动态模型目录缓存与稳定的安装 id。原生凭据存储是 provider 认证的唯一事实来源；OAuth 刷新结果会持久化在这里，数值不会回传给网页。
- `<数据目录>/emit.lock` —— `proper-lockfile` 用来保证一个数据目录同时只有一个进程的锁。

### 凭据优先级

- 原生保存的 provider 凭据（文件里的 `auth` 部分）优先于环境变量。未保存凭据的 provider 才回退到 ambient 环境变量，例如 `OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`OPENROUTER_API_KEY`、`TYPESAFE_API_KEY`。
- 文件里的 `env` map 会在启动时注入进程环境，但同名变量若已存在于环境中则环境变量优先：shell export 总是覆盖文件。
- 凭据文件缺失是正常的，Emit 会初始化它；非法 JSON 或非对象文件会拒绝启动。
- 0600 只是写入文件时使用的权限，并不代表数据目录天然私密；如果机器上还有其他用户，请用操作系统权限保护该目录。

## 锁与恢复

- 一个数据目录同一时间只允许一个进程。第二个进程会重试约 20 秒，然后带着锁路径拒绝启动。仍有进程可能持有锁时，不要删除锁。
- 被强制结束（SIGKILL、断电）后，遗留的锁不再被刷新；超过 15 秒未刷新即被视为过期，新进程会自动接管。
- SQLite 使用 WAL + `synchronous=NORMAL`：进程崩溃可恢复，但不保证断电时不丢失最后一次提交。
- 每个工作开展一条独立的执行 conversation；房间的公开记录放在房间自己的 conversation 里，两者不互相污染。
- 答案与「工作已完成」在同一个提交里写入：崩溃只会导致两边都没写，恢复后会重新投递，不会产生半截状态。
- 启动时先恢复运行中的任务，再把没有活任务、也没有未决提交的工作标记为失败，并在原会话里说明原因。
- 已经写入 intent、但执行阶段被中断的工具不会被自动重放。`read_file`、`load_skill` 与 `send_mail` 声明了 `replay=safe`（邮件通过持久 receipt 去重）；未声明 safe 的工具（写文件、编辑文件、Shell 等）与 `replay=unsafe` 的 MCP 工具在中断后不会自动重跑。模型会看到调用被中断，并自行决定下一步。外部副作用不承诺 exactly-once。

## 从员工目录升级

会话工作目录取代了员工自有的 `cwd`，审批契约也升级到 v3，并需要单独配置判断模型。目录的变更是干净切换：不迁移旧员工目录、不自动授予旧路径、不清空数据库。缺少新目录配置的旧会话需要重新创建。
