import { readFileSync } from 'node:fs'

const { userConfig } = JSON.parse(readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8'))

export class SettingsError extends Error {}

// Claude owns persistence and precedence. Hooks receive the effective options;
// standalone callers can supply the same environment without another config store.
export function runtimeSettings(env = process.env) {
  const values = {}
  for (const [key, schema] of Object.entries(userConfig)) {
    const value = env[`CLAUDE_PLUGIN_OPTION_${key.toUpperCase()}`] ?? schema.default
    if (!schema.options.includes(value))
      throw new SettingsError(`Invalid ${schema.title}. Choose a supported value in Claude /config.`)
    values[key] = value
  }
  return {
    mode: values.mode === 'Enforcing' ? 'ENFORCING' : 'MONITORING',
    onEvaluationError: values.evaluation_failure === 'Allow tool calls (fail open)' ? 'continue' : 'deny',
  }
}
