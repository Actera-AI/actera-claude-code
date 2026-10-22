---
name: connect
description: Connect this Claude Code installation to an Actera agent through administrator browser approval, or with a setup code from Actera.
argument-hint: "[setup code]"
disable-model-invocation: true
---

Connect Actera without asking for or displaying a machine key.

The plugin includes its Actera API endpoint. Do not ask for an API URL or server configuration. Tell the user that tool inputs are sent by default after local sensitive-field redaction and bundled Gitleaks secret scanning. Detection is best effort; ordinary commands and message text remain visible. Existing connections keep their capture setting.

The command's arguments are: `$ARGUMENTS`. If they are a setup code from Actera (16 letters and digits, usually in four groups such as `7AHV-F8T0-M349-HPF7`), run `node "${CLAUDE_PLUGIN_ROOT}/bin/pair.mjs" --setup-code <code>` with that code instead. It connects to the agent an administrator made the code for, with no browser page. A code works once and expires after 30 minutes; if it fails, tell the user to get a new code from Actera. Otherwise run `node "${CLAUDE_PLUGIN_ROOT}/bin/pair.mjs"` in a terminal tool with a ten-minute timeout. If the user explicitly requests a reconnect, append `--reconnect`. The script opens Actera in the browser and waits for approval. The browser defaults to a new agent named Claude Code; an administrator can rename it or select an existing agent. Do not ask for policies, agent IDs, or fallback behavior. Keep the process attached until it reports the result. Never request, print, or pass a machine key through this skill or a Claude tool call. If the service is unavailable, tell the user to retry this command later.

After success, report the current Actera mode: **${user_config.mode}**. The saved choice for when Actera cannot evaluate is **${user_config.evaluation_failure}**; it applies only in Enforcing. Monitoring records policy results without blocking tool calls. The defaults are Monitoring and fail closed. Change either setting in Claude's `/config` panel; `/actera:status` shows the current settings and delivery status. Reconnecting preserves these settings. Configuration on the agent page assigns policies and never changes plugin mode. Execution reports are attached to the same decision, even when the host executes a blocked action. Do not describe pairing alone as proof that traffic has arrived.
