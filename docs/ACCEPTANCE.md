# Validation and acceptance

This public source release contains generic validation guidance and a sanitized maintenance summary. Private deployment receipts, original chats, task IDs, host paths and transport identities are intentionally excluded. They are not needed to run the local fixtures.

## Sanitized release preparation results

The public snapshot was checked with the native suite: 515 tests, 514 passed,
one environment-dependent skip and no failures. Type checking and bundled builds
passed. Release privacy checks cover tracked source, all reachable Git objects
and actual package members; separate Gitleaks scans complement these checks.
Automated scanning cannot prove the absence of every kind of sensitive data.

A fresh check in the existing original DOT completed 11 actual tool calls with
no tool errors: one narrowly scoped task, terminal status and permission
restoration, an independently parsed generated JSON file, search-to-SHA-guarded
readback, and native-history lookup of that task and final reply. Original run,
operation and session IDs and raw evidence remain private. This confirms the
maintained deployment, not a new installation on every supported environment.

## Historical maintenance evidence

Before preparing this source release, the maintained `.14` integration reported 515 native tests: 514 passed, one environment-dependent test skipped, and none failed. It also completed representative read-only calls through an existing DOT main chat, including expected path/SHA rejection cases. These are historical maintenance results, not a fresh test of your clone, account, Host or Tunnel. They do not establish compatibility with other Harness versions.

The `.14` connected catalog contains 48 tools. Content-search checks covered literal and Unicode queries, bounded traversal, hidden/excluded entries, directory depth, skipped files, truncated output, complete versus incomplete zero results, and SHA-guarded expansion of a matching line. Local fixtures also cover file replacement, links, special files and transport/error behavior. Do not treat a simulated boundary as proof that a real filesystem reached that boundary.

## Check a source checkout

Use Node.js >=22.19 and the CI pnpm version (12.11.2):

```sh
pnpm install --frozen-lockfile
pnpm run prepack
pnpm test
pnpm run test:package
```

Record the actual commit, tool versions, pass/fail/skip totals and package hash privately. A conditional skip remains unverified for that environment. `test:package` checks the actual built tarball; it does not install a plugin, contact a provider or exercise DOT.

For an installed compatible `tunnel-client`, the optional isolated initialization fixture is:

```sh
TUNNEL_CLIENT=/absolute/path/to/tunnel-client python3 scripts/verify-tunnel-initialization.py
```

It uses local synthetic services and does not prove hosted Tunnel or DOT connectivity.

## Check the intended connected path

Use the existing DOT main chat, existing Harness Host and intended private Tunnel. Do not substitute a new Work/Codex task, a second Host, a local HTTP response or another chat for this acceptance.

1. In DOT, call `doctor`, `harness_health` and `get_operational_capabilities`. Confirm proxy/Relay versions, compatible Host, connected readiness and configured defaults.
2. Discover a known allowed project, list a small directory, search for a known literal, then expand one hit with `read_project_text` using its original SHA-256. Compare the actual text and line number.
3. Check one safe expected rejection (such as a path outside the workspace), then confirm a valid read still succeeds. An expected refusal should be recorded separately from unexpected failures.
4. If task execution is authorized, submit a narrowly scoped task with an explicit supported provider/model, permissions and a stable idempotency key. Save the returned IDs, wait for its native final state, and independently read back any requested artifact. Keep write acceptance separate from read-only connectivity.
5. Reconnect and query the same run/operation. Never replay an unknown write with a new key just to obtain a successful receipt.

A successful `doctor` proves local preflight only. Healthy polling is not proof of dispatch or response delivery. A completed native task does not independently prove every claimed file change or deployment check. Cancellation receipts require terminal-state verification; parent cancellation does not prove all child agents stopped.

Account/workspace restrictions or platform review may prevent a call before it reaches the Relay. Report that gate without claiming connected acceptance or bypassing it. See [operations and recovery](OPERATIONS.md) and the [deployment contract](DEPLOYMENT.md).
