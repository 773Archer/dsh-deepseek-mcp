// Parallel dispatch E2E: compare 3 sequential delegate_task vs 3-task delegate_parallel.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
const here = dirname(fileURLToPath(import.meta.url))
const transport = new StdioClientTransport({ command: process.execPath, args: [join(here, 'server.mjs')], stderr: 'inherit' })
const client = new Client({ name: 'parallel-e2e', version: '1.0.0' }, { capabilities: {} })
await client.connect(transport)

async function callTool(name, args) {
  const r = await client.callTool({ name, arguments: args })
  return JSON.parse(r.content?.[0]?.text || '{}')
}
const cwd = process.cwd()
const N = 3
const task = (i) => `用 shell 工具执行命令：Start-Sleep -Seconds 4 （PowerShell 的睡眠）。执行完只回复 "DONE_${i}"，不要做别的。`

const tools = (await client.listTools()).tools.map((t) => t.name)
console.log('tools=', JSON.stringify(tools))

// Baseline: sequential 3 calls (different keys)
let t = Date.now()
for (let i = 0; i < N; i++) await callTool('delegate_task', { task: task(i), cwd, sessionKey: `base-${i}` })
const Ts = Date.now() - t
console.log('sequential elapsedMs=', Ts)

// Parallel: one delegate_parallel with 3 tasks (different keys), concurrency 3
t = Date.now()
const summary = await callTool('delegate_parallel', { tasks: Array.from({ length: N }, (_, i) => ({ task: task(i), cwd, sessionKey: `par-${i}` })), maxConcurrency: 3 })
const Tp = Date.now() - t
console.log('parallel elapsedMs=', Tp, 'summary.ok=', summary.ok, 'failed=', summary.failed, 'timedOut=', summary.timedOut, 'serverElapsed=', summary.elapsedMs)
console.log('answers=', JSON.stringify((summary.results || []).map((r) => (r.answer || '').slice(0, 20))))

const checks = {
  'has delegate_parallel tool': tools.includes('delegate_parallel'),
  'parallel all ok': summary.ok === N,
  'parallel faster than sequential (<85%)': Tp < Ts * 0.85,
}
let fail = 0
for (const [k, v] of Object.entries(checks)) { console.log((v ? 'PASS ' : 'FAIL ') + k); if (!v) fail++ }
console.log(`speedup x${(Ts / Tp).toFixed(2)}`)
console.log(fail === 0 ? 'PARALLEL_E2E_PASS' : `PARALLEL_E2E_FAIL(${fail})`)
try { await client.close() } catch {}
process.exit(fail === 0 ? 0 : 1)
