import { expect, test } from 'claude-code/testing'

const id = '52865aae-b114-49db-9f3b-5870744603d8'
const publish = 'mcp__catalog__publish_item'

// Each tool.check mock is scoped to the tool under test. The review prompt
// ($.ui.ask) is an AskUserQuestion tool call that runs the permission check
// as well, and an unscoped deny would swallow that prompt.

test('linked approval releases the same held Claude tool call', async ($, on) => {
  on('tool.check', { tool: publish }, () => ({
    decision: 'deny',
    reason: `PreToolUse:mcp__catalog__publish_item hook error: Actera decision ${id} is awaiting approval. Approve it in Actera, then retry this exact tool call.`,
  }))
  on('tool.call', ($, e) => ({ result: { answers: { [e.questions[0].question]: 'Allow once' } } }))
  on('process.run', ($, e) => {
    if (e.argv.includes('link-status')) return { value: { exitCode: 0, stdout: '{"linked":true}', stderr: '' } }
    expect(e.argv.slice(-4)).toEqual(['--decision-id', id, '--choice', 'approve'])
    return { value: { exitCode: 0, stdout: JSON.stringify({ id, status: 'APPROVED' }), stderr: '' } }
  })
  const result = await $.tool.check({ tool: publish, input: { channel: 'demo', text: 'hi' } })
  expect(result.decision).toBe('allow')
})

test('other denials are never overridden by Actera native review', async ($, on) => {
  on('tool.check', { tool: 'Bash' }, () => ({ decision: 'deny', reason: 'Managed rule denied the call' }))
  const result = await $.tool.check({ tool: 'Bash', input: { command: 'echo test' } })
  expect(result.decision).toBe('deny')
  expect(result.reason).toBe('Managed rule denied the call')
})

test('an ineligible linked reviewer leaves the tool call denied', async ($, on) => {
  on('tool.check', { tool: publish }, () => ({ decision: 'deny', reason: `Actera decision ${id} is awaiting approval.` }))
  on('tool.call', ($, e) => ({ result: { answers: { [e.questions[0].question]: 'Allow once' } } }))
  on('process.run', ($, e) =>
    e.argv.includes('link-status')
      ? { value: { exitCode: 0, stdout: '{"linked":true}', stderr: '' } }
      : { value: { exitCode: 1, stdout: '', stderr: 'Actera approve returned HTTP 403' } },
  )
  const result = await $.tool.check({ tool: publish, input: { channel: 'demo', text: 'hi' } })
  expect(result.decision).toBe('deny')
  expect(result.reason).toMatch('HTTP 403')
})

test('unlinked reviewer is prompted to link before approving the held call', async ($, on) => {
  on('tool.check', { tool: publish }, () => ({ decision: 'deny', reason: `Actera decision ${id} is awaiting approval.` }))
  let linked = false
  on('tool.call', ($, e) => {
    const question = e.questions[0].question
    const answer = question.includes('link Claude Code')
      ? 'Link account'
      : question.includes('Finish linking')
        ? "I've linked my account"
        : 'Allow once'
    if (answer === "I've linked my account") linked = true
    return { result: { answers: { [question]: answer } } }
  })
  on('process.run', ($, e) => {
    if (e.argv.includes('link-status'))
      return { value: { exitCode: 0, stdout: JSON.stringify({ linked }), stderr: '' } }
    if (e.argv.includes('link')) {
      expect(e.argv.slice(-3)).toEqual(['link', '--json', '--open'])
      return {
        value: {
          exitCode: 0,
          stdout: JSON.stringify({ browserUrl: 'http://localhost:8080/auth/reviewer-link?code=test' }),
          stderr: '',
        },
      }
    }
    expect(e.argv.slice(-4)).toEqual(['--decision-id', id, '--choice', 'approve'])
    return { value: { exitCode: 0, stdout: JSON.stringify({ id, status: 'APPROVED' }), stderr: '' } }
  })
  const result = await $.tool.check({ tool: publish, input: { channel: 'demo', text: 'hi' } })
  expect(result.decision).toBe('allow')
})

test('a prefixed denial for a different tool is not overridden', async ($, on) => {
  on('tool.check', { tool: publish }, () => ({
    decision: 'deny',
    reason: `PreToolUse:mcp__other__send hook error: Actera decision ${id} is awaiting approval.`,
  }))
  const result = await $.tool.check({ tool: publish, input: {} })
  expect(result.decision).toBe('deny')
})

test('native review uses a readable action and input preview without internal identifiers', async ($, on) => {
  const tool = 'mcp__2652758a-3362-40ec-859f-69ec8c910d3c__send_message'
  on('tool.check', { tool }, () => ({ decision: 'deny', reason: `Actera decision ${id} is awaiting approval.` }))
  let asked = false
  on('tool.call', ($, e) => {
    asked = true
    const question = e.questions[0].question
    expect(question).toMatch('Allow Claude to send message?')
    expect(question).toMatch('Message: Hello again!')
    expect(question).toMatch('Channel ID: C123')
    expect(question).toMatch('API key: (hidden)')
    expect(question).not.toMatch('mcp__')
    expect(question).not.toMatch(id)
    expect(question).not.toMatch('{"')
    expect(e.questions[0].options.map((option) => option.label)).toEqual(['Allow once', 'Deny'])
    return { result: { answers: { [question]: 'Deny' } } }
  })
  on('process.run', ($, e) =>
    e.argv.includes('link-status')
      ? { value: { exitCode: 0, stdout: '{"linked":true}', stderr: '' } }
      : { value: { exitCode: 0, stdout: JSON.stringify({ id, status: 'REJECTED' }), stderr: '' } },
  )
  const result = await $.tool.check({ tool, input: { channel_id: 'C123', message: 'Hello again!', api_key: 'private' } })
  expect(asked).toBe(true)
  expect(result.decision).toBe('deny')
  expect(result.reason).toMatch('was rejected in Claude Code')
})

