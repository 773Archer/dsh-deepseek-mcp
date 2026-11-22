// E2E MCP reuse test: same sessionKey remembers, different key isolated, no-key ephemeral.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const transport = new StdioClientTransport({ command: process.execPath, args: [join(here, 'server.mjs')], stderr: 'inherit' })
const client = new Client({ name: 'reuse-e2e', version: '1.0.0' }, { capabilities: {} })
await client.connect(transport)

async function call(args) {
  const r = await client.callTool({ name: 'delegate_task', arguments: args })
  return JSON.parse(r.content?.[0]?.text || '{}')
}

const cwd = process.cwd()
// conv-A: two turns, same key -> should reuse and remember 317.
const a1 = await call({ task: '请记住这个数字：317。只回复「记住了」。', cwd, sessionKey: 'conv-A' })
const a2 = await call({ task: '我刚才让你记住的数字是多少？只回复那个数字。', cwd, sessionKey: 'conv-A' })
// conv-B: different key -> must NOT know 317.
const b1 = await call({ task: '我刚才让你记住的数字是多少？如果你不知道就只回复「不知道」。', cwd, sessionKey: 'conv-B' })
// no key -> ephemeral.
const e1 = await call({ task: '我刚才让你记住的数字是多少？不知道就回复「不知道」。', cwd })

const st = JSON.parse((await client.callTool({ name: 'pool_status', arguments: {} })).content?.[0]?.text || '[]')

console.log('A1.reused=', a1.reused, 'ans=', JSON.stringify((a1.answer || '').slice(0, 30)))
console.log('A2.reused=', a2.reused, 'turns=', a2.turns, 'ans=', JSON.stringify((a2.answer || '').slice(0, 40)))
console.log('B1.reused=', b1.reused, 'ans=', JSON.stringify((b1.answer || '').slice(0, 40)))
console.log('E1.reused=', e1.reused, 'ans=', JSON.stringify((e1.answer || '').slice(0, 40)))
console.log('pool=', JSON.stringify(st))

const checks = {
  'A2 复用同一会话(reused=true)': a2.reused === true,
  'A2 记住 317': /\b317\b/.test(a2.answer || ''),
  'B1 新 key 隔离(不记得 317)': !/\b317\b/.test(b1.answer || ''),
  '无 key 一次性(reused=false)': e1.reused === false,
  '池里有 conv-A': st.some((x) => String(x.key).startsWith('conv-A||')),
}
let fail = 0
for (const [k, v] of Object.entries(checks)) { console.log((v ? 'PASS ' : 'FAIL ') + k); if (!v) fail++ }
console.log(fail === 0 ? 'REUSE_E2E_PASS' : `REUSE_E2E_FAIL(${fail})`)
try { await client.close() } catch {}
process.exit(fail === 0 ? 0 : 1)
