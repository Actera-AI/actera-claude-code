# Actera for Claude Code

Evaluate Claude Code tool calls against Actera policies, request approval when
needed, and record tool outcomes. The plugin supports built-in tools and MCP
tools through Claude's hooks and mods.

Licensed under [Apache-2.0](LICENSE). The Actera service requires an account.

## Status

This is an alpha release. The plugin is tested on Linux, macOS, and Windows,
but its behavior and settings can still change between minor versions before
1.0. Breaking changes are listed in [CHANGELOG.md](CHANGELOG.md).

## Installation

Requires Node.js 22+, Claude Code 2.1.292+ with mods enabled, and an Actera API
with agent connection pairing. Run these commands in a terminal:

```sh
claude plugin marketplace add Actera-AI/actera-claude-code
claude plugin install actera@actera --scope user
```

In Claude Code (the terminal or a local Code session in Claude Desktop), run
`/reload-plugins` or start a new session, then run `/actera:connect`.
The plugin connects to the Actera service automatically. No API URL or machine
key is needed.
The Chat/Cowork plugin search is a separate
directory; this repository is installed into Claude Code through its Git
marketplace. A browser page opens for a workspace administrator to name a new
agent or select an existing one. Confirm that the short code in Claude matches
the page.
With a setup code from the Actera Overview, run `/actera:connect <setup code>`
instead. The code already names the agent, so no browser page opens. It works
once and expires after 30 minutes.
The plugin waits for approval and stores the resulting agent-bound machine key
locally without displaying it in the conversation. Tool inputs are captured by default after local field-name redaction and scanning with the bundled Gitleaks engine. Prompt text and tool responses are not forwarded.
The default Actera mode is **Monitoring**. Every tool attempt creates a decision,
including when no policy applies (using the agent's configured Allow/Deny default). The Decisions page contains the policy
result and reported execution outcome.

Configure policies on the agent page. Open Claude's `/config` panel, or run
`/plugin configure actera@actera`, to choose:

- **Actera mode**: Monitoring (default) or Enforcing.
- **When Actera cannot evaluate**: Block tool calls (fail closed, default) or
  Allow tool calls (fail open). This applies only in Enforcing mode; Monitoring
  always continues. Explicit denials and required approvals remain enforced.

Claude stores both choices in its user settings. Reconnecting does not reset them,
report backlogs do not prevent changing them, and agent configuration never changes
plugin mode. Use `/actera:status` to see the effective settings and delivery status.
Run `/actera:disconnect` before uninstalling to deliver queued reports and remove
local state; see [operations](docs/operations.md#credential-rotation).
After changing settings, use `/reload-plugins` or start a new session before relying
on the new behavior.

Claude Code fetches the marketplace with the machine's Git configuration. See
[installation checks](docs/installation-checks.md) for verifying an
installation. Local API setup is in [CONTRIBUTING.md](CONTRIBUTING.md).

## Usage

In either mode, each `PreToolUse` call requests an Actera decision. In enforcing mode, allowed calls continue through
Claude's native permission flow; blocked calls are denied. Pending approvals
hold the original call while the mod offers **Allow once** or **Deny**. The
reviewer links an Actera account, and Actera checks their approval eligibility.
Approval releases the held call once and preserves other native permission denials.

Enforcing mode denies on evaluation errors by default. Monitoring continues and
queues the request for later evaluation and reporting. A delayed evaluation uses
the policies available when it reaches Actera; the original failure remains in
local plugin status. Outcome reports retain their original action and decision
identity on retry.
A disabled or failed local hook cannot guarantee enforcement. Mandatory enforcement
belongs in an application-owned tool gateway.

MCP action types follow `claude.mcp.<operation>`. Policies match that operation
across MCP servers unless narrowed by context. Reported server names and keys
are identifiers supplied by Claude, not proof of the upstream provider.

| Claude event                     | Reported outcome |
| -------------------------------- | ---------------- |
| `PostToolUse`                    | Tool succeeded   |
| `PostToolUseFailure`             | Tool failed      |
| Interrupted `PostToolUseFailure` | Tool cancelled   |

These reports describe Claude's tool lifecycle. They do not prove that an
external business effect settled or settle managed execution reservations.

## Data and credentials

`tool-inputs` is the default for new connections. The plugin redacts sensitive
field names and uses bundled Gitleaks 8.30.1 to detect credentials inside argument
strings before storing or sending them. Ordinary commands, Slack destinations,
and message text remain available to policies. Secret detection is best effort;
it is not general PII anonymization or a guarantee that all credentials are found.
The original tool input is unchanged. Decisions include `context.input_capture`
with capture status and redacted JSON pointer paths, reasons, and detector rule IDs.

Each decision request sends the tool name, the redacted tool input (or only its
field names in `metadata` mode), the MCP server key and name for MCP tools, and
Claude's session, prompt, subagent, and tool-use identifiers, working directory,
and permission mode. Execution reports repeat the same action and context.
Prompt text, model output, and tool results are never sent.

The scanner is bundled for Windows, macOS, and Linux (x64 and ARM64), verified
against pinned checksums, and starts a persistent local helper on demand. Tool
inputs travel only over authenticated IPv4 loopback to the helper; they are never
sent to an external scanning service or written to raw-input temporary files.
The helper loads Gitleaks rules once, exits after five minutes idle, and restarts
when needed. No separate scanner installation or system service is required.
`metadata` remains an explicit option to omit argument values. Existing connections
keep their capture setting until changed; see [operations](docs/operations.md).
On scanner failure or oversized input, monitoring records an explicit omission;
enforcing follows the configured evaluation-error behavior (deny by default).
Raw inputs are never sent as a fallback. Requests use HTTPS outside loopback and
reject redirects.

Configuration, credentials, and queued events live under `~/.actera/claude-code`.
The scoped key cannot administer the workspace or read full Decisions. It has
only the operations granted by the administrator. Human approval uses
a separate linked-reviewer credential. Protect the local account and state
directory; Unix files are owner-only, while Windows inherits profile ACLs.
Never put either credential in the repository or Claude settings.

See [operations.md](docs/operations.md) for queue behavior, reviewer linking,
capture settings, and troubleshooting, and [SECURITY.md](SECURITY.md) for reports.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for checks, updating the vendored hook package
and release instructions. [Integration tests](docs/integration-tests.md) cover the
offline behavior and optional native Claude configuration checks. Development files stay outside the
installed plugin; it contains runtime hooks, skills, scanner bundles and licenses.

## Updates

CI cancels superseded runs and skips the test matrix only for explicitly
informational documentation changes. Distribution and secret checks still run.
Main-branch selection includes changes since the last successful CI run, so a
documentation push cannot hide cancelled code checks. **Run workflow** on `ci`
forces all checks; `ci-result` is the aggregate check for branch protection.

Releases reuse successful full CI for the exact tagged commit on `main`, including
the `release-ready` check. They do not repeat the test suite. A tag pushed while CI
is running is picked up when CI succeeds. A failed, cancelled or documentation-only
run cannot authorize a release. Prefer tagging the current main commit after CI
passes; to release a documentation-only commit, run `ci` manually on main first.
The release workflow can also be retried manually with an existing version tag.

The marketplace follows `main`. Updating it can install a new manifest version
before a GitHub release is published; tags do not gate marketplace delivery.
Run `claude plugin update actera@actera`, then `/reload-plugins` or start a new
session. See [installation checks](docs/installation-checks.md).

## Security

Report vulnerabilities privately to [hello@actera.dev](mailto:hello@actera.dev).
See [SECURITY.md](SECURITY.md) for what to include.
