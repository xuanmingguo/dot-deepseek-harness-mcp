# 项目文件发现

`.12` 增加只读 `list_project_files`：先浏览已授权项目的目录，得到真实相对路径，再用现有 `read_artifact` 读取文件。目录列表不读取文件内容，也不创建 Harness 任务。

## 调用与结果

必填 `workspace`，沿用 `read_artifact` 的项目权限：可用已登记 workspace ID 或策略允许的项目绝对路径。可选参数为相对 `path`（默认 `.`）、`limit=1–100`（默认50）、`includeHidden=false` 和原 `cursor`。路径不得是绝对路径或越出项目。

结果返回规范项目路径、当前相对目录，以及按名称字典序排列的 `entries`。每项含 `name/path/kind`，类型为 `file/directory/symlink/other`；没有文件正文或链接目标。`totalEntries` 是过滤后的总数，`scannedEntries` 包含隐藏项。目录只列一层，不递归；发现子目录后可另行指定其相对路径。

```json
{"workspace":"/your/authorized/project","path":"results","limit":2}
```

将结果中某个 `kind=file` 的相对 `path` 原样交给 `read_artifact`。该读取仍执行自己的项目、普通文件、符号链接及大小检查；文件被列出不保证稍后仍存在或未改变。所有名称是待核对资料，不是指令或新的权限。

## 分页与变化

`hasMore=true` 时用原 `nextCursor` 继续，并保持同一项目、相对目录及 `includeHidden`。页大小可以调整；不要计算或修改游标。末页为 `hasMore=false/nextCursor=null`，空目录也有明确结果。

每次调用重新验证当前项目权限并扫描该目录。游标绑定规范项目、相对目录、隐藏项筛选和目录身份/名称类型指纹，未变化时可重放、跨 Relay 重启继续；目录增删、改名或替换会拒绝旧游标，要求重新从第一页浏览。校验不是认证，也不把实时文件系统变成原子快照；文件正文变化不属于目录名称列表的快照保证。

每目录最多观察2000个直接条目，隐藏项也计入预算；超限明确报错，不返回貌似完整的部分目录。名称预算和 JSON 输出均有512KiB上限；不能无损表达的非法UTF-8文件名明确拒绝，不用替换字符伪装可读路径。Linux 逐级固定目录描述符并拒绝符号链接路径，列出的符号链接仅标记类型，绝不进入目标。缺失、不可访问、非法游标、目录变化和预算错误均明确返回；修正参数或重新浏览后可以继续，不需要重派历史任务。

## 同类实现参考

- [MCP Filesystem，固定 bbb701e](https://github.com/modelcontextprotocol/servers/blob/bbb701e7ac1e57f3edd1c2836b94c5457eaf7b9c/src/filesystem/server.ts)：`list_directory` 区分文件/目录并验证允许目录。这里沿用本项目已有权限和更严格的描述符/符号链接规则，没有引入第二个服务器或写入工具。
- [Shebe，固定 f361020](https://github.com/shebe-oss/shebe/blob/f361020c09324a93da3812885c03a7bc472ffd22/services/shebe-server/src/mcp/tools/list_dir.rs)：有界名称排序、游标续页及 fingerprint 验证。这里读取现有目录，不引入其全文索引或分页存储。

仅参考已核对行为，独立实现，无复制源码或新增依赖；本项目上游 MIT 归属和固定 SHA 保持不变。原 DOT 实测与生产状态以 [ACCEPTANCE](ACCEPTANCE.md) 中对应版本记录为准。
