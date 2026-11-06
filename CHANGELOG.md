# Changelog

## 0.0.10

Prepares the plugin for Anthropic's directory, which refuses a mod that answers `allow` and skills
that read options with allowed values. Adds a README and icon inside the plugin folder. The mod now
reviews a held call from `tool.call` and runs the PreToolUse hook again, and the hook releases the
call once Actera reports the approval. Approval still releases one call. `/actera:status` reads the
mode and evaluation-failure choice that hooks saved. Vendors
[agent-hooks](https://github.com/Actera-AI/actera-agent-hooks) 0.4.2.

## 0.0.9

When a workspace reaches its monthly decisions, Claude Code says so once a day, `/actera:status`
shows why, and the plugin waits until Actera accepts requests again instead of retrying every
30 seconds. Enforcing mode behaves as before, and a denied call now explains the limit. Vendors
[agent-hooks](https://github.com/Actera-AI/actera-agent-hooks) 0.4.1.

## 0.0.8

`/actera:disconnect` also ends the connection in Actera, so the agent shows as
disconnected and its key stops working. If Actera cannot be reached, local state is still
removed and the command says to disconnect the agent in Actera. Vendors
[agent-hooks](https://github.com/Actera-AI/actera-agent-hooks) 0.4.0.

## 0.0.7

Vendors only the core and the Claude Code adapter of
[agent-hooks](https://github.com/Actera-AI/actera-agent-hooks) 0.3.3, taken from its
published release. Behavior is unchanged: 0.3.3 only changed the Codex adapter.

## 0.0.6

Questions Claude asks with `AskUserQuestion`, including Actera's own review
prompt, report their outcome again. Claude adds the answer to the tool input
after the call is checked, so the report did not match the checked call and
`/actera:status` showed a delivery error after every question. Uses
[agent-hooks](https://github.com/Actera-AI/actera-agent-hooks) 0.3.2.

## 0.0.5

The hook bridge, delivery worker, pairing and bundled scanner now come from the
[agent-hooks package](https://github.com/Actera-AI/actera-agent-hooks) 0.3.1,
vendored in the plugin and pinned by checksum. Decisions, execution reports,
local state and settings are unchanged; existing connections and queued reports
carry over. New connections tell Actera they come from Claude Code. The scanner
helpers were rebuilt from the same Gitleaks and dependency versions.

## 0.0.4

When a held tool call is approved and released, Claude is told that Actera
held it and which Decision approved it. Previously Claude saw only the tool's
result and could describe the call as one that ran without a check.

## 0.0.3

Execution outcomes are saved before the delivery worker starts. Previously a
worker that could not start made every post-tool hook fail, so no outcome was
recorded or reported. Hooks no longer wait for the worker to start.

The delivery worker exits after five minutes with an empty queue and no tool
calls, and when its bridge directory or connection is removed. Uninstalling the
plugin or deleting `~/.actera` no longer leaves a worker running indefinitely.
A worker whose discovery file is deleted publishes it again instead of blocking
every new worker. The worker and scanner helper no longer run from the plugin
or project folder, which blocked deleting those folders on Windows.

`/actera:disconnect` delivers queued reports, stops the worker and scanner, and
removes this machine's Actera state. Run it before uninstalling the plugin.

A held tool call is released when its Decision is approved on the Actera
Decision page while Claude's review prompt is open. Previously, closing the
prompt or choosing **Not now** kept the call denied as awaiting approval even
after it was approved. The link prompts also offer **I've approved it in Actera**.

## 0.0.2

`/actera:connect <setup code>` connects with a setup code from the Actera
Overview. The code names the agent, so no browser approval is needed. It works
once and expires after 30 minutes.

## 0.0.1

Initial alpha release of Actera for Claude Code: policy decisions for built-in
and MCP tool calls, native approval through a linked reviewer, local input
redaction with the bundled Gitleaks scanner, and durable execution reports
delivered by a local worker. Behavior and settings can change between minor
versions before 1.0.
