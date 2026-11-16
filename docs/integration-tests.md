# Testing the plugin

Install dependencies with `npm ci`, then run `npm test`. The offline suite checks
pairing against controlled HTTP fixtures, plugin hook and settings files,
installation validation, and the vendored agent-hooks copy. Decision handling,
redaction, retries and delivery recovery are tested in agent-hooks.

`npm run test:native-settings` additionally exercises the real Claude host with
isolated settings and local HTTP fixtures. It needs Claude authentication and
allows a $1 model budget per scenario. Ordinary CI makes no paid model calls.
Temporary state and credentials stay in ignored `.dev` directories.

Run `npm run check:distribution` before proposing changes. Integration behavior
must follow the reviewed operations and response fields in the vendored package's API contract.
