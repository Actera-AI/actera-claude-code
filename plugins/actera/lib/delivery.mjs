import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer, request } from 'node:http'
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { deliverBatch, loadConfig, pendingCount, pruneLocalState } from './bridge.mjs'

const protocol = 1
const revision = 2
const identity = home => createHash('sha256').update((process.platform === 'win32' ? path.resolve(home).toLowerCase() : path.resolve(home))).digest('hex')
const stateFile = home => path.join(home, 'delivery-worker.json')
async function state(home) {
  try { return JSON.parse(await readFile(stateFile(home), 'utf8')) } catch { return undefined }
}

function rpc(port, route, token, timeout = 2000) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path: route, method: 'POST', agent: false,
      headers: token ? { authorization: `Bearer ${token}` } : {} }, res => {
      let text = ''
      res.on('data', data => { text += data; if (text.length > 32768) req.destroy(new Error('Invalid delivery worker response')) })
      res.on('end', () => {
        try { if (res.statusCode !== 200) throw new Error('Delivery worker rejected request'); resolve(JSON.parse(text)) } catch (e) { reject(e) }
      })
      res.on('error', reject)
    })
    const timer = setTimeout(() => req.destroy(new Error('Delivery worker timeout')), timeout)
    req.on('close', () => clearTimeout(timer))
    req.on('error', reject)
    req.end()
  })
}

export async function deliveryStatus(home) {
  const saved = await state(home)
  if (saved) {
    try {
      const current = await rpc(saved.port, '/status', saved.token, 500)
      if (current.identity === identity(home) && current.protocol === protocol) return current
    } catch { /* Status must distinguish a stopped worker from an empty queue. */ }
  }
  const { token, ...safe } = saved || {}
  return { ...safe, running: false, state: 'stopped' }
}

export async function ensureDelivery(home) {
  const current = await deliveryStatus(home)
  if (current.running && current.revision === revision) return
  if (current.running) {
    // Keep the control protocol compatible with old hooks, but replace the
    // sender before publishing queue records that need the new implementation.
    const saved = await state(home)
    await rpc(saved.port, '/stop', saved.token, 65000).catch(async error => {
      const latest = await deliveryStatus(home)
      if (latest.running && latest.revision !== revision) throw error
    })
    for (let i = 0; i < 250; i++) {
      const old = await rpc(saved.port, '/status', saved.token, 500).catch(() => undefined)
      if (!old) break
      if (i === 249) throw new Error('Previous delivery worker did not stop')
      await delay(20)
    }
    if ((await deliveryStatus(home)).running) return
  }
  await mkdir(home, { recursive: true, mode: 0o700 })
  const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/delivery-worker.mjs', import.meta.url)), home],
    { detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  await new Promise((resolve, reject) => {
    let output = '', errors = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error('Delivery worker did not start')) }, 5000)
    child.stderr.on('data', data => { errors = (errors + data).slice(-1000) })
    child.once('error', e => { clearTimeout(timer); reject(e) })
    child.once('exit', code => { clearTimeout(timer); if (!output.includes('READY')) reject(new Error(errors || `Delivery worker exited (${code})`)) })
    child.stdout.on('data', data => {
      output += data
      if (output.includes('READY')) { clearTimeout(timer); resolve() }
    })
  })
  child.stdout.destroy(); child.stderr.destroy(); child.unref()
}

export async function flushDelivery(home) {
  await ensureDelivery(home)
  const saved = await state(home)
  return rpc(saved.port, '/flush', saved.token, 65000)
}

export async function stopDelivery(home) {
  const saved = await state(home)
  if (!saved) return
  if (!(await deliveryStatus(home)).running) return
  await rpc(saved.port, '/stop', saved.token, 65000)
  for (let i = 0; i < 100 && (await deliveryStatus(home)).running; i++) await delay(20)
}

