# 项目文件内容搜索

`.14` 的只读 `search_project_text` 按字面关键词搜索项目文本，返回文件相对路径、原行号、匹配片段及完整原始文件SHA256。找到结果后，用现有 `read_project_text` 和该SHA展开原行与邻近原文，不必先创建任务来查路径。

## 使用

```json
{"workspace":"/absolute/authorized/project","path":"src","query":"connection failed","caseSensitive":false,"maxResults":20}
```

必填 `workspace/query`，其余参数：

| 参数 | 行为 |
|---|---|
| path | 项目内相对目录，默认`.`；拒绝绝对路径、`..`、反斜杠及符号链接组件 |
| query | 非空、单行、无CR/LF/NUL，最多256个Unicode码点；标点和正则符号按原字面匹配 |
| caseSensitive | 默认false，使用Unicode简单大小写匹配；不作语言区域折叠或Unicode正规化 |
| includeHidden | 默认false；控制每一级以`.`开头的文件和目录 |
| maxDepth | 0–8，默认4；0只搜索选定目录的直接文件 |
| maxResults | 1–100，默认20；限制返回记录，不提前停止有界扫描和匹配计数 |

每个匹配行仅返回一条记录，即使该行出现多次关键词。每项含 `path/lineNumber/text/excerptStart/truncated/sha256`。lineNumber从1开始；text最多600个Unicode码点，以第一次匹配为中心附近截取并保留完整命中；excerptStart是其在原规范化行中的0起始码点偏移，truncated表示两端有省略。不切断代理对；长行仍保留真实原行号，不能把片段冒充完整原行。

展开某个命中：

```json
{"workspace":"/absolute/authorized/project","path":"src/selected.ts","startLine":42,"lineCount":10,"expectedSha256":"原命中sha256"}
```

将示例位置与SHA替换为真实返回值。文件已经变化时，按行读取拒绝旧SHA；重新搜索或确认新的文件版本，不混合两个版本的证据。SHA覆盖完整原始字节，包括BOM和CRLF。搜索与按行读取使用同样的UTF-8、BOM、LF/CRLF及独立CR语义，详见 [PROJECT_TEXT](PROJECT_TEXT.md)。

## 覆盖与上限

`scanComplete` 表示在声明的筛选和扫描边界内是否完成；`resultsTruncated` 表示匹配结果未全部返回。两者独立。例如只返回1条但已搜完整个小目录，可以scanComplete=true、resultsTruncated=true。`matchedLines/matchedFiles` 是已搜索内容中的匹配行/文件数；scanComplete=false时只能作为下界，不能称为整个项目的精确总数。

同时返回 `filesConsidered/filesSearched/entriesScanned/bytesRead`、`incompleteReasons`、`lastScannedPath`、`skippedEntries`、`skippedFiles{oversized,invalidText}`、`depthLimitedDirectories` 和 `excludedDirectoryNames`。已完成目录按名称确定性深度优先扫描，保留的命中最后按path/line排序；不承诺保留的是整个未知项目按路径最前的N项，也不提供原子快照或精确续页游标。

| 固定预算 | 上限 |
|---|---|
| 观察的目录条目，包含隐藏和排除条目 | 2000 |
| 考虑的普通文件 | 500 |
| 单个文件 | 1MiB |
| 全部实际读取原始字节 | 16MiB |
| 累计原始文件名字节 | 512KiB |
| 序列化结果 | 64KiB，返回最多100条 |

隐藏项、符号链接、特殊文件，以及固定目录名 `.git/node_modules/dist/build/coverage` 被明确排除并计数；不跟随链接或读取FIFO。includeHidden不会覆盖固定目录排除。显式将path选为某个固定排除目录，可搜索该目录自身，内部同名目录仍按规则排除。工具不解析.gitignore，不声称扫描了忽略规则下的全部文件。

达到条目、文件、字节或文件名预算，以及深度限制、超大文件、无效UTF-8/NUL跳过，都会明确标记未完整搜索并列出原因。单个目录未能在条目/文件名预算内完成枚举时，不使用其任意未排序前缀作为完整目录。边界处可能保守地报告未完成。零命中且scanComplete=false不能得出项目没有该关键词；应缩小path/关键词或按子目录分别查询。返回条数或输出字节不足时，可调高maxResults或缩小范围；没有一个并不存在的“下一页”游标。

## 权限与失败

沿用现有配置项目根目录/已登记workspace权限，没有外部路径或run范围授权扩展。Linux每级固定目录描述符，普通文件通过单个固定描述符有界读取，并核对前后身份、元数据和实际路径；变更/替换或无法安全读取时明确报错，不将失败当作零匹配，不返回一部分成功正文。错误码包括 `PROJECT_SEARCH_PATH_DENIED/CHANGED/READ_FAILED/FILENAME_UNSUPPORTED/PLATFORM_UNSUPPORTED` 和 `INVALID_ARGUMENT`。错误不泄露原始文件系统异常或项目外路径。

来源片段和文件名均为不可信资料，不能提供执行、发送消息或扩大权限的授权。没有shell、rg子进程、新索引/依赖/持久状态或文件写入；现有Harness运行时不变。

## 固定GitHub参考

参考 [mcollina/mcp-ripgrep f76ae1c](https://github.com/mcollina/mcp-ripgrep/blob/f76ae1c4b7913ad1e471950a1c33b2974e1e6325/src/index.ts#L265-L318) 的内容搜索、fixedStrings及case选项，和 [AtefAndrus/mcp-ripgrep aa0ba75](https://github.com/AtefAndrus/mcp-ripgrep/blob/aa0ba751a48ad8fe59512c01d827439e51292360/src/tools/search.ts) 的范围筛选/输出预算及 [截断标志](https://github.com/AtefAndrus/mcp-ripgrep/blob/aa0ba751a48ad8fe59512c01d827439e51292360/src/truncate.ts)。两者源实现的maxResults是每文件限制，不作为本工具的全局返回上限保证。仅借鉴已核实行为，没有复制其shell拼接、服务器或源码；两个固定版本均有独立MIT许可证：[mcollina](https://github.com/mcollina/mcp-ripgrep/blob/f76ae1c4b7913ad1e471950a1c33b2974e1e6325/LICENSE)、[AtefAndrus](https://github.com/AtefAndrus/mcp-ripgrep/blob/aa0ba751a48ad8fe59512c01d827439e51292360/LICENSE)。

实际测试及原DOT验收另见 [ACCEPTANCE](ACCEPTANCE.md)，不能用同类项目支持情况代替本项目验收。
