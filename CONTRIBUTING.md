# Contributing

Open a pull request with the problem, the resulting behavior, and the checks you
ran. Keep unrelated changes separate. Run these checks with Node.js 22+ and Claude Code 2.1.292+:

```sh
npm ci
npm test
npm run test:mods
npm run check:distribution
claude plugin validate . --strict
claude plugin validate .tools/mod-tests --strict
```

Let CI pass before merging. `test/unit` contains offline tests; `test/mods`
contains native mod tests. The mod runner stages a disposable plugin under
`.tools/mod-tests` because Claude discovers tests inside a plugin. Scope a
`tool.check` mock to the tool under test: the review prompt is an
AskUserQuestion tool call that runs the permission check as well, and an
unscoped deny swallows it. Never put contributor tests or generated host types
in the installed payload.

Use synthetic fixtures. Do not commit credentials, customer data, captured
sessions, local configuration, or build caches. The distribution check reviews
tracked paths; the secret scan checks Git history. Neither replaces review of
new examples, fixtures, and release contents.

The hook bridge, delivery worker, input capture and bundled scanner come from
the [agent-hooks package](https://github.com/Actera-AI/actera-agent-hooks), vendored under
`plugins/actera/vendor/agent-hooks`. Change them in that package, run `npm pack` there, then vendor the archive here
with `npm run vendor:agent-hooks -- <archive.tgz>`. The script records every file's
SHA-256 in `scripts/agent-hooks.lock.json`; `npm test` and the installation check
reject any vendored file that differs. Do not edit vendored files in place. The
package owns the API contract snapshot, scanner sources and their checks.

Describe user-visible changes in `CHANGELOG.md`. Release tags are immutable;
publish a new version for corrections. Follow the
[installation checks](docs/installation-checks.md) before tagging. Never commit
customer data or credentials to make an example work. Participation is governed
by the [code of conduct](CODE_OF_CONDUCT.md).

The plugin connects to the hosted service defined in
`plugins/actera/vendor/agent-hooks/src/core/defaults.mjs`; users never see or choose an endpoint. For
local development, set `ACTERA_API_ORIGIN` (HTTPS, or HTTP on loopback) in the
shell that launches Claude Code or the test harness, then run `/actera:connect`.
The override applies only at pairing time and is stored as that connection's
`baseUrl`, so switching services means reconnecting. The connect output names
the override when one is active. The developer-only `actera-hook.mjs setup`
command honors the same variable and `--base-url ORIGIN`. Keep the test agent,
machine key, and bridge state outside the repository.

## Integration coverage

Keep plugin behavior covered by offline tests against the supported contract.
Optional native-host configuration checks live under `test/integration` and use
local HTTP fixtures. See [integration tests](docs/integration-tests.md).
