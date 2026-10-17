# DOT DeepSeek Harness MCP

让 DOT 主聊天通过 MCP 操作**已有的 DeepSeek Harness**。基于固定版本的 [Harness Relay MCP](https://github.com/tonytanglab/deepseek-harness-relay-mcp)，适配 Harness **0.2.1-alpha.2** 的公共插件 API，不修改上游 Harness，也不另起 Host。

[English](README.md) · [安装与运维](docs/OPERATIONS.md) · [完整工具说明](docs/TOOLS.md) · [验收边界](docs/ACCEPTANCE.md)

```text
DOT 主聊天 → OpenAI Secure MCP Tunnel → 本地 stdio proxy
          → 已有 Harness Host 内的 Relay 插件 → 原生项目、会话与任务
```

无需创建 Work/Codex 聊天。DOT、自定义 MCP 和 Tunnel 是否可用，取决于账号、工作空间权限及 Platform 组织；开源本项目不会授予这些权限。这里连接的是私人自定义 MCP，不是公开插件商店发布。请参考[官方接入说明](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels#connect-from-chatgpt)。

## 能力

版本 `0.2.18-dsh021a2.14` 在兼容 Host 中提供 48 个工具，覆盖原生任务提交、进度、回复、排队、取消、交互、权限恢复及明确范围的部署计划。保留持久 run/operation ID 与幂等请求，不以断线为由自动重派。

可按项目、会话及状态查找任务；分页读原始历史、[搜索历史关键词](docs/HISTORY_SEARCH.md)、[展开消息原文及前文](docs/SESSION_CONTEXT.md)。文件能力包括[目录发现](docs/PROJECT_FILES.md)、[UTF-8 按行/末尾读取](docs/PROJECT_TEXT.md)及[字面关键词内容搜索](docs/PROJECT_SEARCH.md)，返回范围、遗漏说明及 SHA-256。文件查询无需新建原生任务。

[静态工具目录](docs/tool-catalog.json)展示未配置时的默认值；以实际 `tools/list` 和 `get_operational_capabilities` 为准。代理尚未连上 Host 时可能只展示 `doctor`。

## 从源码构建

需要 Node.js **>=22.19**；CI 使用 pnpm **12.11.2**：

```sh
git clone https://github.com/xuanmingguo/dot-deepseek-harness-mcp.git
cd dot-deepseek-harness-mcp
pnpm install --frozen-lockfile
pnpm run prepack
pnpm test
pnpm run test:package
npm pack --ignore-scripts
```

`prepack` 包含类型检查、构建和打包校验。最后一条命令打包已验证的构建文件，生成 `harness-relay-mcp-0.2.18-dsh021a2.14.tgz`。保留上游 npm 包名是为了兼容；**本 fork 没有发布到 npm**，直接 registry 安装或 `npx harness-relay-mcp` 不会选中本 fork。

按[运维说明](docs/OPERATIONS.md)将本地 tgz 安装到已有 Harness profile，配置嵌入插件与 stdio proxy，再连接自己的 Tunnel。安装前保存 profile 和请求状态，等待相关任务空闲；不要另建 Harness 实例来代替原路径验收。

## 权限、结果与隐私

`start_run` 缺省为 `read-only`、`confirmedDangerousPermission=false`。示例保留 `DSH_RELAY_TRUSTED_OPERATOR=false`；只有运行方显式配置 true 时，省略的权限/确认字段才改为全权限/true。调用参数优先，该配置不代表每项任务都获得授权。完整说明见[权限约定](docs/TOOLS.md#权限选择与默认值)及[部署契约](docs/DEPLOYMENT.md)。任务文件范围属于指令与准入校验，不是 OS 逐路径沙箱。

先查询现有 Host 的实际 provider/model/reasoning 能力，再显式选择；项目不提供模型凭据或订阅。保存原 `runId`、`operationId`、`sessionId` 与稳定 `idempotencyKey`。超时先查询或协调原操作，不换键重派。排队/派发回执与 HTTP 200 不等于最终成功；取消也须核对原生终态。

Token、Tunnel 配置、原聊天历史、任务 journal、备份和回执留在私有目录。问题报告只提供脱敏的最小复现，见 [SECURITY.md](SECURITY.md) 与 [CONTRIBUTING.md](CONTRIBUTING.md)。

采用 MIT；保留原始 [LICENSE](LICENSE)，固定上游提交见 [UPSTREAM.json](UPSTREAM.json)，贡献归属见 [NOTICE](NOTICE)。这是独立维护的集成，不代表 OpenAI 或 DeepSeek 官方支持。
