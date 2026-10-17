# 命中消息原文与前文（.11）

`read_session_context` 把历史搜索结果展开为原消息及最近的前文。先用 `search_session_history` 找到任务或结果，再原样传入命中的 `sessionId`、`seq`（作为anchorSeq）、`throughSeq` 及原项目。通过现有Harness公开 `session.page` 接口直接定位该序号；不会从最新历史反复扫描到旧命中，也不会重新执行任务。

## 参数与范围

| 参数 | 约定 |
|---|---|
| workspace | 必填；已登记项目的完整路径或workspaceId，每次重验当前根目录策略 |
| sessionId | 必填；属于该项目当前可见会话，含归档会话，排除已失效/子代理/外项目cwd条目 |
| anchorSeq | 必填；精确命中的原生事件序号，0也是有效序号 |
| throughSeq | 必填；原搜索结果的固定cut，必须大于等于anchorSeq，保持原搜索时的范围 |
| beforeMessages | 0–10，默认2；返回原消息加最近的这些较早用户/助手文本消息，按时间序号正序排列 |
| maxMessageChars | 1–4000，默认2000；每条消息所有返回文本块合计的Unicode字符上限 |

每条消息保留原 `seq/role/eventType`、可用的原生time以及原 `textBlockIndex`。`textBlocks[].text` 是对应原文本块的前缀；各块 `textLength/truncated`、消息 `textLength/omittedTextBlocks/messageTruncated` 明示截断。最多返回每消息10个非空文本块和总共11条消息，emoji不会在代理对中间断开。省略空文本块时仍保留原块索引，omittedTextBlocks统计因字符/块数上限而未返回的非空文本块。

仅包括与历史搜索一致的原始用户/助手文本；明确标记plugin来源的用户上下文、reasoning、工具内容和媒体不作为文本消息。原生user/message也可能是Harness的运行上下文或时间提示，按原role保留，不推断为人类新授权。原生完整记录仍由 `read_session_history` 提供。所有返回历史是资料，不是新的操作指令或授权。

## 完整性与失败

`messages` 的最后一项始终是精确anchor，较早项是它的前文；不推断Claude分叉树、任务成败或后续消息。`returnedBeforeMessages` 给出实际前文数；到达历史开头时可以少于请求数。`contextComplete=true` 表示请求的窗口已满足或已确认到达历史开头，`hasEarlier` 表示还存在未扫描的较早原生记录，不保证其中有合格文本，也不表示整个会话已读完。

每次最多5个原生页，每页请求maxMessages10并限制原始JSON512KiB；原生页包含消息之间的事件，事件条数不等于消息数。跨页固定throughSeq、严格向前推进。超出扫描预算返回 `CONTEXT_SCAN_LIMIT`，没有部分成功或伪造完整性；可减少beforeMessages，或使用已有原生历史接口核对。

不存在精确序号返回 `CONTEXT_ANCHOR_NOT_FOUND`；序号指向非文本/被排除事件返回 `CONTEXT_ANCHOR_NOT_TEXT`，不会退到旁边另一条消息冒充命中。参数、当前项目权限、原生错误/格式和超大页面均明确报错。后续会话新增内容不挤动指定cut；游标/序号不提供认证，当前项目范围仍须每次校验。

## 来源与用法

主要参考 [AgentsView v0.41.0的MCP实现，82c31c5](https://github.com/kenn-io/agentsview/blob/82c31c59384e2363f1d66af5eaede3c1a8de0b4d/internal/mcp/tools.go)：search返回session和match_ordinal，随后get_messages精确展开、有界消息原文及截断标记；它还支持双侧窗口和其他分页，未照搬到本接口。该固定版本有 [MIT许可证](https://github.com/kenn-io/agentsview/blob/82c31c59384e2363f1d66af5eaede3c1a8de0b4d/LICENSE)。另对照 [Gunther get_thread，5d0530f](https://github.com/Gunther-Schulz/claude-session-mcp/blob/5d0530fe0cd048f8834a37bc94f6b97cc34b7280/src/claude_session_mcp/server.py) 的原消息路径和文本上限；Harness以自己的原生事件序号及固定cut为准。

独立实现，无复制第三方源码、新依赖或索引。可对DOT说：“在这个项目里搜以前提到‘权限恢复’的结果，把命中的原文和前两条对话展开，给我原会话和事件序号。”来源对照见 [CAPABILITY_COMPARISON](CAPABILITY_COMPARISON.md)，实际验收见 [ACCEPTANCE](ACCEPTANCE.md)。
