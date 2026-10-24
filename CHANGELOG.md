# Changelog

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
