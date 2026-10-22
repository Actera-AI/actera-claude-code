import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { checkPlugin, pluginFiles } from '../../scripts/check-plugin.mjs'

test('installation validation rejects development files, missing licenses and changed runtime code', async () => {
  const stage = await mkdtemp(join(tmpdir(), 'actera-distribution-'))
  try {
    for (const name of pluginFiles) {
      const target = join(stage, name)
      await mkdir(dirname(target), { recursive: true })
      await copyFile(new URL('../../plugins/actera/' + name, import.meta.url), target)
    }
    await checkPlugin(stage)
    await mkdir(join(stage, '.in_use'))
    await writeFile(join(stage, '.in_use', '1234'), '')
    await checkPlugin(stage)
    await writeFile(join(stage, '.in_use', 'unexpected.js'), 'not a host marker')
    await assert.rejects(checkPlugin(stage), /exactly the runtime files/)
    await rm(join(stage, '.in_use', 'unexpected.js'))
    await writeFile(join(stage, 'test.test.ts'), 'development-only')
    await assert.rejects(checkPlugin(stage), /exactly the runtime files/)
    await rm(join(stage, 'test.test.ts'))
    await rm(join(stage, 'LICENSE'))
    await assert.rejects(checkPlugin(stage), /exactly the runtime files/)
    await copyFile(new URL('../../LICENSE', import.meta.url), join(stage, 'LICENSE'))
    await writeFile(join(stage, 'bin/actera-hook.mjs'), '// stale installation')
    await assert.rejects(checkPlugin(stage), /Installed file differs/)
  } finally {
    await rm(stage, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
