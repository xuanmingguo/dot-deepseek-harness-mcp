# DOT DeepSeek Harness MCP

Connect a DOT main chat to an **existing DeepSeek Harness** through MCP. This source release extends [Harness Relay MCP](https://github.com/tonytanglab/deepseek-harness-relay-mcp) for Harness **0.2.1-alpha.2**, using its public plugin APIs without patching Harness or launching another Host.

[中文说明](README.zh-CN.md) · [Setup and operations](docs/OPERATIONS.md) · [Tools](docs/TOOLS.md) · [Validation boundaries](docs/ACCEPTANCE.md)

```text
DOT main chat
  → OpenAI Secure MCP Tunnel
  → local stdio proxy
  → embedded Relay plugin in the existing Harness Host
  → native projects, sessions, tasks and history
```

No Work/Codex chat or second Harness runtime is required. DOT/custom MCP access and Tunnel availability depend on your account, workspace permissions and Platform organization; this repository does not grant that access. The Tunnel setup is for a private custom MCP connection, not a public plugin marketplace submission. See the [official connection guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels#connect-from-chatgpt).

## What it provides

Version `0.2.18-dsh021a2.14` exposes 48 tools when connected to a compatible Host:

- Native task submission, progress, replies, queue controls and cancellation, with persistent run/operation IDs and idempotency.
- Compact run discovery, paged original history, keyword history search and original-message/context expansion.
- [Project file discovery](docs/PROJECT_FILES.md), [UTF-8 line/tail reads](docs/PROJECT_TEXT.md) and [literal content search](docs/PROJECT_SEARCH.md), with bounded results and SHA-256 checks.
- Native interactions, permission reconciliation, and explicitly scoped [deployment planning and evidence reads](docs/DEPLOYMENT.md).

The [tool catalog](docs/tool-catalog.json) describes the unconfigured defaults. Live `tools/list` and `get_operational_capabilities` describe the running configuration. A disconnected proxy may expose only `doctor`.

## Build from source

Use Node.js **22.19 or later** and pnpm **12.11.2** (the CI version). From your clone:

```sh
git clone https://github.com/xuanmingguo/dot-deepseek-harness-mcp.git
cd dot-deepseek-harness-mcp
pnpm install --frozen-lockfile
pnpm run prepack
pnpm test
pnpm run test:package
npm pack --ignore-scripts
```

`prepack` performs type checks, builds the bundled runtime and validates the package. `npm pack --ignore-scripts` packages those already checked files into `harness-relay-mcp-0.2.18-dsh021a2.14.tgz`. The upstream npm package name is retained for compatibility; **this fork is not published to npm**. A registry install or `npx harness-relay-mcp` does not select this fork.

Install that local tarball into your existing Harness profile, configure the attached plugin and stdio proxy, then connect your private Tunnel: follow [OPERATIONS.md](docs/OPERATIONS.md). The guide includes the native CLI command, examples, account requirements and a small DOT acceptance path.

## Permissions and recovery

`start_run` defaults to `read-only` with `confirmedDangerousPermission=false`. A configured trusted operator can change omitted fields to full access; explicit call values take precedence. The examples keep that setting false. Workspace/task scopes are instructions and admission checks, not OS process isolation or multi-tenant access control. See the [permission contract](docs/TOOLS.md#权限选择与默认值).

Select provider/model/reasoning from the **actual existing Host capabilities**. Model credentials and defaults belong to the operator; no provider subscription or model access is bundled here.

Keep the original `runId`, `operationId`, `sessionId` and stable `idempotencyKey`. After a timeout or disconnect, query/reconcile that operation before deciding what to do next. A dispatch receipt, queued reply or HTTP 200 does not prove task completion. Cancellation must be verified from the final native state.

Keep tokens, Tunnel configuration, original chat history, task journals, backups and receipts outside Git. Report problems with a minimal sanitized reproduction; see [SECURITY.md](SECURITY.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

## License and attribution

MIT; the upstream [LICENSE](LICENSE) is preserved unchanged. [NOTICE](NOTICE) and [UPSTREAM.json](UPSTREAM.json) identify the pinned upstream source and separate local maintenance. This is an independent integration, with no claim of official OpenAI or DeepSeek support.
