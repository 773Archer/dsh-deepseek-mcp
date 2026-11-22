# dsh-deepseek-mcp (v2.5.0)

<p align="center">
  <strong>English</strong> | <a href="./README.zh-CN.md">简体中文</a>
</p>

> **Brain (Antigravity / Frontier LLM) × Hands (Persistent DeepSeek Worker Pool)**  
> A production-grade **Stdio MCP Server** that turns **DeepSeek Harness (`dsh --profile sdk`)** into a warm, stateful, parallelizable worker pool for **Google Antigravity**, Claude Code, Cursor, and any MCP-compatible host.

[![Version](https://img.shields.io/badge/version-2.5.0-teal.svg)](https://github.com/773Archer/dsh-deepseek-mcp)
[![MCP SDK](https://img.shields.io/badge/MCP_SDK-1.32.2-blue.svg)](https://modelcontextprotocol.io)
[![Backend](https://img.shields.io/badge/Backend-DSH_SDK_JSON--RPC-purple.svg)](https://github.com/773Archer/dsh-deepseek-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)

---

## ✨ Why `dsh-deepseek-mcp`?

Frontier orchestrator models (like Gemini / Claude inside **Google Antigravity**) excel at system architecture, cross-module reasoning, and final integration—but burning their context window and quota on leaf tasks, boilerplate generation, or 40-step tool loops is slow and expensive.

`dsh-deepseek-mcp` implements the **Brain × Worker Shunt Architecture** without any reverse-proxying or ToS hacks:

1. **🔥 Persistent Warm Session Pool (`sessionKey` + 98%+ KV Cache Hit)**  
   Backed by DSH's official `dsh --profile sdk` JSON-RPC runtime. Subtasks sharing the same `sessionKey` reuse the exact same warm DeepSeek agent process and memory—achieving **>98% KV Cache hit rates** (¥0.02 / 1M tokens off-peak!). Unrelated tasks use a new key (or omit it) for zero context contamination.
2. **⚡ True Server-Side Parallel Fan-Out (`delegate_parallel`)**  
   Dispatch up to 16 independent leaf tasks in a single MCP tool call. Distinct `sessionKey`s execute concurrently across multiple `dsh --profile sdk` workers; identical `sessionKey`s automatically serialize through an `initPromise` + turn mutex lock to share memory safely.
3. **⏱️ Three-Tier Wall-Clock Anti-Runaway Timer (`15m / 25m / 30m`)**  
   Tames runaway agent loops with a three-stage ladder:
   - **Warn (`warnMs`, default 15 min)**: Injects a live steering nudge via JSON-RPC to start converging.
   - **Force Wrap-Up (`forceMs`, default 25 min)**: Commands the worker to stop all new tool calls immediately and output its final summary.
   - **Hard Timeout (`timeoutMs`, default 30 min)**: Terminates the worker and its entire Windows/POSIX subprocess tree (`taskkill /T /F`), returning `timedOut: true`.
4. **🚀 `pureText` Fast Generation Mode & Configurable `reasoningEffort`**  
   Set `pureText: true` for pure code/SVG/text generation tasks to forbid the worker from running unnecessary local shell/browser self-verification loops—cutting latency from 10+ minutes to ~30 seconds. Supports per-call `reasoningEffort` (`low` | `high` | `max`).
5. **💰 Real-Time Token & Cost Accounting (`usage` / `batchUsage`)**  
   Intercepts live `assistant/message` token meter events from the DSH SDK stream and returns exact `uncachedInputTokens`, `cacheReadTokens`, `outputTokens`, automatic Beijing Peak/Off-Peak detection (`isOffPeak`), and real-time RMB cost (`estimatedCostCNY`).

---

## 🏗️ Architecture

```text
User Request
  │
  ▼
Google Antigravity / Orchestrator LLM ("The Brain")
  ├─ Global Rule (`delegate-to-dsh.md`): Triage complexity
  │    ├─ Simple / Leaf Task ──────► `delegate_task(tier: "flash")`
  │    └─ Complex Architecture ────► Brain designs contract & decomposes
  │                                  ├─► `delegate_parallel(tasks: [...], maxConcurrency: 4)`
  │                                  └─► Brain integrates, verifies & delivers
  ▼
MCP Server: `dsh-deepseek-mcp` (Stdio JSON-RPC)
  ├─ Race-free LRU Session Pool (`POOL_MAX=4`, `POOL_TTL=30m`, `MAX_TURNS=40`)
  ├─ Windows Path Normalization (`D:\agy` === `d:/agy`)
  ├─ 3-Tier Timer Ladder (`warnMs` -> `forceMs` -> `timeoutMs` + Process Tree Kill)
  └─ Real-Time Stream Token & RMB Cost Meter
  ▼
Persistent `dsh --profile sdk` Worker Processes
  ├─ `flash` tier: `auto/deepseek-v4.1-flash`
  └─ `max` tier:   `trae-cn/deepseek-v4.1-flash-max` (1M Context)
```

---

## 🛠️ Exposed MCP Tools

| Tool Name | Description |
| :--- | :--- |
| **`delegate_task`** | Delegate a single task to a DeepSeek worker. Supports `task`, `cwd`, `context`, `sessionKey`, `tier` (`flash`\|`max`), `pureText` (`boolean`), `reasoningEffort` (`low`\|`high`\|`max`), `fresh`, `warnMs`, `forceMs`, `timeoutMs`. Returns full `answer`, `toolCalls`, `elapsedMs`, `usage`, and `sessionUsage`. |
| **`delegate_parallel`** | Fan out an array of `tasks` concurrently on the server (`maxConcurrency` default 4, max 16). Returns ordered per-task results (`answer` untruncated) plus aggregated `batchUsage` token & RMB cost summary. |
| **`pool_status`** | Inspect active warm sessions in the pool (`key`, `sessionId`, `turns`, `busy`, `idleMs`, and cumulative `sessionUsage`). |
| **`worker_info`** | Inspect server version (`2.5.0`), tier model mappings, timer defaults, and pool status. |
| **`reset_session`** | Evict and kill the process tree for a specific `sessionKey` (or clear the entire pool if omitted). |
| **`echo`** | Quick connectivity health check. |

---

## 🚀 Quick Start

### 1. Prerequisites
- **Node.js** `>= 18`
- **DeepSeek Harness (`@deepseek-ai/dsh`)** installed with an `sdk` profile configured (`~/.dsh/profiles/sdk`).

### 2. Install Dependencies
```bash
git clone https://github.com/773Archer/dsh-deepseek-mcp.git
cd dsh-deepseek-mcp
npm install
```

### 3. Register in Google Antigravity (`mcp_config.json`)
Add `dsh-deepseek` to `~/.gemini/config/mcp_config.json` (or `~/.gemini/antigravity/mcp_config.json`):

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

### 4. (Required for Auto-Delegation) Install the Global Orchestrator Plugin
In **Google Antigravity 2.0**, loose files in `~/.gemini/config/rules/` are ignored after plugin migration—global rules **must** live inside an enabled plugin (`~/.gemini/config/plugins/<name>/rules/AGENTS.md`).

Install the bundled `dsh-deepseek-delegator` plugin so Antigravity **proactively delegates without waiting to be asked**, **enforces multi-part decomposition via `delegate_parallel`** (`>120` lines or `>=2` modules), and **automatically switches to Multi-Wave Rolling Concurrency** on mega-tasks (`>4` units/maps/scenes, capping each worker turn at `1–2` units and running multiple waves of `delegate_parallel(4)` while reusing `worker-1`..`worker-4` `sessionKey`s to hit 98% KV cache without timing out):

```bash
mkdir -p ~/.gemini/config/plugins/dsh-deepseek-delegator/rules
cp plugin.json ~/.gemini/config/plugins/dsh-deepseek-delegator/plugin.json
cp delegate-to-dsh.md ~/.gemini/config/plugins/dsh-deepseek-delegator/rules/AGENTS.md
```

---

## 🧪 Real-World Benchmark: 245 KB Single-File SVG Animation

In a live benchmark orchestrating a **245 KB multi-country picture-in-picture SVG animation** (*"Pelican cycling around the world inside hanging Polaroid photos with dynamic camera tracking"*):
- **4 specialized DeepSeek workers** ran in parallel (`svg-pelican-hero`, `svg-photo-1-2`, `svg-photo-3-4`, `svg-frames-studio`).
- **Total Token Throughput**: **6,413,000 Tokens** (`100,537` uncached input + `5,869,824` KV cache read + `442,639` output & reasoning tokens).
- **KV Cache Hit Rate**: **`98.32%`**
- **Total Official API Cost (Off-Peak)**: **¥1.99 CNY (~$0.27 USD)**!

---

## ✅ Built-In Verification Suite

Run the included self-tests and E2E suites to verify your local DSH SDK runtime:

```bash
# 1. Warm session memory reuse & token meter self-test
npm run selftest

# 2. Hard wall-clock timeout self-test (scaled to 1.2s)
npm run test:timeout

# 3. 3-tier timer ladder self-test (3s warn -> 6s force -> 25s cap)
npm run test:ladder

# 4. Full MCP stdio E2E suites
npm run test:e2e
npm run test:reuse
npm run test:parallel
```

---

## ⚙️ Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `DSH_NODE` | `process.execPath` | Path to Node.js binary used to spawn `dsh` |
| `DSH_BIN` | `~/nodejs/node_modules/@deepseek-ai/dsh/lib/bin.js` | Path to `@deepseek-ai/dsh/lib/bin.js` |
| `DSH_WORKER_PROFILE` | `sdk` | DSH profile name |
| `DEFAULT_WORKSPACE_CWD` | `d:\agy` or `process.cwd()` | Safe fallback workspace when `cwd` is omitted |
| `PARALLEL_MAX` | `4` | Default concurrency for `delegate_parallel` (1–16) |
| `POOL_MAX` | `max(4, PARALLEL_MAX)` | Maximum warm sessions retained in the LRU pool |
| `POOL_TTL_MS` | `1800000` (30 min) | Idle session TTL before automatic eviction |
| `MAX_TURNS` | `40` | Maximum turns per session before automatic recycle |
| `DELEGATE_WARN_MS` | `900000` (15 min) | Tier-1 gentle convergence reminder threshold |
| `DELEGATE_FORCE_MS` | `1500000` (25 min) | Tier-2 forced wrap-up threshold |
| `DELEGATE_TIMEOUT_MS` | `1800000` (30 min) | Tier-3 hard kill timeout threshold |

---

## 📄 License

MIT
