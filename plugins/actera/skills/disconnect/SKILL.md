---
name: disconnect
description: Disconnect this Claude Code installation from Actera and remove the plugin's local state.
argument-hint: "[--discard]"
disable-model-invocation: true
---

The command's arguments are: `$ARGUMENTS`. Run `node "${CLAUDE_PLUGIN_ROOT}/bin/actera-hook.mjs" disconnect`, appending `--discard` only when the arguments are exactly `--discard`.

The command first delivers queued execution reports and policy evaluations. If it reports that some could not be delivered, tell the user how many and the error, and that nothing was removed. They can retry later, or run `/actera:disconnect --discard` to delete them. Never add `--discard` on your own.

After success, tell the user that this machine's Actera key, reviewer link, queued reports and archives were removed, and the background delivery worker and scanner were stopped. The command also ends the connection in Actera, so the agent shows as disconnected there and the key stops working. If the result has `revoked: false`, Actera could not be reached or refused: say so with `revokeError`, and that an administrator should disconnect the agent on its page in Actera. The plugin stays installed but does nothing until `/actera:connect` runs again; to remove it, run `claude plugin uninstall actera@actera` in a terminal. Do not edit Claude settings or the bridge state directory yourself.
