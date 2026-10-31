import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { userConfig } from '../../plugins/actera/vendor/agent-hooks/src/hosts/claude-code/settings.mjs'
import { checkVendored } from '../../scripts/vendor-agent-hooks.mjs'

const json = async (name) => JSON.parse(await readFile(new URL('../../plugins/actera/' + name, import.meta.url), 'utf8'))

test('a failed command hook does not block Claude tool calls', async () => {
  const manifest = await json('hooks/hooks.json')
  const hooks = manifest.hooks.PreToolUse.flatMap((entry) => entry.hooks)
  assert.ok(hooks.length > 0)
  assert.ok(hooks.every((hook) => hook.type === 'command' && hook.onFailure !== 'block'))
})

test('the plugin offers exactly the settings the vendored adapter reads', async () => {
  assert.deepEqual((await json('.claude-plugin/plugin.json')).userConfig, JSON.parse(JSON.stringify(userConfig)))
})

test('the vendored agent-hooks files match the lock', () => {
  checkVendored()
})
