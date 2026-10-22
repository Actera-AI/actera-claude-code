# Installation and release checks

The marketplace is a catalog in this repository. It is not a listing in
Anthropic's official plugin directory. Claude Code installs a cached copy of the
plugin from the repository when the marketplace was added from GitHub.

## Repository access

Claude Code fetches the marketplace with the machine's existing Git
configuration and no interactive prompt. A public repository needs no
credentials. A fork or mirror that is private needs Git authentication first:
for HTTPS, configure a credential helper (`gh auth login` followed by
`gh auth setup-git` is one option); an SSH key loaded in `ssh-agent` also works.

The marketplace does not contain an Actera machine key. Installation and Actera
authentication are separate steps. A reviewer links their own Actera account
only when approval is needed.

## Before tagging

Run from a clean checkout:

```sh
npm test
npm run check:distribution
claude plugin validate . --strict
npm run test:mods
claude plugin validate .tools/mod-tests --strict
```

Set `CLAUDE_CONFIG_DIR` to a new disposable directory before installation (never
your normal Claude profile). In that configuration, install the local checkout to catch
missing files and invalid paths. After pushing the release commit, test the
GitHub source as well:

```sh
claude plugin marketplace add Actera-AI/actera-claude-code
claude plugin install actera@actera --scope user
claude plugin list
node scripts/check-plugin.mjs --installed
```

CI tests a local install on Linux, macOS, and Windows. Its remote-install job
tests the pushed branch or tag against a fresh Claude configuration. The checker
compares every installed runtime/license file and all six scanner
checksums with the checkout, rejecting extra files or a stale version. The
release workflow verifies an archive of the tag and attaches it to the GitHub
release. A release tag is immutable; publish a new version for a correction.

The marketplace follows `main`, so merging a manifest version makes it available
independently of GitHub Releases. Bump the manifest and changelog together and
require the branch CI checks before merging. Verify the pushed installation,
then tag that exact commit `v<version>`. The release workflow runs all checks again
before creating a source archive. A failed or unstarted CI run is not validation.

## Host acceptance

On a supported Claude Code host with access to the local Actera API, verify
setup, agent activation, an allowed call, a blocked call, a pending approval,
one linked-reviewer approval, an unavailable API, a queued report flush, and
plugin update. Check that Claude's own permission denial still wins when Actera
allows a call. Repeat in Claude Desktop before claiming Desktop support for a
release. CI fixtures and `claude plugin test` do not exercise that full host and
service path. Record hook latency for a normal session and a tool-heavy session;
the plugin runs command hooks for `PreToolUse`, `PostToolUse` and
`PostToolUseFailure`, plus native `classic.PreToolUse` and `tool.check` mod hooks.

Local hooks can be disabled or fail to start. Actera's decision is advisory in
that case; mandatory enforcement belongs at an application-owned gateway.
