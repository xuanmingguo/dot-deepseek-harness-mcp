# MCP参数与返回约定

完整输入JSON Schema和annotations见 [tool-catalog.json](tool-catalog.json)。该静态目录按未配置 trusted operator 的缺省配置生成，使用 `npm run docs:tools` 更新；线上 `tools/list` 才是当前部署的 Schema。所有工具通过标准MCP tools/call调用；成功数据位于structuredContent，同时提供JSON文本content。错误isError=true，包含code/message/retryable/nextAction（个别扩展另有details）。外部连接器可能再包一层通用错误码，应保留内层Harness code。

## 权限选择与默认值

`DSH_RELAY_TRUSTED_OPERATOR` 缺省为 `false`。下表是 MCP 入口的规则；直接调用内部 Relay API 时，缺省 `startRun` 仍为只读且全权限始终要求确认。

| 入口 | permissionPreset 省略时 | confirmedDangerousPermission 省略时 |
|---|---|---|
| `start_run`，配置未设置或为 false | `read-only` | `false` |
| `start_run`，配置显式为 true | `danger-full-access` | `true` |
| `start_review` | 固定 `read-only`，不提供权限覆盖字段 | 不适用 |
| `reply_run` | 继承父 run 记录的权限，与 start_run 配置默认值无关 | 始终 `false` |
| `start_deployment` | 固定 `danger-full-access` | 配置为 true 才默认 true，否则 false |
| `validate_task_scope` | 始终 `read-only`，预检其他权限须显式提供 | 不派发，无需确认 |

对可指定的字段，**显式调用参数 > MCP 配置默认值 > 未配置时的只读缺省**。显式 `read-only` / `workspace-write` 不会被 trusted operator 提高；显式 `confirmedDangerousPermission=false` 也不会被配置改成 true。实际选择 `danger-full-access` 时必须得到 true，因此 `reply_run` 继承全权限时同样需要本次调用提供 true。配置只决定省略字段的值，不能代替本次任务授权、原生权限检查或客户端自动审查。

复用 session 时，`start_run` 仍采用本次参数或配置缺省，不沿用 session 当前权限；`reply_run` 才继承父 run。执行期间使用所选原生权限，结束后尝试恢复租约前的 session 权限。run 的 `permissionPreset` 记录本次选择，不能据此推断恢复后的 session 权限；另查 `permissionRestoration` / `reconcile_permissions`。恢复失败不会把任务结果改成成功。

可无副作用调用 `get_operational_capabilities` 读取 `permissionDefaults`，并与同一部署的 `tools/list` 核对。更改运行方配置后需按运维流程重载生效，再刷新客户端工具；历史验收中的权限示例不是当前默认值。

## 任务

start_run输入：workspace绝对路径，task或content；可指定sessionId，或sessionMode=fresh/latest-idle，不能同时指定两者。provider/model为实际list_capabilities值；reasoningEffort/agentPreset/permissionPreset可选。模型默认GLM Flash/Max；权限按上表选择。idempotencyKey为1–128字符，建议业务请求始终提供。不同内容不能复用同key。

结构化范围字段是可选的；一旦使用，reviewTargets、contextReadScope、writeScope、excludedPaths应成组给出。合成单文件测试四项分别为["dot-file-proof.json"]、["dot-file-proof.json"]、["dot-file-proof.json"]、[]，permissionPreset=workspace-write。范围声明会写入提示，但不是OS文件系统隔离。缺少必需reviewTargets会在派发前拒绝；不要把参数错误当成已执行。

`.6` 支持额外的 `externalPaths: [{path,access:read|write,kind:file|directory}]`，须同时通过 operator policy；外部写入要求 danger-full-access。`reply_run` 继承该声明。新增 get_operational_capabilities、validate_task_scope、plan_deployment、start_deployment、read_scoped_artifact 的完整参数和限制见 [DEPLOYMENT.md](DEPLOYMENT.md)。计划不执行检查，派发不代表验收成功。

