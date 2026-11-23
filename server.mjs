#!/usr/bin/env node
// Stdio MCP server (v3.0.0): persistent-session DeepSeek worker pool for an MCP client (Antigravity).
// Backed by DSH's official SDK JSON-RPC server (`dsh --profile sdk`).
//
// Key features & v3.0.0 upgrades:
//   - Three-tier execution modes (`mode: 'fast' | 'craft' | 'agent'`): decouples tool-isolation from output depth,
//     giving high-craft single-turn generation (`craft`) without agentic tool-loop runaway.
//   - Physical worker profile isolation (`worker-clean.patch.yml` + `worker-pure.patch.yml`): strips personal
//     ~/.dsh/AGENTS.md and irrelevant skills, cutting base input bloat from ~9.4k tokens down to ~520 tokens.
//   - Step-activity stall watchdog (`stallTimeoutMs`), empty-reply & turn-error detection, and multi-hop failover
//     across healthy Magpie routes on stall/crash/empty-reply.
//   - Two-pass KV-cached craft + polish workflow: `fast` and `craft` share the same warm `sessionKey` pool bucket
//     so Pass-2 targeted critique/polish hits ~95-98% KV cache (`cacheHitRate` reported on every response).
//   - Magpie credit-aware direct route spreading (editable in `MAGPIE_DIRECT_ROUTES` below).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { resolve as resolvePath, join as joinPath, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { homedir } from 'node:os'

const execFileAsync = promisify(execFile)
const HERE_DIR = dirname(fileURLToPath(import.meta.url))
const CLEAN_PATCH = joinPath(HERE_DIR, 'worker-clean.patch.yml')
const PURE_PATCH = joinPath(HERE_DIR, 'worker-pure.patch.yml')
const ISOLATE_WORKER = process.env.DSH_WORKER_ISOLATE !== '0'
const SERVER_VERSION = '3.1.0'
const MAX_FAILOVERS = Math.max(0, Math.min(4, Number(process.env.MAX_FAILOVERS || 2)))

const NODE_EXE = process.env.DSH_NODE || process.execPath
const DEFAULT_DSH_BIN = joinPath(homedir(), 'nodejs/node_modules/@deepseek-ai/dsh/lib/bin.js').replace(/\\/g, '/')
const DSH_BIN = process.env.DSH_BIN || (existsSync(DEFAULT_DSH_BIN) ? DEFAULT_DSH_BIN : 'C:/Users/24537/nodejs/node_modules/@deepseek-ai/dsh/lib/bin.js')
const PROFILE = process.env.DSH_WORKER_PROFILE || 'sdk'
const TURN_TIMEOUT = Number(process.env.DELEGATE_TIMEOUT_MS || 1800000) // hard cap 30 min
const WARN_TIMEOUT = Number(process.env.DELEGATE_WARN_MS || 900000)     // reminder 15 min
const FORCE_TIMEOUT = Number(process.env.DELEGATE_FORCE_MS || 1500000)  // forced wrap-up 25 min
const MIN_TURN_TIMEOUT = 10000
const MAX_TURN_TIMEOUT = 7200000
const MIN_WARN = 2000
const PARALLEL_MAX = Number(process.env.PARALLEL_MAX || 4) // default concurrency for delegate_parallel
const POOL_MAX = Math.max(Number(process.env.POOL_MAX || 4), PARALLEL_MAX)
const POOL_TTL = Number(process.env.POOL_TTL_MS || 1800000)
const MAX_TURNS = Number(process.env.MAX_TURNS || 40)
const DEFAULT_WORKSPACE = process.env.DEFAULT_WORKSPACE_CWD || (existsSync('d:\\agy') ? 'd:\\agy' : process.cwd())

const MODE_PRESETS = {
  fast: {
    tools: false,
    defaultEffort: 'low',
    defaultStallMs: 150000,
    defaultTimeoutMs: 180000,
    singleStepGate: true,
    desc: '极速纯输出（禁工具 + 浅思考，适合样板/配置/小片段/Pass-2 快速定点精修，10~35s）',
  },
  craft: {
    tools: false,
    defaultEffort: 'low',
    defaultStallMs: 240000,
    defaultTimeoutMs: 300000,
    singleStepGate: true,
    desc: '精工纯输出甜品档（禁工具防死循环 + 隔离冗余上下文 + 高完整度代码/艺术渲染，20~90s；极难算法可显式传 reasoningEffort:"high"）',
  },
  agent: {
    tools: true,
    defaultEffort: 'high',
    defaultStallMs: 240000,
    defaultTimeoutMs: TURN_TIMEOUT,
    singleStepGate: false,
    desc: '完整自治代理（开启 shell/fs 工具 + 隔离个人 AGENTS.md，适合真实仓库排障与测试）',
  },
}

function resolveMode(mode, pureText, reasoningEffort) {
  if (mode && MODE_PRESETS[mode]) return mode
  if (pureText === true) return reasoningEffort === 'low' ? 'fast' : 'craft'
  return 'agent'
}

const TIERS = {
  flash: { model: 'auto/deepseek-v4.1-flash', desc: '便宜快，适合简单/叶子任务（多路并发时自动分散到各 Magpie 独立路线并检查积分）' },
  max: { model: 'trae-cn/deepseek-v4.1-flash-max', desc: '更强、1M 上下文，适合偏重但仍可独立完成的子任务（积分不足时自动切高上下文健康路线）' },
}

// Magpie direct routes (bypassing routing group `auto/deepseek-v4.1-flash` during multi-way concurrency).
// Note: `wps-lingxi` (slow streaming) and `trae-cn` (16k output cap) are kept as fallback-only (`dshPrimary: false`).
const MAGPIE_DIRECT_ROUTES = [
  { provider: 'workbuddy',  model: 'workbuddy/deepseek-v4.1-flash',       minPct: 5, minAbs: 50, maxTokens: 128000, highCtx: true,  dshPrimary: true  },
  { provider: 'dumate',     model: 'dumate/deepseek-v41-flash',           minPct: 5, minAbs: 50, maxTokens: 384000, highCtx: true,  dshPrimary: true  },
  { provider: 'raccoon',    model: 'raccoon/sn-deepseek-v4-1-flash-1017', minPct: 5, minAbs: 50, maxTokens: 100000, highCtx: true,  dshPrimary: true  },
  { provider: 'loomy',      model: 'loomy/DeepSeek-V4.1-Flash',           minPct: 5, minAbs: 50, maxTokens: 384000, highCtx: true,  dshPrimary: true  },
  { provider: 'wps-lingxi', model: 'wps-lingxi/deepseek-v4.1-flash',      minPct: 5, minAbs: 50, maxTokens: 393216, highCtx: true,  dshPrimary: false },
  { provider: 'trae-cn',    model: 'trae-cn/deepseek-v4.1-flash',         minPct: 5, minAbs: 50, maxTokens: 16000,  highCtx: false, dshPrimary: false },
]
const MAGPIE_MAX_ROUTES = [
  { provider: 'workbuddy',  model: 'workbuddy/deepseek-v4.1-flash',       minPct: 5, minAbs: 50, maxTokens: 128000, highCtx: true, dshPrimary: true  },
  { provider: 'dumate',     model: 'dumate/deepseek-v41-flash',           minPct: 5, minAbs: 50, maxTokens: 384000, highCtx: true, dshPrimary: true  },
  { provider: 'loomy',      model: 'loomy/DeepSeek-V4.1-Flash',           minPct: 5, minAbs: 50, maxTokens: 384000, highCtx: true, dshPrimary: true  },
  { provider: 'trae-cn',    model: 'trae-cn/deepseek-v4.1-flash-max',     minPct: 5, minAbs: 50, maxTokens: 64000,  highCtx: true, dshPrimary: true  },
  { provider: 'wps-lingxi', model: 'wps-lingxi/deepseek-v4.1-flash',      minPct: 5, minAbs: 50, maxTokens: 393216, highCtx: true, dshPrimary: false },
]
const QUOTA_CACHE_TTL_MS = Number(process.env.MAGPIE_QUOTA_TTL_MS || 60000)
let _quotaCache = { ts: 0, entries: null, error: null, source: null }
let _routeRR = 0

