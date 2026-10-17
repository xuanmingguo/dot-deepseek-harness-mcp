# Contributing

Open an issue or pull request with the concrete behavior, expected outcome and a minimal sanitized reproduction. Include the source commit, Node/pnpm versions, compatible Harness version and relevant check results. Keep private workspaces, credentials, chat history, task receipts and service configuration out of patches and reports.

Use Node.js >=22.19 and pnpm 12.11.2. Run `pnpm install --frozen-lockfile`, `pnpm run prepack`, `pnpm test` and `pnpm run test:package` for changes affecting the runtime or package. For a documentation-only change, check the affected instructions and links. Add focused fixtures when they demonstrate a meaningful behavior or regression.

Use Harness public plugin APIs and preserve the pinned upstream provenance and MIT attribution. Reuse existing profiles and native sessions; development checks must not interrupt live tasks, change operator credentials or replay uncertain writes. Distinguish local fixtures, installed-plugin checks and actual DOT main-chat evidence in your report.

This fork is distributed as source and locally built tarballs, not as a published npm fork. Do not replace a local installation instruction with a registry command unless publication and package identity have actually changed.

For sensitive reports, follow [SECURITY.md](SECURITY.md).
