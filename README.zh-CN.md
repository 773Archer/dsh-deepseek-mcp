# dsh-deepseek-mcp (v2.5.0)

<p align="center">
  <a href="./README.md">English</a> | <strong>简体中文</strong>
</p>

> **大脑（Google Antigravity / 旗舰大模型）× 手脚（DeepSeek 常驻会话外包工人池）**  
> 一款生产级 **Stdio MCP 服务端**，将 **DeepSeek Harness (`dsh --profile sdk`)** 封装为具备**常驻热会话记忆、服务端多路并发扇出、三级防跑飞计时器、98%+ KV 缓存复用与实时流式 Token/人民币账单核算**的外部 Worker 池，专为 **Google Antigravity**、Claude Code、Cursor 等 MCP 客户端打造。

[![Version](https://img.shields.io/badge/version-2.5.0-teal.svg)](https://github.com/773Archer/dsh-deepseek-mcp)
[![MCP SDK](https://img.shields.io/badge/MCP_SDK-1.32.2-blue.svg)](https://modelcontextprotocol.io)
[![Backend](https://img.shields.io/badge/Backend-DSH_SDK_JSON--RPC-purple.svg)](https://github.com/773Archer/dsh-deepseek-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)

---

## ✨ 为什么要做 `dsh-deepseek-mcp`？

在 **Google Antigravity** 等 AI IDE 中，顶层编排大模型（如 Gemini / Claude）极其擅长全局架构拆解、跨模块推理与最终集成验收；但如果把单文件小改、样板/测试生成、几十步的 Shell 工具试错循环全都塞在主对话里，不仅会迅速污染主上下文窗口，还会白白烧掉昂贵的旗舰模型额度。

`dsh-deepseek-mcp` 采用**零反代、零侵入的「大脑 × 外包工人分流架构（Shunt Pattern）」**：

1. **🔥 常驻热会话池（`sessionKey` + 98%+ KV 缓存命中率）**  
   底层直连 DSH 官方 `dsh --profile sdk` JSON-RPC 服务。同一轮任务拆出的多条子任务只需传入相同的 `sessionKey`，即可复用同一个常驻 DeepSeek 进程与上下文记忆——实测 **KV 缓存命中率超 98%**（空闲时段缓存命中仅需 **¥0.02 元 / 百万 Tokens**！）。切换无关新任务时换新 Key 或省略即可彻底隔离，零串味污染。
2. **⚡ 真正的服务端并发扇出（`delegate_parallel`）**  
   单次 MCP 调用即可并发下发最多 16 条独立子任务。不同 `sessionKey` 的子任务在多个 `dsh --profile sdk` 进程间真并行执行；相同 `sessionKey` 的并发请求会自动通过 `initPromise` 初始化锁与 `runTurn` 互斥锁安全排队并共享记忆，彻底杜绝孤儿进程与竞态。
3. **⏱️ 三级墙钟防跑飞计时器（`15m / 25m / 30m`）**  
   专治 Agent 陷入无限工具调用死循环或“雷霆大思考”：
   - **一级温和提醒（`warnMs`，默认 15 分钟）**：通过 JSON-RPC 实时向运行中的 Worker 注入收敛提醒，要求停止发散探索。
   - **二级强制收尾（`forceMs`，默认 25 分钟）**：下达最后通牒，命令立刻停止一切新工具调用并在当前回复内输出最终结论与进度。
   - **三级硬超时强杀（`timeoutMs`，默认 30 分钟）**：超时瞬间终止会话并调用 `taskkill /PID <pid> /T /F` 连根拔起 Worker 派生的整棵孙进程树（如 PowerShell、无头浏览器），返回 `timedOut: true`。
4. **🚀 `pureText` 纯文本/纯代码极速模式 & `reasoningEffort` 思考深度分档**  
   对于无需读写磁盘或跑命令自检的纯代码/SVG/文案生成任务，传 `pureText: true` 即可严禁 Worker 调用本地工具自嗨，将耗时从 10 分钟以上直接砍到 **30~40 秒**；同时支持按任务难度单次指定 `reasoningEffort`（`low` 极速 | `high` 深度 | `max` 极限）。
5. **💰 实时流式 Token 计量与官方峰谷人民币账单（`usage` / `batchUsage`）**  
   在 JSON-RPC 事件流中实时拦截 `assistant/message` 的 Token 消耗块，自动识别北京时间**官方高峰/空闲半价时段（周末全天与工作日夜间 5 折）**，在每次调用返回 JSON 中直接附带 `uncachedInputTokens`、`cacheReadTokens`、`outputTokens`、实付人民币估算 `estimatedCostCNY` 以及本地 Magpie 网关积分。

---

## 🏗️ 架构与数据流

```text
用户任务
  │
  ▼
Google Antigravity / 顶层编排大模型（"大脑"）
  ├─ 全局规则 (`delegate-to-dsh.md`)：自动评估任务复杂度
  │    ├─ 简单 / 叶子级杂活 ───────► `delegate_task(tier: "flash")` 直派
  │    └─ 复杂系统 / 大工程 ───────► 大脑设计接口契约并拆解叶子模块
  │                                  ├─► `delegate_parallel(tasks: [...], maxConcurrency: 4)`
  │                                  └─► 大脑汇总审阅、联调统合与实机验收
  ▼
MCP 服务端：`dsh-deepseek-mcp` (Stdio JSON-RPC v2.5.0)
  ├─ 防自杀竞态 LRU 会话池 (`POOL_MAX=4`, `POOL_TTL=30m`, `MAX_TURNS=40`)
  ├─ Windows 路径大小写/斜杠归一化 (`D:\agy` === `d:/agy`)
  ├─ 三级防跑飞计时阶梯 (`warnMs` -> `forceMs` -> `timeoutMs` + 进程树连根清理)
  └─ 实时流式 Token & 人民币峰谷费用核算器
  ▼
常驻 `dsh --profile sdk` Worker 进程池
  ├─ `flash` 档：`auto/deepseek-v4.1-flash`（便宜快，默认主力）
  └─ `max` 档：  `trae-cn/deepseek-v4.1-flash-max`（1M 超长上下文重装档）
```

---

## 🛠️ MCP 工具一览

| 工具名称 | 功能说明 |
| :--- | :--- |
| **`delegate_task`** | 外派单个子任务给 DeepSeek Worker。支持 `task`、`cwd`、`context`、`sessionKey`、`tier` (`flash`\|`max`)、`pureText` (`boolean`)、`reasoningEffort` (`low`\|`high`\|`max`)、`fresh`、`warnMs`、`forceMs`、`timeoutMs`。返回完整 `answer`、`toolCalls`、`elapsedMs`、单轮 `usage` 与会话累计 `sessionUsage`。 |
| **`delegate_parallel`** | 服务端多路并发外包多条子任务（默认并发 4，最高 16）。按序返回每条任务的完整 `answer`（绝不截断）以及整批任务的汇总 Token 与人民币账单 `batchUsage`。 |
| **`pool_status`** | 查看当前常驻会话池状态（包含 `key`、`sessionId`、已跑轮次 `turns`、`busy` 状态、空闲时长 `idleMs` 及该会话累计消耗的 Token 与人民币费用 `sessionUsage`）。 |
| **`worker_info`** | 查看服务端版本（`2.5.0`）、档位模型映射、三级计时阈值与当前会话池快照。 |
| **`reset_session`** | 丢弃指定 `sessionKey`（不传则清空全部）的常驻会话并清理其底层进程树。 |
| **`echo`** | 连通性秒级自检工具。 |

---

## 🚀 快速开始

### 1. 环境要求
- **Node.js** `>= 18`
- 已安装 **DeepSeek Harness (`@deepseek-ai/dsh`)** 并配置好 `sdk` profile（`~/.dsh/profiles/sdk`）。

### 2. 克隆与安装依赖
```bash
git clone https://github.com/773Archer/dsh-deepseek-mcp.git
cd dsh-deepseek-mcp
npm install
```

### 3. 在 Google Antigravity 中注册 MCP (`mcp_config.json`)
将 `dsh-deepseek` 添加到 `~/.gemini/config/mcp_config.json`（或 `~/.gemini/antigravity/mcp_config.json`）：

```json
{
  "mcpServers": {
    "dsh-deepseek": {
      "command": "node",
      "args": ["D:/path/to/dsh-deepseek-mcp/server.mjs"],
      "env": {
        "POOL_MAX": "4",
        "PARALLEL_MAX": "4",
        "DEFAULT_WORKSPACE_CWD": "d:/agy"
      }
    }
  }
}
```

### 4. （强烈推荐）挂载全局大脑分流规则
将 [`delegate-to-dsh.md`](./delegate-to-dsh.md) 复制到 `~/.gemini/config/rules/delegate-to-dsh.md`。挂载后无需在对话中手动提及 DeepSeek，Antigravity 大脑也会自动按难度判别、自动绑定 `sessionKey` 吃满缓存并并发调遣外包军团。

---

## 🧪 实战压测战绩：245 KB 单文件四国画中世界 SVG 动画

在**「鹈鹕在串联拍立得相片内部风景世界里骑自行车环游世界（锁定跟拍运镜 + 相框交界物理裁剪遮挡）」**的实战压测中：
- 大脑拆解坐标与裁剪契约后，通过 `delegate_parallel` 并发调度 **4 路 DeepSeek Worker**（`svg-pelican-hero`、`svg-photo-1-2`、`svg-photo-3-4`、`svg-frames-studio`）协同手搓了 **244,997 字节（245 KB）** 的零依赖单文件矢量动画。
- **总 Token 吞吐量**：**6,413,000 Tokens**（未缓存输入 `100,537` + KV 缓存命中 `5,869,824` + 深度思考与代码输出 `442,639`）。
- **KV 缓存命中率**：**`98.32%`**（其中最重的一路 Worker 自行调用 20+ 步无头 Chrome 渲染截图与裁图自检，454 万缓存读取仅花费 ¥0.09 元！）。
- **DeepSeek 官方 API 空闲时段实付总成本**：**¥1.99 元人民币**！

---

## ✅ 内置自检与端到端测试套件

```bash
# 1. 常驻会话记忆复用与实时 Token 计费自检
npm run selftest

# 2. 墙钟硬超时强杀自检（缩放到 1.2s）
npm run test:timeout

# 3. 三级计时器阶梯触发自检（3s 提醒 -> 6s 催收尾 -> 25s 硬上限）
npm run test:ladder

# 4. 完整 MCP Stdio 端到端测试套件
npm run test:e2e
npm run test:reuse
npm run test:parallel
```

---

## ⚙️ 环境变量一览

| 变量名 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `DSH_NODE` | `process.execPath` | 拉起 `dsh` 子进程所使用的 Node 可执行文件路径 |
| `DSH_BIN` | `~/nodejs/node_modules/@deepseek-ai/dsh/lib/bin.js` | `@deepseek-ai/dsh/lib/bin.js` 入口路径 |
| `DSH_WORKER_PROFILE` | `sdk` | DSH 运行 profile 名称 |
| `DEFAULT_WORKSPACE_CWD` | `d:\agy` 或 `process.cwd()` | 当未传 `cwd` 或检测到默认目录落在 IDE 安装目录时的安全回退工作区 |
| `PARALLEL_MAX` | `4` | `delegate_parallel` 默认并发上限（1–16） |
| `POOL_MAX` | `max(4, PARALLEL_MAX)` | 常驻会话池最大保留会话数（LRU 淘汰） |
| `POOL_TTL_MS` | `1800000` (30 分钟) | 空闲会话自动回收时间 |
| `MAX_TURNS` | `40` | 单个常驻会话最大轮次上限（超限自动重开） |
| `DELEGATE_WARN_MS` | `900000` (15 分钟) | 一级收敛提醒阈值 |
| `DELEGATE_FORCE_MS` | `1500000` (25 分钟) | 二级强制收尾命令阈值 |
| `DELEGATE_TIMEOUT_MS` | `1800000` (30 分钟) | 三级硬超时强杀阈值 |

---

## 📄 开源协议

MIT
