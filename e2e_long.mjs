// Verify delegate_parallel no longer truncates answers at 4000 chars.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
const here = dirname(fileURLToPath(import.meta.url))
const transport = new StdioClientTransport({ command: process.execPath, args: [join(here, 'server.mjs')], stderr: 'inherit' })
const client = new Client({ name: 'long-e2e', version: '1.0.0' }, { capabilities: {} })
await client.connect(transport)
const cwd = process.cwd()
const summary = await client.callTool({ name: 'delegate_parallel', arguments: {
  maxConcurrency: 2,
  tasks: [
    { task: '请逐行输出数字 1 到 1400，每行一个数字，不准省略、不准用省略号、不准总结、不准分段省略。必须从 1 连续写到 1400。', cwd, timeoutMs: 240000 },
    { task: '用 shell 执行命令 echo PAR_B_OK ，然后只回复 PAR_B_OK。', cwd, timeoutMs: 240000 },
  ],
} })
const s = JSON.parse(summary.content?.[0]?.text || '{}')
const a0 = s.results?.[0]?.answer || ''
const a1 = s.results?.[1]?.answer || ''
console.log('ok=', s.ok, 'failed=', s.failed, 'timedOut=', s.timedOut)
console.log('taskA answer length=', a0.length, 'contains 1400=', a0.includes('1400'))
console.log('taskB answer head=', JSON.stringify(a1.slice(0, 40)))
const ok = s.ok === 2 && a0.length > 4000 && a0.includes('1400')
console.log(ok ? 'LONG_PARALLEL_PASS (not truncated)' : 'LONG_PARALLEL_FAIL')
try { await client.close() } catch {}
process.exit(ok ? 0 : 1)
