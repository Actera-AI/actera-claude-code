import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from '../../plugins/actera/hooks/register.js'

const id = '52865aae-b114-49db-9f3b-5870744603d8'

function preToolUseHook() {
  const hooks = {}
  register((event, hook) => {
    hooks[event] = hook
    return { catch() {} }
  })
  return hooks['classic.PreToolUse']
}

// The mod test kit stands in for the engine beneath the plugin, so the context a
// PreToolUse result hands Claude is checked on the hook's own answer.
test('Claude is told that a held call was approved before it ran', async () => {
  const $ = {
    plugin: { root: '/plugin' },
    ui: { ask: async () => "I've approved it in Actera" },
    process: {
      run: async (argv) =>
        argv.includes('link-status')
          ? { exitCode: 0, stdout: '{"linked":false}', stderr: '' }
          : { exitCode: 0, stdout: JSON.stringify({ id, status: 'APPROVED' }), stderr: '' },
    },
  }
  const next = async () => ({ deny: `Actera decision ${id} is awaiting approval. Approve it in Actera, then retry this exact tool call.` })
  const result = await preToolUseHook()($, { tool: 'Bash', tool_use_id: 'toolu_1', command: 'ls' }, next)
  assert.deepEqual(result, {
    allow: true,
    additionalContext: [`Actera held this tool call for approval, then released it. Actera Decision ${id} was approved in Actera.`],
  })
})
