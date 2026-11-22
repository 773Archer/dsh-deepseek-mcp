// E2E stdio MCP test: spawn server.mjs as a real MCP server, then initialize/listTools/callTool.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(here, 'server.mjs')],
  stderr: 'inherit',
})
const client = new Client({ name: 'e2e-test', version: '1.0.0' }, { capabilities: {} })
await client.connect(transport)
console.log('connected. serverVersion=', client.getServerVersion?.())

const tools = await client.listTools()
console.log('tools=', tools.tools.map((t) => t.name))

const echo = await client.callTool({ name: 'echo', arguments: { text: 'hi-e2e' } })
console.log('echo ->', echo.content?.[0]?.text)

const info = await client.callTool({ name: 'worker_info', arguments: {} })
console.log('worker_info ->', info.content?.[0]?.text)

const marker = 'MCP_E2E_OK_' + Date.now()
const d = await client.callTool({
  name: 'delegate_task',
  arguments: { task: `Use your shell tool to run: echo ${marker} ; then report exact stdout.`, cwd: process.cwd() },
})
const payload = JSON.parse(d.content?.[0]?.text || '{}')
console.log('delegate_task.ok=', payload.ok, 'exitCode=', payload.exitCode)
console.log('delegate_task.answer=', (payload.answer || '').slice(0, 400))
const worked = payload.ok && ((payload.answer || '').includes(marker))
console.log(worked ? 'E2E_PASS' : 'E2E_FAIL')
try { await client.close() } catch {}
process.exit(worked ? 0 : 1)
