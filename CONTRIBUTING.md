# Contributing

Open a pull request with the problem, the resulting behavior, and the checks you
ran. Keep unrelated changes separate. Run these checks with Node.js 22+, Go 1.27.0 and Claude Code 2.1.292+:

```sh
npm ci
npm test
npm run test:mods
npm run check:distribution
node scripts/bundle-gitleaks.mjs
node scripts/scanner-notices.mjs --check
claude plugin validate . --strict
claude plugin validate .tools/mod-tests --strict
```

Let CI pass before merging. `test/unit` contains offline tests; `test/mods`
contains native mod tests. The mod runner stages a disposable plugin under
`.tools/mod-tests` because Claude discovers tests inside a plugin. Never put
contributor tests or generated host types in the installed payload.

Use synthetic fixtures. Do not commit credentials, customer data, captured
sessions, local configuration, or build caches. The distribution check reviews
tracked paths; the secret scan checks Git history. Neither replaces review of
new examples, fixtures, and release contents.

API changes originate in the backend repository. Export a reviewed contract to
`actera-api`, release it, and import that exact tag into each consumer with
`node scripts/update-contract.mjs <actera-api-checkout>`. Do not edit a consumer's
contract snapshot independently. Review handwritten clients as well as generated
types when changing a contract.

Describe user-visible changes in `CHANGELOG.md`. Release tags are immutable;
publish a new version for corrections. Follow the
[installation checks](docs/installation-checks.md) before tagging. Never commit
customer data or credentials to make an example work. Participation is governed
by the [code of conduct](CODE_OF_CONDUCT.md).

The plugin connects to the hosted service defined in
`plugins/actera/lib/defaults.mjs`; users never see or choose an endpoint. For
local development, set `ACTERA_API_ORIGIN` (HTTPS, or HTTP on loopback) in the
shell that launches Claude Code or the test harness, then run `/actera:connect`.
The override applies only at pairing time and is stored as that connection's
`baseUrl`, so switching services means reconnecting. The connect output names
the override when one is active. The developer-only `actera-hook.mjs setup`
command honors the same variable and `--base-url ORIGIN`. Keep the test agent,
machine key, and bridge state outside the repository.

## Bundled scanner

Run `node scripts/bundle-gitleaks.mjs` to verify all six bundled platforms.
Maintainers rebuild with Go 1.27.0 and `node scripts/bundle-gitleaks.mjs --build`.
The Go helper uses Gitleaks 8.30.1 as a library, pinned through `scanner/go.mod`
and `scanner/go.sum`. The script builds six targets with CGO disabled, trimmed
paths and no VCS/build ID, then records binary hashes and a hash of the source
inputs. Run `node scripts/scanner-notices.mjs` after rebuilding. Commit the six `.gz`
files, manifest, generated third-party notices, license, and Go sources together.
The notice generator reads dependencies from all six binaries and includes their
upstream license and attribution files, including notices in nested directories.
Runtime hooks never download binaries or install an OS service. CI rebuilds with
`--verify-build` and compares executable hashes, independent of platform-specific
gzip headers.

Run `npm test`
and `(cd scanner && go vet ./...)`. `node scripts/benchmark-capture.mjs` measures
cold capture, warm capture, and capture from fresh Node hook processes. It exits
nonzero when typical warm p95 exceeds 50 ms; this is a local acceptance benchmark,
not a shared-CI timing assertion. `node scripts/benchmark-scanner.mjs <binary>`
measures the helper round trip separately. Build a local helper first with
`go build -o ../.tools/scanner-benchmark.exe .` from `scanner/` (use a suitable
filename on Unix). Both benchmarks create their output directory automatically.
See [scanner performance](docs/scanner-performance.md) for measurement scope.

## Integration coverage

Keep plugin behavior covered by offline tests against the supported contract.
Optional native-host configuration checks live under `test/integration` and use
local HTTP fixtures. See [integration tests](docs/integration-tests.md).
