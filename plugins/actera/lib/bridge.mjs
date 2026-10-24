import { ensureDelivery, flushDelivery, deliveryStatus, startDelivery, stopDelivery } from './delivery.mjs'
import { ExecutionOutcome } from './generated/outcomes.mjs'
import { DEFAULT_API_ORIGIN } from './defaults.mjs'
import { runtimeSettings } from './runtime-settings.mjs'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdir, readdir, rename, rm, stat, link } from 'node:fs/promises'
import os from 'node:os'
import { captureInput } from './input-capture.mjs'
import path from 'node:path'

const MAX_HOOK_BYTES = 16 * 1024 * 1024
// Each event can contain up to 512 KiB of tool input. Reserve outcome capacity
// for tool calls already admitted when the offline spool approaches its limit.
const MAX_QUEUED_EVENTS = 128
const MAX_QUEUED_WITH_OUTCOMES = 256
const RETRY_WINDOW_MS = 60 * 60 * 1000
const OUTCOME_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000
const DETAIL_FIELDS = [
  'tool_name',
  'tool_use_id',
  'agent_id',
  'agent_type',
  'source',
  'reason',
  'event',
  'command_name',
  'file_path',
  'directory',
  'old_cwd',
  'new_cwd',
  'message_id',
  'index',
  'final',
  'name',
  'from_model',
  'to_model',
]

export function bridgeHome() {
  return process.env.ACTERA_CLAUDE_BRIDGE_HOME || path.join(os.homedir(), '.actera', 'claude-code')
}

function configPath(home) {
  return path.join(home, 'config.json')
}
function queuePath(home) {
  return path.join(home, 'queue')
}
function markerPath(home) {
  return path.join(home, 'registered.json')
}
function offlinePath(home) {
  return path.join(home, 'offline-until.json')
}
function errorPath(home) {
  return path.join(home, 'last-error.json')
}
function deliveredPath(home) {
  return path.join(home, 'last-delivery.json')
}

function maintenancePath(home) {
  return path.join(home, 'last-maintenance.json')
}

function approvalPath(home, fingerprint) {
  return path.join(home, 'approvals', `${fingerprint}.json`)
}

function approvalClaimPath(home, decisionId) {
  const decisionHash = createHash('sha256').update(decisionId).digest('hex')
  return path.join(home, 'approvals', `${decisionHash}.claimed`)
}

async function legacyApprovalClaimed(home, decisionId) {
  const decisionHash = createHash('sha256').update(decisionId).digest('hex')
  try {
    return (await readdir(path.join(home, 'approvals'))).some((name) => name.endsWith(`-${decisionHash}.claimed`))
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

function reviewerPath(home) {
  return path.join(home, 'reviewer.json')
}

function credentialID(config) {
  return createHash('sha256').update(config.apiKey).digest('hex').slice(0, 16)
}

function toolCallKey(hook, config) {
  if (!hook.session_id || !hook.tool_use_id || typeof hook.tool_name !== 'string') return undefined
  return createHash('sha256')
    .update(
      JSON.stringify([
        config.baseUrl,
        credentialID(config),
        config.agentId,
        hook.session_id,
        hook.agent_id || '',
        hook.tool_use_id,
      ]),
    )
    .digest('hex')
}

function toolCallPath(home, key) {
  return path.join(home, 'tool-calls', `${key}.json`)
}

async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 })
    await rename(temporary, file)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

export function validateConfig(input) {
  const url = new URL(input.baseUrl ?? DEFAULT_API_ORIGIN)
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new Error('Actera base URL must be an origin without a path or credentials')
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  )
    throw new Error('Use HTTPS for remote Actera; HTTP is permitted only on loopback')
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(input.agentId))
    throw new Error('Agent ID must be 1–128 letters, digits, dots, underscores, colons, or hyphens')
  if (!/^actera_\S{25,}$/.test(input.apiKey)) throw new Error('A valid actera_ API key is required')
  if (input.capture !== undefined && !['metadata', 'tool-inputs'].includes(input.capture)) throw new Error('Capture must be metadata or tool-inputs')
  return {
    version: 3,
    baseUrl: url.origin,
    agentId: input.agentId,
    apiKey: input.apiKey,
    capture: input.capture || 'tool-inputs',
  }
}

