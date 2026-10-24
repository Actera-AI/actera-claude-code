---
name: disconnect
description: Disconnect this Claude Code installation from Actera and remove the plugin's local state.
argument-hint: "[--discard]"
disable-model-invocation: true
---

The command's arguments are: `$ARGUMENTS`. Run `node "${CLAUDE_PLUGIN_ROOT}/bin/actera-hook.mjs" disconnect`, appending `--discard` only when the arguments are exactly `--discard`.

The command first delivers queued execution reports and policy evaluations. If it reports that some could not be delivered, tell the user how many and the error, and that nothing was removed. They can retry later, or run `/actera:disconnect --discard` to delete them. Never add `--discard` on your own.

After success, tell the user that this machine's Actera key, reviewer link, queued reports and archives were removed, and the background delivery worker and scanner were stopped. The plugin stays installed but does nothing until `/actera:connect` runs again; to remove it, run `claude plugin uninstall actera@actera` in a terminal. Disconnecting does not revoke the agent key in Actera, so an administrator should disable it on the agent page if this machine should no longer report. Do not edit Claude settings or the bridge state directory yourself.
