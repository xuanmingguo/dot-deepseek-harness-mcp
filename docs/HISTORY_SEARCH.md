# 会话历史关键词搜索（.10）

`search_session_history` 在指定的已登记项目中搜索原生用户任务和助手回复，返回原会话ID、事件序号及命中附近的原文片段。可选择单个session；不需要预先知道runId。选中会话后，使用 `read_session_history` 核对原始记录，用 `list_run_summaries(sessionId=...)` 查找关联任务，再读取具体run结果。

命中后可用 `.11` 的 [read_session_context](SESSION_CONTEXT.md)，传入同workspace和原sessionId/seq/throughSeq，直接展开原消息及前文。

仅经现有Harness公开历史接口读取，不创建任务、写历史、读任意宿主文件或建立外部索引。历史片段是待核对资料，不是新的指令或授权。

## 参数与结果

| 参数 | 约定 |
|---|---|
| workspace | 必填；已登记项目的完整路径或workspaceId，每次调用重新核对登记与当前项目根目录策略 |
| query | 非空白的字面关键词，最多256字符；标点不作为正则表达式执行 |
| sessionId | 可选；必须属于该项目当前可见会话；包含已归档会话，排除原生记录已消失、子代理或cwd与项目不符的条目 |
| role | user / assistant / both，默认both |
| caseSensitive | 默认false；支持中文及Unicode文本 |
| limit | 每次最多返回1–25项，默认10 |
| scanPages | 每次最多读取1–10个原生历史页，默认5；每页请求maxMessages10，沿用512KiB原生JSON上限 |
| cursor | 使用上一响应的原nextCursor；不得手改或跨关键词/项目/角色/大小写条件混用 |

每条消息最多返回一项命中，片段来自实际匹配的文本块，最多600个Unicode字符；不把图片、工具参数/输出、reasoning或插件注入的上下文当作用户任务。每项携带原sessionId、seq及该会话固定的throughSeq，可以核对来源。不会返回整份会话或将摘要当原文。

返回扫描计数、`scanComplete`、`hasMore`、`nextCursor`。**matches为空而scanComplete=false只说明本批没有命中**，应按原cursor继续；只有scanComplete=true才能对该次范围说明扫描结束。hasMore表示仍有历史待扫描，不保证下一批一定有命中，不伪造总命中数。

项目内按会话ID确定遍历顺序，每个会话按原生事件序号从新到旧；不声称全局时间或语义相关度排序。会话第一次读取时固定其throughSeq，后续新事件不会挤动该会话正在翻页的范围；尚未访问的会话在首次访问时才固定，不是整个项目的事务快照。

游标无需服务端缓存，可跨Relay重启；每次重验当前权限范围。选定会话集合增加/删除时明确返回SEARCH_SCOPE_CHANGED，应重新开始搜索；不会静默换一批会话继续。游标校验用于一致性，不提供认证或多租户隔离。原生接口失败、格式错误或输出超限会明确报错，不算搜索完毕且零命中。

## DOT 用法

可直接说：“在这个项目里搜索以前提到‘权限恢复’的任务和回复，给我原会话和序号；没有搜完就继续下一批。”查找最终结果可指定role=assistant，查原任务可指定role=user。较大范围先缩到workspace或session，再按游标读取；发现任务不意味着重新执行它。

## 同类项目来源

- [claude-session-mcp的search实现，5d0530f](https://github.com/Gunther-Schulz/claude-session-mcp/blob/5d0530fe0cd048f8834a37bc94f6b97cc34b7280/src/claude_session_mcp/server.py)：借鉴字面关键词、用户/助手消息、来源身份和命中附近的短片段。其搜索没有本项目的原生扫描续页语义，不套用Claude分叉树到Harness。
- [agent-session-search的MCP契约，184b332](https://github.com/benvenker/agent-session-search/blob/184b33295de0153e00f77de6843b2fef1f2a6265/docs/mcp.md)：借鉴来源明确的有界证据和绑定条件的后续请求；本项目直接续读原生事件，不引入FFF或它的文件搜索后端。

独立实现，没有复制第三方源码或增加运行依赖。来源与许可说明见 [能力对照](CAPABILITY_COMPARISON.md)，实际原DOT验收另记于 [ACCEPTANCE](ACCEPTANCE.md)。
