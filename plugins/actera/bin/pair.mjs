#!/usr/bin/env node
import { createHash, generateKeyPairSync, privateDecrypt, randomBytes, constants } from 'node:crypto'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { agentReadiness, loadConfig, provisionBridge } from '../lib/bridge.mjs'
import { DEFAULT_API_ORIGIN } from '../lib/defaults.mjs'

function apiOrigin(raw) {
  const url = new URL(raw)
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))))
    throw new Error('Enter an HTTPS Actera API origin (HTTP is allowed only on localhost).')
  return url.origin
}

function openBrowser(raw) {
  const url = new URL(raw)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    throw new Error('Actera returned an invalid browser URL')
  const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url.href] : [url.href]
  const child = spawn(command, args, { detached: true, stdio: 'ignore' })
  child.on('error', () => {})
  child.unref()
}

async function post(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(8000),
  })
  if (response.status !== 202 && !response.ok) throw new Error(`Actera connection returned HTTP ${response.status}`)
  return { status: response.status, body: await response.json() }
}

export async function pair(origin = process.env.ACTERA_API_ORIGIN || DEFAULT_API_ORIGIN, { capture, reconnect = false, open = openBrowser, maxWaitMs = 600_000, onWaiting = () => {} } = {}) {
  const baseUrl = apiOrigin(origin)
  const existing = await loadConfig()
  capture ??= existing?.baseUrl === baseUrl ? existing.capture : 'tool-inputs'
  if (!['metadata', 'tool-inputs'].includes(capture)) throw new Error('Invalid capture mode')
  if (existing?.baseUrl === baseUrl && !reconnect) {
    // Re-running connect for a healthy identity is a status check, not a new grant.
    try { await agentReadiness(existing) } catch (error) { throw new Error(`${error.message}. Run connect again with --reconnect to replace access for agent ${existing.agentId}.`) }
    return { agentId: existing.agentId, baseUrl, capture: existing.capture }
  }
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } })
  const claim = randomBytes(32).toString('base64url')
  const claimHash = createHash('sha256').update(claim).digest('hex')
  const started = await post(`${baseUrl}/v1/agent-connections`, { claim_hash: claimHash, public_key: publicKey })
  const { code, browser_url: browserUrl } = started.body
  if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(code) || typeof browserUrl !== 'string')
    throw new Error('Actera returned an invalid connection request')
  const destination = new URL(browserUrl)
  if (destination.searchParams.get('code') !== code) throw new Error('Actera returned a mismatched connection URL')
  if (reconnect && existing?.baseUrl === baseUrl) destination.searchParams.set('agent', existing.agentId)
  onWaiting({ codeHint: code.slice(0, 8), browserUrl: destination.href })
  open(destination.href)
  const deadline = Date.now() + maxWaitMs
  while (Date.now() < deadline) {
    await delay(2000)
    const result = await post(`${baseUrl}/v1/agent-connections/${code}/redeem`, { claim })
    if (result.status === 202) continue
    const { ciphertext, agent_id: agentId } = result.body
    if (result.body.status !== 'approved' || typeof ciphertext !== 'string' || typeof agentId !== 'string')
      throw new Error('Actera returned an invalid connection approval')
    const apiKey = privateDecrypt({ key: privateKey, oaepHash: 'sha256', oaepLabel: Buffer.from('actera-agent-connection-v1'), padding: constants.RSA_PKCS1_OAEP_PADDING }, Buffer.from(ciphertext, 'base64url')).toString('utf8')
    await agentReadiness({ baseUrl, agentId, apiKey })
    const configured = await provisionBridge({ baseUrl, agentId, capture, apiKey })
    return {
      agentId, baseUrl, capture,
      ...(configured.archivedEvents ? {
        archivedEvents: configured.archivedEvents,
        archivePath: configured.archivePath,
      } : {}),
    }
  }
  throw new Error('The connection expired. Run /actera:connect again.')
}

const setupFailures = {
  400: 'That is not an Actera setup code.',
  404: 'Actera does not recognize that setup code.',
  409: 'The agent for that setup code is no longer available. Get a new code from Actera.',
  410: 'That setup code was already used or has expired. Get a new code from Actera.',
  429: 'Too many setup attempts. Try again in a moment.',
}

// A setup code from Actera connects to the agent an administrator made it for,
// so it needs no browser approval.
export async function connectWithSetupCode(code, origin = process.env.ACTERA_API_ORIGIN || DEFAULT_API_ORIGIN, { capture } = {}) {
  const baseUrl = apiOrigin(origin)
  const existing = await loadConfig()
  capture ??= existing?.baseUrl === baseUrl ? existing.capture : 'tool-inputs'
  if (!['metadata', 'tool-inputs'].includes(capture)) throw new Error('Invalid capture mode')
  const response = await fetch(`${baseUrl}/v1/agent-setup-codes/redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: String(code).trim() }),
    redirect: 'error',
    signal: AbortSignal.timeout(8000),
  })
  if (!response.ok) throw new Error(setupFailures[response.status] ?? `Actera setup returned HTTP ${response.status}`)
  const { api_key: apiKey, agent_id: agentId } = await response.json()
  if (typeof apiKey !== 'string' || typeof agentId !== 'string') throw new Error('Actera returned an invalid setup response')
  const configured = await provisionBridge({ baseUrl, agentId, capture, apiKey })
  return {
    agentId, baseUrl, capture,
    ...(configured.archivedEvents ? {
      archivedEvents: configured.archivedEvents,
      archivePath: configured.archivePath,
    } : {}),
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const setupCode = args[0] === '--setup-code' && args.length === 2 ? args[1] : undefined
  if (setupCode === undefined && (args.some((arg) => arg !== '--reconnect') || args.length > 1)) {
    process.stderr.write('Usage: pair.mjs [--reconnect | --setup-code <code>]. The Actera API endpoint is bundled with the plugin.\n')
    process.exitCode = 1
  } else await (setupCode !== undefined ? connectWithSetupCode(setupCode) : pair(undefined, {
    reconnect: process.argv.includes('--reconnect'),
    onWaiting: ({ codeHint, browserUrl }) => process.stdout.write(`Confirm code ${codeHint} in the Actera browser page.\nIf it did not open, visit: ${browserUrl}\nWaiting for an administrator to approve the connection…\n`),
  })).then(({ agentId, baseUrl, archivedEvents, archivePath }) => {
    process.stdout.write(`Actera is connected to agent ${agentId}.\n`)
    if (process.env.ACTERA_API_ORIGIN) process.stdout.write(`Using the ACTERA_API_ORIGIN override: ${baseUrl}\n`)
    if (archivedEvents) process.stdout.write(`Preserved ${archivedEvents} undelivered events from the previous connection in ${archivePath}.\n`)
  }).catch((error) => {
    process.stderr.write(`Actera connection: ${error.message}\n`)
    process.exitCode = 1
  })
}
