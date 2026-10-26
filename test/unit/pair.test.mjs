import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { publicEncrypt, constants } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { connectWithSetupCode, pair } from '../../plugins/actera/bin/pair.mjs'
import { loadConfig } from '../../plugins/actera/vendor/agent-hooks/src/hosts/claude-code/bridge.mjs'

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
      assert.equal(start.client, 'claude_code', 'Actera labels the connection as Claude Code')
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
    const mockedFetch = t.mock.method(globalThis, 'fetch', (url, options) => {
      const target = new URL(url)
      assert.equal(target.origin, 'https://app.actera.dev')
      return fetch(`${origin}${target.pathname}${target.search}`, options)
    })
    let display
    const result = await pair({ open: () => {}, onWaiting: (value) => { display = value } })
    assert.deepEqual(result, { agentId: 'test-agent', baseUrl: 'https://app.actera.dev', capture: 'tool-inputs' })
    assert.equal(display.codeHint, 'aaaaaaaa')
    assert.equal(JSON.stringify(display).includes(apiKey), false)
    const saved = JSON.parse(await readFile(join(home, 'config.json'), 'utf8'))
    assert.equal(saved.apiKey, apiKey)
    assert.equal(saved.agentId, 'test-agent')
    assert.equal(saved.baseUrl, 'https://app.actera.dev')
    assert.equal(saved.mode, undefined)
    assert.equal(saved.onEvaluationError, undefined)
    await pair({ open: () => assert.fail('healthy connection reopened the browser') })
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
    await pair({ reconnect: true, open: (url) => assert.equal(new URL(url).searchParams.get('agent'), 'test-agent') })
    assert.equal(starts, 2)
    const reconnected = await loadConfig()
    assert.equal(reconnected.mode, 'ENFORCING')
    assert.equal(reconnected.onEvaluationError, 'continue')
    const persisted = JSON.parse(await readFile(join(home, 'config.json'), 'utf8'))
    assert.equal(persisted.mode, undefined)
    assert.equal(persisted.onEvaluationError, undefined)

    // Contributors point pairing at another service with ACTERA_API_ORIGIN. It is
    // validated like any origin and recorded as the connection's baseUrl.
    mockedFetch.mock.restore()
    const oldOrigin = process.env.ACTERA_API_ORIGIN
    t.after(() => {
      if (oldOrigin === undefined) delete process.env.ACTERA_API_ORIGIN
      else process.env.ACTERA_API_ORIGIN = oldOrigin
    })
    process.env.ACTERA_API_ORIGIN = 'http://example.com'
    await assert.rejects(pair({ open: () => {} }), /HTTPS/)
    process.env.ACTERA_API_ORIGIN = origin
    const overridden = await pair({ open: () => {} })
    assert.equal(overridden.baseUrl, origin)
    assert.equal(starts, 3)
    assert.equal(JSON.parse(await readFile(join(home, 'config.json'), 'utf8')).baseUrl, origin)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('a setup code connects to the agent it was made for without a browser', async () => {
  const apiKey = 'actera_' + 's'.repeat(43)
  const codes = new Map([['ABCD-EFGH-JKMN-PQRS', 'fresh'], ['USED-USED-USED-USED', 'used']])
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    response.setHeader('content-type', 'application/json')
    if (request.url === '/v1/agent-setup-codes/redeem' && request.method === 'POST') {
      const { code, client } = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      assert.equal(client, 'claude_code')
      const state = codes.get(code)
      if (state === 'fresh') {
        codes.set(code, 'used')
        response.end(JSON.stringify({ api_key: apiKey, agent_id: 'setup-agent', workspace_id: 'w', expires_at: 'x' }))
      } else {
        response.writeHead(state === 'used' ? 410 : 404)
        response.end('{}')
      }
    } else if (request.url === '/v1/agents/setup-agent/readiness') {
      assert.equal(request.headers.authorization, `Bearer ${apiKey}`)
      response.end(JSON.stringify({ agent_id: 'setup-agent', status: 'DISCOVERED', ready: true, observation_ready: true }))
    } else {
      response.writeHead(404)
      response.end('{}')
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const origin = `http://127.0.0.1:${server.address().port}`
    await assert.rejects(connectWithSetupCode('USED-USED-USED-USED', { origin }), /already used or has expired/)
    await assert.rejects(connectWithSetupCode('NOPE-NOPE-NOPE-NOPE', { origin }), /does not recognize/)
    const result = await connectWithSetupCode(' ABCD-EFGH-JKMN-PQRS ', { origin })
    assert.deepEqual(result, { agentId: 'setup-agent', baseUrl: origin, capture: 'tool-inputs' })
    const saved = JSON.parse(await readFile(join(home, 'config.json'), 'utf8'))
    assert.equal(saved.apiKey, apiKey)
    assert.equal(saved.agentId, 'setup-agent')
    assert.equal(saved.baseUrl, origin)
    await assert.rejects(connectWithSetupCode('ABCD-EFGH-JKMN-PQRS', { origin }), /already used/)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
