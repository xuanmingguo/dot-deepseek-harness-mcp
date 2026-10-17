# 部署与项目外文件

Relay .6 增加五个工具，复用当前 Harness 和普通 run/operation 回执。

| 工具 | 行为 |
|---|---|
| `get_operational_capabilities` | 读取能力、配置的外部路径策略和限制 |
| `validate_task_scope` | 只校验项目准入、文件范围和外部路径策略，不派发 |
| `plan_deployment` | 生成完整部署指令并校验范围，不运行所列检查 |
| `start_deployment` | 将明确授权的完整部署计划交给现有原生 Agent |
| `read_scoped_artifact` | 根据已记录 run 的范围读回普通文件，不接受临时扩权 |

## 外部路径策略

项目仍须满足原有 `DSH_RELAY_ALLOWED_WORKSPACE_ROOTS` 或注册目录规则。需要访问项目外的指定文件时，运行方配置独立策略，调用方再在任务中声明所需的 `externalPaths`。两者缺一不可。

配置 `DSH_RELAY_EXTERNAL_PATHS_FILE=/absolute/operator-owned/policy.json`，或配置 `DSH_RELAY_EXTERNAL_PATHS_JSON`，二选一。例如：

```json
[
  {"path":"/opt/example/service.py","access":"write","kind":"file"},
  {"path":"/opt/example/release.json","access":"write","kind":"file"}
]
```

`file` 只涵盖该文件；`directory` 包含该目录的后代。`read` 不能授权写，`write` 同时允许核对原文件。先比较声明路径，再核对真实路径和已有父目录，拒绝符号链接子路径逃逸；尚未创建的部署文件可以通过已授权父目录校验。每个实际外部范围也会单独检查。策略只影响声明路径准入，不把外部目录注册为项目。

`start_run`、`start_review` 和 `reply_run` 均接受 `externalPaths`。外部范围使用绝对路径，并显式加入 `contextReadScope`、需要时加入 `writeScope`。项目内的 `.` 不包含外部绝对路径。外部写入要求 `danger-full-access`；当前公共 Harness API 没有逐任务新增 writable roots 的能力。任务范围依然是 **指令约束，不是 OS 逐路径沙箱**。用户授权、客户端自动审查和原生权限均继续适用。

准入时逐项校验全部 review/context/write 路径。项目内路径按当前主机的路径语义解析；绝对项目内路径归一化为相对路径，项目外的绝对路径只有同时满足任务 grant 和运行方策略才可接受。相对路径中的 `..` 不能越过项目根。POSIX 主机保留文件名中的反斜线，不将 Windows 盘符或 UNC 路径猜作本地路径；远端映射仍使用下文的显式 `host`。项目内声明若经符号链接指向项目外会被拒绝；项目内链接可指向项目内，项目根本身也可为链接。外部链接和未创建目标均核对真实父目录，悬空链接不能绕过策略。

这些检查针对**本次声明的路径和校验时的文件系统状态**，不会递归扫描整个 `contextReadScope`，也不会拦截 Agent 的每次文件访问。派发后的路径变化、目录中未单独声明的链接和 Agent 是否遵守 exclusions/writeScope，仍由原生权限及任务指令约束；成功准入不代表已经执行部署或建立持续的逐路径隔离。

### 范围拒绝回执

范围拒绝在新建原生 session、修改权限或提交 prompt 前返回。响应使用稳定的 `code`，并提供 `field`（含失败数组索引）、`reason`，适用时提供 `path`；`retryable:false` 表示需先修正声明或策略。

| code | 含义 |
|---|---|
| `TASK_SCOPE_INVALID` | 缺少必填范围、非法/跨主机路径、项目逃逸、目标不在 context 中、被 exclusions 排除或写范围不符合权限 |
| `EXTERNAL_PATH_DENIED` | 外部声明或其实际子路径未被任务 grant / 运行方策略覆盖，含链接逃逸 |
| `EXTERNAL_WRITE_REQUIRES_FULL_ACCESS` | 外部 write grant 使用了 `workspace-write`；公共 API 无逐任务外部 writable root |

例如第二个 review target 为 `../outside/secret` 时返回 `{"code":"TASK_SCOPE_INVALID","field":"reviewTargets[1]","reason":"path_outside_workspace","path":"../outside/secret","retryable":false}`，并附说明消息。运行方策略本身格式错误仍使用 `INVALID_ARGUMENT`，并指明策略字段。混合多个目标时任一失败均拒绝整次派发。

