import { expect, test } from 'claude-code/testing'

const id = '52865aae-b114-49db-9f3b-5870744603d8'
const publish = 'mcp__catalog__publish_item'

const held = `Actera decision ${id} is awaiting approval.`

// Stands in for the command hook and the tool beneath the mod: the hook denies
// the first run, and a second run reaches the tool. It is scoped to the tool under
// test because the review prompt ($.ui.ask) is an AskUserQuestion tool call.
function heldCall(on, tool: string, denial: object = { deny: held }) {
  let runs = 0
  on('tool.call', { tool }, () => (++runs === 1 ? denial : { result: { ok: true } }))
  return { runs: () => runs }
}

test('linked approval releases the same held Claude tool call', async ($, on) => {
  const text = `PreToolUse:mcp__catalog__publish_item hook error: Actera decision ${id} is awaiting approval. Approve it in Actera, then retry this exact tool call.`
  const call = heldCall(on, publish, { result: `Error: ${text}`, text, isError: true })
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => ({ result: { answers: { [e.questions[0].question]: 'Allow once' } } }))
  on('process.run', ($, e) => {
    if (e.argv.includes('link-status')) return { value: { exitCode: 0, stdout: '{"linked":true}', stderr: '' } }
    expect(e.argv.slice(-4)).toEqual(['--decision-id', id, '--choice', 'approve'])
    return { value: { exitCode: 0, stdout: JSON.stringify({ id, status: 'APPROVED' }), stderr: '' } }
  })
  const result = await $.tool.call({ tool: publish, channel: 'demo', text: 'hi' })
  expect(result.deny).toBeUndefined()
  expect(call.runs()).toBe(2)
})

test('other denials are never overridden by Actera native review', async ($, on) => {
  heldCall(on, 'Bash', { deny: 'Managed rule denied the call' })
  const result = await $.tool.call({ tool: 'Bash', command: 'echo test' })
  expect(result.deny).toBe('Managed rule denied the call')
})

test('an ineligible linked reviewer leaves the tool call denied', async ($, on) => {
  const call = heldCall(on, publish)
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => ({ result: { answers: { [e.questions[0].question]: 'Allow once' } } }))
  on('process.run', ($, e) =>
    e.argv.includes('link-status')
      ? { value: { exitCode: 0, stdout: '{"linked":true}', stderr: '' } }
      : { value: { exitCode: 1, stdout: '', stderr: 'Actera approve returned HTTP 403' } },
  )
  const result = await $.tool.call({ tool: publish, channel: 'demo', text: 'hi' })
  expect(result.deny).toMatch('HTTP 403')
})

test('unlinked reviewer is prompted to link before approving the held call', async ($, on) => {
  const call = heldCall(on, publish)
  let linked = false
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
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
  const result = await $.tool.call({ tool: publish, channel: 'demo', text: 'hi' })
  expect(result.deny).toBeUndefined()
  expect(call.runs()).toBe(2)
})

test('a prefixed denial for a different tool is not overridden', async ($, on) => {
  heldCall(on, publish, { deny: `PreToolUse:mcp__other__send hook error: ${held}` })
  const result = await $.tool.call({ tool: publish })
  expect(result.deny).toMatch('mcp__other__send')
})

test('native review uses a readable action and input preview without internal identifiers', async ($, on) => {
  const tool = 'mcp__2652758a-3362-40ec-859f-69ec8c910d3c__send_message'
  heldCall(on, tool)
  let asked = false
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
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
  const result = await $.tool.call({ tool, channel_id: 'C123', message: 'Hello again!', api_key: 'private' })
  expect(asked).toBe(true)
  expect(result.deny).toMatch('was rejected in Claude Code')
})

test('provider-prefixed MCP operations read as actions instead of raw tool identifiers', async ($, on) => {
  const tool = 'mcp__2652758a-3362-40ec-859f-69ec8c910d3c__slack_send_message'
  heldCall(on, tool)
  let asked = false
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
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
  const result = await $.tool.call({ tool, channel_id: 'C123', message: 'Hello again!' })
  expect(asked).toBe(true)
  expect(result.deny).toBe(`Actera decision ${id} is awaiting approval.`)
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
  const call = heldCall(on, publish)
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    expect(e.questions[0].options.map((option) => option.label)).toEqual(['Link account', "I've approved it in Actera", 'Not now'])
    return { result: { answers: { [e.questions[0].question]: 'Not now' } } }
  })
  const bridge = reviewedElsewhere('APPROVED')
  on('process.run', bridge.run)
  const result = await $.tool.call({ tool: publish, channel: 'demo', text: 'hi' })
  expect(result.deny).toBeUndefined()
  expect(call.runs()).toBe(2)
  expect(bridge.calls.some((argv) => argv.includes('native-review'))).toBe(false)
})

test('a rejection made in Actera denies the held call with that reason', async ($, on) => {
  const call = heldCall(on, publish)
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => ({ result: { answers: { [e.questions[0].question]: "I've approved it in Actera" } } }))
  on('process.run', reviewedElsewhere('REJECTED').run)
  const result = await $.tool.call({ tool: publish, channel: 'demo', text: 'hi' })
  expect(result.deny).toBe(`Actera Decision ${id} was rejected in Actera.`)
})

test('a linked reviewer who closes the prompt still releases a call approved in Actera', async ($, on) => {
  const call = heldCall(on, publish)
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => ({ result: { answers: {} } }))
  on('process.run', reviewedElsewhere('APPROVED', true).run)
  const result = await $.tool.call({ tool: publish, channel: 'demo', text: 'hi' })
  expect(result.deny).toBeUndefined()
  expect(call.runs()).toBe(2)
})

test('an explicit Deny in Claude is not replaced by a status lookup', async ($, on) => {
  const call = heldCall(on, publish)
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => ({ result: { answers: { [e.questions[0].question]: 'Deny' } } }))
  const calls: string[][] = []
  on('process.run', ($, e) => {
    calls.push(e.argv)
    return e.argv.includes('link-status')
      ? { value: { exitCode: 0, stdout: '{"linked":true}', stderr: '' } }
      : { value: { exitCode: 0, stdout: JSON.stringify({ id, status: 'REJECTED' }), stderr: '' } }
  })
  const result = await $.tool.call({ tool: publish, channel: 'demo', text: 'hi' })
  expect(result.deny).toMatch('was rejected in Claude Code')
  expect(calls.some((argv) => argv.includes('review-status'))).toBe(false)
})
