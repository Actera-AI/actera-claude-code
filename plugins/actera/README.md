# Actera for Claude Code

Actera decides whether AI agents may take actions. This plugin sends each Claude Code tool call to your Actera workspace before it runs. Your policies allow it, block it, or hold it for a person's approval, and every attempt is recorded as a decision with its outcome.

The plugin works in Claude Code only: the terminal, the IDE extensions, and the Code tab in Claude Desktop. It needs an Actera account, Node.js 22 or later, and Claude Code 2.1.292 or later with mods enabled.

To review activity or write policies from a conversation, add the separate [Actera connector](https://docs.actera.dev/integrations/claude/). The plugin governs the agent. The connector is for the people running Actera.

## Get started

1. If you already installed this plugin from the `Actera-AI/actera-claude-code` marketplace, remove that copy first with `claude plugin uninstall actera@actera`, so only one copy runs.
2. Run `/reload-plugins` or start a new session.
3. Run `/actera:connect`. A browser page opens for a workspace admin to name the agent or select an existing one. Check that the short code in Claude matches the page.

The plugin starts in Monitoring mode, which records decisions and never blocks. To block and hold calls, open `/config` and set **Actera mode** to Enforcing.

| Command | What it does |
| --- | --- |
| `/actera:connect` | Connects this machine to an Actera agent |
| `/actera:status` | Shows the current settings and whether reports are being delivered |
| `/actera:disconnect` | Delivers queued reports, ends the connection in Actera, and removes local state |

## Examples

- **See what your agent did.** Connect in Monitoring mode, ask Claude to fix a bug, then open Decisions in Actera to see each file edit and shell command it attempted.
- **Block a command.** Publish a policy that denies `git push --force`, assign it to the agent, set Enforcing mode, and ask Claude to force-push. The call is denied and the reason appears in Claude Code.
- **Require approval.** Publish a policy that requires approval for a tool such as `Bash`, then ask Claude to run a command. The call waits in Claude Code while a linked reviewer chooses **Allow once** or **Deny**.

## Modes and failures

- **Monitoring** asks Actera about every call and records the result without blocking.
- **Enforcing** denies blocked calls and holds calls that need approval. If Actera cannot be reached, calls are blocked by default. You can change that in `/config` by setting **When Actera cannot evaluate** to allow.

When a workspace reaches its monthly decision limit, Enforcing mode blocks calls and says so. Monitoring continues.

## What the plugin sends

The plugin connects only to the Actera service at `https://app.actera.dev`, over HTTPS.

Each decision request and execution report contains the tool name, the redacted tool input, the MCP server key and name for MCP tools, Claude's session, prompt, subagent and tool-use identifiers, the working directory, and the permission mode.

Sensitive field names are masked, and Gitleaks looks for credentials in argument strings, before anything is stored or sent. Detection is best effort. Ordinary commands and message text remain visible to policies. Prompt text, model output, and tool results are never sent.

Privacy policy: <https://actera.dev/legal/privacy-policy>

## What the plugin runs on your machine

- **Hooks** on `PreToolUse`, `PostToolUse`, and `PostToolUseFailure` run `bin/actera-hook.mjs` with Node.js.
- **A mod** in `hooks/register.js` shows **Allow once** and **Deny** for held calls.
- **A delivery worker** runs in the background, sends queued reports to Actera, and exits after five minutes with nothing to do. The next hook starts it again.
- **Gitleaks 8.30.1** ships as compiled programs for Windows, macOS, and Linux in `vendor/agent-hooks/vendor/gitleaks`. They come from the Gitleaks project, and the plugin checks them against pinned checksums before unpacking one to `~/.actera/claude-code`. It runs as a local helper that receives tool inputs over authenticated loopback, never sends them anywhere, and exits after five minutes idle.
- **`/actera:connect`** opens your browser and stores a scoped key.

Keys, settings, and queued events are stored in `~/.actera/claude-code`. The agent key cannot administer the workspace or read full decisions. `/actera:disconnect` removes the key, the reviewer link, and queued reports.

A local hook that is disabled or fails cannot guarantee enforcement. Mandatory enforcement belongs in an application-owned tool gateway.

## Help

- Source and troubleshooting: <https://github.com/Actera-AI/actera-claude-code>
- Issues: <https://github.com/Actera-AI/actera-claude-code/issues>
- Support: hello@actera.dev

Licensed under Apache-2.0. Gitleaks is licensed under MIT; see `vendor/agent-hooks/vendor/gitleaks/LICENSE`.
