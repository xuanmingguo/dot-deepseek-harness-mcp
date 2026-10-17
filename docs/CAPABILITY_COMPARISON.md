# 同类 GitHub 项目能力对照

2026-10-15–16纽约时间核对，链接固定到当时源码commit。对照的是工具行为，不把项目宣传或其他客户端成功算作本项目验收。

## DOT与Harness整条连接的同类方案

2026-10-16纽约晚间补查公开GitHub项目与官方连接文档。以下是有界候选核对，不能视为完整市场普查；仓库文档中的功能声明也不代表已在本账号/原DOT验收。

| 项目 | 已核对的重合 | 适用边界 |
|---|---|---|
| [tonytanglab/Harness Relay MCP](https://github.com/tonytanglab/deepseek-harness-relay-mcp/blob/17e690cf9a56fc65fe39b2c214276cfdcb5a1891/README.md) | 本仓库的公开上游；现有Harness原生会话、事件、长任务生命周期、权限和持久恢复入口 | main仍为本项目固定源SHA17e690cf9a56fc65fe39b2c214276cfdcb5a1891；[包元数据](https://github.com/tonytanglab/deepseek-harness-relay-mcp/blob/17e690cf9a56fc65fe39b2c214276cfdcb5a1891/package.json)的Harness peer范围低于0.2.0，未覆盖现用0.2.1-alpha.2。本项目保留该版本适配和原DOT实测；上游通用MCP支持本身不是DOT验收 |
| [Emilia-awa/hermes-dsh-bridge](https://github.com/Emilia-awa/hermes-dsh-bridge/blob/5b8c9ef3310a1900faf8bbba3b11c9a44fe7e05f/README.md) | README列25/26工具，包括任务队列、终态webhook、提问挂起通知、会话历史/搜索、按行文件读/列目录、权限与审批 | 最接近的独立功能候选；文档展示Harness内插件和本地Streamable HTTP接入，未找到DOT/Secure Tunnel实测。GPL-3.0，本轮只核对公开行为，没有复制源码或安装 |
| [chushixixin/dsh-harness-mcp-server](https://github.com/chushixixin/dsh-harness-mcp-server/blob/d174cea870aaa9f6dd67f2e9c3f3e3fa0f0e041e/README.md) | README列同步agent_run、异步task_inbox/task_result和工具发现 | 更小的同方向桥接；展示本地HTTP，未见等价持久生命周期/原DOT证据。MIT，未安装或改换现有生产配置 |
| [官方Harness MCP client](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.md) | Harness消费外部MCP工具 | 是客户端方向，不能单凭该组件推断外部DOT已能操控Harness |
| [OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels#connect-from-chatgpt) | 官方明确列出从ChatGPT插件连接私有MCP的流程 | 是传输/接入组件，任务、会话、权限和恢复仍由Harness桥接实现；该段官方文档未提供上述第三方项目的原DOT验收 |

已有直接相关产品和组件，本项目是在Relay上游基础上维护兼容与实际连接，不把普通DeepSeek模型API包装当成相同能力。当前证据尚未找到一个公开项目明确展示“原DOT主聊天＋现有Harness0.2.1-alpha.2＋同一Tunnel路径＋同等恢复能力”的完整开箱实测。可继续参考hermes-dsh-bridge的终态回调和提问通知设计；这些只读调研结果不授权新增回调服务、改造生产或替换连接。

## 具体能力来源

| 原始项目/来源 | 实际已有能力 | 本项目已有/缺口与选择 |
|---|---|---|
| [mcollina/mcp-ripgrep f76ae1c](https://github.com/mcollina/mcp-ripgrep/blob/f76ae1c4b7913ad1e471950a1c33b2974e1e6325/src/index.ts)；[AtefAndrus/mcp-ripgrep aa0ba75](https://github.com/AtefAndrus/mcp-ripgrep/blob/aa0ba751a48ad8fe59512c01d827439e51292360/src/tools/search.ts)及[输出截断](https://github.com/AtefAndrus/mcp-ripgrep/blob/aa0ba751a48ad8fe59512c01d827439e51292360/src/truncate.ts) | 文件内容搜索、字面关键词/大小写、目录筛选和输出上限；两者maxResults限制每文件匹配 | `.14` 补上search_project_text，在原项目权限内返回路径/原行号/片段/完整文件SHA。独立区分扫描覆盖与全局返回上限，达到输出上限后继续有界计数；不用其shell拼接、rg子进程或第二服务器 |
| [MCP Filesystem bbb701e文本工具](https://github.com/modelcontextprotocol/servers/blob/bbb701e7ac1e57f3edd1c2836b94c5457eaf7b9c/src/filesystem/server.ts#L229-L294)；[K Filesystem MCP 0d4225d的范围选择](https://github.com/3mzKK/k-filesystem-mcp/blob/0d4225d25d8c35ff7643f2bb8ea5d63b9288c482/dist/index.js#L787-L867) | 已知文件的文本/head/tail读取；K版另有1起始行范围、原行号和结构化选择/截断结果 | `.13` 补上read_project_text，直接读真实UTF-8行与末尾，并带完整原始文件SHA256及连续读取校验。使用现有项目权限，200行/32KiB文本/64KiB结果/16MiB文件；不采用K版global local filesystem、无限读取或文件写入 |
| [MCP Filesystem，bbb701e](https://github.com/modelcontextprotocol/servers/blob/bbb701e7ac1e57f3edd1c2836b94c5457eaf7b9c/src/filesystem/server.ts) | list_directory验证允许目录并区分文件/目录，便于发现路径后读取文件 | `.12` 补上单层项目文件发现，复用原read_artifact授权、固定Linux目录描述符及更严格的链接拒绝；不引入第二服务器或文件写入工具 |
| [Shebe，f361020](https://github.com/shebe-oss/shebe/blob/f361020c09324a93da3812885c03a7bc472ffd22/services/shebe-server/src/mcp/tools/list_dir.rs) | list_dir按名称排序、有界输出、游标续页，并验证来源fingerprint | `.12` 采纳条件/目录指纹绑定与明确续页，直接读现有目录，不复制全文索引、Tantivy后端或其500项上限 |
| [kenn-io/agentsview v0.41.0，82c31c5](https://github.com/kenn-io/agentsview/blob/82c31c59384e2363f1d66af5eaede3c1a8de0b4d/internal/mcp/tools.go)；[原生窗口实现](https://github.com/kenn-io/agentsview/blob/82c31c59384e2363f1d66af5eaede3c1a8de0b4d/internal/db/messages.go) | search返回session_id/match_ordinal，get_messages据精确序号读取有界窗口，保留ordinal与截断标志；支持双侧窗口、角色过滤、序号0与分页 | `.11` 补上search命中后的直接原文/前文展开；使用Harness原生seq/throughSeq和项目权限，保持文本块身份。公开page只支持向前读，因此本接口限定原消息及较早消息，不照搬SQL双侧窗口 |
| [Gunther-Schulz/claude-session-mcp，5d0530f](https://github.com/Gunther-Schulz/claude-session-mcp/blob/5d0530fe0cd048f8834a37bc94f6b97cc34b7280/README.md)；[实现](https://github.com/Gunther-Schulz/claude-session-mcp/blob/5d0530fe0cd048f8834a37bc94f6b97cc34b7280/src/claude_session_mcp/server.py) | 轻量会话列表；search按不区分大小写的字面关键词搜索user/assistant，支持项目/会话/角色等筛选，返回来源及短片段；其搜索本身没有扫描续页，线程/列表分页是另行接口 | `.9` 增加紧凑run发现；`.10` 增加原生历史搜索，借鉴角色筛选与附近原文，但按Harness原生seq而非Claude分叉树定位，增加有界扫描和可续页的明确完成标志 |
| [benvenker/agent-session-search，184b332](https://github.com/benvenker/agent-session-search/blob/184b33295de0153e00f77de6843b2fef1f2a6265/docs/mcp.md)；[oversized fallback](https://github.com/benvenker/agent-session-search/blob/184b33295de0153e00f77de6843b2fef1f2a6265/src/oversized-search.ts) | 区分紧凑候选与限定来源的有界证据；后续请求绑定原查询fingerprint。大型文件fallback有显式扫描/输出上限和不完整提示 | `.10` 采纳有界证据、来源身份和条件绑定；直接读现有原生历史，使用sessionId/seq/throughSeq，不引入FFF、文件索引或其后端的搜索语法 |
| [jawkjiang/claude-code-mcp，b8b3208](https://github.com/jawkjiang/claude-code-mcp/blob/b8b3208010564dda18410d84b398355872969559/src/index.ts) | 内存会话列表含活动/状态/最近时间/输出及待审批标志；读取进展、响应审批、interrupt | 本项目已有持久run、精确原请求查询、问答/审批及取消；无需重复添加。紧凑列表保留稳定run/operation/session身份供下一步读取 |
| [tuannvm/codex-mcp-server，a57acb6](https://github.com/tuannvm/codex-mcp-server/blob/a57acb6080ae41139211fdfabf2bce4851a86b1a/README.md) | listSessions、指定session续接、threadId结构化返回及outputSchema | 本项目已有续接/身份和结构化结果；新增发现工具也声明outputSchema，不另建Codex运行时 |

`.9` 新增 `list_run_summaries`：按workspace/sessionId/serviceId/status组合筛选、每页1–50（缺省20）、最近优先、紧凑元数据和绑定筛选条件的续页游标。不返回任务正文、完整模型输出或原始日志；选中run后使用已有get_run/get_run_summary读取。旧list_runs保持兼容。

`.9` 已实现并在原DOT实际验收：15次只读调用覆盖筛选、两页/重放、两种非法游标及错误恢复、零匹配、代理重载后的原游标续读；独立原生核对通过。完整结果见 [验收记录](ACCEPTANCE.md)。

游标不是权限凭证或数据库快照；新创建且更晚的run不插入正在翻页的窗口，状态在翻页期间变化仍按当前可见状态处理。具体边界与用法见 [TOOLS](TOOLS.md)。本轮不加入全文索引或Claude分叉语义，Harness原生事件仍是历史权威。

`.10` 的关键词搜索契约和边界见 [HISTORY_SEARCH](HISTORY_SEARCH.md)。它补上跨原生会话的任务/结果发现，不依赖Relay是否保存过该任务正文。原DOT27次实际调用及26次独立读取已通过，涵盖旧任务/结果、中文/字面标点、分页/零命中继续扫描、错误拒绝与恢复；记录见 [ACCEPTANCE](ACCEPTANCE.md)，不由同类项目的功能推断。

`.11` 选择补齐“找到消息后直接展开原文与前文”：此前只能拿搜索片段或从最新原生页逐步翻到旧命中。`read_session_context` 将同一session/seq/throughSeq直接交给原生page，返回精确原消息和最近前文、原文本块索引及明确截断。AgentsView的命中ordinal到消息窗口是主要参考；Gunther的get_thread则证明原消息路径与文本上限的用途。后者的Claude分叉树和前者的SQL双侧窗口未移植。契约和限制见 [SESSION_CONTEXT](SESSION_CONTEXT.md)；AgentsView固定版本有独立 [MIT许可证](https://github.com/kenn-io/agentsview/blob/82c31c59384e2363f1d66af5eaede3c1a8de0b4d/LICENSE)。

`.11` 原DOT目录缺口已通过同一应用安装绑定恢复后实测闭环，最终14次调用验证搜索到原文/前文、长度与截断、历史开头、精确cut、三项拒绝与恢复，结果与原历史一致。477项测试476通过、1条件跳过、0失败；细节与此前未通过的目录探测见 [ACCEPTANCE](ACCEPTANCE.md)。

没有复制上述项目源码或引入其依赖。Gunther README声明MIT但未找到独立许可证文本；benvenker有[独立MIT许可证](https://github.com/benvenker/agent-session-search/blob/184b33295de0153e00f77de6843b2fef1f2a6265/LICENSE)；jawkjiang包元数据声明MIT，tuannvm README声明ISC。仅借鉴已核实功能模式，原上游MIT归属与固定SHA继续保留在 [UPSTREAM](../UPSTREAM.json)。新增功能必须经过本地契约/打包检查和原DOT实测，不能只以比较文档作为完成。

`.12` 选择“发现文件再读取”的缺口：原工具只能读已知路径，需要额外任务才能获知目录。新 `list_project_files` 返回直接条目的名称、相对路径和类型，最多100项/页、2000条目录扫描预算，游标重验当前目录及筛选；不递归、读取正文或沿链接访问目标。使用与限制见 [PROJECT_FILES](PROJECT_FILES.md)。Shebe固定版本为[Apache-2.0](https://github.com/shebe-oss/shebe/blob/f361020c09324a93da3812885c03a7bc472ffd22/LICENSE)；MCP仓库固定版本的[许可证说明](https://github.com/modelcontextprotocol/servers/blob/bbb701e7ac1e57f3edd1c2836b94c5457eaf7b9c/LICENSE)包含MIT向Apache-2.0过渡，均仅作行为参考，没有复制代码。

`.12` 原DOT最终18次实际调用已通过，覆盖三页/重放、隐藏和空目录、实际发现中文文件后读取、四项拒绝与恢复；早先3/0次目录未暴露轮次保留。487项测试486通过、1条件跳过、0失败；源码与既有生产运行边界详见 [ACCEPTANCE](ACCEPTANCE.md)。

`.13` 选择按行读取：发现文件后，原base64字节工具不便于核对源码位置、日志末尾和长文本续读。独立增加原行号、完整文件指纹、UTF-8/BOM/CRLF和完整行输出边界；没有把同类项目的权限模式搬到远程DOT。K版固定源码与独立MIT许可证已核对，来源及精确契约见 [PROJECT_TEXT](PROJECT_TEXT.md)。生产和原DOT通过情况只以 [ACCEPTANCE](ACCEPTANCE.md) 的具名版本记录为准。

`.13` 原DOT23次实际调用通过（6次预期拒绝），包括真实追加文件后旧SHA拒绝、新SHA新内容读回；498测试497通过/1环境跳过/0失败。正常工具刷新和原聊天重载即可看到新工具，本轮没有绑定重装。现有Host与驻留代理均加载.13，原数据和共享包保持不变。

`.14` 按用户明确要求补上项目文件正文的关键词搜索：此前只能浏览目录或读取已知路径，历史搜索也只覆盖用户/助手对话。新工具以受限目录深度优先扫描、字面关键词和原行号来发现文件，SHA交给现有按行读取展开。固定预算和跳过均显式呈现，不把结果省略当作未扫描，也不把未完成的零匹配当作项目没有结果。来源与边界见 [PROJECT_SEARCH](PROJECT_SEARCH.md)，实际验收单独记在 [ACCEPTANCE](ACCEPTANCE.md)。

`.14` 原DOT23次实际调用通过（3次预期拒绝），包括真实搜索→原SHA展开→文件追加后旧SHA拒绝→重新搜索/新SHA展开。515测试514通过/1环境跳过/0失败，独立stdio25次验证通过；现有Host/代理.14健康，原任务、操作和共享依赖保留。没有安装表中其他产品或据文档推断它们已接通DOT。
