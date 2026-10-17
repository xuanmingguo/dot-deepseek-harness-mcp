# Security and privacy

This integration is designed for one operator/trust domain. A client holding the loopback Relay bearer can access its runs, sessions and operations. The optional principal header is an idempotency namespace, not authenticated identity or multi-tenant isolation. Keep the Harness listener and Relay endpoint on loopback and restrict access to local runtime files.

Examples default to read-only tasks and keep trusted-operator mode disabled. Task scopes validate declared paths and guide the native agent; they do not create OS isolation. Existing Harness permissions, client review and explicit task authorization still apply. Inspect the actual capabilities and provider selection before submitting a task.

Never commit or attach API keys, tokens, cookies, Tunnel identities/configuration, endpoint descriptors, task journals, original chat histories or backups. Disable unsafe raw HTTP logging. Sanitized diagnostics should retain the error code and relevant versions without exposing prompts, personal paths, private URLs or request/session IDs.

For a vulnerability, use the repository's private vulnerability reporting channel if available. If it is unavailable, open a minimal issue asking for a private contact channel without posting exploit details or sensitive data. For an ordinary bug, provide a synthetic reproduction and sanitized check results. Do not post secrets while waiting for a response; exposed credentials should be revoked through their owning credential manager.

No formal response-time commitment or external security audit is claimed. Compatibility and validation boundaries are described in [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md).
