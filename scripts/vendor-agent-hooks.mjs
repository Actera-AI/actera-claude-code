// Plugins install as folders without running npm, so this plugin ships the
// files of an agent-hooks release, for its own host only, and pins each one by
// SHA-256. The same script is used by every host plugin; keep the copies equal.
//   node scripts/vendor-agent-hooks.mjs --version 0.3.3            vendor a release
//   node scripts/vendor-agent-hooks.mjs --from ../actera-agent-hooks  vendor a local checkout (development only)
//   node scripts/vendor-agent-hooks.mjs --check                    the vendored files match the lock (offline)
//   node scripts/vendor-agent-hooks.mjs --verify-release           the lock matches its release; notes a newer one
// --host <host> names this plugin's host on the first vendor; the lock keeps it.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const root = fileURLToPath(new URL('../', import.meta.url))
export const paths = {
  target: resolve(root, 'plugins/actera/vendor/agent-hooks'),
  lockFile: resolve(root, 'scripts/agent-hooks.lock.json'),
}
const name = '@actera-ai/agent-hooks'
const repository = 'Actera-AI/actera-agent-hooks'
const hosts = ['claude-code', 'codex']
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const archiveName = version => `actera-ai-agent-hooks-${version}.tgz`

// npm pack writes a gzipped ustar archive with every entry under package/.
export function unpack(archive) {
  const tar = gunzipSync(archive, { maxOutputLength: 256 * 1024 * 1024 })
  const files = new Map()
  const field = (block, start, length) => block.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '')
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    const size = parseInt(field(header, 124, 12).trim() || '0', 8)
    const type = field(header, 156, 1) || '0'
    const prefix = field(header, 345, 155)
    const entry = (prefix ? prefix + '/' : '') + field(header, 0, 100)
    const body = tar.subarray(offset + 512, offset + 512 + size)
    offset += 512 + Math.ceil(size / 512) * 512
    if (type === '5') continue
    assert.equal(type, '0', `Unsupported archive entry type ${type} for ${entry}`)
    const path = posix.normalize(entry)
    assert.ok(path.startsWith('package/') && !path.includes('..'), `Unexpected archive path: ${entry}`)
    files.set(path.slice('package/'.length), Buffer.from(body))
  }
  return files
}

// Every host adapter imports only the core, so another host's folder is never
// loaded and is left out.
export function forHost(files, host) {
  assert.ok(hosts.includes(host), `Unknown host ${host}; expected one of ${hosts.join(', ')}`)
  assert.ok([...files.keys()].some(path => path.startsWith(`src/hosts/${host}/`)), `The archive has no src/hosts/${host}/`)
  return new Map([...files].filter(([path]) => !/^src\/hosts\/[^/]+\//.test(path) || path.startsWith(`src/hosts/${host}/`)))
}

export function readLock(lockFile = paths.lockFile) {
  return existsSync(lockFile) ? JSON.parse(readFileSync(lockFile, 'utf8')) : undefined
}

function vendored(directory, prefix = '') {
  const files = []
  for (const entry of readdirSync(join(directory, prefix), { withFileTypes: true })) {
    const path = prefix + entry.name
    if (entry.isDirectory()) files.push(...vendored(directory, path + '/'))
    else files.push(path)
  }
  return files.sort()
}

export function lockedFiles(lockFile = paths.lockFile) {
  return Object.keys(readLock(lockFile).files).sort()
}

// Offline: the vendored files are exactly the locked ones. A local pack is for
// development only, so CI refuses it.
export function checkVendored({ target, lockFile } = paths, env = process.env) {
  const lock = readLock(lockFile)
  assert.ok(lock, 'No agent-hooks lock; run npm run vendor:agent-hooks -- --version <version>')
  assert.equal(lock.name, name)
  assert.ok(hosts.includes(lock.host), 'The lock names no host')
  assert.ok(lock.source?.release || lock.source?.local, 'The lock records no source; vendor a release')
  if (lock.source.local) {
    const message = `agent-hooks ${lock.version} is vendored from a local pack. Vendor a release before merging: npm run vendor:agent-hooks -- --version <version>`
    if (env.CI) throw new Error(message)
    process.stderr.write(`Warning: ${message}\n`)
  } else assert.equal(lock.source.release, `v${lock.version}`, 'The lock source and version differ')
  assert.deepEqual(vendored(target), Object.keys(lock.files).sort(), 'Vendored agent-hooks files differ from the lock')
  for (const [path, digest] of Object.entries(lock.files))
    assert.equal(sha256(readFileSync(join(target, path))), digest, `Vendored file changed: ${path}`)
  const manifest = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))
  assert.equal(manifest.version, lock.version, 'Vendored package version differs from the lock')
  return lock
}

async function download(url) {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(60000) })
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

// Downloads a release's archive and checks it against the SHA-256 published
// with it.
export async function releaseArchive(version, origin = 'https://github.com') {
  assert.match(version, /^\d+\.\d+\.\d+$/, `Expected a version like 0.3.3, got ${version}`)
  const base = `${origin}/${repository}/releases/download/v${version}/${archiveName(version)}`
  const [archive, checksum] = await Promise.all([download(base), download(`${base}.sha256`)])
  const published = checksum.toString('utf8').trim().split(/\s+/)[0]
  assert.match(published, /^[0-9a-f]{64}$/, `Unreadable checksum at ${base}.sha256`)
  assert.equal(sha256(archive), published, `The v${version} archive does not match its published SHA-256`)
  return archive
}

