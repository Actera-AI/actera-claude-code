import { stopDelivery } from '../../plugins/actera/vendor/agent-hooks/src/core/delivery.mjs'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { configure, status } from '../../plugins/actera/vendor/agent-hooks/src/hosts/claude-code/bridge.mjs'
import { stopScanner } from '../../plugins/actera/vendor/agent-hooks/src/core/scanner-client.mjs'
import { isolatedClaudeSettings } from './claude-settings.mjs'

// Real Claude settings loading, hooks and tool dispatch, with a controlled local
// service for failures. The separate live suite covers the real Actera backend.
const root = fileURLToPath(new URL('../../', import.meta.url))
const directory = path.join(root, '.dev', 'native-settings', randomUUID())
await mkdir(directory, { recursive: true })
const fixture = path.join(directory, 'read-fixture.txt')
await writeFile(fixture, 'Actera native settings verification.\n')
const cases = [
  ['monitoring-closed-outage', 'Monitoring', 'Block tool calls (fail closed)', 'outage', true],
  ['monitoring-open-outage', 'Monitoring', 'Allow tool calls (fail open)', 'outage', true],
  ['enforcing-closed-outage', 'Enforcing', 'Block tool calls (fail closed)', 'outage', false],
  ['enforcing-open-outage', 'Enforcing', 'Allow tool calls (fail open)', 'outage', true],
  ['enforcing-open-block', 'Enforcing', 'Allow tool calls (fail open)', 'block', false],
  ['enforcing-open-invalid', 'Enforcing', 'Allow tool calls (fail open)', 'invalid', true],
  ['enforcing-closed-invalid', 'Enforcing', 'Block tool calls (fail closed)', 'invalid', false],
]
const evidence = []
for (const [name, mode, failure, responseKind, shouldDispatch] of cases) {
  const caseDirectory = path.join(directory, name)
  const home = path.join(caseDirectory, 'bridge')
  const requests = []
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    requests.push({ path: request.url, body: body ? JSON.parse(body) : undefined })
    response.setHeader('content-type', 'application/json')
    response.statusCode = responseKind === 'outage' ? 503 : 200
    response.end(JSON.stringify(responseKind === 'block'
      ? { id: randomUUID(), status: 'BLOCKED', effect: 'BLOCK', explanation: 'Native settings test denies this read.' }
      : {}))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  // The first scenario also proves a fresh install uses the manifest defaults.
  const settings = await isolatedClaudeSettings(caseDirectory, name === 'monitoring-closed-outage' ? {} : { mode, evaluation_failure: failure })
  let dispatched = 0
  let attempted = 0
  let completed = false
  try {
    await configure({ baseUrl: `http://127.0.0.1:${server.address().port}`, agentId: 'settings-test', apiKey: `actera_${'x'.repeat(40)}`, capture: 'metadata' }, home)
    const env = { ...process.env, ...settings.env, ACTERA_CLAUDE_BRIDGE_HOME: home }
    // Only Claude's user settings may supply these values in this test.
    delete env.CLAUDE_PLUGIN_OPTION_MODE
    delete env.CLAUDE_PLUGIN_OPTION_EVALUATION_FAILURE
    const stream = query({
      prompt: `This is an integration test. Make exactly one Read call for ${fixture}. If denied, report that and stop. Do not retry, use another tool, or work around a denial.`,
      options: {
        cwd: caseDirectory, tools: ['Read'], settingSources: ['user'],
        plugins: [{ type: 'local', path: path.join(root, 'plugins/actera') }],
        strictMcpConfig: true, mcpServers: {}, env,
        permissionMode: 'default', maxTurns: 3, maxBudgetUsd: 1,
        canUseTool: async (_name, input) => ({ behavior: 'allow', updatedInput: input }),
        hooks: { PostToolUse: [{ matcher: 'Read', hooks: [async () => { dispatched++; return {} }] }] },
        ...(process.env.ACTERA_E2E_CLAUDE_EXECUTABLE ? { pathToClaudeCodeExecutable: process.env.ACTERA_E2E_CLAUDE_EXECUTABLE } : {}),
      },
    })
    for await (const message of stream) {
      if (message.type === 'assistant') attempted += message.message.content.filter(part => part.type === 'tool_use' && part.name === 'Read').length
      if (message.type === 'result') { assert.equal(message.is_error, false, message.subtype); completed = true }
    }
    assert.ok(completed, 'Claude must finish the scenario')
    assert.equal(attempted, 1, 'Claude must attempt exactly one Read')
    assert.equal(dispatched, shouldDispatch ? 1 : 0, `${name}: actual tool dispatch`)
    const evaluations = requests.filter(request => request.path === '/v1/decisions')
    assert.ok(evaluations.length > 0, 'The installed hook must contact the service')
    assert.ok(evaluations.every(request => request.body.mode === mode.toUpperCase()), 'Claude must deliver the selected mode to the hook')
    const bridgeStatus = await status(home)
    if (responseKind !== 'block') assert.ok(bridgeStatus.lastError, 'Failures must remain visible in status')
    evidence.push({ name, attempted, dispatched, mode, failure, errorRecorded: !!bridgeStatus.lastError })
    console.log(JSON.stringify({ stage: 'passed', ...evidence.at(-1) }))
  } finally {
    await stopDelivery(home)
    await settings.cleanup()
    await stopScanner(path.join(home, 'scanner')).catch(() => {})
    await new Promise(resolve => server.close(resolve))
  }
}
await writeFile(path.join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2))
console.log(JSON.stringify({ stage: 'all-settings-passed', evidence: path.join(directory, 'evidence.json') }))
