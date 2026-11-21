# 受控 MCP 接入设计

日期：2026-11-20

状态：按产品方向推进的实施设计

## 调研结论

### 可复用

- `RuntimeController` 是 Harness 的方法入口，SQLite `meta` 可持久化服务器、工具授权和状态，不需要新增任意代码执行接口。
- `PermissionGateway` 默认拒绝未知 action，可增加 MCP 工具级授权判断。
- `runPiAgentTurn` 已集中构建 Pi 工具、顺序执行、记录工具状态，并将工具结果写入 transcript。
- `LocalRuntimeLogger` 使用字段白名单，可扩充服务器 ID、MCP 工具 ID 等非敏感字段。
- Electron 主进程的 `CredentialVault`、`createRuntimeRequestHandler` 已处理密钥隔离、加密保存、失败回滚和 Renderer 脱敏，可沿用该凭据边界。
- UI 已用 Runtime 请求轮询并管理 Skills，可增加 MCP 服务器管理、发现工具和逐工具授权入口。
- 官方 MCP TypeScript Client SDK v2 提供 Streamable HTTP 客户端；桌面项目运行 Node 24，满足当前 Node 20+ 的 SDK 运行要求。

### 缺失

- 项目尚无 MCP 客户端 SDK 依赖、服务器配置模型、连接生命周期和工具发现能力。
- Pi 的工具集不包含 MCP 远程工具，Harness 也没有 MCP 工具级权限状态。
- MCP 配置与凭据没有本机持久化/脱敏路径，Renderer 无服务器管理界面。
- 生产 Runtime 没有 Spike 中验证过的 Windows AppContainer Worker 接入。现有 `runtime/worker.mjs` 是普通 Node 函数，不能承载本地 stdio MCP 进程作为安全沙箱。

## 改动点与接入方式

1. 在桌面项目增加固定版本 `@modelcontextprotocol/client`，仅集成 Streamable HTTP transport。远程地址只允许 HTTPS，开发时可使用 loopback HTTP。拒绝 URL 用户名/密码、查询参数和片段，禁止自动跟随重定向，并为连接、发现、调用设超时。
2. 新增 Runtime MCP 管理模块，负责严格规范化服务器和工具记录、连接/发现工具、调用远程工具、断开与错误归一化。服务器定义只保存 ID、名称、URL、启用状态和凭据引用，Bearer 凭据不写入 SQLite、JSON、日志或 Renderer 响应。
3. SQLite meta 持久化 MCP 服务器与每个服务器的工具授权。新服务器及发现工具默认禁用。用户从 UI 对单个工具确认启用后，Harness 才向 Pi 注册该工具。
4. Electron 主进程沿用 `CredentialVault` 保存 MCP Bearer Token。Runtime IPC 适配层负责将 Token 注入 Runtime 内存，不能将凭据返回给 Renderer。更新凭据失败时保留原配置，无法确认提交状态时保留两份密钥以便恢复。
5. `PermissionGateway` 在每次调用时检查服务器与工具仍处于启用/已授权状态。MCP 工具只能访问用户显式配置的远程服务，不能取得 workspace、文件写入或宿主进程权限。调用参数通过 MCP 返回的 JSON Schema 校验，返回的文本结果有长度上限，图像/嵌入等非文本内容不进入 Pi。
6. Pi 工具使用稳定且唯一的 Harness 工具名，工具说明标明不可信外部工具来源。执行开始/结束日志只记录服务器 ID、工具名、状态、时长和错误码，不记录 Token、参数、结果或服务器返回的描述文本。
7. UI 提供服务器名称、HTTPS URL、可选 Bearer Token、连接/刷新工具、逐项授权和启停。已保存 Token 保持密码态，不提供回显。删除服务器前停用其工具并清理对应凭据。

## 推进顺序

1. 先写 Runtime MCP 模块测试，验证 URL 校验、未知/未授权工具拒绝、结果限长、元数据脱敏和凭据不落盘。
2. 实现 MCP 配置/授权持久化及权限网关行为，逐项更新 checklist。
3. 安装官方 SDK，实现 Streamable HTTP 连接、工具发现、schema 转换与远程调用，增加本机 MCP 协议测试服务器完成真实 SDK 往返。
4. 将已授权工具接入 Pi，补充模型发起工具调用的 Runtime 集成测试。
5. 接入 Electron CredentialVault 生命周期与失败恢复，再增加服务器管理 UI。
6. 完成全量桌面测试、typecheck、build、diff 检查，复核 checklist 后进行用户要求的独立 Codex 审查。

## 风险与处理

- 远程 MCP 服务是外部信任边界，可能返回提示注入内容。结果作为不可信工具输出交给模型，工具说明明确外部来源，所有副作用以服务自身账户授权为准。
- 用户显式配置的 HTTPS 服务仍可访问其自身服务端能力。首版逐工具授权并限制工具调用只发生在 Harness 内，不把 MCP 服务的远程权限误称为本机隔离。
- URL 主机名解析、DNS rebinding 等完整网络沙箱需要 OS 网络隔离。本轮不声称实现通用 egress 沙箱。目标 URL 固定、TLS、禁重定向以及用户主动配置是当前 Harness 控制边界。
- 本地 stdio MCP 会运行本地任意命令。生产受限 Worker 尚未接入，因此本轮不提供 stdio 启动入口，也不允许通过 UI 自定义命令绕开隔离。
- MCP 服务可能离线、超时或返回异常数据。调用有超时、schema 校验、错误归一化、结果限长，失败工具结果不得伪装成成功。
- MCP SDK v2 为当前官方稳定主线。本地依赖锁定具体版本并以本机协议往返测试验证实际 API 与 Electron Node 兼容性。

## 验收边界

本轮完成后，用户可以在真实桌面产品中配置一个远程 MCP Streamable HTTP 服务、发现工具、逐工具授权，并让 Pi 在自然语言对话中调用获准工具。连接与工具启用状态保存在本机 SQLite，Bearer Token 由主进程加密保存，Runtime 日志不含密钥、工具参数或工具结果。

本轮不包含本地 stdio 服务器、OAuth 授权流程、资源/提示模板管理、任意插件安装、插件开发环境或 AppContainer Worker 产品化。这些能力不作为已交付功能展示。