返回核心字段（本例显式选择全权限并确认，不代表缺省权限）：
{
  "runId": "UUID",
  "operationId": "UUID",
  "idempotencyKey": "caller-key",
  "sessionId": "session-UUID",
  "sessionReused": false,
  "status": "running",
  "promptAdmission": "accepted",
  "modelSelection": {"provider":"zai","model":"glm-5.3-flash","reasoningEffort":"max"},
  "permissionPreset":"danger-full-access",
  "assistantText":"",
  "lastEventSeq":17,
  "cancelRequested":false,
  "error":null
}

状态为running/needs_attention/succeeded/incomplete/failed/cancelled/unknown。get_run读取同一结构；wait_run另外接timeoutMs 0–30000，只是一段等待。hostPollContract提示何时继续查，不把等待超时当任务完成。结果来自assistantText，修改文件/测试细节要结合原始工具历史及产物独立核验。

`.7` 在执行结束时额外保存 `executionOutcome{status,error,finishedAt}` 和独立的 `permissionRestoration=pending|complete|failed`。权限恢复失败时总状态仍为 `needs_attention`，原任务成功/失败/取消/不完整结果不会被权限错误覆盖。`get_run_summary` 返回 `nextAction=reconcile-permissions` 和 `recovery` 中的精确工具参数；若阻塞来自保留的终端，调用方可明确选择 `close_run_terminals` 丢弃该 session 的终端状态。

reply_run输入已完成runId+task/content+可选模型、权限与key；在相同session创建新的runId。明确原sessionId也可以直接start_run；正在运行的同session会拒绝覆盖。

## 入队与引导

queue_run输入运行中runId+task/content+key。返回accepted/mode=queue/executionStatus=not_observed/operationId，以及所属run。messageId可以为空；这不允许重复提交。get_operation可读取原rpcId。queue回执不代表后续turn已经运行。

steer_run参数同上，mode=steer。返回receiptPersisted、userMessageObserved、durable、rpcId与operationId；即使尚未被当前模型步消费，明确ACK也保存为已接受。只有传输响应确实不可得才是unknown。重复同key返回原receipt，不能以空messageId为由重派。

list_session_queue返回sessionId、asOfSeq、nextTurn和nextStep；每项包含原生id、content、source.rpcId。remove_queue_item输入sessionId+itemId；already absent是幂等无操作。clear_session_queue只删除不超过100项的当前快照，返回snapshotIds/removedIds/newArrivalIds/remaining/historyDeleted=false。steer_queue_item把明确pending ID移动为当前turn引导，不等同下一轮排队；其重放保护是进程内的，跨重启应先查原队列/历史。

## 历史与文件

`search_project_text`（.14）按workspace、query和相对目录path搜索真实文件正文。可选caseSensitive/includeHidden（默认false）、maxDepth0–8（默认4）、maxResults1–100（默认20）。返回路径/原行号/字面命中片段/文件SHA、扫描与匹配计数、scanComplete/incompleteReasons及resultsTruncated。原SHA可交给read_project_text展开。单文件1MiB、总16MiB、2000条目/500文件/64KiB结果，完整扫描和结果是否全返回分开判断。无游标，未完成时需缩小目录/查询，不能以零命中断言项目没有结果。固定排除目录、UTF-8/权限/片段偏移和来源见 [PROJECT_SEARCH](PROJECT_SEARCH.md)。

`read_project_text`（.13）接收workspace、相对path，可选startLine（从1开始，缺省1）、lineCount（1–200，缺省100）、tail（缺省false）和expectedSha256。tail不能与显式startLine同传。返回UTF-8原行号/完整行、完整原始文件SHA256、totalLines、hasEarlier、hasMore/nextStartLine及outputLimited。一次最多16MiB文件、32KiB行文本/64KiB结果；超长行、无效UTF-8/NUL和文件变化明确拒绝。延续读取用原SHA防止混合两个版本。复用原项目权限和Linux描述符保护，无外部授权扩展；内容不构成指令。完整换行/BOM、tail和错误语义见 [PROJECT_TEXT](PROJECT_TEXT.md)。