export async function latestRelease(origin = 'https://github.com') {
  const response = await fetch(`${origin}/${repository}/releases/latest`, { redirect: 'manual', signal: AbortSignal.timeout(30000) })
  const tag = response.headers.get('location')?.match(/\/releases\/tag\/v(\d+\.\d+\.\d+)$/)?.[1]
  if (!tag) throw new Error(`Could not read the latest agent-hooks release (HTTP ${response.status})`)
  return tag
}

const newer = (a, b) => {
  const [x, y] = [a, b].map(version => version.split('.').map(Number))
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]
  return false
}

export function packLocal(checkout) {
  const directory = mkdtempSync(join(tmpdir(), 'agent-hooks-pack-'))
  try {
    // Run npm through Node itself so no shell is involved.
    const npmCli = [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')]
      .find(file => file?.endsWith('npm-cli.js') && existsSync(file))
    const args = ['pack', '--ignore-scripts', '--json', '--pack-destination', directory]
    const output = npmCli
      ? execFileSync(process.execPath, [npmCli, ...args], { cwd: resolve(checkout), encoding: 'utf8' })
      : execFileSync('npm', args, { cwd: resolve(checkout), encoding: 'utf8' })
    return readFileSync(join(directory, JSON.parse(output)[0].filename))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

export function vendorArchive(archive, { host, source }, { target, lockFile } = paths) {
  const files = forHost(unpack(archive), host)
  const manifest = JSON.parse(files.get('package.json').toString('utf8'))
  assert.equal(manifest.name, name, 'Not an agent-hooks archive')
  if (source.release) assert.equal(source.release, `v${manifest.version}`, 'The archive version differs from its release')
  rmSync(target, { recursive: true, force: true })
  for (const [path, bytes] of files) {
    mkdirSync(dirname(join(target, path)), { recursive: true })
    writeFileSync(join(target, path), bytes)
  }
  const lock = {
    name,
    version: manifest.version,
    host,
    source,
    archiveSha256: sha256(archive),
    files: Object.fromEntries([...files].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([path, bytes]) => [path, sha256(bytes)])),
  }
  writeFileSync(lockFile, JSON.stringify(lock, null, 2) + '\n')
  return lock
}

const releaseSource = version => ({ release: `v${version}`, url: `https://github.com/${repository}/releases/tag/v${version}` })

// Online: the locked files are exactly the release's files for this host, and a
// newer release is reported without failing, since moving to it is a choice.
export async function verifyRelease({ lockFile } = paths, origin = 'https://github.com') {
  const lock = readLock(lockFile)
  assert.ok(lock?.source?.release, 'The lock does not name a release')
  const archive = await releaseArchive(lock.version, origin)
  assert.equal(sha256(archive), lock.archiveSha256, `The lock's archive SHA-256 differs from release ${lock.source.release}`)
  const files = forHost(unpack(archive), lock.host)
  assert.deepEqual(
    Object.fromEntries([...files].map(([path, bytes]) => [path, sha256(bytes)]).sort(([a], [b]) => a.localeCompare(b, 'en'))),
    Object.fromEntries(Object.entries(lock.files).sort(([a], [b]) => a.localeCompare(b, 'en'))),
    `The locked files differ from release ${lock.source.release}`,
  )
  const latest = await latestRelease(origin)
  return { lock, latest, behind: newer(latest, lock.version) }
}

function option(flag) {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : undefined
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const host = option('--host') ?? readLock()?.host
  if (process.argv.includes('--check')) {
    const lock = checkVendored()
    console.log(`${lock.name}@${lock.version} (${lock.host}): ${Object.keys(lock.files).length} vendored files match the lock`)
  } else if (process.argv.includes('--verify-release')) {
    const { lock, latest, behind } = await verifyRelease()
    console.log(`${lock.name}@${lock.version} (${lock.host}) matches release ${lock.source.release}`)
    if (behind) {
      const message = `agent-hooks v${latest} is released; this plugin vendors v${lock.version}. Move to it when this plugin needs it: npm run vendor:agent-hooks -- --version ${latest}`
      console.log(process.env.GITHUB_ACTIONS ? `::warning title=Newer agent-hooks release::${message}` : `Note: ${message}`)
    }
  } else if (option('--version') || option('--from')) {
    assert.ok(host, 'Name this plugin\'s host with --host claude-code or --host codex')
    const version = option('--version')
    const archive = version ? await releaseArchive(version) : packLocal(option('--from'))
    const lock = vendorArchive(archive, { host, source: version ? releaseSource(version) : { local: true } })
    checkVendored(paths, {})
    console.log(`Vendored ${name}@${lock.version} for ${host} from ${version ? lock.source.release : 'a local pack'}: ${Object.keys(lock.files).length} files`)
  } else {
    console.error('Usage: node scripts/vendor-agent-hooks.mjs --version <x.y.z> | --from <checkout> | --check | --verify-release [--host <host>]')
    process.exit(1)
  }
}
