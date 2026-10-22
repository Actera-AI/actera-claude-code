import { copyFile, mkdir, writeFile, unlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// Exercise Claude's real userConfig loader without changing the developer's settings.
export async function isolatedClaudeSettings(directory, options) {
  const configDirectory = path.join(directory, 'claude-config')
  await mkdir(configDirectory, { recursive: true, mode: 0o700 })
  const credential = path.join(configDirectory, '.credentials.json')
  try {
    await copyFile(path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.credentials.json'), credential)
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  await writeFile(path.join(configDirectory, 'settings.json'), JSON.stringify({
    pluginConfigs: { 'actera@inline': { options } },
  }), { mode: 0o600 })
  return {
    env: { CLAUDE_CONFIG_DIR: configDirectory },
    cleanup: () => unlink(credential).catch(error => { if (error.code !== 'ENOENT') throw error }),
  }
}
