import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, mkdir, cp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { configure, status } from '../../plugins/actera/lib/bridge.mjs'
import { deliveryStatus, ensureDelivery, stopDelivery } from '../../plugins/actera/lib/delivery.mjs'

const cli = fileURLToPath(new URL('../../plugins/actera/bin/actera-hook.mjs', import.meta.url))
async function until(check, timeout = 15000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await check()) return; await delay(50) }
  assert.fail('Delivery did not reach the expected state without another hook')
}
async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'actera-delivery-'))
  const decisions = new Map(), reports = new Map(), attempts = []
  const service = { available: true, loseAcknowledgement: false }
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    const input = JSON.parse(body)
    if (req.url === '/v1/decisions') {
      decisions.set(input.idempotency_key, input)
      res.end(JSON.stringify({ id: input.idempotency_key, status: 'MONITORED', effect: 'ALLOW' })); return
    }
    attempts.push(input.idempotency_key)
    if (!service.available) { res.writeHead(503); res.end('{}'); return }
    reports.set(input.idempotency_key, input)
    if (service.loseAcknowledgement) { service.loseAcknowledgement = false; req.socket.destroy(); return }
    await delay(25)
    res.end('{}')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  await configure({ baseUrl: `http://127.0.0.1:${server.address().port}`, agentId: 'delivery-test', apiKey: 'actera_' + 'x'.repeat(40), capture: 'metadata' }, home)
  t.after(async () => { await stopDelivery(home); await new Promise(resolve => server.close(resolve)); await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) })
  async function hook(event, id) {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cli, 'hook'], { windowsHide: true, env: { ...process.env, ACTERA_CLAUDE_BRIDGE_HOME: home, CLAUDE_PLUGIN_OPTION_MODE: 'Monitoring' } })
      let error = ''; child.stderr.on('data', data => error += data)
      child.on('error', reject); child.on('close', code => code ? reject(new Error(error)) : resolve())
      child.stdin.end(JSON.stringify({ hook_event_name: event, session_id: 'delivery', tool_use_id: id, tool_name: 'Bash', tool_input: { command: 'echo test' } }))
    })
  }
  return { home, service, decisions, reports, attempts, hook }
}

test('twenty concurrent real hook processes drain all outcomes with a single sender', async t => {
  const f = await fixture(t)
  const ids = Array.from({ length: 20 }, (_, i) => `call-${i}`)
  await Promise.all(ids.map(id => f.hook('PreToolUse', id)))
  await Promise.all(ids.map(id => f.hook('PostToolUse', id)))
  await until(async () => (await status(f.home)).pending === 0)
  assert.equal(f.decisions.size, 20)
  assert.equal(f.reports.size, 20)
  assert.equal(f.attempts.length, 20, 'Concurrent hooks must not resend the same queue head')
  assert.equal((await deliveryStatus(f.home)).state, 'idle')
})

test('new hooks replace an old persistent sender before publishing outcome records', async t => {
  const f = await fixture(t)
  const older = path.join(f.home, 'older-plugin')
  await mkdir(path.join(older, 'bin'), { recursive: true })
  await cp(fileURLToPath(new URL('../../plugins/actera/lib', import.meta.url)), path.join(older, 'lib'), { recursive: true })
  await cp(fileURLToPath(new URL('../../plugins/actera/.claude-plugin', import.meta.url)), path.join(older, '.claude-plugin'), { recursive: true })
  await cp(fileURLToPath(new URL('../../plugins/actera/bin/delivery-worker.mjs', import.meta.url)), path.join(older, 'bin/delivery-worker.mjs'))
  const implementation = path.join(older, 'lib/delivery.mjs')
  await writeFile(implementation, (await readFile(implementation, 'utf8')).replace('const revision = 2', 'const revision = 1'))
  const worker = spawn(process.execPath, [path.join(older, 'bin/delivery-worker.mjs'), f.home], { windowsHide: true, stdio: 'ignore' })
  worker.on('error', error => { throw error })
  t.after(() => worker.kill())
  await until(async () => (await deliveryStatus(f.home)).revision === 1)
  const oldPid = (await deliveryStatus(f.home)).pid
  await Promise.all(Array.from({ length: 8 }, () => ensureDelivery(f.home)))
  const current = await deliveryStatus(f.home)
  assert.equal(current.revision, 2)
  assert.notEqual(current.pid, oldPid)
  await f.hook('PreToolUse', 'upgraded')
  await f.hook('PostToolUse', 'upgraded')
  await until(async () => f.reports.size === 1 && (await status(f.home)).pending === 0)
  assert.equal(f.attempts.length, 1)
  assert.ok([...f.reports.values()].every(report => !('_tool_call_key' in report)))
})

test('outage retries autonomously, survives worker restart, and exposes queue age and recovery', async t => {
  const f = await fixture(t)
  f.service.available = false
  for (const id of ['one', 'two']) await f.hook('PreToolUse', id)
  await Promise.all(['one', 'two'].map(id => f.hook('PostToolUse', id)))
  await until(async () => (await deliveryStatus(f.home)).state === 'retrying')
  let snapshot = await status(f.home)
  assert.equal(snapshot.queue.executionReports, 2)
  assert.equal(snapshot.queue.decisionRetries, 0)
  assert.ok(snapshot.queue.oldestPendingAt)
  assert.match(snapshot.delivery.lastError.message, /503/)
  assert.ok(snapshot.delivery.nextRetryAt)
  await stopDelivery(f.home)
  assert.equal((await status(f.home)).delivery.state, 'stopped')
  assert.equal((await status(f.home)).pending, 2)
  await ensureDelivery(f.home)
  await until(async () => (await deliveryStatus(f.home)).state === 'retrying')
  f.service.available = true
  // No hook, status command, or manual flush triggers delivery after recovery.
  await until(async () => f.reports.size === 2 && (await status(f.home)).pending === 0)
  snapshot = await status(f.home)
  assert.equal(snapshot.delivery.state, 'idle')
  assert.ok(snapshot.delivery.recoveredAt)
  assert.ok(snapshot.delivery.lastError)
})

test('an acknowledgement lost after acceptance retries the same idempotency key', async t => {
  const f = await fixture(t)
  f.service.loseAcknowledgement = true
  await f.hook('PreToolUse', 'lost-ack')
  await f.hook('PostToolUse', 'lost-ack')
  await until(async () => f.attempts.length === 2 && (await status(f.home)).pending === 0)
  assert.equal(f.reports.size, 1)
  assert.equal(f.attempts[0], f.attempts[1])
})


test('a killed sender releases its OS lock and a replacement resumes durable reports', async t => {
  const f = await fixture(t)
  f.service.available = false
  await f.hook('PreToolUse', 'crash')
  await f.hook('PostToolUse', 'crash')
  await until(async () => (await deliveryStatus(f.home)).state === 'retrying')
  const worker = await deliveryStatus(f.home)
  process.kill(worker.pid, 'SIGKILL')
  await until(async () => !(await deliveryStatus(f.home)).running)
  assert.equal((await status(f.home)).pending, 1)
  f.service.available = true
  await ensureDelivery(f.home)
  await until(async () => f.reports.size === 1 && (await status(f.home)).pending === 0)
  assert.notEqual((await deliveryStatus(f.home)).pid, worker.pid)
})