续接继承并复制完整范围；重启后保留声明，每次新派发和范围读回重新检查当前策略。撤销策略后，新操作会拒绝对应路径；这不会中断已经运行的 Agent。

本地 manifest CLI 增加四个可重复参数：`--external-read-file`、`--external-write-file`、`--external-read-directory`、`--external-write-directory`。带外部声明输出 schemaVersion 4；原调用继续输出原 schemaVersion 3。CLI 声明不能替代服务器策略。

## 部署契约

先调用 `plan_deployment` 检查下列完整参数，再在已有明确部署授权下调用 `start_deployment`。后者额外要求稳定 `idempotencyKey` 和 `authorizationBasis: explicit-user-request`，接受现有 provider/model/reasoning 与 sessionId/sessionMode。个人 trusted operator 的确认默认值沿用现有配置，不增加重复确认流程。

```json
{
  "workspace":"/home/deploy/projects/example",
  "objective":"Deploy the bridge, adapter and service together",
  "files":[
    {"source":"src/bridge.py","host":"existing-mac","target":"/Users/deploy/tools/bridge.py"},
    {"source":"src/adapter.py","target":"/opt/example/adapter.py"},
    {"source":"src/service.py","target":"/opt/example/service.py"}
  ],
  "backupDirectory":"work/deploy-42/backup",
  "receiptPath":"work/deploy-42/receipt.json",
  "contextPaths":["work/deploy.py"],
  "writePaths":["/opt/example/release.json"],
  "externalPaths":[
    {"path":"/opt/example/adapter.py","access":"write","kind":"file"},
    {"path":"/opt/example/service.py","access":"write","kind":"file"},
    {"path":"/opt/example/release.json","access":"write","kind":"file"}
  ],
  "preflightChecks":["Run the focused tests; verify deployed versions, idle state and exact remote identity"],
  "applySteps":["Deploy the remote bridge through the existing pinned route; atomically replace both local mappings; update release.json; restart only the named facade after it is idle"],
  "verificationChecks":["Verify all mapped hashes and release pin; check the named facade; read back the known affected message without changing unread state"],
  "rollbackSteps":["On definite failure restore this deployment's verified backups and release pin; preserve journals and unknown request IDs"]
}
```

可为每个映射提供 `sourceSha256` 冻结预期源码。带 `host` 的映射明确属于该远端主机，其 target 不是本地路径；Agent 只能使用既有获准远端路由和列出的步骤。Relay 不创建 SSH 凭据、不实现另一个远端执行器。远端备份、哈希及回执由原生 Agent 实际核实。

`contextPaths` 用于必要的测试、部署脚本和配置；`writePaths` 用于 release pin 等配套修改。项目外路径仍需显式 grant 和策略。所有映射、辅助路径、步骤和预期哈希都进入普通任务内容与幂等请求指纹。不要将源码或凭据粘贴到参数里。

派发生成的指令要求：先检查全部映射，记录源码/旧目标哈希；备份所有旧目标并核验；执行所列步骤；核对每个目标与源码哈希并执行验收；确定失败时仅回滚本次修改；未知结果保留原操作 ID，不盲目重放。JSON 回执记录逐文件哈希、备份、各步骤、回滚和未知状态。

这些是交给 Agent 的部署要求，**Relay 本身不是事务式部署引擎**。`plan_deployment` 返回的 `checksExecuted:false` 表示测试、备份和健康检查尚未运行；`start_deployment` 返回 runId 表示任务已派发。持续 `wait_run`，读取最终回复和回执，并独立验证；`succeeded` 只证明原生任务完成，不能单独证明部署通过验收。

## 证据与恢复

项目内证据继续用 `read_artifact`；项目外证据用 `read_scoped_artifact(runId, path, offsetBytes?, maxBytes?)`，限定在原 run 的 context/write 范围并遵守 exclusions，重新检查当前外部策略。两者均拒绝符号链接和非普通文件，单次最多 64 KiB、单文件 16 MiB。无结构化范围的旧 run 继续用项目内读取。远端结果通过项目内的已核实回执读回。

取消、状态、权限恢复和不确定结果继续使用原有 run/operation 工具，不新增重派或后台重启机制。`start_service` / `stop_service` 始终只是 Harness attachment 管理；应用服务启停必须是已授权部署步骤。

现有 .5 运行记录可被 .6 读取。新增外部范围会持久保存，旧 .5 的严格状态 schema 不理解它；产生这类新记录后，不可直接切回 .5 并覆盖 journal。保留完整新旧状态和在途 ID，优先使用修正版 .6；回退旧版本前需要空闲及独立状态兼容处理。
