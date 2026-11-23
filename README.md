# dsh-deepseek-mcp (v3.0.0)

<p align="center">
  <strong>English</strong> | <a href="./README.zh-CN.md">简体中文</a>
</p>

> **Brain (Antigravity / Frontier LLM) × Hands (Isolated, Credit-Aware DeepSeek Worker Pool)**  
> A production-grade **Stdio MCP Server** that turns **DeepSeek Harness (`dsh --profile sdk`)** into a warm, stateful, parallelizable worker pool with **3-tier execution modes (`fast` / `craft` / `agent`)**, **physical prompt/tool isolation (`9,409 → 161` tokens)**, **Magpie credit-aware direct-route spreading**, **stall watchdogs + automatic failover**, and **98%+ KV-cached two-pass polish** for **Google Antigravity**, Claude Code, Cursor, and any MCP-compatible host.

[![Version](https://img.shields.io/badge/version-3.0.0-teal.svg)](https://github.com/773Archer/dsh-deepseek-mcp)
[![MCP SDK](https://img.shields.io/badge/MCP_SDK-1.32.2-blue.svg)](https://modelcontextprotocol.io)
[![Backend](https://img.shields.io/badge/Backend-DSH_SDK_JSON--RPC-purple.svg)](https://github.com/773Archer/dsh-deepseek-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)

---

## ✨ What's New in v3.0.0 (Speed × Quality Sweet Spot)

1. **🎯 Three-Tier Execution Modes (`mode: "fast" | "craft" | "agent"`)**  
   Decouples tool isolation from output craftsmanship (backward-compatible with legacy `pureText`):
   - **`fast`** (no tools, `low` effort, `60s` stall cap): Boilerplate, configs, short glue scripts, and **Pass-2 targeted polish** (`10–25s`).
   - **`craft`** (no tools, stripped context, unrestricted craftsmanship, `120s` stall cap): **The default sweet spot for complex code & generative visuals** (`20–60s`), producing complete 250–500 line modules without tool-loop runaway. Pass `reasoningEffort: "high"` explicitly when deep algorithmic reasoning is needed.
   - **`agent`** (shell/fs tools enabled, personal `AGENTS.md`/skills still isolated): Real repo debugging, test execution, and multi-file refactoring.
2. **🧼 Physical Worker Isolation (`worker-clean.patch.yml` + `worker-pure.patch.yml`)**  
   Injects native DSH Cordis `--patch` overlays on every spawned worker:
   - Strips personal `~/.dsh/AGENTS.md`, unrelated `<available_skills>`, `plan-mode`, `user-questions`, and autonomous subagent/goal loops in **all** modes.
   - Unloads `pwsh`/`bash`/`fs`/`jobs`/`web` tool schemas at runtime in `fast`/`craft` modes—cutting base input overhead from **`~9,409` tokens down to `161` tokens (`-98.3%`)** with **`tools: []`** (`152` header bytes) so even strict or low-context reverse-proxy providers never reject bloated prompts!
3. **🛡️ Stream-Aware Stall Watchdog + Single-Turn Gate + Automatic 1× Failover**  
   Tracks real JSON-RPC progress timestamps (`stallTimeoutMs`), immediately resolves single-turn `fast`/`craft` completions (`singleStepGate`) to prevent spurious Turn-2 self-chat, and automatically fails over once (`autoFailover: true`) to another healthy direct Magpie route if a lane stalls or crashes.
4. **🔁 Two-Pass Craft + Cheap KV-Cached Critique/Polish (`cacheHitRate` Telemetry)**  
   `fast` and `craft` share the same warm `pure` session pool bucket. Run **Pass-1 (`mode: "craft"`)** across 4 workers → run Brain QA → send targeted fixes back to the **same `sessionKey`** (`mode: "fast"`), hitting **`95–98.9%` KV cache** (~¥0.02/M off-peak) in seconds!
5. **🧭 Magpie Credit-Aware Direct-Route Load Balancing**  
   Checks live quotas via `magpie quota --json` (60s cache), skips low-credit routes automatically, and spreads concurrent lanes in `delegate_parallel` across distinct healthy direct Magpie routes instead of piling onto a single routing group. Multi-wave sessions stay pinned to their warm route for maximum KV cache reuse.

---

## 🏗️ Architecture

```text
User Request
  │
  ▼
Google Antigravity / Orchestrator LLM ("The Brain")
  ├─ Global Plugin Rule (`delegate-to-dsh.md` v3.0):
  │    ├─ Micro leaf task ────────► `delegate_task(mode: "fast")`
  │    ├─ Complex / Multi-Wave ───► Pass-1 `delegate_parallel(mode: "craft", maxConcurrency: 4)`
  │    │                            ├─► Brain runs syntax / runtime / visual QA
  │    │                            └─► Pass-2 `same sessionKey` (`mode: "fast"`, 98% KV cache)
  │    └─ Repo debug / tests ─────► `delegate_task(mode: "agent")`
  ▼
MCP Server: `dsh-deepseek-mcp` (Stdio JSON-RPC v3.0.0)
  ├─ Worker Isolation Patches (`worker-clean.patch.yml` + `worker-pure.patch.yml`)
  ├─ Magpie Live Quota Checker (`magpie quota --json`) & Direct-Route Spreader
  ├─ Race-Free LRU Session Pool (`POOL_MAX=4`, shared `pure` bucket for fast/craft)
  ├─ Stream Stall Watchdog + Single-Turn Gate + Auto 1x Failover + Process Tree Kill
  └─ Real-Time Token, `cacheHitRate` & Beijing Peak/Off-Peak RMB Cost Meter
  ▼
Isolated `dsh --profile sdk` Worker Processes (161-token base in `fast`/`craft`)
```

---

## 🛠️ Exposed MCP Tools

| Tool Name | Description |
| :--- | :--- |
| **`delegate_task`** | Delegate an atomic leaf task or Pass-2 KV-cached polish. Supports `task`, `cwd`, `context`, `sessionKey`, `mode` (`fast`\|`craft`\|`agent`), `tier` (`flash`\|`max`), `model`, `pureText` (legacy), `reasoningEffort`, `stallTimeoutMs`, `autoFailover`, `fresh`, `warnMs`, `forceMs`, `timeoutMs`. Returns `answer`, `toolCalls`, `elapsedMs`, `usage` (with `cacheHitRate`), `sessionUsage`, and `failoverFrom`. |
| **`delegate_parallel`** | Fan out 2–4 concurrent tasks (up to 16) across distinct healthy direct Magpie routes. Returns ordered untruncated `results`, `routePlan`, `skippedRoutes`, `failovers`, and aggregated `batchUsage`. |
| **`pool_status`** | Inspect active warm sessions (`key`, `mode`, `tools`, `model`, `sessionId`, `turns`, `busy`, `idleMs`, and cumulative `sessionUsage`). |
| **`worker_info`** | Inspect server version (`3.0.0`), `workerIsolation` patch status, `modes` presets, live `magpieRoutes` credit status, and pool snapshot. |
| **`reset_session`** | Evict and kill the process tree for a specific `sessionKey` (or clear the entire pool if omitted). |
| **`echo`** | Quick connectivity health check. |

---

## 🚀 Quick Start

### 1. Prerequisites
- **Node.js** `>= 18`
- **DeepSeek Harness (`@deepseek-ai/dsh`)** installed with an `sdk` profile (`~/.dsh/profiles/sdk`).
- Optional: **Magpie** gateway CLI (`magpie quota --json`) for credit-aware multi-route spreading. You can customize direct routes directly in `MAGPIE_DIRECT_ROUTES` near the top of `server.mjs`.

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
      },
      "timeoutSeconds": 7200
    }
  }
}
```

### 4. (Required for Auto-Delegation) Install the Global Orchestrator Plugin
In **Google Antigravity 2.0**, global rules **must** live inside an enabled plugin (`~/.gemini/config/plugins/<name>/rules/AGENTS.md`):

```bash
mkdir -p ~/.gemini/config/plugins/dsh-deepseek-delegator/rules
cp plugin.json ~/.gemini/config/plugins/dsh-deepseek-delegator/plugin.json
cp delegate-to-dsh.md ~/.gemini/config/plugins/dsh-deepseek-delegator/rules/AGENTS.md
```

---

## 🧪 Live v3.0.0 Benchmarks

- **Prompt & Tool Isolation Audit**:
  - Unpatched `dsh --profile sdk`: `~9,409` base input tokens (personal `AGENTS.md` + skills + 20+ tools).
  - Patched `fast`/`craft` (`worker-clean.patch.yml` + `worker-pure.patch.yml`): **`161` input tokens**, **`tools: []`**, **`152` header bytes** (`-98.3%`).
- **Two-Pass Craft + KV-Cached Polish E2E**:
  - Pass-1 (`mode: "craft"`): `665` uncached input tokens on isolated `workbuddy/deepseek-v4.1-flash`.
  - Pass-2 (`mode: "fast"`, same `sessionKey`): **`98.9%` KV cache hit** (`19,712` cacheRead vs `213` new input), **`¥0.027` CNY**.
- **20-Era Procedural Film Multi-Wave Stress Test (5 Waves × 4 Workers = 20/20 OK)**:
  - Generated **215 KB** of pure Canvas 2D + Web Audio code across 5 rolling waves, **`561,920` KV cache read tokens**, total cost **¥0.95 CNY**, zero timeouts after direct-route credit filtering.

---

## ✅ Built-In Verification Suite

```bash
npm run selftest       # Warm session reuse & token meter self-test
npm run test:timeout   # Hard wall-clock timeout self-test
npm run test:ladder    # 3-tier timer ladder self-test
npm run test:e2e       # Full MCP stdio E2E
npm run test:reuse     # SessionKey memory isolation & reuse E2E
npm run test:parallel  # True parallel fan-out speedup E2E
```

---

## ⚙️ Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `DSH_NODE` | `process.execPath` | Path to Node.js binary used to spawn `dsh` |
| `DSH_BIN` | `~/nodejs/node_modules/@deepseek-ai/dsh/lib/bin.js` | Path to `@deepseek-ai/dsh/lib/bin.js` |
| `DSH_WORKER_PROFILE` | `sdk` | DSH profile name |
| `DSH_WORKER_ISOLATE` | `1` (set `0` to disable) | Apply `worker-clean.patch.yml` / `worker-pure.patch.yml` isolation patches |
| `MAGPIE_QUOTA_TTL_MS` | `60000` (60s) | Cache TTL for `magpie quota --json` credit checks |
| `DEFAULT_WORKSPACE_CWD` | `d:\agy` or `process.cwd()` | Safe fallback workspace when `cwd` is omitted |
| `PARALLEL_MAX` | `4` | Default concurrency for `delegate_parallel` (1–16) |
| `POOL_MAX` | `max(4, PARALLEL_MAX)` | Maximum warm sessions retained in the LRU pool |
| `POOL_TTL_MS` | `1800000` (30 min) | Idle session TTL before automatic eviction |
| `MAX_TURNS` | `40` | Maximum turns per session before automatic recycle |
| `DELEGATE_WARN_MS` | `900000` (15 min) | Tier-1 gentle convergence reminder (`agent` mode) |
| `DELEGATE_FORCE_MS` | `1500000` (25 min) | Tier-2 forced wrap-up command (`agent` mode) |
| `DELEGATE_TIMEOUT_MS` | `1800000` (30 min) | Tier-3 hard kill timeout (`agent` mode) |

---

## 📄 License

MIT