export async function runDelivery(home) {
  home = path.resolve(home)
  const id = identity(home)
  const token = randomBytes(32).toString('hex')
  let stopping = false, busy = Promise.resolve(), failures = 0
  const previous = await state(home)
  const health = { protocol, revision, identity: id, pid: process.pid, running: true, state: 'idle', lastError: previous?.lastError || null, nextRetryAt: null }
  const serialized = fn => {
    const operation = busy.then(fn)
    busy = operation.catch(() => {})
    return operation
  }
  async function drain() {
    if (stopping) return { sent: 0, pending: await pendingCount(home) }
    const config = await loadConfig(home, {})
    if (!config) { stopping = true; return { sent: 0, pending: 0 } }
    health.state = 'sending'; health.nextRetryAt = null
    const result = await deliverBatch(config, { home, limit: 16, timeoutMs: 3000, force: true })
    if (result.error) {
      failures++
      health.state = 'retrying'
      delete health.recoveredAt
      health.lastError = { at: new Date().toISOString(), message: result.error }
      health.nextRetryAt = new Date(Date.now() + Math.min(30000, 1000 * 2 ** Math.min(failures - 1, 5))).toISOString()
    } else {
      failures = 0; health.state = result.pending ? 'sending' : 'idle'; health.nextRetryAt = null
      // Keep the last failure visible, with a separate recovery time.
      if (health.lastError) health.recoveredAt = new Date().toISOString()
    }
    await saveState()
    return result
  }
  const server = createServer(async (req, res) => {
    req.resume()
    res.setHeader('content-type', 'application/json')
    if (req.url === '/identity') { res.end(JSON.stringify({ identity: id, protocol })); return }
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(403); res.end('{}'); return }
    try {
      if (req.url === '/status') res.end(JSON.stringify(health))
      else if (req.url === '/stop') { stopping = true; await busy; res.end('{}') }
      else if (req.url === '/flush') res.end(JSON.stringify(await serialized(async () => {
        let sent = 0, result
        const deadline = Date.now() + 50000
        do { result = await drain(); sent += result.sent } while (result.pending && !result.error && Date.now() < deadline)
        return { ...result, sent }
      })))
      else { res.writeHead(404); res.end('{}') }
    } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: error.message })) }
  })
  // The OS-held listening socket is the election lock. It disappears on process
  // death, avoiding stale-file locks and concurrent recovery/rename races.
  const firstPort = 20000 + parseInt(id.slice(0, 8), 16) % 30000
  let port
  for (let offset = 0; offset < 100; offset++) {
    const candidate = firstPort + offset
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(candidate, '127.0.0.1', () => { server.removeListener('error', reject); resolve() })
      })
      port = candidate; break
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error
      const owner = await rpc(candidate, '/identity', undefined, 500).catch(() => undefined)
      if (owner?.identity === id && owner.protocol === protocol) {
        // The elected worker may still be writing its discovery file.
        for (let i = 0; i < 100; i++) { if ((await deliveryStatus(home)).running) { console.log('READY'); return }; await delay(20) }
        throw new Error('Delivery worker discovery timed out')
      }
    }
  }
  if (!port) throw new Error('No local delivery worker port available')
  async function saveState() {
    const temporary = `${stateFile(home)}.${process.pid}.tmp`
    await writeFile(temporary, JSON.stringify({ port, token, ...health }), { mode: 0o600 })
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, stateFile(home)); break }
      catch (error) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 20) throw error
        await delay(20)
      }
    }
  }
  await pruneLocalState(home)
  await saveState()
  console.log('READY')
  try {
    while (!stopping) {
      if (await pendingCount(home)) {
        if (!health.nextRetryAt || Date.parse(health.nextRetryAt) <= Date.now()) await serialized(drain)
      }
      await delay(200)
    }
  } finally {
    await busy
    // Persist failure history before releasing ownership. A replacement cannot
    // write discovery until this socket closes.
    health.running = false; health.state = 'stopped'
    await saveState()
    await new Promise(resolve => server.close(resolve))
  }
}
