---
name: status
description: Show the Actera connection, current mode, evaluation-failure behavior and delivery status.
disable-model-invocation: true
---

Run `node "${CLAUDE_PLUGIN_ROOT}/bin/actera-hook.mjs" status --mode "${user_config.mode}" --evaluation-failure "${user_config.evaluation_failure}"`.

Summarize whether Actera is connected, the current mode, and the evaluation-failure choice. In Monitoring, explain that tool calls always continue and the failure choice applies only in Enforcing. Report queued events and any delivery error without implying that pairing proves tool traffic has arrived. To change either setting, direct the user to Claude's `/config` panel. Do not edit the bridge configuration or Claude settings files.

Describe `queue.executionReports` as locally saved execution outcomes awaiting acknowledgement, and `queue.decisionRetries` as policy evaluations awaiting retry. Include the oldest pending age. These are different from already recorded Decisions. Report `delivery.state` (idle, sending, retrying, stopped), `nextRetryAt`, and the last delivery failure with its recovery time if present. A stopped worker with pending items needs attention; status starts it again. The worker retries without further tool calls. Do not claim that Actera is falling behind or that an empty lastError proves delivery is healthy. Queue counts are a snapshot and may change while this status command itself executes.