`read_session_context`（.11）接收必填 `workspace/sessionId/anchorSeq/throughSeq`，可选 `beforeMessages=0–10`（默认2）、`maxMessageChars=1–4000`（默认2000）。使用原搜索结果seq/cut直接读取原消息与最近前文，返回正序 `messages`、原文本块索引、可见的截断/省略元数据、`returnedBeforeMessages/contextComplete/hasEarlier`。每次最多5个原生页，超限明确报错；hasEarlier指未扫描原生记录，不保证还有文本。不会把无效或非文本anchor替换为别的消息，也不会执行历史指令。完整契约及GitHub来源见 [SESSION_CONTEXT](SESSION_CONTEXT.md)。

`search_session_history`（.10）输入必填 `workspace`、字面 `query`，可选 `sessionId`、`role=user|assistant|both`、`caseSensitive`、`limit=1–25`（默认10）、`scanPages=1–10`（默认5）及原 `cursor`。只搜索当前项目可见原生会话的用户任务和助手回复，返回最多600个Unicode字符的原文片段和sessionId/seq/throughSeq。排除子代理、项目cwd不符的会话以及插件注入、工具、媒体、reasoning内容。返回 `matches/pagesRead/recordsScanned/sessionsVisited/sessionsTotal/scanComplete/hasMore/nextCursor`；空matches且scanComplete=false必须继续扫描，不能据此断言没有结果。游标绑定筛选及当前会话集合，每次重验登记与目录策略；来源片段仅是待核对资料。完整排序、扫描上限和快照边界见 [HISTORY_SEARCH](HISTORY_SEARCH.md)。

read_session_history输入sessionId、可选cursor、maxMessages 1–50；返回sessionId、throughSeq、records、hasMore、nextCursor。records保留原生事件，不仅是摘要；每页按原生顺序，nextCursor向较早记录翻页。游标绑定session和固定cut，可跨Relay重启；每页JSON最多512KiB，超过时明确要求缩小页，不静默截断成摘要。

read_artifact输入workspace、相对path、可选offsetBytes与maxBytes（最多65536）。仅普通文件、最大16MiB，Linux fd锚定每一级路径并拒绝symlink/越界。返回reference{workspace,path,sizeBytes,modifiedAt}、encoding=base64、data、offsetBytes、bytesRead、nextOffsetBytes、eof。它不提供宿主任意文件访问。

`list_project_files`（.12）接收workspace、可选相对path（默认`.`）、limit1–100（默认50）、includeHidden（默认false）和原cursor。返回单层名称/相对路径/类型列表、过滤后totalEntries、含隐藏项scannedEntries及hasMore/nextCursor。按名称排序，游标绑定当前目录身份/名称类型指纹与筛选；目录变化拒绝旧游标。每次最多观察2000个条目，不递归、不读取正文或链接目标。选中普通文件后仍由read_artifact独立核对读取。完整边界与来源见 [PROJECT_FILES](PROJECT_FILES.md)。

## 取消、恢复与权限

cancel_run输入runId和key；cancelRequested=true表示已请求，只有实际终态cancelled证明Agent已停。Inbox需另清；子Agent停止语义由Harness管理，独立会话不受影响。

get_operation返回operation{operationId,clientPrincipalId,idempotencyKey,kind,rpcId,state,messageId,error,...}。kind包含start/reply/steer/queue/cancel；state为prepared/submitted/acknowledged/unknown/reconciled/failed。reconcile_operation查询原生历史；不创建替代任务。重启恢复读取原始历史/持久请求，不是模型内部精确断点恢复。

