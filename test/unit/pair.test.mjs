import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { publicEncrypt, constants } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { pair } from '../../plugins/actera/bin/pair.mjs'
import { loadConfig } from '../../plugins/actera/lib/bridge.mjs'

const home = await mkdtemp(join(tmpdir(), 'actera-pair-test-'))
process.env.ACTERA_CLAUDE_BRIDGE_HOME = home
after(async () => { delete process.env.ACTERA_CLAUDE_BRIDGE_HOME; await rm(home, { recursive: true, force: true }) })

test('browser pairing uses the bundled endpoint without URL input and keeps the key private', async (t) => {
  const code = 'a'.repeat(43)
  const apiKey = 'actera_' + 'k'.repeat(43)
  let publicKey
  let claimHash
  let redeemed = false
  let starts = 0
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = Buffer.concat(chunks).toString('utf8')
    response.setHeader('content-type', 'application/json')
    if (request.url === '/v1/agent-connections' && request.method === 'POST') {
      starts++; redeemed = false
      const start = JSON.parse(body)
      publicKey = start.public_key
      claimHash = start.claim_hash
      response.end(JSON.stringify({ code, browser_url: `http://localhost:${server.address().port}/connect-claude?code=${code}` }))
    } else if (request.url === `/v1/agent-connections/${code}/redeem`) {
      assert.equal(claimHash.length, 64)
      assert.equal(JSON.parse(body).claim.length, 43)
      assert.equal(redeemed, false)
      redeemed = true
      const ciphertext = publicEncrypt({ key: publicKey, oaepHash: 'sha256', oaepLabel: Buffer.from('actera-agent-connection-v1'), padding: constants.RSA_PKCS1_OAEP_PADDING }, Buffer.from(apiKey)).toString('base64url')
      response.end(JSON.stringify({ status: 'approved', ciphertext, agent_id: 'test-agent' }))
    } else if (request.url === '/v1/agents/test-agent/readiness') {
      assert.equal(request.headers.authorization, `Bearer ${apiKey}`)
      response.end(JSON.stringify({ agent_id: 'test-agent', status: 'DISCOVERED', ready: true, observation_ready: true }))
    } else {
      response.writeHead(404)
      response.end('{}')
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const origin = `http://127.0.0.1:${server.address().port}`
    const fetch = globalThis.fetch
    t.mock.method(globalThis, 'fetch', (url, options) => {
      const target = new URL(url)
      assert.equal(target.origin, 'http://localhost:8080')
      return fetch(`${origin}${target.pathname}${target.search}`, options)
    })
    let display
    const result = await pair(undefined, { open: () => {}, onWaiting: (value) => { display = value } })
    assert.deepEqual(result, { agentId: 'test-agent', baseUrl: 'http://localhost:8080', capture: 'tool-inputs' })
    assert.equal(display.codeHint, 'aaaaaaaa')
    assert.equal(JSON.stringify(display).includes(apiKey), false)
    const saved = JSON.parse(await readFile(join(home, 'config.json'), 'utf8'))
    assert.equal(saved.apiKey, apiKey)
    assert.equal(saved.agentId, 'test-agent')
    assert.equal(saved.baseUrl, 'http://localhost:8080')
    assert.equal(saved.mode, undefined)
    assert.equal(saved.onEvaluationError, undefined)
    await pair(undefined, { open: () => assert.fail('healthy connection reopened the browser') })
    assert.equal(starts, 1)
    const oldMode = process.env.CLAUDE_PLUGIN_OPTION_MODE
    const oldFailure = process.env.CLAUDE_PLUGIN_OPTION_EVALUATION_FAILURE
    process.env.CLAUDE_PLUGIN_OPTION_MODE = 'Enforcing'
    process.env.CLAUDE_PLUGIN_OPTION_EVALUATION_FAILURE = 'Allow tool calls (fail open)'
    t.after(() => {
      for (const [name, value] of [['CLAUDE_PLUGIN_OPTION_MODE', oldMode], ['CLAUDE_PLUGIN_OPTION_EVALUATION_FAILURE', oldFailure]]) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    })
    await pair(undefined, { reconnect: true, open: (url) => assert.equal(new URL(url).searchParams.get('agent'), 'test-agent') })
    assert.equal(starts, 2)
    const reconnected = await loadConfig()
    assert.equal(reconnected.mode, 'ENFORCING')
    assert.equal(reconnected.onEvaluationError, 'continue')
    const persisted = JSON.parse(await readFile(join(home, 'config.json'), 'utf8'))
    assert.equal(persisted.mode, undefined)
    assert.equal(persisted.onEvaluationError, undefined)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
