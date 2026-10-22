// Claude discovers mod tests inside the plugin. Stage a disposable test copy so
// contributors can run that suite without shipping tests to every installation.
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { pluginFiles, checkPlugin } from './check-plugin.mjs'

await checkPlugin()
const stage = new URL('../.tools/mod-tests/', import.meta.url)
await rm(stage, { recursive: true, force: true })
for (const name of pluginFiles) {
  const target = new URL(name, stage)
  await mkdir(new URL('.', target), { recursive: true })
  await copyFile(new URL('../plugins/actera/' + name, import.meta.url), target)
}
await copyFile(new URL('../test/mods/register.test.ts', import.meta.url), new URL('hooks/register.test.ts', stage))
await writeFile(new URL('tsconfig.json', stage), JSON.stringify({ extends: './.claude-plugin/types/tsconfig.json' }, null, 2) + '\n')
console.log('Staged native mod tests in .tools/mod-tests')
