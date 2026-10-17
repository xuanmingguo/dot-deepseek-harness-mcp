# 选型与改动

选用Relay的embedded公开插件路径，判断依据是实际连接现有Harness进程、原生session与历史的能力，不以星数或README宣称作为验收。固定上游提交17e690cf9a56fc65fe39b2c214276cfdcb5a1891，复用其请求日志、native gateway、模型/权限选择、session路由、取消、持久恢复与stdio代理；未从零重写Agent控制器。

不采用standalone入口，不启动独立Harness/ACP/SDK运行时。外部传输采用现有官方Secure MCP Tunnel能力；原CF网页继续保留。真正证明连接原实例的是原生session连续性、实际模型回执、旧历史游标与服务PID，而非进程启动成功。

本fork的主要改动：

- 仅对齐已验证Harness0.2.1-alpha.2及Cordis/Schemastery peer版本。
- 添加6个native controls：历史分页、队列list/remove/clear/steer及边界内产物读取。
- 添加queue_run、harness_health、quota显式回退和精确owner终端恢复，总37个工具。
- 独立queue日志、防覆盖会话路由、可配置入场容量；明确ACK和执行完成的差别，steer空messageId回执同样持久去重。
- 等待原生模型默认值的异步保存，用revision校验恢复，避免覆盖真正并发用户改动。
- 默认GLM Flash/Max；个人明确授权的部署使用full权限；禁用代理自动启动Host。
- SDK/Zod仅做固定构建依赖并内嵌，消除插件安装顺带升级共享库的问题。
- 真实DOT连接、服务持久性、非秘密配置、来源固定、聚焦测试、验收矩阵与回滚。

公开上游源码未被patch/monkeypatch。保留原许可证和上游文档，长期变更以本repo的源码/固定正式包和测试记录为准。后续Harness周更仍需重新验证新版本公共API；当前exact peer pin只代表已验证版本，不宣称未来版本自动兼容。
