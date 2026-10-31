// Check both the source plugin and the actual Claude installation, not the repo archive.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { lockedFiles } from './vendor-agent-hooks.mjs'

const gitleaks = 'vendor/agent-hooks/vendor/gitleaks'
export const pluginFiles = [
  '.claude-plugin/plugin.json', 'LICENSE', 'NOTICE',
  'bin/actera-hook.mjs', 'bin/pair.mjs',
  'hooks/hooks.json', 'hooks/register.js',
  'skills/connect/SKILL.md', 'skills/disconnect/SKILL.md', 'skills/status/SKILL.md',
  ...lockedFiles().map(file => `vendor/agent-hooks/${file}`),
].sort()
const source = resolve(fileURLToPath(new URL('../plugins/actera/', import.meta.url)))

async function filesAt(root, prefix = '') {
  const result = []
  for (const entry of await readdir(resolve(root, prefix), { withFileTypes: true })) {
    const name = prefix + entry.name
    // Claude creates these host types during validation; they are not shipped.
    if (root === source && (name === '.claude-plugin/types' || name === 'tsconfig.json')) continue
    assert.ok(!entry.isSymbolicLink(), `Plugin must be self-contained: ${name}`)
    // Claude creates numeric PID markers in a loaded installation. They are
    // host bookkeeping, never part of the shipped payload.
    if (root !== source && /^\.in_use\/\d+$/.test(name) && entry.isFile()) continue
    if (entry.isDirectory()) result.push(...await filesAt(root, name + '/'))
    else result.push(name)
  }
  return result.sort()
}

export async function checkPlugin(root = source) {
  root = resolve(root)
  assert.deepEqual(await filesAt(root), pluginFiles, 'Installed plugin must contain exactly the runtime files and licenses')
  const expected = JSON.parse(await readFile(resolve(source, '.claude-plugin/plugin.json'), 'utf8'))
  const manifest = JSON.parse(await readFile(resolve(root, '.claude-plugin/plugin.json'), 'utf8'))
  assert.equal(manifest.version, expected.version, 'Installed plugin version differs from this checkout')
  for (const file of pluginFiles) {
    assert.ok((await readFile(resolve(root, file))).equals(await readFile(resolve(source, file))), `Installed file differs: ${file}`)
  }
  assert.deepEqual(await readFile(resolve(root, 'LICENSE')), await readFile(new URL('../LICENSE', import.meta.url)), 'Installed project license differs')
  const bundles = JSON.parse(await readFile(resolve(root, gitleaks, 'manifest.json'), 'utf8'))
  const hash = bytes => createHash('sha256').update(bytes).digest('hex')
  for (const entry of Object.values(bundles.binaries)) {
    const bytes = await readFile(resolve(root, gitleaks, entry.file))
    assert.equal(hash(bytes), entry.compressedSha256)
    assert.equal(hash(gunzipSync(bytes)), entry.sha256)
  }
  console.log(`Plugin ${manifest.version}: ${pluginFiles.length} runtime/license files verified at ${root}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let target = process.argv[2]
  if (target === '--installed') {
    assert.ok(process.env.CLAUDE_CONFIG_DIR, 'Set an isolated CLAUDE_CONFIG_DIR first')
    const state = JSON.parse(await readFile(resolve(process.env.CLAUDE_CONFIG_DIR, 'plugins/installed_plugins.json'), 'utf8'))
    const entries = state.plugins['actera@actera']
    assert.equal(entries?.length, 1, 'Expected one isolated user installation')
    target = entries[0].installPath
  }
  await checkPlugin(target)
}
