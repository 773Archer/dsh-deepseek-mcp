// MCP-level wall-clock timeout test: expect {ok:false, timedOut:true} for a 1.5s cap on a long task.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
const here = dirname(fileURLToPath(import.meta.url))
const transport = new StdioClientTransport({ command: process.execPath, args: [join(here, 'server.mjs')], stderr: 'inherit' })
const client = new Client({ name: 'timeout-e2e', version: '1.0.0' }, { capabilities: {} })
await client.connect(transport)
const t0 = Date.now()
const r = await client.callTool({ name: 'delegate_task', arguments: {
  task: '请慢慢非常详尽地思考并写一篇 3000 字长文，再总结要点。', cwd: process.cwd(), timeoutMs: 1500,
} })
const dt = Date.now() - t0
const p = JSON.parse(r.content?.[0]?.text || '{}')
console.log('elapsedMs=', dt, 'ok=', p.ok, 'timedOut=', p.timedOut, 'timeoutMs=', p.timeoutMs, 'err=', p.error)
const ok = p.ok === false && p.timedOut === true && dt < 120000
console.log(ok ? 'MCP_TIMEOUT_PASS' : 'MCP_TIMEOUT_FAIL')
try { await client.close() } catch {}
process.exit(ok ? 0 : 1)
