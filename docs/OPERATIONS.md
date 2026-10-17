# Setup and operations

This guide attaches version `0.2.18-dsh021a2.14` to an existing Harness **0.2.1-alpha.2** web profile. It uses public bundle APIs and existing native model/session configuration. It does not install Harness, patch upstream code, launch a second Host or create Work/Codex chats.

## Prerequisites and build

Check installed `dsh --version` and `dsh plugin --help`; use that installation's executable if it is not on PATH. Identify the existing profile, `DSH_HOME`, loopback listener and service manager. Paths below are examples. Substitute your actual existing profile for `web`.

Build in a separate checkout with Node.js >=22.19 and pnpm 12.11.2:

```sh
pnpm install --frozen-lockfile
pnpm run prepack
pnpm test
pnpm run test:package
npm pack --ignore-scripts
```

The result is `harness-relay-mcp-0.2.18-dsh021a2.14.tgz`. This fork is source-only and is not published to npm. Its npm name remains `harness-relay-mcp` for compatibility. Installing the upstream registry package will not install these local changes. Runtime SDK/Zod code is bundled; compatible Harness peer packages come from the existing profile.

## Attach to the existing profile

Wait for relevant native tasks to finish. Preserve profile package/lock/workspace files, plugin patch configuration, installed package contents and Relay journals in a private backup. Keep original run/operation IDs; do not overwrite live history with a backup or copy credentials into this repository.

The native CLI forwards `plugin` arguments to pnpm in the selected profile:

```sh
export DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
export DSH_PROFILE=web  # your existing profile
# Use the absolute path of the tarball built above.
dsh plugin --profile "$DSH_PROFILE" add /absolute/path/harness-relay-mcp-0.2.18-dsh021a2.14.tgz
```

Confirm the profile already exists: this CLI can initialize an absent profile. The package ships its bundle declaration and `cordis.patch.yml` insertion. Keep existing product rows and user overrides. Follow the installed plugin manager's reload/restart result; package replacement can require restarting the existing Host. Use its existing service manager in an appropriate idle window. Do not launch `dsh web` alongside an already running Host.

The Host must bind to **127.0.0.1**; the embedded plugin refuses a non-loopback web bind. Configure Relay environment variables on the existing Host process/service, not only in the proxy wrapper. For a systemd user service, [40-mcp-relay.conf.example](../deploy/40-mcp-relay.conf.example) is a starting point; replace its roots and use the actual service's drop-in directory.

The example allows `/home/example/projects`, caps this Relay's active runs at four and disables trusted-operator mode, prompt-text persistence and quota fallback. This is not a global quota across every Harness task. External files need a separate operator policy and per-task grants; see [DEPLOYMENT.md](DEPLOYMENT.md).

Choose provider/model/reasoning from live `list_capabilities` and explicitly pass them or configure `DSH_RELAY_DEFAULT_PROVIDER`, `DSH_RELAY_DEFAULT_MODEL` and `DSH_RELAY_DEFAULT_REASONING_EFFORT` on the Host. The source has compatibility defaults; do not assume they match a provider installed in your profile. This project supplies no model credentials or subscriptions.

## Configure the stdio proxy

The proxy connects to the embedded authority. Use the same `DSH_HOME` and `DSH_PROFILE` as the Host, with `DSH_RELAY_AUTO_START=false`.

Copy [stdio.sh.example](../deploy/stdio.sh.example) to a private executable location such as `$HOME/.local/libexec/dsh-relay-stdio`. Point `DSH_RELAY_PROXY_ENTRY` to the **absolute** `dist/dsh-relay-proxy.mjs` in a checked release directory; this can be the source checkout built above, kept intact while in use. Use an absolute Node executable in the wrapper if the service PATH does not find Node.

The default descriptor is `$DSH_HOME/plugins/dsh-relay/$DSH_PROFILE/relay-endpoint.json`. The Host writes it and private token/state locations. With an explicit plugin `stateDirectory` or descriptor override, set `DSH_RELAY_ENDPOINT_DESCRIPTOR` in the proxy to the actual matching descriptor. Never post its contents or bearer token. Host and proxy must resolve the same authority.

```sh
export DSH_HOME="$HOME/.dsh"
export DSH_PROFILE=web
export DSH_RELAY_PROXY_ENTRY="/absolute/path/to/checked-release/dist/dsh-relay-proxy.mjs"
"$HOME/.local/libexec/dsh-relay-stdio"
```

This stdio MCP server waits for a protocol client; it does not print a human-readable success message. Keep stdout exclusively for MCP traffic.

## Connect a private OpenAI Secure MCP Tunnel

