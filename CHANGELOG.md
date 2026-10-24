# Changelog

## 0.0.3

Execution outcomes are saved before the delivery worker starts. Previously a
worker that could not start made every post-tool hook fail, so no outcome was
recorded or reported. Hooks no longer wait for the worker to start.

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
