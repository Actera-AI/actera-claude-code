// The command PreToolUse hook creates the Actera Decision. This mod reviews
// the command-hook denial in the same tool call before permission mode settles;
// the permission-check hook remains as a compatibility fallback.
const pendingReason = /^Actera decision ([0-9a-f-]{36}) is awaiting approval\./i
const prefixedPendingReason = /^PreToolUse:(.+?) hook error: Actera decision ([0-9a-f-]{36}) is awaiting approval\./i

function pendingDecision(reason, tool) {
  const direct = pendingReason.exec(reason)
  if (direct) return direct[1]
  const prefixed = prefixedPendingReason.exec(reason)
  return prefixed?.[1] === tool ? prefixed[2] : undefined
}

async function bridgeCommand($, root, ...args) {
  return $.process.run(['node', `${root}/bin/actera-hook.mjs`, ...args])
}

function readableName(value) {
  return String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

const actionVerbs = new Set([
  'add', 'archive', 'cancel', 'create', 'delete', 'edit', 'execute', 'export',
  'invite', 'post', 'publish', 'remove', 'rename', 'run', 'send', 'share',
  'submit', 'transfer', 'update', 'upload', 'write',
])

function actionName(tool) {
  // MCP server names can be opaque, installation-specific IDs. The operation
  // suffix is the part a reviewer can use to recognize the requested action.
  const operation = tool.startsWith('mcp__') ? tool.split('__').slice(2).join('__') : tool
  const words = readableName(operation).split(' ').filter(Boolean)
  const verbIndex = words.findIndex((word) => actionVerbs.has(word))
  if (verbIndex > 0) {
    const source = words.slice(0, verbIndex).join(' ').replace(/^./, (letter) => letter.toUpperCase())
    return `${words.slice(verbIndex).join(' ')} via ${source}`
  }
  if (verbIndex === 0) return words.join(' ')
  return words.length ? `use ${words.join(' ')}` : 'use a tool'
}

function fieldLabel(key) {
  return readableName(key)
    .replace(/^./, (letter) => letter.toUpperCase())
    .replace(/\b(id|api|url)\b/gi, (word) => word.toUpperCase())
}

function reviewQuestion(tool, input) {
  const lines = [`Allow Claude to ${actionName(tool)}?`]
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    let shown = 0
    let omitted = 0
    for (const [key, value] of Object.entries(input)) {
      if (shown >= 4 || value === null || typeof value === 'object') {
        omitted++
        continue
      }
      const label = fieldLabel(key)
      const secret = /(?:secret|password|token|credential|api.?key|authorization)/i.test(key)
      const raw = secret ? '(hidden)' : String(value).replace(/\s+/g, ' ').trim()
      const preview = raw.length > 180 ? `${raw.slice(0, 180)}…` : raw
      lines.push(`${label}: ${preview}`)
      shown++
    }
    if (omitted) lines.push('Additional details are in the tool request.')
  }
  lines.push('Actera will record your choice. Review the full tool request before allowing it.')
  return lines.join('\n')
}

const approvedInActera = "I've approved it in Actera"

// The reviewer can approve or reject on the Actera Decision page while a
// prompt here is open. Returns null while the Decision is still pending.
async function reviewedInActera($, root, decisionId) {
  const reviewed = await bridgeCommand($, root, 'review-status', '--decision-id', decisionId)
  if (reviewed.exitCode !== 0)
    return { decision: 'deny', reason: `Actera could not check Decision ${decisionId}: ${(reviewed.stderr || 'lookup failed').trim()}` }
  let result
  try { result = JSON.parse(reviewed.stdout) } catch { /* Checked below. */ }
  if (result?.id !== decisionId || typeof result.status !== 'string')
    return { decision: 'deny', reason: 'Actera returned an invalid Decision status.' }
  if (result.status === 'PENDING_APPROVAL') return null
  if (result.status === 'APPROVED')
    return { decision: 'allow', reason: `Actera Decision ${decisionId} was approved in Actera.` }
  return { decision: 'deny', reason: `Actera Decision ${decisionId} was ${result.status.toLowerCase().replaceAll('_', ' ')} in Actera.` }
}