test('provider-prefixed MCP operations read as actions instead of raw tool identifiers', async ($, on) => {
  const tool = 'mcp__2652758a-3362-40ec-859f-69ec8c910d3c__slack_send_message'
  on('tool.check', { tool }, () => ({ decision: 'deny', reason: `Actera decision ${id} is awaiting approval.` }))
  let asked = false
  on('tool.call', ($, e) => {
    asked = true
    expect(e.questions[0].question).toMatch('Allow Claude to send message via Slack?')
    return { result: { answers: { [e.questions[0].question]: 'Not now' } } }
  })
  on('process.run', ($, e) => {
    if (e.argv.includes('review-status'))
      return { value: { exitCode: 0, stdout: JSON.stringify({ id, status: 'PENDING_APPROVAL' }), stderr: '' } }
    expect(e.argv).toContain('link-status')
    return { value: { exitCode: 0, stdout: '{"linked":true}', stderr: '' } }
  })
  const result = await $.tool.check({ tool, input: { channel_id: 'C123', message: 'Hello again!' } })
  expect(asked).toBe(true)
  expect(result.decision).toBe('deny')
  expect(result.reason).toBe(`Actera decision ${id} is awaiting approval.`)
})

function reviewedElsewhere(status: string, linked = false) {
  const calls: string[][] = []
  const run = ($, e) => {
    calls.push(e.argv)
    if (e.argv.includes('link-status')) return { value: { exitCode: 0, stdout: JSON.stringify({ linked }), stderr: '' } }
    if (e.argv.includes('review-status')) {
      expect(e.argv.slice(-2)).toEqual(['--decision-id', id])
      return { value: { exitCode: 0, stdout: JSON.stringify({ id, status }), stderr: '' } }
    }
    throw new Error(`Unexpected bridge command ${e.argv.join(' ')}`)
  }
  return { calls, run }
}

test('an approval made in Actera while the link prompt is open releases the held call', async ($, on) => {
  on('tool.check', { tool: publish }, () => ({ decision: 'deny', reason: `Actera decision ${id} is awaiting approval.` }))
  on('tool.call', ($, e) => {
    expect(e.questions[0].options.map((option) => option.label)).toEqual(['Link account', "I've approved it in Actera", 'Not now'])
    return { result: { answers: { [e.questions[0].question]: 'Not now' } } }
  })
  const bridge = reviewedElsewhere('APPROVED')
  on('process.run', bridge.run)
  const result = await $.tool.check({ tool: publish, input: { channel: 'demo', text: 'hi' } })
  expect(result.decision).toBe('allow')
  expect(bridge.calls.some((argv) => argv.includes('native-review'))).toBe(false)
})

test('a rejection made in Actera denies the held call with that reason', async ($, on) => {
  on('tool.check', { tool: publish }, () => ({ decision: 'deny', reason: `Actera decision ${id} is awaiting approval.` }))
  on('tool.call', ($, e) => ({ result: { answers: { [e.questions[0].question]: "I've approved it in Actera" } } }))
  on('process.run', reviewedElsewhere('REJECTED').run)
  const result = await $.tool.check({ tool: publish, input: { channel: 'demo', text: 'hi' } })
  expect(result.decision).toBe('deny')
  expect(result.reason).toBe(`Actera Decision ${id} was rejected in Actera.`)
})

test('a linked reviewer who closes the prompt still releases a call approved in Actera', async ($, on) => {
  on('tool.check', { tool: publish }, () => ({ decision: 'deny', reason: `Actera decision ${id} is awaiting approval.` }))
  on('tool.call', ($, e) => ({ result: { answers: {} } }))
  on('process.run', reviewedElsewhere('APPROVED', true).run)
  const result = await $.tool.check({ tool: publish, input: { channel: 'demo', text: 'hi' } })
  expect(result.decision).toBe('allow')
})

test('an explicit Deny in Claude is not replaced by a status lookup', async ($, on) => {
  on('tool.check', { tool: publish }, () => ({ decision: 'deny', reason: `Actera decision ${id} is awaiting approval.` }))
  on('tool.call', ($, e) => ({ result: { answers: { [e.questions[0].question]: 'Deny' } } }))
  const calls: string[][] = []
  on('process.run', ($, e) => {
    calls.push(e.argv)
    return e.argv.includes('link-status')
      ? { value: { exitCode: 0, stdout: '{"linked":true}', stderr: '' } }
      : { value: { exitCode: 0, stdout: JSON.stringify({ id, status: 'REJECTED' }), stderr: '' } }
  })
  const result = await $.tool.check({ tool: publish, input: { channel: 'demo', text: 'hi' } })
  expect(result.decision).toBe('deny')
  expect(result.reason).toMatch('was rejected in Claude Code')
  expect(calls.some((argv) => argv.includes('review-status'))).toBe(false)
})

test('a held call approved in Actera runs through the PreToolUse hook', async ($, on) => {
  on('classic.PreToolUse', { tool: publish }, () => ({
    deny: `Actera decision ${id} is awaiting approval. Approve it in Actera, then retry this exact tool call.`,
  }))
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => ({
    result: { answers: { [e.questions[0].question]: "I've approved it in Actera" } },
  }))
  let ran = false
  on('tool.call', { tool: publish }, () => {
    ran = true
    return { result: { ok: true } }
  })
  on('process.run', reviewedElsewhere('APPROVED').run)
  const result = await $.tool.call({ tool: publish, channel: 'demo', text: 'hi' })
  expect(result.deny).toBeUndefined()
  expect(ran).toBe(true)
})
