// Verify the SDK worker can itself spawn a sub-agent (dsh-base subagent tool).
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
const here = dirname(fileURLToPath(import.meta.url))
const transport = new StdioClientTransport({ command: process.execPath, args: [join(here, 'server.mjs')], stderr: 'inherit' })
const client = new Client({ name: 'subagent-probe', version: '1.0.0' }, { capabilities: {} })
await client.connect(transport)
const cwd = process.cwd()
const task = [
  '这是一个能力自检：请使用你的 subagent（子代理）工具派一个子代理去干活。',
  '步骤：调用 subagent 工具（provider 用默认 spawn），prompt 设为「用 shell 工具执行命令 echo SUBAGENT_KID_OK_777 ，然后只回复它打印的 stdout」。',
  '等子代理返回后，把它返回的内容原样贴出来，并明确说明是否包含 SUBAGENT_KID_OK_777。',
].join('\n')
const t0 = Date.now()
const r = await client.callTool({ name: 'delegate_task', arguments: { task, cwd, timeoutMs: 180000 } })
const p = JSON.parse(r.content?.[0]?.text || '{}')
const calls = (p.toolCalls || []).map((c) => c.name)
console.log('elapsedMs=', Date.now() - t0, 'ok=', p.ok, 'status=', p.status)
console.log('toolCalls=', JSON.stringify(calls))
console.log('answerHead=', JSON.stringify((p.answer || '').slice(0, 500)))
const usedSubagent = calls.some((n) => String(n).includes('subagent'))
const gotMarker = (p.answer || '').includes('SUBAGENT_KID_OK_777')
console.log('usedSubagent=', usedSubagent, 'gotMarker=', gotMarker)
const ok = (usedSubagent || gotMarker) && p.ok
console.log(ok ? 'SUBAGENT_PROBE_PASS' : 'SUBAGENT_PROBE_FAIL')
try { await client.close() } catch {}
process.exit(ok ? 0 : 1)
