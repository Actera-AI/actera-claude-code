# Operating the Claude Code integration

Use `/actera:status` in Claude to see the effective mode, failure behavior, and
delivery status. For developer diagnostics, run these commands from the repository root:

```sh
node plugins/actera/bin/actera-hook.mjs status
node plugins/actera/bin/actera-hook.mjs flush
```

`status` shows queue depth, the latest delivered event, and the last delivery
error. A recent delivery and empty queue mean Actera accepted the decision reports. Every tool attempt creates a Decision. Non-tool lifecycle hooks are not collected. Start a new Claude session after plugin updates or use
`/reload-plugins`; an existing session may still be running older hook code.

## Reviewer linking

The native approval prompt offers account linking when needed. To link ahead
of time, run `node plugins/actera/bin/actera-hook.mjs link`, open the
printed URL, sign in, and select **Link this account**. The URL expires after
ten minutes. Check with `node plugins/actera/bin/actera-hook.mjs link-status`.

Linking ends when the browser session expires, on sign-out, after eight hours,
or when the integration is disabled. Run `link` again to renew it. The reviewer
credential lives in `reviewer.json` in the bridge state directory. Someone who
can read that file or modify the plugin may misuse its delegated authority.

**Allow once** approves the existing Decision and releases that call once.
**Deny** rejects it. Skip or an unrecognized answer leaves it pending. Without
the mod, approve in Actera and retry the same tool and arguments in the same
session within one hour. Another invocation needs its own decision.

## Capture and error settings

Flush queued events before changing capture mode:

```sh
node plugins/actera/bin/actera-hook.mjs flush
node plugins/actera/bin/actera-hook.mjs capture --mode tool-inputs
```

New connections use `tool-inputs` by default. Existing connections retain their
setting until explicitly changed with the command above. Use `metadata` only when
you intentionally want to omit argument values. Both modes capture decisions.

Gitleaks runs locally before input values reach the queue or API. Known sensitive
field names are also redacted. `context.input_capture` records `complete`,
`redacted`, or `omitted`, with JSON pointer paths and rule IDs for redactions.
The decision page displays the capture status. Redaction is best effort, does not
remove all PII, and does not make an arbitrary command safe. Policies see the
sanitized values, including `[redacted]` markers, not the removed originals.

If verification, startup, scanning, or parsing fails, no raw values are sent or
queued. Monitoring records a decision with omitted inputs and records the error
in plugin status. Enforcing treats this as an evaluation error (deny by default;
`continue` remains an explicit host choice). Unsupported platforms behave the same.
Scanning has a 3-second server limit and a 4-second client deadline; helper startup has an 8-second deadline. Inputs over
512 KiB are omitted. Decisions without values cannot evaluate those values.

The persistent helper is scoped to the bridge state directory and bundled binary
version. Concurrent hooks share one process. The client verifies the binary's
checksum and challenges the helper before disclosing credentials or tool input.
Scan requests then use a random local bearer credential. The helper rejects
browser-origin requests and never reads repository scanner overrides or allow
comments. Credentials and the ephemeral port live in an owner-private state file.
It exits after five minutes without authenticated work and restarts after a crash.
Stop it immediately with:

```sh
node plugins/actera/bin/actera-hook.mjs scanner-stop
```

No input or findings cache is retained between scans. The helper has no filesystem
scan API and no external network dependency. See [performance measurement](scanner-performance.md).

Open Claude's `/config` panel and change **When Actera cannot evaluate**.
**Block tool calls (fail closed)** is the default; **Allow tool calls (fail open)**
continues when evaluation fails. This covers service outages, HTTP errors,
timeouts, invalid responses, and local input-scanning failures. It applies only
in Enforcing mode. Explicit blocked, rejected, or pending Decisions remain
blocked. Invalid plugin settings themselves are rejected, not treated as fail open.
Hook startup failures and host-enforced timeouts remain subject to Claude's behavior.

## Offline delivery

