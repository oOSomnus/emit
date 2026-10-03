## read-too-large
文件过大（{{size}} 字节，上限 {{max}}）。请先用 run_shell 或分段读取。

## read-lines-suffix
… 共 {{total}} 行

## write-ok
已写入 {{path}}（{{length}} 字符）

## edit-ambiguous
oldText 出现了 {{count}} 次；请提供更精确的片段或设置 replaceAll

## edit-ok
已更新 {{path}}（替换 {{count}} 处）

## shell-failed
命令失败: {{message}}{{spillBlock}}

## shell-failed-spill
完整输出: {{spillPath}}

## shell-exit
退出码 {{exitCode}}{{spillBlock}}

## shell-exit-spill
完整输出已写入 {{spillPath}}

## skill-directory
技能目录：{{directory}}
配套文件请用相对该目录的路径访问。

## skill-truncated
… 已截断

## skill-missing
没有名为 {{name}} 的技能。已绑定：{{bound}}

## send-message-ok
已发送给 {{name}}，工作 {{workId}} 已开始；对方的回复会出现在你们的私信里。

## send-mail-ok
已发送邮件给 {{name}}，工作 {{workId}} 已开始。

## delegate-ok
已把任务交办给 {{name}}（工作 {{workId}}）。结果会以消息形式出现在本会话中，你可以继续别的工作或等待。
