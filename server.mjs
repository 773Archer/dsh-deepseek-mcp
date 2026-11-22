#!/usr/bin/env node
// Stdio MCP server (v2.5.0): persistent-session DeepSeek worker pool for an MCP client (Antigravity).
// Backed by DSH's official SDK JSON-RPC server (`dsh --profile sdk`).
//
// Key features & v2.5.0 upgrades:
//   - Race-free session pool: `busy: true` and `initPromise` are registered synchronously before `await s.start()`,
//     fixing the self-eviction bug when concurrency > POOL_MAX and preventing duplicate orphan processes on same-key races.
//   - Deferred LRU eviction: `evictLRU()` runs both on creation and in `finally` after `rec.busy = false`.
//   - Windows path normalization & safe default CWD: `D:\agy` and `d:/agy` share the same pool key; avoids falling back to IDE binary dir.
//   - Windows process-tree cleanup: `taskkill /PID <pid> /T /F` kills child PowerShell / headless browser processes on timeout or eviction.
//   - Real-time Token & Cost accounting: extracts `usage` from `assistant/message` stream events and reports `usage`, `costCNY`, `elapsedMs`.
//   - `pureText` mode & `reasoningEffort` ('low' | 'high' | 'max'): prevents unnecessary tool-call loops on pure generation tasks.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { resolve as resolvePath, join as joinPath } from 'node:path'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'

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