async function resolvePending($, decisionId, tool, input) {
    const root = $.plugin.root.replace(/[\\/]$/, '')
    // Before leaving the call held, or denying it for a local linking problem,
    // use a review made in Actera meanwhile.
    const unlessReviewed = async (fallback) => (await reviewedInActera($, root, decisionId)) || fallback
    let linkStatus
    try {
      const status = await bridgeCommand($, root, 'link-status')
      if (status.exitCode === 0) linkStatus = JSON.parse(status.stdout)
    } catch { /* An absent or expired link is handled below. */ }
    if (linkStatus?.linked !== true) {
      let linkAnswer
      try {
        linkAnswer = await $.ui.ask(
          'To review this action here, link Claude Code to your Actera account. You can also approve it on the Decision page in Actera.',
          ['Link account', approvedInActera, 'Not now'],
        )
      } catch { return unlessReviewed(null) }
      if (linkAnswer !== 'Link account') return unlessReviewed(null)
      const link = await bridgeCommand($, root, 'link', '--json', '--open')
      if (link.exitCode !== 0)
        return unlessReviewed({ decision: 'deny', reason: `Actera account linking failed: ${(link.stderr || 'link failed').trim()}` })
      let browserUrl
      try { browserUrl = JSON.parse(link.stdout).browserUrl } catch { /* Invalid link stays denied. */ }
      if (!browserUrl) return unlessReviewed({ decision: 'deny', reason: 'Actera returned an invalid account link.' })
      let completed
      try {
        completed = await $.ui.ask(
          `Finish linking in the browser, then return here. If it did not open, visit ${browserUrl}`,
          ["I've linked my account", approvedInActera, 'Not now'],
        )
      } catch { return unlessReviewed(null) }
      if (completed !== "I've linked my account") return unlessReviewed(null)
      const verified = await bridgeCommand($, root, 'link-status')
      try { linkStatus = verified.exitCode === 0 ? JSON.parse(verified.stdout) : null } catch { linkStatus = null }
      if (linkStatus?.linked !== true)
        return unlessReviewed({ decision: 'deny', reason: `Actera account link is not complete. Decision ${decisionId} remains pending.` })
    }

    const question = reviewQuestion(tool, input)
    let answer
    try {
      answer = await $.ui.ask(question, ['Allow once', 'Deny'])
    } catch {
      return unlessReviewed(null)
    }
    if (answer !== 'Allow once' && answer !== 'Deny') return unlessReviewed(null)

    const choice = answer === 'Allow once' ? 'approve' : 'reject'
    const reviewed = await bridgeCommand($, root, 'native-review', '--decision-id', decisionId, '--choice', choice)
    if (reviewed.exitCode !== 0) {
      return { decision: 'deny', reason: `Actera did not ${choice} this call: ${(reviewed.stderr || 'review failed').trim()}` }
    }
    try {
      const result = JSON.parse(reviewed.stdout)
      if (result.id !== decisionId || result.status !== (choice === 'approve' ? 'APPROVED' : 'REJECTED'))
        throw new Error('unexpected Actera response')
    } catch {
      return { decision: 'deny', reason: 'Actera returned an invalid review result.' }
    }
    if (choice === 'reject') return { decision: 'deny', reason: `Actera Decision ${decisionId} was rejected in Claude Code.` }
    return { decision: 'allow', reason: `Actera Decision ${decisionId} was approved by the linked reviewer.` }
}

export function register(on) {
  // This event wraps the command PreToolUse hook itself. It is reached before
  // Claude settles permission mode, including Bypass permissions in Desktop.
  on('classic.PreToolUse', async ($, e, next) => {
    const decided = await next(e)
    if (!decided?.deny) return decided
    const decisionId = pendingDecision(decided.deny, e.tool)
    if (!decisionId) return decided
    const { tool, tool_use_id, ...input } = e
    const reviewed = await resolvePending($, decisionId, tool, input)
    // Claude sees only the tool's result otherwise, and would describe a held and
    // approved call as one that ran unchecked. A denial's reason already reaches it.
    return reviewed?.decision === 'allow'
      ? { allow: true, additionalContext: [`Actera held this tool call for approval, then released it. ${reviewed.reason}`] }
      : reviewed?.decision === 'deny'
        ? { deny: reviewed.reason }
        : decided
  }).catch(async ($, e, next) => ({
    deny: `Actera could not complete the native review (${next.error.kind}). The tool call was not released.`,
  }))

  // Older hosts may expose the PreToolUse denial only at the permission check.
  on('tool.check', async ($, e, next) => {
    const decided = await next(e)
    if (decided?.decision !== 'deny') return decided
    const decisionId = pendingDecision(decided.reason || '', e.tool)
    if (!decisionId) return decided
    return (await resolvePending($, decisionId, e.tool, e.input)) || decided
  }).catch(async ($, e, next) => ({
    decision: 'deny',
    reason: `Actera could not complete the native review (${next.error.kind}). The tool call was not released.`,
  }))
}