export async function configure(input, home = bridgeHome()) {
  await stopDelivery(home)
  await rm(path.join(home, 'delivery-worker.json'), { force: true })
  const previous = await readJson(configPath(home))
  const config = validateConfig(input)
  const sameIdentity =
    previous?.baseUrl === config.baseUrl &&
    previous?.agentId === config.agentId &&
    previous?.apiKey === config.apiKey
  const queued = await queueFiles(home)
  if (queued.length && sameIdentity && previous.version === 3)
    throw new Error(`Flush the ${queued.length} queued event(s) before changing configuration`)
  const archive = previous && (!sameIdentity || previous.version !== 3) && queued.length
    ? await archivePreviousConnection(home, previous, queued.length)
    : undefined
  try {
    await writeJsonAtomic(configPath(home), config)
  } catch (error) {
    if (archive) await archive.restore()
    throw error
  }
  await rm(markerPath(home), { force: true })
  await rm(offlinePath(home), { force: true })
  await rm(errorPath(home), { force: true })
  await rm(deliveredPath(home), { force: true })
  if (!sameIdentity) await rm(reviewerPath(home), { force: true })
  return {
    baseUrl: config.baseUrl,
    agentId: config.agentId,
    capture: config.capture,
    home,
    ...(archive ? { archivedEvents: archive.count, archivePath: archive.path } : {}),
  }
}

