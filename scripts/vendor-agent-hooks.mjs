// Claude installs a plugin as a folder without running npm, so the plugin ships
// the agent-hooks package's packed files and pins each one by SHA-256.
//   node scripts/vendor-agent-hooks.mjs <actera-ai-agent-hooks-x.y.z.tgz>
//   node scripts/vendor-agent-hooks.mjs --check
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const root = fileURLToPath(new URL('../', import.meta.url))
const target = resolve(root, 'plugins/actera/vendor/agent-hooks')
const lockFile = resolve(root, 'scripts/agent-hooks.lock.json')
const name = '@actera-ai/agent-hooks'
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

// npm pack writes a gzipped ustar archive with every entry under package/.
function unpack(archive) {
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

function vendored(directory = target, prefix = '') {
  const files = []
  for (const entry of readdirSync(join(directory, prefix), { withFileTypes: true })) {
    const path = prefix + entry.name
    if (entry.isDirectory()) files.push(...vendored(directory, path + '/'))
    else files.push(path)
  }
  return files.sort()
}

export function lockedFiles() {
  return Object.keys(JSON.parse(readFileSync(lockFile, 'utf8')).files).sort()
}

export function checkVendored() {
  const lock = JSON.parse(readFileSync(lockFile, 'utf8'))
  assert.equal(lock.name, name)
  assert.deepEqual(vendored(), Object.keys(lock.files).sort(), 'Vendored agent-hooks files differ from the lock')
  for (const [path, digest] of Object.entries(lock.files))
    assert.equal(sha256(readFileSync(join(target, path))), digest, `Vendored file changed: ${path}`)
  const manifest = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))
  assert.equal(manifest.version, lock.version, 'Vendored package version differs from the lock')
  return lock
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--check') {
    const lock = checkVendored()
    console.log(`${lock.name}@${lock.version}: ${Object.keys(lock.files).length} vendored files match the lock`)
  } else {
    assert.ok(process.argv[2], 'Usage: node scripts/vendor-agent-hooks.mjs <archive.tgz> | --check')
    const archive = readFileSync(resolve(process.argv[2]))
    const files = unpack(archive)
    const manifest = JSON.parse(files.get('package.json').toString('utf8'))
    assert.equal(manifest.name, name, 'Not an agent-hooks archive')
    rmSync(target, { recursive: true, force: true })
    for (const [path, bytes] of files) {
      mkdirSync(dirname(join(target, path)), { recursive: true })
      writeFileSync(join(target, path), bytes)
    }
    const lock = {
      name,
      version: manifest.version,
      archiveSha256: sha256(archive),
      files: Object.fromEntries([...files].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([path, bytes]) => [path, sha256(bytes)])),
    }
    writeFileSync(lockFile, JSON.stringify(lock, null, 2) + '\n')
    checkVendored()
    console.log(`Vendored ${name}@${manifest.version}: ${files.size} files`)
  }
}