`.7` 对已创建 operation 的派发前失败保存 `failure{code,message,retryable,promptAdmission,nextAction}`，第一次错误和同参数同 key 重放均返回原 operationId/runId。此处 `promptAdmission=not_submitted|rejected|accepted|unknown` 区分未提交、原生明确拒绝、已接收、未知；run 快照自身仍使用原有 pending/accepted/rejected/unknown。旧 failed 记录缺少结构化证据时返回 OPERATION_FAILED，不能仅凭 messageId 为空推断未接收。陈旧 prepared/submitted 不自动重派；保留原 ID 并 reconcile。

close_run_terminals输入runId，只允许终态或明确permission_restore_failed的run，并再次确认精确原生Agent空闲。返回closedIds、remainingIds、stillOwnerActivity、quiescent、permissions{attempted,restored}；.4在恢复后立即根据原生终态更新并持久化run状态，成功、失败、取消各自保留；缺少原终态证据时保留待处理。只关该Agent快照中的PTY。若Host重启后Agent尚未加载，工具会明确unavailable，此时可用reconcile_permissions恢复旧租约，不能把unavailable当已关闭证明。需要活动PTY时本工具不自动加载/恢复任务。

`.7` 清理响应还包含重读的 `run`；重读失败则返回 `runReadError` 并保留已完成的清理回执。Agent 空闲不证明 shell 内的命令已结束；同一 session 的终端可能来自更早的 run。此工具是明确丢弃该 owner 已发布终端的操作，不自动执行，也不声称逐 run 终端归属。

retry_run_with_fallback输入runId。部署显式启用时，仅处理GLM Flash明确额度错误、完整历史排除工具/子任务和其他副作用证据、原文本保留且原run为failed的情况。用固定quota-fallback:<原runId>，同session提交DeepSeek Flash/Max，返回原runId、fallbackReason与新run；不会把超时/断线/unknown当额度错误。真实耗尽场景未人为制造实测。

## 紧凑任务发现（.9）

`list_run_summaries` 支持可选 `workspace`（记录中的完整绝对路径）、`sessionId`、`serviceId`、`status` 组合精确匹配，`limit` 为1–50、缺省20，以及原 `nextCursor` 续页。返回 `runs`、`hasMore`、`nextCursor`；按 `startedAt/runId` 从新到旧。每条是紧凑状态和稳定run/operation/session/service身份，不含task、assistantText和原始历史；详情仍用 `get_run` / `get_run_summary`。旧 `list_runs` 的全快照接口不变。

游标固定首次上界并绑定筛选条件；更晚创建的run不插入本轮遍历，可跨Relay重启。跨条件、损坏或过长游标明确拒绝；重新筛选时不传旧游标。状态可能变化，因此这不是不可变快照。游标校验不提供认证，沿用原单用户信任边界，不触发任务派发、取消或权限变更。

DOT可直接说“列出这个项目最近已完成的两条任务，再读下一页”。无需先记住runId，也无需一次读取所有任务正文。设计来源见 [GitHub对照](CAPABILITY_COMPARISON.md)。

## 连接与错误

doctor诊断本地proxy/端点/owner/token可读性；harness_health实际查询正在运行的Host版本与状态。list_capabilities读取原生目录。list_workspaces/list_workspace_sessions返回项目与会话元数据；search_session_history在选定项目内按关键词寻找任务/回复，再用原历史或run详情核对来源。

需要区分RELAY_ROUTE_UNAVAILABLE（连接/owner/认证原因）、CONCURRENCY_LIMIT（容量、可稍后重试）、PERMISSION_* / RUN_TERMINALS_*（权限/原生状态）、OPERATION_UNKNOWN（先查原ID）、OPERATION_FAILED（明确拒绝）、QUOTA_FALLBACK_*（回退条件）。执行终态failed的原始error单独保留。不要只根据“retryable=true”生成新key重派可能已有副作用的任务。

范围错误使用 `TASK_SCOPE_INVALID`（或具体的 EXTERNAL_PATH_DENIED 等）并包含 `field`、`reason`、适用时的 `path`。隧道前置超时可能完全没有到达插件，无法由 Relay 自行返回此类结构化诊断；部署端可使用 [运维探针](OPERATIONS.md#隧道只读分层诊断)。
