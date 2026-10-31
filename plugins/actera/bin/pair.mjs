#!/usr/bin/env node
// Pairing lives in the vendored agent-hooks package; this binds it to Claude Code.
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { bridgeHome } from '../vendor/agent-hooks/src/hosts/claude-code/bridge.mjs'
import { connectWithSetupCode as connectHost, pair as pairHost } from '../vendor/agent-hooks/src/core/pairing.mjs'

export const pair = (options = {}) => pairHost({ client: 'claude_code', home: bridgeHome(), ...options })
export const connectWithSetupCode = (code, options = {}) => connectHost({ client: 'claude_code', home: bridgeHome(), code, ...options })

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const setupCode = args[0] === '--setup-code' && args.length === 2 ? args[1] : undefined
  if (setupCode === undefined && (args.some((arg) => arg !== '--reconnect') || args.length > 1)) {
    process.stderr.write('Usage: pair.mjs [--reconnect | --setup-code <code>]. The Actera API endpoint is bundled with the plugin.\n')
    process.exitCode = 1
  } else await (setupCode !== undefined ? connectWithSetupCode(setupCode) : pair({
    reconnect: args.includes('--reconnect'),
    onWaiting: ({ codeHint, browserUrl }) => process.stdout.write(`Confirm code ${codeHint} in the Actera browser page.\nIf it did not open, visit: ${browserUrl}\nWaiting for an administrator to approve the connection…\n`),
  })).then(({ agentId, baseUrl, alreadyConnected, archivedEvents, archivePath }) => {
    process.stdout.write(`${alreadyConnected ? 'Actera was already connected' : 'Actera is connected'} to agent ${agentId}.\n`)
    if (process.env.ACTERA_API_ORIGIN) process.stdout.write(`Using the ACTERA_API_ORIGIN override: ${baseUrl}\n`)
    if (archivedEvents) process.stdout.write(`Preserved ${archivedEvents} undelivered events from the previous connection in ${archivePath}.\n`)
  }).catch((error) => {
    process.stderr.write(`Actera connection: ${error.message}\n`)
    process.exitCode = 1
  })
}