Hooks persist reports durably and hand delivery to one local worker process per
bridge directory (see [Execution report delivery](#execution-report-delivery)).
A failed delivery backs off before retrying; `flush` retries immediately.
The queue holds up to 256 reports. When full, recording fails visibly in status; policy checks still run. Flush the queue to restore reporting. A persistent backlog
appears in `status`; ordinary lifecycle hooks do not repeatedly print the same
queue-full error in Claude. A full queue does not bypass policy checks. In enforcing mode, handled evaluation errors deny by default. Monitoring does not emit permission denials.

Reports keep their original body and idempotency key across retries. Identity or
capture changes with the same key are rejected while events are pending. A new
browser-approved connection archives the prior key and its undelivered events
under `~/.actera/claude-code/archived/`; the old events are not replayed using
the new key. The connection command reports the archive location. The archive
can contain tool inputs and credentials, so keep it private and review it before
removing it. Approval and correlation files expire after seven days. Hook input
is limited to 16 MiB; forwarded tool input is limited to 512 KiB, with oversized
input marked as omitted.

## Credential rotation

If the machine key is unavailable or compromised, deactivate it in Actera Admin,
then run `/actera:connect` and request a reconnect. The browser preselects
the previous agent; approve it to preserve the identity and its policy configuration.
Deactivation revokes the old key and its reviewer links; link the reviewer again.
If events remain queued, the new connection preserves the prior state in an
archive. Those events cannot be delivered using the new key.

To disable or remove the plugin:

```sh
claude plugin disable actera@actera
claude plugin uninstall actera@actera --scope user
```

Disabling the plugin does not revoke server credentials or erase local state.
Disable the agent key in Actera when retiring the plugin.

## Plugin mode

Choose **Actera mode** in Claude's `/config` panel: **Monitoring** or **Enforcing**.
The default is Monitoring. Both this and the evaluation-failure choice live in
Claude's user settings, not the bridge credential file. Reconnecting preserves
them. Mode changes do not require draining the report queue: queued requests keep
their original mode. Registration and policy configuration never change this setting.
After changing settings, reload plugins or start a new session. Check
`/actera:status` before relying on the new behavior.

Standalone developer commands do not inherit Claude's plugin options. For test harnesses,
supply `CLAUDE_PLUGIN_OPTION_MODE` (`Monitoring` or `Enforcing`) and
`CLAUDE_PLUGIN_OPTION_EVALUATION_FAILURE` (`Block tool calls (fail closed)` or
`Allow tool calls (fail open)`). Without those values, standalone commands use
the manifest defaults; use the slash command for actual session status.
Monitoring defaults to continuing during API outages. Its queued reports carry the
original decision request and create that decision idempotently on recovery. Late
evaluation uses the policy state at recovery. The original error remains in local
plugin status; it is not appended to the recovered outcome report.

## Execution report delivery

Hooks durably save execution reports and wake a single background Node worker. A hook writes its report before it starts the worker and does not wait for the worker to start, so a slow or blocked worker cannot drop a report or hold up Claude. It drains batches independently of further tool calls, retaining files until the API acknowledges them. An OS-owned loopback socket elects one sender per bridge directory; concurrent startup and manual flushes share that sender. Only the authenticated local control channel can flush or stop it. API keys and report bodies are never sent over that channel.

Failures retry after 1, 2, 4, 8, 16, then at most 30 seconds. A lost acknowledgement retries the same idempotency key. The worker keeps retrying while reports are queued, and exits after five minutes with an empty queue and no tool calls. It also exits when its bridge directory or connection is removed, and publishes its discovery file again if that file is deleted. Neither the worker nor the scanner helper runs from the plugin or project folder, so they do not block deleting either. After the worker exits, or after a process or machine restart, the next hook or `/actera:status` starts it again and resumes the durable queue. `node plugins/actera/bin/actera-hook.mjs delivery-stop` stops the current worker without deleting reports.

Status separates `queue.executionReports` from `queue.decisionRetries`, and reports `oldestPendingAgeSeconds`. `delivery.state` is `idle`, `sending`, `retrying`, or `stopped`; `nextRetryAt`, `lastError`, and `recoveredAt` describe delivery independently from evaluation failures. Pending reports are local delivery backlog, not proof of a slow Actera service. Checking status can start a stopped worker, and the status tool's own execution report arrives after its snapshot.
