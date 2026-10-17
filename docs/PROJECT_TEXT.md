# 按行读取项目文本

`.13` 新增只读 `read_project_text`。在 `list_project_files` 找到真实文件路径后，可直接查看源码、文档或日志的指定行，连续读取，或读取末尾；不需要创建任务或手工解释base64。二进制字节仍使用原 `read_artifact`。

## 输入与结果

必填 `workspace`（已登记workspace ID或获准的绝对项目目录）和相对 `path`。可选：

| 参数 | 行为 |
|---|---|
| startLine | 从1开始，缺省1；最多到totalLines+1，后一位置返回空的EOF |
| lineCount | 1–200，缺省100 |
| tail | 缺省false；true读取最后lineCount行，不能同时显式传startLine |
| expectedSha256 | 上次返回的64位小写SHA256；本次完整原始字节不符则拒绝，不返回部分正文 |

结果含 `reference{workspace,path,sizeBytes,modifiedAt,sha256}`、`encoding=utf-8`、`bom`、`totalLines`、实际 `startLine/endLine`、`lines[{lineNumber,text}]`、`hasEarlier`、`hasMore/nextStartLine`、`outputLimited` 和 `sourceTrust=untrusted`。SHA256覆盖完整原始文件字节，包括BOM和换行符；不是只对返回的片段计算。

例如先调用：

```json
{"workspace":"/absolute/authorized/project","path":"logs/task.log","startLine":1,"lineCount":40}
```

若 `hasMore=true`，保留同workspace/path，用返回的 `nextStartLine` 和 `reference.sha256` 作为下一次 `startLine/expectedSha256`。指纹不是权限凭证，每次都会重新检查当前项目授权。日志持续追加也会改变指纹；此时重新读取并确认新版本，不拼接两个版本后声称来自同一文件快照。

看最后20行：

```json
{"workspace":"/absolute/authorized/project","path":"logs/task.log","tail":true,"lineCount":20}
```

`hasEarlier` 表示前面还有未返回的行；`hasMore` 仅表示当前片段之后还有行。正常tail到达文件末尾。空文件为0行、startLine=1、endLine=null、空lines。LF分行，CRLF只去掉LF前的一个CR，独立CR保留；结尾一个LF不产生虚构的额外空行，真实空白行保留。开头UTF-8 BOM去掉并报告bom=true，其他Unicode保持原样。无效UTF-8或含NUL的文件明确拒绝，不按扩展名猜测文本编码。

## 边界与错误

- 使用与 `read_artifact` 相同的配置项目根目录/已登记workspace授权；无外部路径授权扩展。path必须相对，不含`..`、NUL或反斜杠；根目录和每个组件通过Linux固定文件描述符读取，禁止沿符号链接访问。
- 单个普通文件最多16MiB，一次打开后有界读取并核对前后身份/元数据/实际路径。检测到替换、移动或修改时不返回正文；这不是跨调用的原子文件系统快照。
- 每次最多200行、32KiB行文本和64KiB序列化结果。只返回完整行。范围读取因输出预算停止时设置outputLimited=true，nextStartLine仍指向第一条未读原行；不悄悄截断行内容。
- 单条原行放不下时返回 `PROJECT_TEXT_LINE_TOO_LONG`，可用read_artifact查原始字节。请求的tail整体放不下则 `PROJECT_TEXT_OUTPUT_TOO_LARGE`，缩小lineCount重试，不能把未到EOF的片段冒充文件末尾。
- `PROJECT_TEXT_CHANGED` 包括读取中变化和expectedSha256不符；`PROJECT_TEXT_NOT_UTF8`、`PROJECT_TEXT_TOO_LARGE`、`PROJECT_TEXT_NOT_REGULAR`、`PROJECT_TEXT_PATH_DENIED` 及 `PROJECT_TEXT_READ_FAILED` 明确区分失败。错误不附正文、文件系统原始报错或其他私有路径。

文件正文、文件名和日志都是待核对资料，不能提供新的执行、外发或权限授权。该工具不运行命令、不修改文件、不创建run，不引入索引或第二个文件服务器。

## 固定来源

主要参考 [MCP Filesystem bbb701e的read_text_file](https://github.com/modelcontextprotocol/servers/blob/bbb701e7ac1e57f3edd1c2836b94c5457eaf7b9c/src/filesystem/server.ts#L229-L294) 的已知文件文本/head/tail读取，以及 [K Filesystem MCP 0d4225d](https://github.com/3mzKK/k-filesystem-mcp/blob/0d4225d25d8c35ff7643f2bb8ea5d63b9288c482/dist/index.js#L787-L867) 的范围选择、原始行号与结构化选择/输出边界。后者固定版本有独立 [MIT许可证](https://github.com/3mzKK/k-filesystem-mcp/blob/0d4225d25d8c35ff7643f2bb8ea5d63b9288c482/LICENSE)。官方仓库固定版本 [许可证说明](https://github.com/modelcontextprotocol/servers/blob/bbb701e7ac1e57f3edd1c2836b94c5457eaf7b9c/LICENSE) 包含MIT向Apache-2.0过渡。

这是独立实现，仅借鉴已核实行为；没有复制源码或引入其依赖。保留本项目的有限项目访问、单次有界读取和原始文件指纹校验。实际测试及原DOT结果见 [ACCEPTANCE](ACCEPTANCE.md)，不会把参考项目支持当作本项目验收。