const TIERS = {
  flash: { model: 'auto/deepseek-v4.1-flash', desc: '便宜快，适合简单/叶子任务（默认）' },
  max: { model: 'trae-cn/deepseek-v4.1-flash-max', desc: '更强、1M 上下文，适合偏重但仍可独立完成的子任务' },
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
  const offPeak = isOffPeakBeijing()
  // Official DeepSeek-V4.1-Flash: Peak (2.00 / 0.04 / 8.00 CNY), Off-Peak 50% (1.00 / 0.02 / 4.00 CNY)
  const offPeakCNY = missM * 1.00 + hitM * 0.02 + outM * 4.00
  const peakCNY = missM * 2.00 + hitM * 0.04 + outM * 8.00
  const magpieCredits = missM * 57.7075 + hitM * 1.1507 + outM * 231.0054
  return {
    ...u,
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
  constructor({ cwd, model, reasoningEffort = 'high' }) {
    this.cwd = cwd
    this.model = model
    this.reasoningEffort = VALID_EFFORTS.has(reasoningEffort) ? reasoningEffort : 'high'
    this.sessionId = 'sess-' + randomUUID()
    this.child = null; this.buf = ''; this.err = ''; this.nextId = 1
    this.pending = new Map(); this.sawRunning = false; this.doneResolve = null
    this.acc = ''; this.toolCalls = []; this.dead = false; this.lastStatus = 'new'
    this.turnUsage = zeroUsage()
    this.totalUsage = zeroUsage()
    this._lastStepUsageKey = null
    this.lock = Promise.resolve()
  }
  async start() {
    this.child = spawn(NODE_EXE, [DSH_BIN, '--profile', PROFILE], { cwd: this.cwd, env: process.env, windowsHide: true })
    this.child.stdout.on('data', (d) => this._onData(d))
    this.child.stderr.on('data', (d) => { this.err = (this.err + d.toString()).slice(-4000) })
    this.child.on('close', (code) => { this.dead = true; this._failAll(new Error(`sdk child closed code=${code} :: ${this.err.slice(-600)}`)) })
    this.child.on('error', (e) => { this.dead = true; this._failAll(e) })
    await this.request('initialize', { cwd: this.cwd, provider: 'magpie', model: this.model, reasoningEffort: this.reasoningEffort })
    log('session started', this.sessionId, 'model=', this.model, 'effort=', this.reasoningEffort, 'cwd=', this.cwd)
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
  // run one turn with three-tier timer.
  runTurn(text, timeoutMs = TURN_TIMEOUT, hooks = {}) {
    const { warnMs, forceMs, onWarn, onForce } = hooks
    const run = async () => {
      if (this.dead) throw new Error('session dead: ' + this.err.slice(-600))
      this.acc = ''; this.toolCalls = []; this.sawRunning = false
      this.turnUsage = zeroUsage(); this._lastStepUsageKey = null
      const t0 = Date.now()
      const done = new Promise((res) => { this.doneResolve = res })
      let warnTimer = null, forceTimer = null
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
      await this.request('session/prompt', { sessionId: this.sessionId, contentBlocks: [{ type: 'text', text }] }, timeoutMs)
      let hardTimer
      const timeoutP = new Promise((_, rej) => { hardTimer = setTimeout(() => { const e = new Error('turn timeout after ' + timeoutMs + 'ms'); e.timedOut = true; rej(e) }, timeoutMs) })
      let status
      try { status = await Promise.race([done, timeoutP]) }
      finally { clearTimeout(hardTimer); if (warnTimer) clearTimeout(warnTimer); if (forceTimer) clearTimeout(forceTimer) }
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
function poolKey(sessionKey, tier, workdir) { return `${sessionKey}||${tier}||${normalizeCwdKey(workdir)}` }
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

async function delegate({ task, cwd, context, sessionKey, tier, fresh, pureText, reasoningEffort, timeoutMs, warnMs, forceMs, onWarn, onForce }) {
  const tierName = TIERS[tier] ? tier : 'flash'
  const model = TIERS[tierName].model
  const effort = VALID_EFFORTS.has(reasoningEffort) ? reasoningEffort : 'high'
  const workdir = resolveWorkdir(cwd)
  const tmo = clampTmo(timeoutMs)
  const warn = clampWarn(tmo, warnMs)
  const force = clampForce(tmo, warn, forceMs)
  const hooks = { warnMs: warn, forceMs: force, onWarn, onForce }
  const footer = pureText
    ? `【纯文本/纯代码快速模式】本次任务严禁调用任何本地工具（禁止执行 pwsh/bash/read/write/edit/glob 等任何命令），不要读取或搜索磁盘文件，请直接输出最终结果或完整代码！`
    : `【完成后】用简洁中文说明你实际做了什么；若执行了命令/改了文件，说明改了什么、如何验证的、有无遗留问题。`
  const text = [
    context ? `【上下文 / 来自上游大脑，供参考】\n${context}\n` : '',
    `【任务】\n${task}\n`,
    footer,
  ].filter(Boolean).join('\n')
  const base = { tier: tierName, model, reasoningEffort: effort, cwd: workdir, pureText: !!pureText, warnMs: warn, forceWrapMs: force, timeoutMs: tmo }

  if (!sessionKey) {
    const s = new SdkSession({ cwd: workdir, model, reasoningEffort: effort })
    try {
      await s.start()
      const r = await s.runTurn(text, tmo, hooks)
      return { ok: r.status !== 'error', key: null, sessionId: s.sessionId, reused: false, ...base, status: r.status, elapsedMs: r.elapsedMs, usage: r.usage, answer: r.answer, toolCalls: r.toolCalls }
    } catch (e) {
      return { ok: false, timedOut: !!e.timedOut, key: null, sessionId: s.sessionId, reused: false, ...base, error: String(e) }
    } finally { s.kill() }
  }

  const key = poolKey(sessionKey, tierName, workdir)
  let rec = pool.get(key); let reused = false
  if (rec && (fresh || rec.turns >= MAX_TURNS)) { log('recycle', key); rec.sess.kill(); pool.delete(key); rec = null }
  if (!rec) {
    const s = new SdkSession({ cwd: workdir, model, reasoningEffort: effort })
    // Register `rec` with `busy: true` and `initPromise` synchronously BEFORE awaiting `s.start()`!
    // This prevents both self-eviction in `evictLRU()` and duplicate process creation on concurrent same-key calls.
    rec = { sess: s, turns: 0, lastUsed: Date.now(), tier: tierName, cwd: workdir, busy: true, initPromise: null }
    pool.set(key, rec)
    evictLRU()
    rec.initPromise = s.start()
    try {
      await rec.initPromise
    } catch (e) {
      rec.sess.kill()
      pool.delete(key)
      return { ok: false, timedOut: false, key: sessionKey, reused: false, ...base, error: String(e) }
    } finally {
      rec.initPromise = null
    }
  } else {
    reused = true
    rec.busy = true
    rec.lastUsed = Date.now()
    if (rec.initPromise) {
      try { await rec.initPromise } catch (e) {
        return { ok: false, timedOut: false, key: sessionKey, reused: true, ...base, error: String(e) }
      }
    }
  }

  rec.busy = true; rec.lastUsed = Date.now()
  try {
    const r = await rec.sess.runTurn(text, tmo, hooks)
    rec.turns++
    return {
      ok: r.status !== 'error',
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
    return { ok: false, timedOut: !!e.timedOut, key: sessionKey, sessionId: rec.sess.sessionId, reused, ...base, error: String(e) }
  } finally {
    rec.busy = false
    rec.lastUsed = Date.now()
    evictLRU()
  }
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

const server = new McpServer({ name: 'dsh-deepseek-worker', version: '2.5.0' })

server.tool('echo', '连通性自检：回显输入文本。', { text: z.string().describe('要回显的文本') },
  async ({ text }) => ({ content: [{ type: 'text', text: `收到: ${text} @ ${new Date().toISOString()}` }] }))

server.tool('worker_info', '返回 worker 配置、难度档、三级计时与会话池状态（排障用）。', {}, async () => ({
  content: [{ type: 'text', text: JSON.stringify({
    version: '2.5.0',
    profile: PROFILE, defaultWorkspace: DEFAULT_WORKSPACE,
    defaultWarnMs: WARN_TIMEOUT, defaultForceWrapMs: FORCE_TIMEOUT, defaultTimeoutMs: TURN_TIMEOUT,
    minTurnTimeoutMs: MIN_TURN_TIMEOUT, maxTurnTimeoutMs: MAX_TURN_TIMEOUT,
    poolMax: POOL_MAX, parallelMax: PARALLEL_MAX, poolTtlMs: POOL_TTL, maxTurns: MAX_TURNS,
    tiers: Object.fromEntries(Object.entries(TIERS).map(([k, v]) => [k, { model: v.model, desc: v.desc }])),
    pool: [...pool.entries()].map(([k, v]) => ({
      key: k,
      sessionId: v.sess.sessionId,
      turns: v.turns,
      busy: !!v.busy,
      idleMs: Date.now() - v.lastUsed,
      sessionUsage: enrichUsageWithCost(v.sess.totalUsage),
    })),
  }, null, 2) }],
}))

server.tool(
  'delegate_task',
  '【仅限单一原子级叶子任务！严禁整包甩锅】把不可再拆的单个原子子任务交给 DeepSeek worker（同步返回，附带实时 Token 消耗与人民币费用估算）。警告：若用户任务预计产出 >120 行代码或包含 ≥2 个独立模块/组件/场景/文件，绝对禁止将整个任务原样塞进单次 delegate_task，必须先由你（大脑）设计接口契约并拆成 2~4 个互不重叠的子任务改调 delegate_parallel 并发外包！纯文本/代码片段生成可传 pureText:true 禁用本地工具自检以大幅提速。',
  {
    task: z.string().describe('要 DeepSeek worker 执行的自然语言任务（越具体越好）'),
    cwd: z.string().optional().describe('工作目录（绝对路径）；默认自动回退到工作区目录（Windows 路径大小写/斜杠自动归一化）'),
    context: z.string().optional().describe('可选：来自大脑的记忆/上下文，注入给 worker 参考'),
    sessionKey: z.string().optional().describe('会话键：相同 key 复用同一常驻会话；省略=一次性全新会话'),
    tier: z.enum(['flash', 'max']).optional().describe('难度档：flash=便宜快(默认)；max=更强/1M上下文'),
    pureText: z.boolean().optional().describe('为 true 时开启纯文本/纯代码快速模式（禁止 worker 调用本地 shell/文件工具，直接生成结果，防过度自检耗时）'),
    reasoningEffort: z.enum(['low', 'high', 'max']).optional().describe('思考深度：low=极速浅思考；high=深度思考(默认)；max=极限思考'),
    fresh: z.boolean().optional().describe('为 true 时强制重开会话（清空记忆）'),
    warnMs: z.number().optional().describe('提醒阈值（毫秒），默认 900000=15 分钟'),
    forceMs: z.number().optional().describe('强制收尾阈值（毫秒），默认 1500000=25 分钟'),
    timeoutMs: z.number().optional().describe('硬超时（毫秒），默认 1800000=30 分钟；范围 10s~2h'),
  },
  async ({ task, cwd, context, sessionKey, tier, pureText, reasoningEffort, fresh, warnMs, forceMs, timeoutMs }, extra) => {
    const notify = (msg) => { try { extra?.sendNotification?.({ method: 'notifications/progress', params: { progressToken: extra?._meta?.progressToken, progress: 1, total: 1, message: msg } }) } catch {} }
    const onWarn = () => { log('WARN 15m threshold: steering worker to converge'); notify('⚠ DeepSeek worker 已运行约 15 分钟，正在提醒其收敛收尾（25 分钟将强制收尾，30 分钟强制结束）。') }
    const onForce = () => { log('FORCE 25m threshold: commanding worker to output final result'); notify('⏰ DeepSeek worker 已运行约 25 分钟，已下达强制收尾命令（30 分钟将强制结束）。') }
    const payload = await delegate({ task, cwd, context, sessionKey, tier, pureText, reasoningEffort, fresh, warnMs, forceMs, timeoutMs, onWarn, onForce })
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] }
  },
)

server.tool(
  'delegate_parallel',
  '【中大型/多模块任务首选｜严禁单次过载】将大脑拆解出的 2~4 条独立叶子子任务一次性并发外包给多个 DeepSeek worker（服务端真并行 + 统一返回全文及汇总 Token 账单）。⚠️ 超大型任务（>4 个单元/地图/场景/模块）严禁把多个单元打包塞给同一个 worker，也严禁在单次 delegate_parallel 中塞入超过 4 个重任务导致集体超时！每个子任务单轮最多只允许生成 1~2 个场景/模块（≤350 行代码），当总单元数 N > 4（例如 20 个地图）时，必须拆成多次（Multi-Wave）delegate_parallel 分波次滚动调用（每波 4 个并发任务，跨波次复用 worker-1~worker-4 的 sessionKey 以命中 98% KV 缓存）！同一波次内要并行执行的子任务必须传不同的 sessionKey；纯代码/SVG 片段生成建议设 pureText:true。',
  {
    tasks: z.array(z.object({
      task: z.string().describe('该子任务内容'),
      cwd: z.string().optional(),
      context: z.string().optional(),
      sessionKey: z.string().optional(),
      tier: z.enum(['flash', 'max']).optional(),
      pureText: z.boolean().optional(),
      reasoningEffort: z.enum(['low', 'high', 'max']).optional(),
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
    const results = await runWithLimit(tasks, limit, async (t, idx) => {
      try {
        const r = await delegate({ ...t })
        done++
        try { extra?.sendNotification?.({ method: 'notifications/progress', params: { progressToken: extra?._meta?.progressToken, progress: done, total: tasks.length, message: `并行外包 ${done}/${tasks.length} 完成` } }) } catch {}
        return { index: idx, ...r }
      } catch (e) {
        return { index: idx, ok: false, error: String(e) }
      }
    })
    const batchUsage = zeroUsage()
    for (const r of results) if (r?.usage) addUsage(batchUsage, r.usage)
    const summary = {
      count: results.length,
      ok: results.filter((r) => r.ok).length,
      failed: results.filter((r) => r && !r.ok && !r.timedOut).length,
      timedOut: results.filter((r) => r && r.timedOut).length,
      maxConcurrency: limit,
      elapsedMs: Date.now() - t0,
      batchUsage: enrichUsageWithCost(batchUsage),
      results,
    }
    return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] }
  },
)

server.tool('pool_status', '查看会话池（哪些 key 常驻、多少轮、空闲多久、累计消耗多少 Token 与费用）。', {}, async () => ({
  content: [{ type: 'text', text: JSON.stringify([...pool.entries()].map(([k, v]) => ({
    key: k,
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
  log('stdio MCP server ready v2.5.0; profile=', PROFILE, 'poolMax=', POOL_MAX, 'parallelMax=', PARALLEL_MAX, 'warn=', WARN_TIMEOUT, 'force=', FORCE_TIMEOUT, 'timeout=', TURN_TIMEOUT)
}