Follow the [official guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels#connect-from-chatgpt) and your installed client's help. Availability depends on the account/workspace. Tunnel creation/editing requires Platform Tunnels Read + Manage; runtime use and app selection require Read + Use. ChatGPT custom MCP permissions are separate. Associate the Tunnel with the intended ChatGPT workspace as well as its owning Platform organization.

1. Reuse suitable existing Tunnel resources. Obtain the official client from Platform Tunnel settings or the [official release page](https://github.com/openai/tunnel-client/releases/latest). This repository does not bundle it.
2. Copy [tunnel-client.example.yaml](../deploy/tunnel-client.example.yaml) into private operator configuration. Replace placeholder IDs and `/home/example` paths. YAML paths are literal; do not assume `$HOME` expands. Configure the wrapper's proxy entry in your private environment. Restrict access to these files/directories.
3. Provide the runtime key through the referenced `CONTROL_PLANE_API_KEY` environment variable or a supported private file reference. Keep its value out of arguments, source and diagnostics. Use only one active client for the same Tunnel identity.
4. With the Host already running, use your installed client's supported command. The verified 0.0.16 config-file interface is:

   ```sh
   tunnel-client run --config "$HOME/.config/tunnel-client/dsh-harness/config.yaml"
   ```

   [dsh-mcp-tunnel.service.example](../deploy/dsh-mcp-tunnel.service.example) is an optional user-service template. Adapt executable paths and provide its private `runtime.env` first; it does not start the Host. Current releases may offer named-profile `init`/`doctor`; follow their help rather than assuming one version's schema.
5. In ChatGPT Plugins, add a custom MCP server with **Connection: Tunnel**, select the intended Tunnel and configure authentication for that private route. Review the product's permission choices. A public Harness web URL is not a Tunnel ID. This is a private custom MCP connection, not public marketplace distribution.
6. Select the integration in the **existing DOT main chat**, then call `doctor`, `harness_health` and `get_operational_capabilities`. Compare proxy/Relay versions and live catalog; connected `.14` has 48 tools. Complete [ACCEPTANCE.md](ACCEPTANCE.md).

The YAML uses `mcp.stdio_send_initialized_notification: true`, supported by tunnel-client 0.0.16. It supplies `notifications/initialized` after successful stdio initialization. Missing initialization can produce `mcp_initialization_required` before forwarding a tool. This flag does not replay calls or repair network failures. The optional local `scripts/verify-tunnel-initialization.py` fixture checks the handshake without a hosted Tunnel.


## Permissions and task identity

`DSH_RELAY_TRUSTED_OPERATOR=false` is the default and the supplied example. `start_run` then defaults to `read-only`, `confirmedDangerousPermission=false`; explicit arguments win. `start_review` remains read-only. Enabling trusted-operator mode changes omitted defaults, not authorization for every caller or task. Inspect live `get_operational_capabilities.permissionDefaults`; the static catalog does not describe operator overrides.

The Relay assumes a single operator/trust domain. Possession of the loopback bearer grants access to its runs/sessions/operations. `DSH_RELAY_CLIENT_PRINCIPAL_ID` is an idempotency namespace, not authenticated identity. Workspace/scope checks do not provide OS isolation; see [TOOLS.md](TOOLS.md) and [SECURITY.md](../SECURITY.md).

Use a stable `idempotencyKey` and retain `runId`, `operationId` and `sessionId`. `queue_run` acknowledges a queued next turn, not the original run's final reply. `cancel_run` requests cancellation; verify native terminal state and child agents separately. For an unknown write result, query `get_run`, `get_operation` or `reconcile_operation` for that original request. Never change keys or resubmit blindly.

## Diagnose before changing services

Start with `doctor`, then actual Host and Tunnel component states. On client versions exposing the corresponding local admin API, this helper performs read-only checks:

```sh
node scripts/diagnose-tunnel.mjs http://127.0.0.1:<actual-admin-port>/
```

Find the actual port in the current local health URL file; a restarted client may allocate a different one. The helper checks health details, readiness and metrics. Missing metrics remain unverified. It distinguishes stale/degraded polling, response delivery and dispatcher state. HTTP 200, `ready=true` or a recent poll alone does not establish complete request delivery. `polling_current` still requires an actual DOT call for acceptance.

Keep unsafe raw HTTP logging disabled. Retain sanitized errors/versions; original request correlation data stays private. Control-plane 503/504 errors can arise outside the Host: inspect evidence before restarting, changing credentials or creating another client. Local `doctor` success does not establish remote recovery. Preserve ordinary client backoff when no local configuration error is evidenced.

When tools change, refresh the existing plugin's tools and reselect it in the original chat, then verify the actual new call. Stale client catalogs differ from server implementation failures. Platform review may stop a call before Relay admission; report that gate without bypassing it with another runtime.

## Upgrade and rollback

Build and validate a separate release directory. Back up relevant profile/package configuration, installed artifacts and state. Wait for native tasks and transport dispatch/queue/uploads to be idle before an affected reload. Updating the Host bundle does not update a resident stdio proxy: compare `doctor` and `harness_health`, then reload only the existing transport when needed and idle. Retain Tunnel identity and original requests.

Use the existing service manager to restore compatible package/profile configuration if needed, preserving current sessions and journals. Strict older schemas may reject new fields: do not downgrade an old binary onto a journal it cannot read or restore an old journal over newer history. Resolve compatibility separately while retaining both copies and original IDs. Disconnecting a Tunnel does not cancel native Harness tasks.

Builds in one checkout use `.build-lock` and its mutation gate. Do not remove locks because they are old. The gate has no automatic stale-owner recovery; establish that all callers are stopped, preserve owner evidence, and handle only the exact orphaned gate. Promotion journals retain staging/backup material when recovery is unresolved. Promotion can briefly leave `dist` unavailable between moves; do not build over an active service's release directory or read/package that directory during promotion.

Remove only the integration-specific entry or Tunnel access to disable this route. Preserve shared credentials, unrelated clients and native history. Keep original logs, receipts and backups private.