function resolveMagpieGateway() {
  let url = (process.env.MAGPIE_GATEWAY_URL || '').trim()
  if (!url) {
    try {
      const yaml = readFileSync(joinPath(homedir(), '.dsh', 'settings.yaml'), 'utf8')
      const block = yaml.match(/magpie:\s*\r?\n(?:[ \t]+.*\r?\n)*/)?.[0] || yaml
      const m = block.match(/^\s*baseURL:\s*(https?:\/\/[^\s#]+)/m)
      if (m) url = m[1].trim()
    } catch {}
  }
  url = url.replace(/\/+$/, '').replace(/\/v1$/i, '')

  let key = (process.env.MAGPIE_GATEWAY_KEY || '').trim()
  if (!key) {
    try {
      const envTxt = readFileSync(joinPath(homedir(), '.dsh', '.env'), 'utf8')
      const m = envTxt.match(/^\s*MAGPIE_GATEWAY_KEY\s*=\s*(.+)$/m)
      if (m) key = m[1].trim().replace(/^['"]|['"]$/g, '')
    } catch {}
  }
  return { url, key }
}

function httpGetJson(urlStr, headers = {}, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr)
    const mod = u.protocol === 'https:' ? https : http
    const req = mod.request(u, { method: 'GET', headers, timeout: timeoutMs }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => {
        if ((res.statusCode || 0) < 200 || (res.statusCode || 0) >= 300) {
          return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`))
        }
        try {
          resolve(JSON.parse(body))
        } catch (e) {
          reject(new Error(`invalid JSON from ${u.origin}${u.pathname}: ${e.message}`))
        }
      })
    })
    req.on('timeout', () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)))
    req.on('error', reject)
    req.end()
  })
}

function pickPrimaryQuotaWindow(windows) {
  if (!Array.isArray(windows) || !windows.length) return null
  const totalWin = windows.find((w) => /total\s*credits/i.test(String(w?.name || '')))
  if (totalWin) return totalWin
  return windows.find((w) => w && w.lane !== 'images' && !/tokens|image/i.test(String(w.name || ''))) || windows[0]
}

function evalAccountCredit(item, route) {
  const w = pickPrimaryQuotaWindow(item?.windows)
  if (!w) return { user: item?.user || 'default', remainingPct: null, remainingAbs: null, unit: '', healthy: true, reason: 'no-window' }
  const remainingPct = typeof w.remaining === 'number' ? Number(w.remaining.toFixed(2)) : null
  let remainingAbs = null
  if (typeof w.balance === 'number') remainingAbs = w.balance
  else if (typeof w.limit === 'number' && typeof w.amount === 'number') remainingAbs = Math.max(0, w.limit - w.amount)
  else if (typeof w.runsOut === 'number') remainingAbs = w.runsOut
  if (remainingAbs !== null) remainingAbs = Number(remainingAbs.toFixed(2))
  const pctOk = remainingPct === null || remainingPct >= route.minPct
  const absOk = remainingAbs === null || remainingAbs >= route.minAbs
  const healthy = pctOk && absOk
  const reason = healthy ? 'ok' : (!pctOk ? `pct ${remainingPct}% < ${route.minPct}%` : `abs ${remainingAbs} < ${route.minAbs}`)
  return { user: item?.user || 'default', window: w.name, remainingPct, remainingAbs, unit: w.unit || '', healthy, reason }
}

async function fetchMagpieQuotas(force = false) {
  const now = Date.now()
  if (!force && _quotaCache.entries && now - _quotaCache.ts < QUOTA_CACHE_TTL_MS) {
    return _quotaCache
  }
  const { url, key } = resolveMagpieGateway()
  if (url) {
    try {
      const headers = key ? { Authorization: `Bearer ${key}` } : {}
      const parsed = await httpGetJson(`${url}/v1/magpie/quotas`, headers, 10000)
      const entries = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.data) ? parsed.data : null)
      if (!entries) throw new Error('no quota array in gateway response')
      _quotaCache = { ts: now, entries, error: null, source: url }
      return _quotaCache
    } catch (e) {
      log(`magpie gateway quota check failed (${url}):`, String(e?.message || e))
    }
  }
  try {
    const { stdout } = await execFileAsync('magpie', ['quota', '--json'], { timeout: 15000, windowsHide: true })
    const startIdx = stdout.indexOf('[')
    if (startIdx < 0) throw new Error('no JSON array in magpie quota output')
    const entries = JSON.parse(stdout.slice(startIdx))
    _quotaCache = { ts: now, entries, error: null, source: 'local-cli' }
    return _quotaCache
  } catch (e) {
    log('magpie quota check failed:', String(e))
    _quotaCache = { ts: now, entries: _quotaCache.entries, error: String(e), source: _quotaCache.source }
    return _quotaCache
  }
}

async function inspectMagpieRoutes(candidates = MAGPIE_DIRECT_ROUTES, force = false) {
  const q = await fetchMagpieQuotas(force)
  const byProvider = new Map()
  if (Array.isArray(q.entries)) {
    for (const item of q.entries) {
      const p = String(item?.provider || '')
      if (!p) continue
      if (!byProvider.has(p)) byProvider.set(p, [])
      byProvider.get(p).push(item)
    }
  }
  const evaluated = candidates.map((route) => {
    const accs = byProvider.get(route.provider)
    if (!accs || !accs.length) {
      return { ...route, eligible: !q.entries, healthyAccounts: 0, accounts: [], skipReason: q.entries ? 'provider-not-found' : 'quota-unavailable' }
    }
    const accounts = accs.map((a) => evalAccountCredit(a, route))
    const healthyAccounts = accounts.filter((a) => a.healthy).length
    return {
      ...route,
      eligible: healthyAccounts > 0,
      healthyAccounts,
      accounts,
      skipReason: healthyAccounts > 0 ? null : accounts.map((a) => `${a.user}:${a.reason}`).join('; '),
    }
  })
  return { evaluated, eligible: evaluated.filter((r) => r.eligible), quotaError: q.error, checkedAt: _quotaCache.ts }
}

// Build a round-robin list of distinct direct Magpie routes for N concurrent tasks.
// Distinct primary high-context providers come first (skipping low-credit routes & low-context fallback routes when primary routes exist).
async function planDirectRoutes(count, tierName = 'flash') {
  const candidates = tierName === 'max' ? MAGPIE_MAX_ROUTES : MAGPIE_DIRECT_ROUTES
  const report = await inspectMagpieRoutes(candidates)
  const primaryEligible = report.eligible.filter((r) => r.dshPrimary !== false)
  const eligible = primaryEligible.length ? primaryEligible : report.eligible
  if (!eligible.length) {
    return {
      models: Array.from({ length: count }, () => TIERS[tierName]?.model || TIERS.flash.model),
      report,
      fallback: true,
    }
  }
  // Construct weighted distinct-first rotation order:
  // Round 1: every eligible provider once (true distinct-route spread)
  // Round 2+: providers with multiple healthy accounts (e.g. workbuddy with 2 accounts) before repeating single-account ones
  const order = []
  for (const r of eligible) order.push(r)
  const multiAcc = eligible.filter((r) => r.healthyAccounts > 1)
  for (const r of multiAcc) {
    for (let k = 1; k < r.healthyAccounts; k++) order.push(r)
  }
  const models = []
  for (let i = 0; i < count; i++) {
    const picked = order[(_routeRR + i) % order.length]
    models.push(picked.model)
  }
  _routeRR = (_routeRR + count) % order.length
  return { models, report, fallback: false }
}

const VALID_EFFORTS = new Set(['low', 'high', 'max'])

// DeepSeek-V4.1-Flash official pricing (CNY per 1M tokens) & Magpie credit rates
function isOffPeakBeijing(date = new Date()) {
  const utcMs = date.getTime() + date.getTimezoneOffset() * 60000
  const bj = new Date(utcMs + 8 * 3600000)
  const day = bj.getDay() // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return true
  const mins = bj.getHours() * 60 + bj.getMinutes()
  const isMorningPeak = mins >= 9 * 60 && mins < 12 * 60
  const isAfternoonPeak = mins >= 14 * 60 && mins < 18 * 60
  return !(isMorningPeak || isAfternoonPeak)
}

function zeroUsage() {
  return { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, totalTokens: 0 }
}

function addUsage(target, sample) {
  if (!sample) return target
  const uncached = Number(sample.inputTokens ?? sample.uncachedInputTokens ?? 0)
  const cacheRead = Number(sample.cacheReadTokens ?? 0)
  const cacheWrite = Number(sample.cacheWriteTokens ?? 0)
  const out = Number(sample.outputTokens ?? 0)
  target.uncachedInputTokens += uncached
  target.cacheReadTokens += cacheRead
  target.cacheWriteTokens += cacheWrite
  target.outputTokens += out
  target.totalTokens = target.uncachedInputTokens + target.cacheReadTokens + target.cacheWriteTokens + target.outputTokens
  return target
}

function enrichUsageWithCost(u) {
  const missM = (u.uncachedInputTokens + u.cacheWriteTokens) / 1e6
  const hitM = u.cacheReadTokens / 1e6
  const outM = u.outputTokens / 1e6
  const totalIn = u.uncachedInputTokens + u.cacheWriteTokens + u.cacheReadTokens
  const cacheHitRate = totalIn > 0 ? Number(((u.cacheReadTokens / totalIn) * 100).toFixed(1)) : 0
  const offPeak = isOffPeakBeijing()
  // Official DeepSeek-V4.1-Flash: Peak (2.00 / 0.04 / 8.00 CNY), Off-Peak 50% (1.00 / 0.02 / 4.00 CNY)
  const offPeakCNY = missM * 1.00 + hitM * 0.02 + outM * 4.00
  const peakCNY = missM * 2.00 + hitM * 0.04 + outM * 8.00
  const magpieCredits = missM * 57.7075 + hitM * 1.1507 + outM * 231.0054
  return {
    ...u,
    cacheHitRate,
    isOffPeak: offPeak,
    estimatedCostCNY: Number((offPeak ? offPeakCNY : peakCNY).toFixed(6)),
    offPeakCostCNY: Number(offPeakCNY.toFixed(6)),
    peakCostCNY: Number(peakCNY.toFixed(6)),
    magpieCredits: Number(magpieCredits.toFixed(4)),
  }
}

function resolveWorkdir(rawCwd) {
  let candidate = rawCwd && String(rawCwd).trim() ? String(rawCwd).trim() : process.cwd()
  // Avoid accidentally running inside the Antigravity IDE binary installation folder when cwd is omitted
  if (!rawCwd && /AppData[\\/]Local[\\/]Programs[\\/]antigravity/i.test(candidate)) {
    candidate = DEFAULT_WORKSPACE
  }
  return resolvePath(candidate)
}

function normalizeCwdKey(workdir) {
  const resolved = resolvePath(workdir)
  return process.platform === 'win32' ? resolved.replace(/\\/g, '/').toLowerCase() : resolved
}

const clampTmo = (ms) => (Number.isFinite(ms) && ms > 0 ? Math.min(MAX_TURN_TIMEOUT, Math.max(MIN_TURN_TIMEOUT, Math.floor(ms))) : TURN_TIMEOUT)
const clampWarn = (tmo, warnMs) => {
  let w = (Number.isFinite(warnMs) && warnMs > 0) ? Math.floor(warnMs) : WARN_TIMEOUT
  if (w >= tmo) w = Math.max(MIN_WARN, Math.floor(tmo * 0.4))
  return Math.max(MIN_WARN, Math.min(w, tmo - 2000))
}
const clampForce = (tmo, warn, forceMs) => {
  let f = (Number.isFinite(forceMs) && forceMs > 0) ? Math.floor(forceMs) : FORCE_TIMEOUT
  if (f <= warn) f = Math.max(warn + 1000, Math.floor((warn + tmo) / 2))
  return Math.min(f, tmo - 1000)
}
const log = (...a) => console.error('[dsh-deepseek-mcp]', ...a)

function extractEventUsage(ev) {
  if (!ev || (ev.type !== 'assistant/message' && ev.type !== 'assistant/attempt')) return null
  if (ev.data?.usage) return ev.data.usage
  const stream = ev.data?.stream
  if (Array.isArray(stream)) {
    for (let i = stream.length - 1; i >= 0; i--) {
      if (stream[i]?.type === 'usage' && stream[i]?.usage) return stream[i].usage
    }
  }
  return null
}

class SdkSession {
  constructor({ cwd, model, reasoningEffort = 'high', tools = true }) {
    this.cwd = cwd
    this.model = model
    this.tools = tools !== false
    this.reasoningEffort = VALID_EFFORTS.has(reasoningEffort) ? reasoningEffort : 'high'
    this.sessionId = 'sess-' + randomUUID()
    this.child = null; this.buf = ''; this.err = ''; this.nextId = 1
    this.pending = new Map(); this.sawRunning = false; this.doneResolve = null
    this.acc = ''; this.toolCalls = []; this.dead = false; this.lastStatus = 'new'
    this.lastActivityAt = Date.now()
    this.singleStepGate = false
    this.turnUsage = zeroUsage()
    this.totalUsage = zeroUsage()
    this._lastStepUsageKey = null
    this.lock = Promise.resolve()
  }
  async start() {
    const args = [DSH_BIN, '--profile', PROFILE]
    if (ISOLATE_WORKER && existsSync(CLEAN_PATCH)) args.push('--patch', CLEAN_PATCH)
    if (ISOLATE_WORKER && !this.tools && existsSync(PURE_PATCH)) args.push('--patch', PURE_PATCH)
    this.child = spawn(NODE_EXE, args, { cwd: this.cwd, env: process.env, windowsHide: true })
    this.child.stdout.on('data', (d) => this._onData(d))
    this.child.stderr.on('data', (d) => { this.err = (this.err + d.toString()).slice(-4000) })
    this.child.on('close', (code) => { this.dead = true; this._failAll(new Error(`sdk child closed code=${code} :: ${this.err.slice(-600)}`)) })
    this.child.on('error', (e) => { this.dead = true; this._failAll(e) })
    await this.request('initialize', { cwd: this.cwd, provider: 'magpie', model: this.model, reasoningEffort: this.reasoningEffort }, 45000)
    log('session started', this.sessionId, 'model=', this.model, 'effort=', this.reasoningEffort, 'tools=', this.tools, 'isolated=', ISOLATE_WORKER, 'cwd=', this.cwd)
  }
  _onData(d) {
    this.buf += d.toString(); let nl
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim(); this.buf = this.buf.slice(nl + 1)
      if (!line) continue
      let f; try { f = JSON.parse(line) } catch { continue }
      if (f.id !== undefined && this.pending.has(f.id)) {
        const { resolve, reject } = this.pending.get(f.id); this.pending.delete(f.id)
        if (f.error) reject(new Error(f.error.message || JSON.stringify(f.error))); else resolve(f.result)
      } else if (f.method) this._onNotif(f.method, f.params || {})
    }
  }
  _onNotif(method, p) {
    this.lastActivityAt = Date.now()
    if (method === 'session.status') {
      const st = String(p.status); this.lastStatus = st
      if (/running/i.test(st)) this.sawRunning = true
      else if (this.sawRunning && this.doneResolve && /idle|done|stop|complete|error|fail/i.test(st)) {
        const r = this.doneResolve; this.doneResolve = null; r(st)
      }
    } else if (method === 'session.event') {
      const ev = p.event || {}
      if (ev.type === 'assistant/message') {
        const content = ev.data?.message?.content
        if (Array.isArray(content)) {
          const t = content.filter((c) => c.type === 'text' && c.text).map((c) => c.text).join('\n')
          if (t) this.acc += t + '\n'
        }
      } else if (ev.type === 'tool/call') {
        this.toolCalls.push({ name: ev.data?.name, args: String(ev.data?.arguments ?? '').slice(0, 800) })
      }
      const u = extractEventUsage(ev)
      if (u) {
        const stepKey = `${ev.data?.turn ?? ''}:${ev.data?.step ?? ''}:${u.inputTokens ?? 0}:${u.outputTokens ?? 0}`
        if (stepKey !== this._lastStepUsageKey) {
          this._lastStepUsageKey = stepKey
          addUsage(this.turnUsage, u)
          addUsage(this.totalUsage, u)
        }
      }
      // Single-turn completion gate for `fast`/`craft` modes: once step 1 emits real text and ends without tool calls, resolve cleanly!
      if (this.singleStepGate && this.doneResolve && (ev.type === 'turn/end' || (ev.type === 'step/end' && this.acc.trim().length > 0 && this.toolCalls.length === 0))) {
        const r = this.doneResolve; this.doneResolve = null; r('idle')
      }
    }
  }
  _failAll(err) {
    for (const { reject } of this.pending.values()) reject(err)
    this.pending.clear()
    if (this.doneResolve) { const r = this.doneResolve; this.doneResolve = null; r('error') }
  }
  request(method, params, timeoutMs = TURN_TIMEOUT) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); const e = new Error('rpc timeout: ' + method); e.timedOut = true; reject(e) }, timeoutMs)
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v) }, reject: (e) => { clearTimeout(timer); reject(e) } })
      try { this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n') }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e) }
    })
  }
  steer(text) {
    return this.request('session/prompt', { sessionId: this.sessionId, contentBlocks: [{ type: 'text', text }] }, 15000).catch(() => {})
  }
  // run one turn with stream-aware stall watchdog + three-tier timer.
  runTurn(text, timeoutMs = TURN_TIMEOUT, hooks = {}) {
    const { warnMs, forceMs, stallTimeoutMs, singleStepGate, onWarn, onForce } = hooks
    const run = async () => {
      if (this.dead) throw new Error('session dead: ' + this.err.slice(-600))
      this.acc = ''; this.toolCalls = []; this.sawRunning = false
      this.singleStepGate = !!singleStepGate
      this.turnUsage = zeroUsage(); this._lastStepUsageKey = null
      const t0 = Date.now()
      this.lastActivityAt = t0
      const done = new Promise((res) => { this.doneResolve = res })
      let warnTimer = null, forceTimer = null, stallInterval = null, hardTimer = null
      const mins = (ms) => Math.round(ms / 60000 * 10) / 10
      if (warnMs && warnMs > 0 && warnMs < timeoutMs) {
        warnTimer = setTimeout(() => {
          try { onWarn?.() } catch {}
          this.steer(`【系统提醒】你已运行约 ${mins(warnMs)} 分钟，接近单轮上限（${mins(timeoutMs)} 分钟将强制结束）。请开始收敛，优先收尾，避免再开新的发散性探索。`)
        }, warnMs)
      }
      if (forceMs && forceMs > (warnMs || 0) && forceMs < timeoutMs) {
        forceTimer = setTimeout(() => {
          try { onForce?.() } catch {}
          this.steer(`【系统强制收尾】你已运行约 ${mins(forceMs)} 分钟，必须在本次回复内立刻给出最终结果：立即停止一切新的工具调用与探索，基于已获得的信息输出结论、改动摘要与验证情况；若确实未完成，明确列出已完成部分与遗留点。这是最后一次机会，随后将强制终止。`)
        }, forceMs)
      }
      await this.request('session/prompt', { sessionId: this.sessionId, contentBlocks: [{ type: 'text', text }] }, Math.min(timeoutMs, 30000))
      this.lastActivityAt = Date.now()
      const timeoutP = new Promise((_, rej) => {
        hardTimer = setTimeout(() => {
          const e = new Error('turn timeout after ' + timeoutMs + 'ms')
          e.timedOut = true; rej(e)
        }, timeoutMs)
        if (stallTimeoutMs && stallTimeoutMs > 0 && stallTimeoutMs < timeoutMs) {
          stallInterval = setInterval(() => {
            const idle = Date.now() - this.lastActivityAt
            if (idle >= stallTimeoutMs) {
              const e = new Error(`stall timeout after ${idle}ms without progress (limit ${stallTimeoutMs}ms)`)
              e.timedOut = true; e.stalled = true; rej(e)
            }
          }, 1500)
        }
      })
      let status
      try { status = await Promise.race([done, timeoutP]) }
      finally {
        this.singleStepGate = false
        clearTimeout(hardTimer)
        if (stallInterval) clearInterval(stallInterval)
        if (warnTimer) clearTimeout(warnTimer)
        if (forceTimer) clearTimeout(forceTimer)
      }
      return {
        answer: this.acc.trim(),
        toolCalls: this.toolCalls.slice(0, 50),
        status,
        elapsedMs: Date.now() - t0,
        usage: enrichUsageWithCost(this.turnUsage),
        sessionUsage: enrichUsageWithCost(this.totalUsage),
      }
    }
    const p = this.lock.then(run, run)
    this.lock = p.catch(() => {})
    return p
  }
  kill() {
    const pid = this.child?.pid
    try { this.child?.kill('SIGKILL') } catch {}
    if (process.platform === 'win32' && pid) {
      try {
        const tk = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        tk.unref()
      } catch {}
    }
  }
}

const pool = new Map()
function poolKey(sessionKey, tier, workdir, toolsGroup = 'pure') { return `${sessionKey}||${tier}||${toolsGroup}||${normalizeCwdKey(workdir)}` }
function evictLRU() {
  while (pool.size > POOL_MAX) {
    let oldestKey = null, oldest = Infinity
    for (const [k, v] of pool) if (!v.busy && v.lastUsed < oldest) { oldest = v.lastUsed; oldestKey = k }
    if (!oldestKey) break
    const v = pool.get(oldestKey); log('LRU evict', oldestKey); v.sess.kill(); pool.delete(oldestKey)
  }
}
setInterval(() => { const now = Date.now(); for (const [k, v] of pool) if (!v.busy && now - v.lastUsed > POOL_TTL) { log('TTL evict', k); v.sess.kill(); pool.delete(k) } }, 60000).unref()
function killAll() { for (const v of pool.values()) v.sess.kill(); pool.clear() }
process.on('exit', killAll)
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { killAll(); process.exit(0) })

function buildModeFooter(modeName, isReused) {
  if (modeName === 'fast') {
    return isReused
      ? `【精修/极速模式 (fast · KV缓存复用)】直接基于上轮上下文按要求精准修改或补充，严禁废话与多余重构，输出最终结果后立刻结束本轮回复。`
      : `【极速纯输出模式 (fast)】直接输出简洁、干净、可直接使用的最终代码或结果（建议控制在 150~250 行以内），零寒暄零冗余，输出完成后立刻结束回复。`
  }
  if (modeName === 'craft') {
    return isReused
      ? `【精工迭代模式 (craft · Pass-2 定点精修)】基于上轮已有成果，精准修复指出的每一处缺陷并拉升完成度，严格保持接口契约不变；保持思考简明扼要，直接输出完整升级后的最终代码后立刻结束本轮回复。`
      : `【精工纯输出模式 (craft · 速度×质量甜品档)】保持内部思考简明果断（避免反复纠结），把输出预算集中在真实的代码质量与细节密度上：严守给定接口契约，优先采用高完成度实现（如复杂绘制使用离屏缓存、完整边界处理与地道风格），一次性输出完整可运行的成品代码后立刻结束本轮回复，零废话。`
  }
  return `【自治代理模式 (agent)】聚焦给定任务边界执行检查、改动与验证；完成后用简洁中文说明你实际改了什么、如何验证的、有无遗留问题。`
}

async function pickFallbackModel(tierName, excludeModels) {
  const candidates = tierName === 'max' ? MAGPIE_MAX_ROUTES : MAGPIE_DIRECT_ROUTES
  const report = await inspectMagpieRoutes(candidates)
  const primary = report.eligible.filter((r) => r.dshPrimary !== false && !excludeModels.has(r.model))
  if (primary.length) return primary[0].model
  const any = report.eligible.filter((r) => !excludeModels.has(r.model))
  return any.length ? any[0].model : null
}

async function delegateOnce({ task, cwd, context, sessionKey, tier, mode, model: explicitModel, fresh, pureText, reasoningEffort, timeoutMs, warnMs, forceMs, stallTimeoutMs, onWarn, onForce }) {
  const tierName = TIERS[tier] ? tier : 'flash'
  const modeName = resolveMode(mode, pureText, reasoningEffort)
  const preset = MODE_PRESETS[modeName]
  const effort = VALID_EFFORTS.has(reasoningEffort) ? reasoningEffort : preset.defaultEffort
  const workdir = resolveWorkdir(cwd)
  const tmo = clampTmo(timeoutMs ?? preset.defaultTimeoutMs)
  const warn = preset.tools ? clampWarn(tmo, warnMs) : 0
  const force = preset.tools ? clampForce(tmo, warn, forceMs) : 0
  const stallMs = Number.isFinite(stallTimeoutMs) && stallTimeoutMs >= 5000 ? Math.min(tmo, Math.floor(stallTimeoutMs)) : Math.min(tmo, preset.defaultStallMs)
  const hooks = { warnMs: warn, forceMs: force, stallTimeoutMs: stallMs, singleStepGate: preset.singleStepGate, onWarn, onForce }
  const toolsGroup = preset.tools ? 'agent' : 'pure'

  // Reuse existing session's pinned direct route when continuing a multi-wave / Pass-2 sessionKey (for KV cache hit),
  // unless fresh=true or explicitModel differs. Otherwise pick a healthy direct Magpie route!
  const existingKey = sessionKey ? poolKey(sessionKey, tierName, workdir, toolsGroup) : null
  const existingRec = existingKey && !fresh ? pool.get(existingKey) : null
  let model = explicitModel && String(explicitModel).trim() ? String(explicitModel).trim() : null
  if (!model && existingRec && existingRec.turns < MAX_TURNS && !existingRec.sess.dead) {
    model = existingRec.sess.model
  }
  if (!model) {
    const plan = await planDirectRoutes(1, tierName)
    model = plan.models[0] || TIERS[tierName].model
  }

  const willReuse = !!(existingRec && !fresh && existingRec.turns < MAX_TURNS && !existingRec.sess.dead && (!explicitModel || existingRec.sess.model === model))
  const footer = buildModeFooter(modeName, willReuse)
  const text = [
    context ? `【上下文 / 来自上游大脑，供参考】\n${context}\n` : '',
    `【任务】\n${task}\n`,
    footer,
  ].filter(Boolean).join('\n')
  const base = {
    tier: tierName,
    mode: modeName,
    model,
    reasoningEffort: effort,
    cwd: workdir,
    tools: preset.tools,
    isolated: ISOLATE_WORKER,
    pureText: !preset.tools,
    stallTimeoutMs: stallMs,
    warnMs: warn,
    forceWrapMs: force,
    timeoutMs: tmo,
  }

  if (!sessionKey) {
    const s = new SdkSession({ cwd: workdir, model, reasoningEffort: effort, tools: preset.tools })
    try {
      await s.start()
      const r = await s.runTurn(text, tmo, hooks)
      const emptyReply = r.status !== 'error' && !r.answer && r.toolCalls.length === 0
      const ok = r.status !== 'error' && !emptyReply
      return {
        ok,
        ...(emptyReply ? { emptyReply: true, timedOut: false, stalled: false, error: 'empty reply from model (likely reasoning exhausted max_tokens or upstream truncation)' } : {}),
        key: null,
        sessionId: s.sessionId,
        reused: false,
        ...base,
        status: r.status,
        elapsedMs: r.elapsedMs,
        usage: r.usage,
        answer: r.answer,
        toolCalls: r.toolCalls,
      }
    } catch (e) {
      return { ok: false, timedOut: !!e.timedOut, stalled: !!e.stalled, key: null, sessionId: s.sessionId, reused: false, ...base, error: String(e) }
    } finally { s.kill() }
  }

  const key = existingKey
  let rec = pool.get(key); let reused = false
  if (rec && (fresh || rec.turns >= MAX_TURNS || rec.sess.dead || (explicitModel && rec.sess.model !== model))) {
    log('recycle', key, 'oldModel=', rec.sess.model, 'newModel=', model)
    rec.sess.kill(); pool.delete(key); rec = null
  }
  if (!rec) {
    const s = new SdkSession({ cwd: workdir, model, reasoningEffort: effort, tools: preset.tools })
    // Register `rec` with `busy: true` and `initPromise` synchronously BEFORE awaiting `s.start()`!
    rec = { sess: s, turns: 0, lastUsed: Date.now(), tier: tierName, mode: modeName, tools: preset.tools, cwd: workdir, busy: true, initPromise: null }
    pool.set(key, rec)
    evictLRU()
    rec.initPromise = s.start()
    try {
      await rec.initPromise
    } catch (e) {
      rec.sess.kill()
      pool.delete(key)
      return { ok: false, timedOut: false, stalled: false, key: sessionKey, reused: false, ...base, error: String(e) }
    } finally {
      rec.initPromise = null
    }
  } else {
    reused = true
    rec.busy = true
    rec.lastUsed = Date.now()
    if (rec.initPromise) {
      try { await rec.initPromise } catch (e) {
        return { ok: false, timedOut: false, stalled: false, key: sessionKey, reused: true, ...base, error: String(e) }
      }
    }
  }

  rec.busy = true; rec.lastUsed = Date.now()
  try {
    const r = await rec.sess.runTurn(text, tmo, hooks)
    const emptyReply = r.status !== 'error' && !r.answer && r.toolCalls.length === 0
    const ok = r.status !== 'error' && !emptyReply
    if (emptyReply) {
      const sid = rec.sess.sessionId
      try { rec.sess.kill() } catch {}
      pool.delete(key)
      return {
        ok: false,
        emptyReply: true,
        timedOut: false,
        stalled: false,
        key: sessionKey,
        sessionId: sid,
        reused,
        turns: rec.turns,
        ...base,
        status: r.status,
        elapsedMs: r.elapsedMs,
        usage: r.usage,
        sessionUsage: r.sessionUsage,
        answer: r.answer,
        toolCalls: r.toolCalls,
        error: 'empty reply from model (likely reasoning exhausted max_tokens or upstream truncation)',
      }
    }
    rec.turns++
    return {
      ok,
      key: sessionKey,
      sessionId: rec.sess.sessionId,
      reused,
      turns: rec.turns,
      ...base,
      status: r.status,
      elapsedMs: r.elapsedMs,
      usage: r.usage,
      sessionUsage: r.sessionUsage,
      answer: r.answer,
      toolCalls: r.toolCalls,
    }
  } catch (e) {
    try { rec.sess.kill() } catch {}; pool.delete(key)
    return { ok: false, timedOut: !!e.timedOut, stalled: !!e.stalled, key: sessionKey, sessionId: rec.sess.sessionId, reused, ...base, error: String(e) }
  } finally {
    rec.busy = false
    rec.lastUsed = Date.now()
    evictLRU()
  }
}

const isRetriableFailure = (r) => !!(r && (r.stalled || r.timedOut || r.emptyReply || /sdk child closed|rpc timeout|session dead|empty reply/i.test(String(r.error || ''))))

async function delegate(opts) {
  const autoFailover = opts.autoFailover !== false
  let res = await delegateOnce(opts)
  if (res.ok || !autoFailover || opts._pinnedByCaller || !isRetriableFailure(res)) return res

  const tierName = TIERS[opts.tier] ? opts.tier : 'flash'
  const tried = new Set([res.model])
  const failoverChain = []

  for (let hop = 0; hop < MAX_FAILOVERS; hop++) {
    const fallbackModel = await pickFallbackModel(tierName, tried)
    if (!fallbackModel) break
    log('auto-failover triggered:', res.model, '->', fallbackModel, 'reason=', res.error)
    failoverChain.push({
      model: res.model,
      error: res.error,
      stalled: !!res.stalled,
      emptyReply: !!res.emptyReply,
    })
    tried.add(fallbackModel)
    res = await delegateOnce({ ...opts, model: fallbackModel, fresh: true })
    if (res.ok || !isRetriableFailure(res)) break
  }

  if (!failoverChain.length) return res
  return { ...res, failoverFrom: failoverChain[failoverChain.length - 1], failoverChain }
}

// Run `fn` over items with a concurrency limit; preserves result order.
async function runWithLimit(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  const n = Math.max(1, Math.min(limit, items.length))
  async function worker() { while (true) { const idx = next++; if (idx >= items.length) return; results[idx] = await fn(items[idx], idx) } }
  await Promise.all(Array.from({ length: n }, () => worker()))
  return results
}

const server = new McpServer({ name: 'dsh-deepseek-worker', version: SERVER_VERSION })

server.tool('echo', '连通性自检：回显输入文本。', { text: z.string().describe('要回显的文本') },
  async ({ text }) => ({ content: [{ type: 'text', text: `收到: ${text} @ ${new Date().toISOString()}` }] }))

server.tool('worker_info', '返回 worker 配置、三档 mode、隔离补丁状态、Magpie 路线积分与会话池状态（排障用）。', {}, async () => {
  const routeReport = await inspectMagpieRoutes(MAGPIE_DIRECT_ROUTES, true)
  return {
    content: [{ type: 'text', text: JSON.stringify({
      version: SERVER_VERSION,
      profile: PROFILE,
      magpieGatewayUrl: resolveMagpieGateway().url || null,
      quotaSource: _quotaCache.source || null,
      workerIsolation: {
        enabled: ISOLATE_WORKER,
        cleanPatchExists: existsSync(CLEAN_PATCH),
        purePatchExists: existsSync(PURE_PATCH),
      },
      modes: MODE_PRESETS,
      defaultWorkspace: DEFAULT_WORKSPACE,
      defaultWarnMs: WARN_TIMEOUT, defaultForceWrapMs: FORCE_TIMEOUT, defaultTimeoutMs: TURN_TIMEOUT,
      minTurnTimeoutMs: MIN_TURN_TIMEOUT, maxTurnTimeoutMs: MAX_TURN_TIMEOUT,
      poolMax: POOL_MAX, parallelMax: PARALLEL_MAX, poolTtlMs: POOL_TTL, maxTurns: MAX_TURNS,
      tiers: Object.fromEntries(Object.entries(TIERS).map(([k, v]) => [k, { model: v.model, desc: v.desc }])),
      magpieRoutes: routeReport.evaluated.map((r) => ({
        provider: r.provider,
        model: r.model,
        eligible: r.eligible,
        healthyAccounts: r.healthyAccounts,
        skipReason: r.skipReason,
        accounts: r.accounts,
      })),
      quotaError: routeReport.quotaError,
      pool: [...pool.entries()].map(([k, v]) => ({
        key: k,
        mode: v.mode,
        tools: v.tools,
        model: v.sess.model,
        sessionId: v.sess.sessionId,
        turns: v.turns,
        busy: !!v.busy,
        idleMs: Date.now() - v.lastUsed,
        sessionUsage: enrichUsageWithCost(v.sess.totalUsage),
      })),
    }, null, 2) }],
  }
})

server.tool(
  'delegate_task',
  '【单一原子任务 / Pass-2 定点精修】将单个叶子任务或针对已有 sessionKey 的 KV 缓存定点精修交给 DeepSeek worker。推荐使用三档 mode：`fast`（极速纯输出/Pass-2 快速精修，10~25s）、`craft`（速度×质量甜品档：禁工具防死循环 + 深度思考 + 高完整度代码，40~90s）、`agent`（开启 shell/fs 工具用于真实排障测试，但仍物理隔离个人 AGENTS.md）。内置失速看门狗与自动故障转移。',
  {
    task: z.string().describe('要 DeepSeek worker 执行的自然语言任务（越具体越好）'),
    cwd: z.string().optional().describe('工作目录（绝对路径）；默认自动回退到工作区目录（Windows 路径大小写/斜杠自动归一化）'),
    context: z.string().optional().describe('可选：来自大脑的记忆/上下文，注入给 worker 参考'),
    sessionKey: z.string().optional().describe('会话键：相同 key 复用同一常驻会话与 KV 缓存（fast 与 craft 共享纯输出池，可直接 Pass-1 craft -> Pass-2 fast 精修）'),
    mode: z.enum(['fast', 'craft', 'agent']).optional().describe('执行档位：fast=极速纯输出；craft=精工纯输出甜品档（高思考+禁工具）；agent=带工具自治代理。省略时按 pureText 兼容推导'),
    tier: z.enum(['flash', 'max']).optional().describe('难度档：flash=便宜快(默认)；max=更强/1M上下文'),
    model: z.string().optional().describe('可选：显式指定 Magpie 独立路线模型 ID（省略则自动按积分挑选健康独立路线）'),
    pureText: z.boolean().optional().describe('兼容旧参数：为 true 且未指定 mode 时自动映射到 fast（low 思考）或 craft（high 思考）'),
    reasoningEffort: z.enum(['low', 'high', 'max']).optional().describe('思考深度：省略则按 mode 默认（fast=low, craft/agent=high）'),
    stallTimeoutMs: z.number().optional().describe('单步活动看门狗超时（毫秒；默认 fast=150s, craft/agent=240s），超时无进展即判失速并触发自动故障转移'),
    autoFailover: z.boolean().optional().describe('默认 true：遇失速/超时/空回复/子进程崩时自动切到健康 Magpie 路线重试（最多 2 次，显式传 model 时不覆盖）'),
    fresh: z.boolean().optional().describe('为 true 时强制重开会话（清空记忆）'),
    warnMs: z.number().optional().describe('agent 模式提醒阈值（毫秒），默认 900000=15 分钟'),
    forceMs: z.number().optional().describe('agent 模式强制收尾阈值（毫秒），默认 1500000=25 分钟'),
    timeoutMs: z.number().optional().describe('硬超时（毫秒）；省略则按 mode 默认（fast=180s, craft=300s, agent=1800s）'),
  },
  async ({ task, cwd, context, sessionKey, mode, tier, model, pureText, reasoningEffort, stallTimeoutMs, autoFailover, fresh, warnMs, forceMs, timeoutMs }, extra) => {
    const notify = (msg) => { try { extra?.sendNotification?.({ method: 'notifications/progress', params: { progressToken: extra?._meta?.progressToken, progress: 1, total: 1, message: msg } }) } catch {} }
    const onWarn = () => { log('WARN threshold: steering worker to converge'); notify('⚠ DeepSeek worker 接近单轮上限，正在提醒收敛收尾。') }
    const onForce = () => { log('FORCE threshold: commanding worker to output final result'); notify('⏰ DeepSeek worker 触发强制收尾命令。') }
    const payload = await delegate({
      task, cwd, context, sessionKey, mode, tier, model,
      _pinnedByCaller: !!(model && String(model).trim()),
      pureText, reasoningEffort, stallTimeoutMs, autoFailover, fresh, warnMs, forceMs, timeoutMs, onWarn, onForce,
    })
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] }
  },
)

server.tool(
  'delegate_parallel',
  '【中大型/多模块任务首选｜三档 mode + 多波次 + 失速故障转移】将大脑拆解出的 2~4 条独立叶子子任务并发外包给多个隔离型 DeepSeek worker（分散到不同健康 Magpie 独立路线 + 自动过滤低积分路线 + 统一返回全文与 KV 缓存命中率账单）。推荐常规复杂开发/视觉渲染使用 `mode: "craft"`（Pass-1 精工首稿，单轮每工人 1~2 单元）→ 大脑快验 → 对薄弱项复用同一 `sessionKey` 发 `mode: "fast"` 或 `"craft"` Pass-2 15 秒定点精修！',
  {
    tasks: z.array(z.object({
      task: z.string().describe('该子任务内容'),
      cwd: z.string().optional(),
      context: z.string().optional(),
      sessionKey: z.string().optional(),
      mode: z.enum(['fast', 'craft', 'agent']).optional().describe('执行档位：fast | craft(推荐精工甜品档) | agent'),
      tier: z.enum(['flash', 'max']).optional(),
      model: z.string().optional().describe('可选：显式指定 Magpie 独立路线（省略则自动分配不同健康独立路线）'),
      pureText: z.boolean().optional(),
      reasoningEffort: z.enum(['low', 'high', 'max']).optional(),
      stallTimeoutMs: z.number().optional(),
      autoFailover: z.boolean().optional(),
      fresh: z.boolean().optional(),
      warnMs: z.number().optional(),
      forceMs: z.number().optional(),
      timeoutMs: z.number().optional(),
    })).min(1).describe('子任务数组'),
    maxConcurrency: z.number().optional().describe('并发上限（默认 4，最大 16）'),
  },
  async ({ tasks, maxConcurrency }, extra) => {
    const limit = Math.max(1, Math.min(maxConcurrency || PARALLEL_MAX, 16))
    const t0 = Date.now()
    let done = 0

    // Pre-plan distinct Magpie direct routes (checking live remaining credits and skipping low-credit routes!)
    const flashPlan = await planDirectRoutes(tasks.length, 'flash')
    const maxPlan = tasks.some((t) => t.tier === 'max') ? await planDirectRoutes(tasks.length, 'max') : null
    const eligibleSet = new Set([
      ...flashPlan.report.eligible.map((r) => r.model),
      ...(maxPlan ? maxPlan.report.eligible.map((r) => r.model) : []),
    ])

    const plannedTasks = tasks.map((t, idx) => {
      const pinnedByCaller = !!(t.model && String(t.model).trim())
      if (pinnedByCaller) return { ...t, _pinnedByCaller: true }
      const tierName = TIERS[t.tier] ? t.tier : 'flash'
      const modeName = resolveMode(t.mode, t.pureText, t.reasoningEffort)
      const toolsGroup = MODE_PRESETS[modeName].tools ? 'agent' : 'pure'
      const workdir = resolveWorkdir(t.cwd)
      // If reusing a warm sessionKey across waves or Pass-2 polish AND its pinned route still has healthy credits, keep it for KV cache!
      if (t.sessionKey && !t.fresh) {
        const rec = pool.get(poolKey(t.sessionKey, tierName, workdir, toolsGroup))
        if (rec && !rec.sess.dead && rec.turns < MAX_TURNS && eligibleSet.has(rec.sess.model)) {
          return { ...t, model: rec.sess.model, _pinnedByCaller: false }
        }
      }
      const plan = tierName === 'max' && maxPlan ? maxPlan : flashPlan
      return { ...t, model: plan.models[idx], _pinnedByCaller: false }
    })

    log('delegate_parallel routePlan:', JSON.stringify(plannedTasks.map((t, i) => ({ idx: i, key: t.sessionKey || null, mode: resolveMode(t.mode, t.pureText, t.reasoningEffort), model: t.model }))))

    const results = await runWithLimit(plannedTasks, limit, async (t, idx) => {
      try {
        const r = await delegate({ ...t })
        done++
        try { extra?.sendNotification?.({ method: 'notifications/progress', params: { progressToken: extra?._meta?.progressToken, progress: done, total: tasks.length, message: `并行外包 ${done}/${tasks.length} 完成 (${r.model || t.model})` } }) } catch {}
        return { index: idx, ...r }
      } catch (e) {
        return { index: idx, ok: false, model: t.model, error: String(e) }
      }
    })
    const batchUsage = zeroUsage()
    for (const r of results) if (r?.usage) addUsage(batchUsage, r.usage)
    const summary = {
      count: results.length,
      ok: results.filter((r) => r.ok).length,
      failed: results.filter((r) => r && !r.ok && !r.timedOut).length,
      timedOut: results.filter((r) => r && r.timedOut).length,
      failovers: results.filter((r) => r && r.failoverFrom).length,
      maxConcurrency: limit,
      elapsedMs: Date.now() - t0,
      routePlan: plannedTasks.map((t, i) => ({ index: i, sessionKey: t.sessionKey || null, mode: resolveMode(t.mode, t.pureText, t.reasoningEffort), model: t.model })),
      skippedRoutes: flashPlan.report.evaluated.filter((r) => !r.eligible).map((r) => ({ provider: r.provider, model: r.model, skipReason: r.skipReason })),
      batchUsage: enrichUsageWithCost(batchUsage),
      results,
    }
    return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] }
  },
)

server.tool('pool_status', '查看会话池（哪些 key 常驻、mode、路线、多少轮、空闲多久、累计消耗与 KV 缓存命中率）。', {}, async () => ({
  content: [{ type: 'text', text: JSON.stringify([...pool.entries()].map(([k, v]) => ({
    key: k,
    mode: v.mode,
    tools: v.tools,
    model: v.sess.model,
    sessionId: v.sess.sessionId,
    turns: v.turns,
    busy: !!v.busy,
    idleMs: Date.now() - v.lastUsed,
    sessionUsage: enrichUsageWithCost(v.sess.totalUsage),
  })), null, 2) }],
}))

server.tool('reset_session', '丢弃会话池会话并清理进程树。传 sessionKey 只清该 key；不传清全部。', {
  sessionKey: z.string().optional().describe('要清理的 sessionKey；省略=清空全部'),
}, async ({ sessionKey }) => {
  let n = 0
  for (const [k, v] of [...pool.entries()]) if (!sessionKey || k.startsWith(sessionKey + '||')) { v.sess.kill(); pool.delete(k); n++ }
  return { content: [{ type: 'text', text: JSON.stringify({ cleared: n, remaining: pool.size }) }] }
})

// ---------------- dev self-tests ----------------
if (process.argv.includes('--selftest')) {
  const cwd = process.env.SELFTEST_CWD || process.cwd()
  const s = new SdkSession({ cwd, model: TIERS[process.env.SELFTEST_TIER === 'max' ? 'max' : 'flash'].model, reasoningEffort: 'low' })
  try {
    await s.start()
    const a = await s.runTurn('请记住这个数字：42。只回复「记住了」。')
    const b = await s.runTurn('我刚才让你记住的数字是多少？只回复那个数字。')
    const ok = /\b42\b/.test(b.answer)
    console.log('turn1=', JSON.stringify(a.answer), 'turn2=', JSON.stringify(b.answer), 'usage=', JSON.stringify(b.sessionUsage))
    console.log(ok ? 'REUSE_SELFTEST_PASS' : 'REUSE_SELFTEST_FAIL'); s.kill(); process.exit(ok ? 0 : 1)
  } catch (e) { console.error('SELFTEST ERROR', e); s.kill(); process.exit(1) }
} else if (process.argv.includes('--timeout-test')) {
  const cwd = process.env.SELFTEST_CWD || process.cwd()
  const s = new SdkSession({ cwd, model: TIERS.flash.model })
  try {
    await s.start(); const t0 = Date.now(); let timedOut = false
    try { await s.runTurn('请慢慢详尽地思考并写一篇 2000 字的技术长文，然后再总结。', 1200) } catch (e) { timedOut = !!e.timedOut }
    console.log('elapsedMs=', Date.now() - t0, 'timedOut=', timedOut)
    const ok = timedOut; console.log(ok ? 'TIMEOUT_TEST_PASS' : 'TIMEOUT_TEST_FAIL'); s.kill(); process.exit(ok ? 0 : 1)
  } catch (e) { console.error('TIMEOUT_TEST ERROR', e); s.kill(); process.exit(1) }
} else if (process.argv.includes('--ladder-test')) {
  const cwd = process.env.SELFTEST_CWD || process.cwd()
  const s = new SdkSession({ cwd, model: TIERS.flash.model })
  const t0 = Date.now(); let warnAt = null, forceAt = null, timedOut = false, finishedAt = null
  try {
    await s.start()
    const hooks = { warnMs: 3000, forceMs: 6000, onWarn: () => { warnAt = Date.now() - t0; console.log('WARN at ms=', warnAt) }, onForce: () => { forceAt = Date.now() - t0; console.log('FORCE at ms=', forceAt) } }
    try { const r = await s.runTurn('请慢慢详尽地思考并写一篇 3000 字的技术长文，再总结。', 25000, hooks); finishedAt = Date.now() - t0; console.log('finished at ms=', finishedAt, 'status=', r.status) }
    catch (e) { timedOut = !!e.timedOut; finishedAt = Date.now() - t0 }
    const ok = warnAt !== null && warnAt >= 2500 && warnAt <= 6000 && forceAt !== null && forceAt >= 5500 && forceAt <= 10000
    console.log('warnAt=', warnAt, 'forceAt=', forceAt, 'finishedAt=', finishedAt, 'timedOut=', timedOut)
    console.log(ok ? 'LADDER_TEST_PASS' : 'LADDER_TEST_FAIL'); s.kill(); process.exit(ok ? 0 : 1)
  } catch (e) { console.error('LADDER_TEST ERROR', e); s.kill(); process.exit(1) }
} else {
  await server.connect(new StdioServerTransport())
  log(`stdio MCP server ready v${SERVER_VERSION} (3-tier mode + worker isolation + stall failover); profile=`, PROFILE, 'isolated=', ISOLATE_WORKER, 'poolMax=', POOL_MAX, 'parallelMax=', PARALLEL_MAX)
}
