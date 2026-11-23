# dsh-deepseek-mcp (v3.0.0)

<p align="center">
  <a href="./README.md">English</a> | <strong>简体中文</strong>
</p>

> **大脑（Google Antigravity / 旗舰大模型）× 手脚（物理隔离、积分感知的 DeepSeek 外包工人池）**  
> 一款生产级 **Stdio MCP 服务端**，将 **DeepSeek Harness (`dsh --profile sdk`)** 封装为具备**三档执行模式（`fast` / `craft` / `agent`）、物理隔离精简 Worker 环境（首轮底座 `9,409 → 161` tokens）、Magpie 积分感知多路直连分流、失速看门狗与自动故障转移、以及 98%+ KV 缓存二段式精修**的外部 Worker 池，专为 **Google Antigravity**、Claude Code、Cursor 等 MCP 客户端打造。

[![Version](https://img.shields.io/badge/version-3.0.0-teal.svg)](https://github.com/773Archer/dsh-deepseek-mcp)
[![MCP SDK](https://img.shields.io/badge/MCP_SDK-1.32.2-blue.svg)](https://modelcontextprotocol.io)
[![Backend](https://img.shields.io/badge/Backend-DSH_SDK_JSON--RPC-purple.svg)](https://github.com/773Archer/dsh-deepseek-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)

---

## ✨ v3.0.0 核心升级（速度 × 质量甜品点）

1. **🎯 三档执行模式（`mode: "fast" | "craft" | "agent"`）**  
   彻底将“工具隔离”与“输出完成度”解耦（并向后兼容旧 `pureText` 参数）：
   - **`fast`（极速纯输出，禁工具 + `low` 思考，失速阈值 `60s`）**：样板配置、短胶水代码以及 **Pass-2 快速定点精修**（`10~25s`）。
   - **`craft`（精工纯输出甜品档，禁工具 + 隔离上下文 + 高完成度输出，失速阈值 `120s`）**：**复杂代码与视觉创作的默认首选**（`20~60s`），彻底杜绝外包跑去瞎敲 shell 浪费几分钟，同时解除硬性短行数限制、稳产 250~500 行精绘/高内聚代码；遇到极难算法可显式传 `reasoningEffort: "high"`。
   - **`agent`（带工具自治代理，开启 shell/fs 工具 + 依然物理隔离个人 `AGENTS.md`）**：用于真实代码库排障、跑单测与多文件重构。
2. **🧼 物理隔离 Worker 环境（`worker-clean.patch.yml` + `worker-pure.patch.yml`）**  
   启动每个 `dsh --profile sdk` 子进程时自动叠加原生 Cordis `--patch` 补丁：
   - **全模式隔离**：底层直接禁用 `agent-instructions`（彻底不读不传个人 `~/.dsh/AGENTS.md`）、`skill-filesystem`、`tool-skill`、`plan-mode`、`user-questions` 及子代理/目标循环插件，杜绝个人人设与外包任务指令打架。
   - **`fast`/`craft` 零工具瘦身**：运行时直接卸载 `pwsh`/`bash`/`fs`/`jobs`/`web` 工具定义，首轮上传底座从 **`~9,409` tokens 暴降至 `161` tokens（`-98.3%`）**、**`tools: []`（0 工具）**、请求头仅 **`152` 字节**，完美兼容对提示词长度或 Function Calling 挑食的各类 Magpie 反代供应商！
3. **🛡️ 流式失速看门狗 + 单轮收尾闸门 + 1 次自动故障转移**  
   盯紧 JSON-RPC 有效事件流刷新活跃时间（`stallTimeoutMs`），`fast`/`craft` 模式首步输出完正文即通过 `singleStepGate` 干脆收网防二轮自嗨；某一路失速/超时/子进程崩掉时（且调用方未显式锁死 `model`），自动触发 `autoFailover` 切换至另一条健康 Magpie 路线重试一次并附带 `failoverFrom` 留痕。
4. **🔁 二段式 KV 缓存精修（Pass-1 `craft` → Pass-2 `fast`，实时回报 `cacheHitRate`）**  
   `fast` 与 `craft` 共享同一纯输出 `sessionKey` 池桶：先用 `craft` 并发出首稿 → 大脑跑语法/单测/截图质检 → 仅对薄弱模块复用原 `sessionKey` 发 `fast` 定点精修，实测命中 **`95~98.9%` KV 缓存**（空闲时段 ¥0.02/百万 Tokens），15~35 秒拉升至精品！
5. **🧭 Magpie 实时积分感知 + 多路独立路线分流**  
   调用 `magpie quota --json`（60s 缓存）自动过滤积分不足的路线，在 `delegate_parallel` 中将各并发通道分散到不同健康直连路线（绕开单一 routing group 拥堵）；跨波次或 Pass-2 复用 `sessionKey` 时自动黏住原健康路线保住 KV 缓存。

---

## 🏗️ 架构与数据流

```text
用户任务
  │
  ▼
Google Antigravity / 顶层编排大模型（"大脑"）
  ├─ 全局插件规则 (`delegate-to-dsh.md` v3.0)：
  │    ├─ 微型原子杂活 ─────────► `delegate_task(mode: "fast")`
  │    ├─ 复杂/多波次工程 ──────► Pass-1 `delegate_parallel(mode: "craft", maxConcurrency: 4)`
  │    │                           ├─► 大脑语法 / 运行 / 截图快验
  │    │                           └─► Pass-2 复用原 `sessionKey` (`mode: "fast"`, 98% KV 缓存)
  │    └─ 代码库排障 / 跑测试 ──► `delegate_task(mode: "agent")`
  ▼
MCP 服务端：`dsh-deepseek-mcp` (Stdio JSON-RPC v3.0.0)
  ├─ 物理隔离补丁层 (`worker-clean.patch.yml` + `worker-pure.patch.yml`)
  ├─ Magpie 实时积分体检 (`magpie quota --json`) & 多路直连分流器
  ├─ 防自杀竞态 LRU 会话池 (`POOL_MAX=4`，`fast`/`craft` 共享 `pure` 缓存桶)
  ├─ 流式失速看门狗 + 单轮收尾闸门 + 1 次自动故障转移 + 进程树连根清理
  └─ 实时流式 Token、`cacheHitRate` 与北京时间峰谷人民币账单核算器
  ▼
物理隔离的 `dsh --profile sdk` Worker 进程池（`fast`/`craft` 底座仅 161 Tokens）
```

---

## 🛠️ MCP 工具一览

| 工具名称 | 功能说明 |
| :--- | :--- |
| **`delegate_task`** | 外派单一原子任务或针对已有 `sessionKey` 的 Pass-2 定点精修。支持 `task`、`cwd`、`context`、`sessionKey`、`mode` (`fast`\|`craft`\|`agent`)、`tier` (`flash`\|`max`)、`model`、`pureText`（旧参数兼容）、`reasoningEffort`、`stallTimeoutMs`、`autoFailover`、`fresh`、`warnMs`、`forceMs`、`timeoutMs`。返回完整 `answer`、`toolCalls`、`elapsedMs`、单轮 `usage`（含 `cacheHitRate`）、`sessionUsage` 及 `failoverFrom`。 |
| **`delegate_parallel`** | 服务端多路并发外包 2~4 条（最高 16 条）子任务，自动分散到不同健康 Magpie 直连路线并跳过低积分路线。按序返回完整 `results`、`routePlan`、`skippedRoutes`、`failovers` 与整批汇总账单 `batchUsage`。 |
| **`pool_status`** | 查看常驻会话池快照（`key`、`mode`、`tools`、`model`、`sessionId`、`turns`、`busy`、`idleMs` 及累计 `sessionUsage`）。 |
| **`worker_info`** | 查看服务端版本（`3.0.0`）、`workerIsolation` 补丁状态、三档 `modes` 预设、各 `magpieRoutes` 实时积分状态与会话池快照。 |
| **`reset_session`** | 丢弃指定 `sessionKey`（不传则清空全部）的常驻会话并清理其底层进程树。 |
| **`echo`** | 连通性秒级自检工具。 |

---

## 🚀 快速开始

### 1. 环境要求
- **Node.js** `>= 18`
- 已安装 **DeepSeek Harness (`@deepseek-ai/dsh`)** 并配置好 `sdk` profile（`~/.dsh/profiles/sdk`）。
- 可选：**Magpie** 本地网关 CLI（`magpie quota --json`），可在 `server.mjs` 顶部的 `MAGPIE_DIRECT_ROUTES` 自由增删/调整你的独立路线与积分阈值。

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
      },
      "timeoutSeconds": 7200
    }
  }
}
```

### 4. （必装：激活默认主动外包与 v3.0 编排铁律）安装全局编排插件
> **⚠️ Antigravity 2.0 避坑重点**：在 Antigravity 2.0 插件化架构下，散装放在 `~/.gemini/config/rules/*.md` 的规则文件会被 Language Server 静默忽略！全局规则**必须**封装在 `~/.gemini/config/plugins/<插件名>/rules/AGENTS.md` 中才会 100% 注入 `<user_rules>`。

```bash
mkdir -p ~/.gemini/config/plugins/dsh-deepseek-delegator/rules
cp plugin.json ~/.gemini/config/plugins/dsh-deepseek-delegator/plugin.json
cp delegate-to-dsh.md ~/.gemini/config/plugins/dsh-deepseek-delegator/rules/AGENTS.md
```

---

## 🧪 v3.0.0 真实压测战绩

- **反代底座瘦身实测**：
  - 改造前裸 `dsh --profile sdk`：首轮上传 **`~9,409` tokens**（含个人 `AGENTS.md` + 全部技能 + 20+ 工具 Schema）。
  - v3.0.0 `fast`/`craft`（物理隔离双补丁）：首轮实测仅 **`161` tokens**、**`tools: []`**、请求头 **`152` 字节**（**直降 98.3%**）！
- **二段式 KV 缓存精修实测**：
  - Pass-1（`mode: "craft"`）：隔离首轮未缓存输入仅 `665` tokens；
  - Pass-2（复用同一 `sessionKey` 切 `mode: "fast"` 定点精修）：**KV 缓存命中率 `98.9%`**（`19,712` 缓存读取 vs 仅 `213` 新输入），实付仅 **¥0.027 元**。
- **超大型多波次实战压测（20 个艺术史时代 2 分 17 秒纯代码短片）**：
  - 5 波 × 4 路真并发 **20/20 子任务全绿零超时**，产出 **215 KB** 零素材 Canvas 2D + Web Audio 实时代码，吃满 **561,920 KV 缓存读取 Tokens**，总费用仅 **¥0.95 元人民币**。

---

## ✅ 内置自检与端到端测试套件

```bash
npm run selftest       # 常驻会话记忆复用与实时 Token 计费自检
npm run test:timeout   # 墙钟硬超时强杀自检（缩放到 1.2s）
npm run test:ladder    # 三级计时器阶梯触发自检（3s -> 6s -> 25s）
npm run test:e2e       # 完整 MCP Stdio 端到端测试
npm run test:reuse     # sessionKey 记忆复用与隔离测试
npm run test:parallel  # 服务端多路并发加速比测试
```

---

## ⚙️ 环境变量一览

| 变量名 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `DSH_NODE` | `process.execPath` | 拉起 `dsh` 子进程所使用的 Node 可执行文件路径 |
| `DSH_BIN` | `~/nodejs/node_modules/@deepseek-ai/dsh/lib/bin.js` | `@deepseek-ai/dsh/lib/bin.js` 入口路径 |
| `DSH_WORKER_PROFILE` | `sdk` | DSH 运行 profile 名称 |
| `DSH_WORKER_ISOLATE` | `1`（设 `0` 可关闭） | 是否自动挂接 `worker-clean.patch.yml` / `worker-pure.patch.yml` 隔离补丁 |
| `MAGPIE_QUOTA_TTL_MS` | `60000` (60 秒) | `magpie quota --json` 积分查询缓存时间 |
| `DEFAULT_WORKSPACE_CWD` | `d:\agy` 或 `process.cwd()` | 当未传 `cwd` 或检测到默认目录落在 IDE 安装目录时的安全回退工作区 |
| `PARALLEL_MAX` | `4` | `delegate_parallel` 默认并发上限（1–16） |
| `POOL_MAX` | `max(4, PARALLEL_MAX)` | 常驻会话池最大保留会话数（LRU 淘汰） |
| `POOL_TTL_MS` | `1800000` (30 分钟) | 空闲会话自动回收时间 |
| `MAX_TURNS` | `40` | 单个常驻会话最大轮次上限（超限自动重开） |
| `DELEGATE_WARN_MS` | `900000` (15 分钟) | `agent` 模式一级收敛提醒阈值 |
| `DELEGATE_FORCE_MS` | `1500000` (25 分钟) | `agent` 模式二级强制收尾命令阈值 |
| `DELEGATE_TIMEOUT_MS` | `1800000` (30 分钟) | `agent` 模式三级硬超时强杀阈值 |

---

## 📄 开源协议

MIT