async function archivePreviousConnection(home, previous, count) {
  const archive = path.join(home, 'archived', `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`)
  await mkdir(archive, { recursive: true, mode: 0o700 })
  await writeJsonAtomic(path.join(archive, 'config.json'), previous)
  const moved = []
  const names = [
    'queue', 'approvals', 'tool-calls', 'tool-outcomes', 'reviewer.json', 'registered.json',
    'offline-until.json', 'last-error.json', 'last-delivery.json', 'last-maintenance.json',
  ]
  const restore = async () => {
    for (const name of moved.reverse()) await rename(path.join(archive, name), path.join(home, name))
    await rm(archive, { recursive: true, force: true })
  }
  try {
    for (const name of names) {
      try {
        await rename(path.join(home, name), path.join(archive, name))
        moved.push(name)
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    }
  } catch (error) {
    await restore()
    throw error
  }
  return { path: archive, count, restore }
}

export async function loadConfig(home = bridgeHome(), env = process.env) {
  const config = await readJson(configPath(home))
  return config ? { ...config, ...runtimeSettings(env) } : undefined
}

export async function provisionBridge(input, home = bridgeHome(), timeoutMs = 8000) {
  const pending = validateConfig(input)
  const readiness = await agentReadiness(pending, timeoutMs, home)
  const result = await configure(pending, home)
  return result
}

function scalar(value) {
  return typeof value === 'string'
    ? value.slice(0, 1024)
    : typeof value === 'number' || typeof value === 'boolean'
      ? value
      : undefined
}

// Claude names MCP tools mcp__<server>__<tool>. The server segment is an
// opaque, potentially changing registration key, so it is evidence rather
// than part of the policy-facing action type.
export function mcpToolForHook(hook) {
  const name = hook.tool_name
  if (typeof name !== 'string' || !name.startsWith('mcp__')) return undefined
  const remainder = name.slice('mcp__'.length)
  const separator = remainder.indexOf('__')
  if (separator < 1 || separator + 2 >= remainder.length) throw new Error('Claude supplied an invalid MCP tool name')
  const mcp = { server_key: remainder.slice(0, separator), tool_name: remainder.slice(separator + 2) }
  const provenance = hook.mcp_server
  if (provenance && typeof provenance === 'object' && !Array.isArray(provenance)) {
    if (typeof provenance.name === 'string' && provenance.name.length <= 256) mcp.server_name = provenance.name
    if (typeof provenance.source === 'string' && provenance.source.length <= 64) mcp.source = provenance.source
  }
  return mcp
}

export async function activityForHook(hook, config, eventId = randomUUID(), occurredAt = new Date().toISOString()) {
  if (!hook || typeof hook !== 'object' || Array.isArray(hook) || !/^[A-Za-z]+$/.test(hook.hook_event_name || ''))
    throw new Error('Invalid Claude hook event')
  const eventName = hook.hook_event_name
  const toolName = typeof hook.tool_name === 'string' ? hook.tool_name : undefined
  if (toolName?.length > 256) throw new Error('Claude tool name exceeds 256 characters')
  const mcp = mcpToolForHook(hook)
  const details = {
    schema_version: 1,
    source: 'claude_code_hook',
    event_id: eventId,
    capture: config.capture,
  }
  for (const field of DETAIL_FIELDS) {
    const value = scalar(hook[field])
    if (value !== undefined) details[field] = value
  }
  if (hook.tool_input && typeof hook.tool_input === 'object' && !Array.isArray(hook.tool_input)) {
    details.tool_input_fields = Object.keys(hook.tool_input)
    const captured = await captureInput(hook.tool_input, config.capture)
    details.input_capture = captured.metadata
    if (captured.parameters !== undefined) details.tool_input = captured.parameters
    if (captured.metadata.status === 'omitted') details.tool_input_omitted = captured.metadata.reason
  }
  if (eventName === 'MessageDisplay') {
    details.text_length = typeof hook.delta === 'string' ? hook.delta.length : 0
  }
  const claude = {}
  for (const [to, from] of [
    ['session_id', 'session_id'],
    ['prompt_id', 'prompt_id'],
    ['subagent_id', 'agent_id'],
    ['subagent_type', 'agent_type'],
    ['cwd', 'cwd'],
    ['permission_mode', 'permission_mode'],
  ]) {
    const value = scalar(hook[from])
    if (value !== undefined) claude[to] = value
  }
  return {
    idempotency_key: `claude-hook:${credentialID(config)}:${eventId}`,
    event_type: `claude.hook.${eventName}`,
    agent: { id: config.agentId },
    action: {
      type: mcp ? `claude.mcp.${mcp.tool_name}` : toolName ? `claude.tool.${toolName}` : `claude.hook.${eventName}`,
      attributes: { hook_event: eventName, ...(toolName ? { tool_name: toolName } : {}), ...(mcp ? { mcp } : {}) },
    },
    context: { claude },
    occurred_at: occurredAt,
    details,
  }
}

export function evaluationForHook(hook, config, activity) {
  if (hook.hook_event_name !== 'PreToolUse' || !activity.details.tool_name)
    throw new Error('Only PreToolUse tool calls can be evaluated')
  if (activity.details.tool_input_omitted && activity.details.tool_input_omitted !== 'metadata_only' && config.mode === 'ENFORCING')
    throw new Error(`Actera tool inputs unavailable: ${activity.details.tool_input_omitted}`)
  const callIdentity = [
    credentialID(config),
    hook.session_id || '',
    hook.agent_id || '',
    hook.tool_use_id || activity.details.event_id,
  ]
  const callHash = createHash('sha256').update(JSON.stringify(callIdentity)).digest('hex')
  return {
    idempotency_key: `claude-tool:${callHash}`,
    mode: config.mode || 'MONITORING',
    agent: { id: config.agentId },
    action: {
      type: activity.action.type,
      attributes: {
        tool_name: activity.details.tool_name,
        ...(activity.action.attributes.mcp ? { mcp: activity.action.attributes.mcp } : {}),
        ...(activity.details.tool_input ? { parameters: activity.details.tool_input } : {}),
        ...(activity.details.tool_input_fields ? { input_fields: activity.details.tool_input_fields } : {}),
      },
    },
    context: {
      claude: { ...activity.context.claude, ...(hook.tool_use_id ? { tool_use_id: hook.tool_use_id } : {}) },
      source: 'claude_code_hook',
      capture: config.capture || 'tool-inputs',
      ...(activity.details.input_capture ? { input_capture: activity.details.input_capture } : {}),
      ...(hook.source === 'actera_bridge_test' ? { bridge_test: true } : {}),
    },
  }
}

// Persist the admitted (already redacted) action, rather than reconstructing
// authority from incidental metadata on a later lifecycle hook. Raw arguments
// are used only in a digest to bind the tool result to the admitted call.
export async function rememberToolDecision(hook, config, request, decision, home = bridgeHome()) {
  const key = toolCallKey(hook, config)
  if (!key) throw new Error('A session and tool invocation ID are required for reporting')
  await writeJsonAtomic(toolCallPath(home, key), {
    decisionId: decision?.id,
    request,
    fingerprint: approvalFingerprint(hook, config),
    savedAt: Date.now(),
  })
}

export async function enqueueToolOutcome(hook, config, home = bridgeHome()) {
  if (!['PostToolUse', 'PostToolUseFailure'].includes(hook.hook_event_name)) return undefined
  const key = toolCallKey(hook, config)
  if (!key) return undefined
  const admitted = await readJson(toolCallPath(home, key))
  if (!admitted) return undefined
  const fingerprint = approvalFingerprint(hook, config)
  if (!fingerprint || fingerprint !== admitted.fingerprint)
    throw new Error('Post-tool call does not match the admitted Actera action')
  const request = admitted.request
  // Normalize the host lifecycle to the shared execution outcome contract.
  // This remains host-reported tool evidence, not proof of a business effect.
  const outcome =
    hook.hook_event_name === 'PostToolUse' ? ExecutionOutcome.SUCCESS : hook.is_interrupt === true ? ExecutionOutcome.CANCELLED : ExecutionOutcome.FAILURE
  const details = {
    schema_version: 1,
    source: 'claude_code_hook',
    hook_event: hook.hook_event_name,
    tool_name: hook.tool_name,
    tool_use_id: hook.tool_use_id,
    outcome_scope: 'tool_call',
    summary:
      outcome === ExecutionOutcome.SUCCESS
        ? 'Claude Code reported that the tool call completed successfully.'
        : outcome === ExecutionOutcome.CANCELLED
          ? 'Claude Code reported that the tool call was interrupted.'
          : 'Claude Code reported that the tool call failed.',
  }
  const activity = {
    _tool_call_key: key,
    // A later definitive result may resolve an interrupted/uncertain call.
    // Retries of that same outcome keep their identity; a correction is new evidence.
    idempotency_key: `claude-tool-outcome:${credentialID(config)}:${key}:${outcome}`,
    decision_id: admitted.decisionId,
    _decision_request: request,
    outcome,
    occurred_at: new Date().toISOString(),
    agent: request.agent,
    action: request.action,
    context: request.context,
    details,
  }
  // Persist the first body for each outcome so retries retain occurred_at too.
  // Atomic link publication elects one body across concurrent hook processes.
  const outcomeFile = path.join(home, 'tool-outcomes', `${key}-${outcome}.json`)
  await mkdir(path.dirname(outcomeFile), { recursive: true })
  const candidate = `${outcomeFile}.${randomUUID()}.tmp`
  await writeJsonAtomic(candidate, activity)
  try {
    await link(candidate, outcomeFile)
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  } finally { await rm(candidate, { force: true }) }
  const stableReport = await readJson(outcomeFile)
  if (await readJson(`${outcomeFile}.sent`)) return stableReport
  await queueReport(home, stableReport, undefined, MAX_QUEUED_WITH_OUTCOMES)
  return stableReport
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`
  return JSON.stringify(value)
}

// A retry is the same proposed effect only within one Claude session, for the
// same raw tool and exact arguments. Never persist plaintext tool arguments.
export function approvalFingerprint(hook, config) {
  if (
    !hook.session_id ||
    !hook.tool_use_id ||
    typeof hook.tool_name !== 'string' ||
    !hook.tool_input ||
    typeof hook.tool_input !== 'object' ||
    Array.isArray(hook.tool_input)
  )
    return undefined
  return createHash('sha256')
    .update(
      canonicalJson([
        credentialID(config),
        config.agentId,
        hook.session_id,
        hook.agent_id || '',
        hook.tool_name,
        hook.tool_input,
      ]),
    )
    .digest('hex')
}

export async function rememberPendingApproval(hook, config, decision, request, home = bridgeHome()) {
  const fingerprint = approvalFingerprint(hook, config)
  if (!fingerprint || decision.status !== 'PENDING_APPROVAL') return
  await writeJsonAtomic(approvalPath(home, fingerprint), {
    decisionId: decision?.id,
    idempotencyKey: request.idempotency_key,
    actionType: request.action.type,
    savedAt: Date.now(),
  })
}

export async function previousApproval(hook, config, request, home = bridgeHome(), timeoutMs = 5000) {
  const fingerprint = approvalFingerprint(hook, config)
  if (!fingerprint) return undefined
  const saved = await readJson(approvalPath(home, fingerprint))
  if (!saved || Date.now() - saved.savedAt > RETRY_WINDOW_MS || saved.actionType !== request.action.type)
    return undefined
  const claimPath = approvalClaimPath(home, saved.decisionId)
  if (await legacyApprovalClaimed(home, saved.decisionId)) return undefined
  try {
    await readFile(claimPath)
    return undefined // That approval already released one Claude tool call.
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const response = await fetch(`${config.baseUrl}/v1/decisions/${encodeURIComponent(saved.decisionId)}/status`, {
    headers: { authorization: `Bearer ${config.apiKey}` },
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error(`Actera decision lookup returned HTTP ${response.status}`)
  const decision = await response.json()
  if (
    decision.id !== saved.decisionId ||
    decision.agent_id !== config.agentId ||
    decision.action_type !== saved.actionType ||
    decision.idempotency_key !== saved.idempotencyKey
  )
    throw new Error('Saved approval does not match the Actera Decision')
  if (decision.status === 'APPROVED') {
    try {
      await writeFile(claimPath, JSON.stringify({ at: new Date().toISOString() }) + '\n', { flag: 'wx', mode: 0o600 })
    } catch (error) {
      if (error?.code === 'EEXIST') return undefined
      throw error
    }
  }
  if (decision.status !== 'APPROVED' && decision.status !== 'PENDING_APPROVAL')
    await rm(approvalPath(home, fingerprint), { force: true })
  return decision
}

export async function startReviewerLink(config, home = bridgeHome(), timeoutMs = 8000) {
  const response = await fetch(`${config.baseUrl}/v1/reviewer-links`, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
    body: '{}',
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error(`Actera account link returned HTTP ${response.status}`)
  const link = await response.json()
  let browserUrl
  try {
    browserUrl = new URL(link.browser_url)
  } catch {
    throw new Error('Actera returned an invalid account link')
  }
  const apiUrl = new URL(config.baseUrl)
  const loopbackAlias =
    apiUrl.protocol === 'http:' &&
    browserUrl.protocol === 'http:' &&
    ['localhost', '127.0.0.1'].includes(apiUrl.hostname) &&
    ['localhost', '127.0.0.1'].includes(browserUrl.hostname) &&
    apiUrl.port === browserUrl.port
  if (
    !/^actera_reviewer_\S{40,}$/.test(link.approval_token) ||
    !/^[0-9a-f-]{36}$/i.test(link.workspace_id) ||
    !(browserUrl.origin === apiUrl.origin || loopbackAlias) ||
    browserUrl.pathname !== '/auth/reviewer-link' ||
    !browserUrl.searchParams.get('code')
  )
    throw new Error('Actera returned an invalid account link')
  await writeJsonAtomic(reviewerPath(home), {
    token: link.approval_token,
    workspaceId: link.workspace_id,
    baseUrl: config.baseUrl,
    agentId: config.agentId,
    credentialId: credentialID(config),
  })
  return { browserUrl: link.browser_url, workspaceId: link.workspace_id }
}

async function loadReviewer(config, home = bridgeHome()) {
  const reviewer = await readJson(reviewerPath(home))
  if (
    !reviewer ||
    reviewer.baseUrl !== config.baseUrl ||
    reviewer.agentId !== config.agentId ||
    reviewer.credentialId !== credentialID(config) ||
    !/^actera_reviewer_\S{40,}$/.test(reviewer.token)
  )
    throw new Error('Link your Actera account first with actera-hook.mjs link')
  return reviewer
}

export async function reviewerLinkStatus(config, home = bridgeHome(), timeoutMs = 5000) {
  const reviewer = await loadReviewer(config, home)
  const response = await fetch(`${config.baseUrl}/v1/reviewer-links/status`, {
    headers: { authorization: `Bearer ${reviewer.token}` },
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error(`Actera account link status returned HTTP ${response.status}`)
  const status = await response.json()
  return { linked: status.linked === true, workspaceId: reviewer.workspaceId }
}

export async function nativeReviewDecision(config, decisionId, choice, home = bridgeHome(), timeoutMs = 8000) {
  if (!/^[0-9a-f-]{36}$/i.test(decisionId) || !['approve', 'reject'].includes(choice))
    throw new Error('Invalid Decision or review choice')
  const lookup = await fetch(`${config.baseUrl}/v1/decisions/${decisionId}/status`, {
    headers: { authorization: `Bearer ${config.apiKey}` },
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!lookup.ok) throw new Error(`Actera decision lookup returned HTTP ${lookup.status}`)
  const original = await lookup.json()
  if (original.id !== decisionId || original.agent_id !== config.agentId)
    throw new Error('Decision does not belong to this Claude agent')
  let decision = original
  if (original.status === 'PENDING_APPROVAL') {
    const reviewer = await loadReviewer(config, home)
    const response = await fetch(`${config.baseUrl}/v1/decisions/${decisionId}/${choice}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${reviewer.token}`,
        'Actera-Workspace-Id': reviewer.workspaceId,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        idempotency_key: `claude-native-${choice}:${decisionId}`,
        ...(choice === 'reject' ? { reason: 'Declined in Claude Code' } : {}),
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) throw new Error(`Actera ${choice} returned HTTP ${response.status}`)
    decision = await response.json()
  }
  if (
    decision.id !== decisionId ||
    decision.agent_id !== config.agentId ||
    decision.status !== (choice === 'approve' ? 'APPROVED' : 'REJECTED')
  )
    throw new Error('Actera returned an unexpected review result')
  if (choice === 'approve') {
    if (await legacyApprovalClaimed(home, decisionId))
      throw new Error('This approved Decision already released a Claude tool call')
    try {
      await mkdir(path.dirname(approvalClaimPath(home, decisionId)), { recursive: true, mode: 0o700 })
      await writeFile(approvalClaimPath(home, decisionId), JSON.stringify({ at: new Date().toISOString() }) + '\n', {
        flag: 'wx',
        mode: 0o600,
      })
    } catch (error) {
      if (error?.code === 'EEXIST') throw new Error('This approved Decision already released a Claude tool call')
      throw error
    }
  }
  return { id: decision.id, status: decision.status }
}

export async function evaluateHook(hook, config, activity, timeoutMs = 8000) {
  const request = evaluationForHook(hook, config, activity)
  const decision = await postActera(config, 'decisions', request, timeoutMs)
  if (!decision?.id || typeof decision.status !== 'string') throw new Error('Actera returned an invalid Decision')
  return decision
}

export async function agentReadiness(config, timeoutMs = 5000, home = bridgeHome()) {
  const response = await fetch(`${config.baseUrl}/v1/agents/${encodeURIComponent(config.agentId)}/readiness`, {
    headers: { authorization: `Bearer ${config.apiKey}` },
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error(`Actera agent readiness returned HTTP ${response.status}`)
  const readiness = await response.json()
  if (readiness.agent_id !== config.agentId || readiness.ready !== true || !['DISCOVERED', 'ACTIVE'].includes(readiness.status))
    throw new Error(`Actera agent ${config.agentId} is unavailable or returned inconsistent readiness`)
  return readiness
}


export function claudeToolDecision(decision) {
  // An explicit Actera approval authorizes this exact tool call. Ordinary
  // ALLOWED decisions leave Claude's own permission flow unchanged.
  if (decision.status === 'ALLOWED') return null
  if (decision.status === 'APPROVED')
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: `Actera decision ${decision.id} approved`,
      },
    }
  if (decision.status === 'PENDING_APPROVAL')
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `Actera decision ${decision.id} is awaiting approval. Approve it in Actera, then retry this exact tool call. The bridge will reuse this Decision for one matching retry.`,
      },
    }
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `Actera decision ${decision.id} ${decision.status.toLowerCase().replaceAll('_', ' ')}: ${decision.explanation || 'Tool call not allowed.'}`,
    },
  }
}

export function claudeEvaluationFailure(error) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `Actera could not evaluate this tool call: ${error.message}`,
    },
  }
}

async function queueReport(home, activity, filename = `${Date.now()}-${randomUUID()}.json`, limit = MAX_QUEUED_EVENTS) {
  if ((await queueFiles(home)).length >= limit)
    throw new Error('Actera report queue is full; flush queued events before continuing')
  await writeJsonAtomic(path.join(queuePath(home), filename), activity)
}

export async function pruneLocalState(home) {
  const now = Date.now()
  const marker = await readJson(maintenancePath(home))
  if (marker && now - marker.at < MAINTENANCE_INTERVAL_MS) return
  for (const [directory, maxAge] of [
    ['approvals', OUTCOME_WINDOW_MS],
    ['tool-calls', OUTCOME_WINDOW_MS],
  ]) {
    let names
    try {
      names = await readdir(path.join(home, directory))
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    for (const name of names) {
      if (!name.endsWith('.json') && !name.endsWith('.claimed')) continue
      const file = path.join(home, directory, name)
      try {
        // Unresolved calls can still hold backend capacity. Keep correlation
        // until a definitive result has actually been acknowledged.
        if (directory === 'tool-calls') {
          const call = await readJson(file)
          if (!call?.resolvedAt || now - call.resolvedAt <= maxAge) continue
        }
        if (now - (await stat(file)).mtimeMs > maxAge) {
          await rm(file, { force: true })
          if (directory === 'tool-calls') {
            const key = name.replace(/\.json$/, '')
            for (const outcome of Object.values(ExecutionOutcome)) {
              await rm(path.join(home, 'tool-outcomes', `${key}-${outcome}.json`), { force: true })
              await rm(path.join(home, 'tool-outcomes', `${key}-${outcome}.json.sent`), { force: true })
            }
          }
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    }
  }
  await writeJsonAtomic(maintenancePath(home), { at: now })
}

async function queueFiles(home) {
  try {
    return (await readdir(queuePath(home))).filter((name) => name.endsWith('.json')).sort()
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

async function postActera(config, endpoint, body, timeoutMs) {
  const response = await fetch(`${config.baseUrl}/v1/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error(`Actera ${endpoint} returned HTTP ${response.status}`)
  return response.json()
}

export async function deliverBatch(config, { home = bridgeHome(), limit = Infinity, timeoutMs = 1500, force = false } = {}) {
  await pruneLocalState(home)
  const files = await queueFiles(home)
  if (!files.length) return { sent: 0, pending: 0 }
  const offline = await readJson(offlinePath(home))
  if (!force && offline?.until > Date.now()) return { sent: 0, pending: files.length, offline: true }
  let sent = 0
  try {
    for (const file of files.slice(0, limit)) {
      const fullPath = path.join(queuePath(home), file)
      let activity
      try {
        activity = await readJson(fullPath)
      } catch (error) {
        throw new Error(`Cannot read queued event ${file}: ${error.message}`)
      }
      if (!activity) continue // Another hook invocation delivered the same file.
      // Old plugin versions queued derived enforcement reports. They contain no
      // execution evidence and must not prevent delivery of actual outcomes.
      if (activity.enforcement && !activity.outcome) {
        if (activity._decision_request && !activity.decision_id) {
          activity = { _decision_request: activity._decision_request }
        } else {
          await rm(fullPath, { force: true })
          continue
        }
      }
      const { _decision_request: request, _tool_call_key: callKey, ...report } = activity
      const acknowledgement = callKey && path.join(home, 'tool-outcomes', `${callKey}-${report.outcome}.json.sent`)
      if (acknowledgement && await readJson(acknowledgement)) {
        await rm(fullPath, { force: true })
        continue
      }
      const decisionOnly = request && Object.keys(report).length === 0
      if (report.event_type) throw new Error("Legacy queued reports must be archived by reconnecting; they are not replayed into usage")
      if (!report.decision_id && request) {
        const decision = await postActera(config, 'decisions', request, timeoutMs)
        if (!decision?.id) throw new Error('Actera returned an invalid Decision')
        report.decision_id = decision.id
      }
      if (decisionOnly) {
        await rm(fullPath, { force: true })
        sent++
        continue
      }
      if (!report.decision_id) throw new Error('Legacy hook queue requires migration; reconnect using the new plugin')
      await postActera(config, `decisions/${encodeURIComponent(report.decision_id)}/reports`, report, timeoutMs)
      if (callKey && [ExecutionOutcome.SUCCESS, ExecutionOutcome.FAILURE].includes(report.outcome)) {
        const callFile = toolCallPath(home, callKey)
        const call = await readJson(callFile)
        if (call) await writeJsonAtomic(callFile, { ...call, resolvedAt: Date.now() })
      }
      if (acknowledgement) await writeJsonAtomic(acknowledgement, { at: Date.now() })
      await writeJsonAtomic(deliveredPath(home), {
        at: new Date().toISOString(),
        outcome: activity.outcome,
        agentId: activity.agent.id,
        sessionId: activity.context?.claude?.session_id || null,
        toolName: activity.details?.tool_name || null,
      })
      await rm(fullPath, { force: true })
      sent++
    }
    await rm(offlinePath(home), { force: true })
  } catch (error) {
    if (!force) await writeJsonAtomic(offlinePath(home), { until: Date.now() + 10_000 })
    return { sent, pending: (await queueFiles(home)).length, error: error.message }
  }
  return { sent, pending: (await queueFiles(home)).length }
}

// Explicit flushes use the same elected sender as background delivery.
export async function flush(config, { home = bridgeHome(), force = false } = {}) {
  if (!(await queueFiles(home)).length) return { sent: 0, pending: 0 }
  const worker = await deliveryStatus(home)
  if (!force && worker.nextRetryAt && Date.parse(worker.nextRetryAt) > Date.now())
    return { sent: 0, pending: (await queueFiles(home)).length, offline: true }
  return flushDelivery(home)
}

// Hooks only hand off to the worker; commands that report on delivery wait for it.
export async function wakeDelivery(home = bridgeHome(), { wait = false } = {}) {
  if (!(await loadConfig(home, {}))) return
  await (wait ? ensureDelivery(home) : startDelivery(home))
}

export async function pendingCount(home) {
  return (await queueFiles(home)).length
}

export async function queueSummary(home) {
  const files = await queueFiles(home)
  let executionReports = 0, decisionRetries = 0, oldest = Infinity
  for (const file of files) {
    try {
      const item = await readJson(path.join(queuePath(home), file))
      if (!item) continue
      if (item.outcome) executionReports++
      else decisionRetries++
      oldest = Math.min(oldest, (await stat(path.join(queuePath(home), file))).mtimeMs)
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  return { total: executionReports + decisionRetries, executionReports, decisionRetries,
    oldestPendingAt: Number.isFinite(oldest) ? new Date(oldest).toISOString() : null,
    oldestPendingAgeSeconds: Number.isFinite(oldest) ? Math.max(0, Math.floor((Date.now() - oldest) / 1000)) : 0 }
}

export async function status(home = bridgeHome(), env = process.env) {
  const config = await loadConfig(home, env)
  const files = await queueFiles(home)
  return {
    configured: !!config,
    settings: runtimeSettings(env),
    settingsManagedBy: 'Claude /config',
    ...(config ? { baseUrl: config.baseUrl, agentId: config.agentId, capture: config.capture, mode: config.mode || 'MONITORING', onEvaluationError: config.onEvaluationError || 'deny' } : {}),
    pending: files.length,
    queue: await queueSummary(home),
    delivery: await deliveryStatus(home),
    lastDelivered: await readJson(deliveredPath(home)),
    lastError: await readJson(errorPath(home)),
  }
}

export async function recordEvaluationError(error, home = bridgeHome()) {
  await writeJsonAtomic(errorPath(home), { at: new Date().toISOString(), message: error.message })
}

export async function readHookInput(stream) {
  const chunks = []
  let size = 0
  for await (const chunk of stream) {
    size += chunk.length
    if (size > MAX_HOOK_BYTES) throw new Error('Claude hook input exceeds 16 MiB')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

// Retry a policy evaluation that could not be delivered by the pre-tool hook.
export async function enqueueDecision(request, home = bridgeHome()) {
  await queueReport(home, { _decision_request: request })
}
