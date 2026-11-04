// Shared with the other host plugins; keep the copies equal.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { gzipSync } from 'node:zlib'
import { checkVendored, forHost, releaseArchive, unpack, vendorArchive, verifyRelease } from '../../scripts/vendor-agent-hooks.mjs'

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

// A minimal npm pack archive: ustar entries under package/, gzipped.
function tarball(files) {
  const blocks = []
  for (const [path, text] of Object.entries(files)) {
    const body = Buffer.from(text)
    const header = Buffer.alloc(512)
    header.write(`package/${path}`, 0)
    header.write('0000644\0', 100)
    header.write('0000000\0', 108)
    header.write('0000000\0', 116)
    header.write(body.length.toString(8).padStart(11, '0') + '\0', 124)
    header.write('00000000000\0', 136)
    header.write('        ', 148)
    header.write('0', 156)
    header.write('ustar\0' + '00', 257)
    header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148)
    blocks.push(header, body, Buffer.alloc(Math.ceil(body.length / 512) * 512 - body.length))
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]))
}

const packageFiles = (version) => ({
  'package.json': JSON.stringify({ name: '@actera-ai/agent-hooks', version }),
  'src/core/bridge.mjs': 'export const core = 1\n',
  'src/hosts/claude-code/cli.mjs': 'export const claude = 1\n',
  'src/hosts/codex/cli.mjs': 'export const codex = 1\n',
  'vendor/gitleaks/manifest.json': '{}',
})

function workspace(t) {
  const directory = mkdtempSync(join(tmpdir(), 'vendor-agent-hooks-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return { target: join(directory, 'vendor'), lockFile: join(directory, 'lock.json') }
}

// Serves releases the way github.com does: assets under releases/download and
// the latest release as a redirect to its tag.
async function releases(t, published) {
  const server = createServer((request, response) => {
    const latest = request.url.endsWith('/releases/latest')
    if (latest) {
      response.writeHead(302, { location: `/Actera-AI/actera-agent-hooks/releases/tag/v${published.latest}` })
      return response.end()
    }
    const asset = published.assets[request.url]
    response.writeHead(asset ? 200 : 404)
    response.end(asset ?? 'Not Found')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  return `http://127.0.0.1:${server.address().port}`
}

function published(version, archive, checksum = `${sha256(archive)}  actera-ai-agent-hooks-${version}.tgz\n`) {
  const base = `/Actera-AI/actera-agent-hooks/releases/download/v${version}/actera-ai-agent-hooks-${version}.tgz`
  return { [base]: archive, [`${base}.sha256`]: checksum }
}

test('a plugin vendors the core and its own host only', () => {
  const files = unpack(tarball(packageFiles('1.2.3')))
  assert.deepEqual([...forHost(files, 'codex').keys()].sort(), ['package.json', 'src/core/bridge.mjs', 'src/hosts/codex/cli.mjs', 'vendor/gitleaks/manifest.json'])
  assert.deepEqual([...forHost(files, 'claude-code').keys()].filter(path => path.startsWith('src/hosts/')), ['src/hosts/claude-code/cli.mjs'])
  assert.throws(() => forHost(files, 'cursor'), /Unknown host/)
  const { 'src/hosts/codex/cli.mjs': _, ...withoutCodex } = packageFiles('1.2.3')
  assert.throws(() => forHost(unpack(tarball(withoutCodex)), 'codex'), /no src\/hosts\/codex/)
})

test('the lock records its release, and CI refuses a local pack or an edited file', (t) => {
  const paths = workspace(t)
  const archive = tarball(packageFiles('1.2.3'))
  const lock = vendorArchive(archive, { host: 'codex', source: { release: 'v1.2.3', url: 'https://example.invalid' } }, paths)
  assert.equal(lock.host, 'codex')
  assert.equal(lock.archiveSha256, sha256(archive))
  assert.equal(checkVendored(paths, { CI: 'true' }).version, '1.2.3')
  assert.throws(() => vendorArchive(archive, { host: 'codex', source: { release: 'v9.9.9' } }, paths), /differs from its release/)

  vendorArchive(archive, { host: 'codex', source: { local: true } }, paths)
  assert.throws(() => checkVendored(paths, { CI: 'true' }), /local pack/)
  assert.equal(checkVendored(paths, {}).source.local, true, 'A local pack is allowed outside CI')

  vendorArchive(archive, { host: 'codex', source: { release: 'v1.2.3' } }, paths)
  writeFileSync(join(paths.target, 'src/core/bridge.mjs'), 'export const core = 2\n')
  assert.throws(() => checkVendored(paths, { CI: 'true' }), /Vendored file changed: src\/core\/bridge.mjs/)
})

test('a release must match its published SHA-256 and the lock, and a newer release is noted', async (t) => {
  const paths = workspace(t)
  const archive = tarball(packageFiles('1.2.3'))
  const origin = await releases(t, { latest: '1.2.3', assets: published('1.2.3', archive) })
  vendorArchive(await releaseArchive('1.2.3', origin), { host: 'codex', source: { release: 'v1.2.3' } }, paths)
  assert.deepEqual((await verifyRelease(paths, origin)).behind, false)

  const newer = await releases(t, { latest: '1.10.0', assets: published('1.2.3', archive) })
  const result = await verifyRelease(paths, newer)
  assert.equal(result.latest, '1.10.0')
  assert.equal(result.behind, true)

  const tampered = await releases(t, { latest: '1.2.3', assets: published('1.2.3', archive, `${'0'.repeat(64)}  x.tgz\n`) })
  await assert.rejects(releaseArchive('1.2.3', tampered), /does not match its published SHA-256/)
  await assert.rejects(releaseArchive('1.2', origin), /Expected a version/)
  await assert.rejects(releaseArchive('2.0.0', origin), /HTTP 404/)

  // A lock edited after vendoring no longer matches its release.
  const other = tarball({ ...packageFiles('1.2.3'), 'src/core/bridge.mjs': 'export const core = 3\n' })
  vendorArchive(other, { host: 'codex', source: { release: 'v1.2.3' } }, paths)
  await assert.rejects(verifyRelease(paths, origin), /archive SHA-256 differs from release v1.2.3/)
})
