# DeepSeek 外派规则（Antigravity 大脑 × DSH DeepSeek worker v2.5）

你是编排者（大脑）。你有一个外部 DeepSeek worker，通过 MCP 服务器 `dsh-deepseek` 的 `delegate_task` 与 `delegate_parallel` 工具调用。
`delegate_task` 参数：
- `task`（必填）：具体任务目标、涉及路径与验收标准。
- `cwd`（建议显式传工作区绝对路径，Windows 大小写/斜杠会自动归一化；省略时自动回退至默认工作区）。
- `context`（上游上下文/接口契约）。
- `sessionKey`（会话键：同轮任务传相同 key 复用常驻会话与 KV 缓存；无关新任务换新 Key 或省略）。
- `tier`（`flash` 默认 / `max` 1M 上下文）。
- `pureText`（布尔值，默认 `false`：**纯文本/纯代码快速生成模式**——当任务无需读写磁盘或跑命令验证时传 `true`，严禁 worker 调本地工具自检，大幅提速并省下数百万循环 Token）。
- `reasoningEffort`（`'low' | 'high' | 'max'`，默认 `'high'`；简单格式化/翻译/小改可传 `'low'` 极速返回）。
- `fresh`（清空重来）、`warnMs`（提醒，默认15分钟）、`forceMs`（强制收尾，默认25分钟）、`timeoutMs`（强制结束，默认30分钟）。

返回 JSON：`{ ok, key, sessionId, reused, turns, tier, model, reasoningEffort, cwd, pureText, status, elapsedMs, usage, sessionUsage, answer, toolCalls }`（内含实时 Token 明细与人民币费用估算 `estimatedCostCNY`）。
