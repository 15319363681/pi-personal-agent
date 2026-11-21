# Pi 对话与受控工作区工具切片设计

日期：2026-11-18  
状态：按已确认产品方向实施  
范围：首个 Pi Personal Agent 可运行纵向切片

## 目标

将桌面普通对话从自写 `ModelClient` 接入 Pi Agent Core 与 Pi AI，使真实模型可以发起工具调用、接收 Harness 工具结果并继续回答。首轮只开放用户通过 Windows 文件夹选择器授权的一个工作区中的只读列举与文本读取；不包含任意 shell、写文件、插件、MCP 或公开市场。

## 调研：可复用与缺失

| 范畴 | 可复用 | 缺失 |
|---|---|---|
| Provider 与凭据 | `ModelSettings`、`CredentialVault`、`runtime-request.mjs` 已保存 Responses/Chat Completions 配置和 API Key；已有端点 HTTPS 检查、超时与关联 ID | 对话目前由自写 `ModelClient` 直接完成，没有 Pi Agent / Pi AI，也没有模型工具循环 |
| Harness | `RuntimeController` 是权限/任务状态/日志边界；`PermissionGateway` 已有 `workspace.read` 决策；`LocalRuntimeLogger` 只保留白名单字段 | Pi 工具未注册到 Harness；工具调用状态和脱敏摘要没有持久化或 UI 呈现 |
| 工作区 | `WorkspaceAdmission` 已检查根目录越界并拒绝最终路径符号链接 | 没有系统文件夹选择器、已授权根目录状态、目录列举、父级 reparse 检查、文件大小/文本限制 |
| 对话 | `conversation.json` 持久化 UI 消息并保留历史记录 | 没有 Pi 结构化 transcript，不能在多轮中回放 tool-call/tool-result；并发 chat 也没有串行化 |
| 桌面桥/UI | Electron context isolation、受限 preload 请求桥、React 对话和 Runtime 状态轮询 | 没有原生选择工作区交互，也没有工具执行结果视图 |
| Pi 依赖 | 本地源码/发行声明确认 Pi Agent Core 与 Pi AI `1.5.2` 的 Agent、Provider、tool-call API；Node `24.10.0` 满足其 Node `>=22.19.0` | 桌面包未依赖 Pi；需锁定 `@earendil-works/pi-agent-core@1.5.2`、`@earendil-works/pi-ai@1.5.2` 与直接使用的 `@earendil-works/pi-schema@1.5.2` |

## 接入设计

1. `src/runtime/pi-agent.mjs` 为本地模型设置构造 Pi `Model`/Provider，针对现有 `openai-responses` 与 `openai-compatible` 协议选择 Pi AI Responses/Completions API。继续从现有 Runtime 请求桥取得 API Key。旧版明文密钥由 Electron 主进程迁入系统加密凭据库并校验后才从设置文件移除，迁移失败保留原文件。凭据更新使用每版本独立引用，每次更新生成独立加密引用，只有 Runtime 成功提交新设置后才删除旧引用，避免失败时端点与 Key 错配。Electron 单实例锁保证迁移完成前不启动 Runtime 写设置。Provider 回显当前完整 API Key 时在结果和 transcript 中脱敏。远端端点必须 HTTPS；仅 loopback 允许 HTTP；Pi 请求保持服务端存储关闭。费用未配置时保持 `costStatus: unknown`。
2. `src/runtime/workspace.mjs` 作为 Harness admission 层，仅对已选择的真实路径提供 `list` 和 `readText`。每次访问检查相对路径、路径分段 reparse/symlink、文件大小和文本编码；目录列举只返回直接子项且有上限。拒绝所有写操作。
3. `src/runtime/pi-tools.mjs` 定义固定 Pi Agent tools `workspace_list` / `workspace_read`。执行前经 `PermissionGateway` 检查，工具实现只调用 WorkspaceAdmission；不接受模型提供的绝对路径或授权根目录。
4. `RuntimeController` 使用 Pi `Agent` 执行普通 chat，订阅 Pi 生命周期事件并记录工具开始/结束/失败、持续时间和固定工具名，不记录提示词、工具参数、文件正文或凭据。会话操作串行化；UI 消息和 Pi transcript 在 SQLite 的 `meta.conversation_state_v1` 中同一事务提交，并通过状态比较拒绝并发旧上下文。`conversation.json` 和 `pi-transcript.json` 是可重建镜像；镜像写入失败不回滚已提交的对话，启动时重建。旧文件迁移只回放可与成功 UI 消息匹配的完整轮次，未匹配的旧消息保留展示并标记为未验证。transcript 绑定配置 ID、Provider、Base URL、模型与 API 格式，配置切换时从空上下文开始。旧 SQLite 状态缺少可信配置身份时不自动重放历史。
5. Electron 主进程通过 `dialog.showOpenDialog` 获取目录，独立的 `workspace.select` 请求返回选择结果并在 Runtime 内保存规范化路径和目录身份。每次使用前复核身份，旧版仅保存路径的授权需要重新选择。Renderer 不能直接调用内部授权方法。Preload 仍仅暴露 `request`。
6. UI 显示授权目录/选择入口；Pi 返回的工具执行名称、状态和安全摘要挂在 assistant 消息下。任务提案模式保留为现有未接 Pi 的本地任务流程，并在 UI 如实标为提案。

## 文件改动点

- 修改：`pi agent/apps/desktop/package.json`、`package-lock.json`
- 新建：`pi agent/apps/desktop/src/runtime/pi-agent.mjs`
- 新建或调整：`pi agent/apps/desktop/src/runtime/pi-tools.mjs`、`workspace.mjs`、`permission-gateway.mjs`、`logging.mjs`
- 修改：`pi agent/apps/desktop/src/runtime.mjs`、`runtime-request.mjs`、`main.mjs`、`ui/main.tsx`、必要的 `ui/styles.css`
- 新建/修改测试：`test/pi-agent.test.mjs`、`test/workspace-tools.test.mjs`、`test/runtime.test.mjs`、`test/preload-bridge.test.mjs`
- 维护本文档及同目录 `checklist.md`

## 推进顺序

1. 先为 WorkspaceAdmission 的路径分段拒绝、边界、列举和大小限制写测试并观察失败。
2. 写 Pi 真正 tool-call -> Harness 执行 -> tool-result -> Pi 最终回答的 Runtime 集成测试，加入多轮 transcript 回放、日志脱敏与拒绝未授权路径断言。
3. 安装锁定 Pi 依赖，实现 Provider/Agent 适配与受控工具。
4. 实现目录选择授权桥、Runtime 授权持久化及工作区接口测试。
5. 更新 UI 呈现选择工作区和工具结果。
6. 更新 checklist，逐项自检，再运行目标测试、桌面全测、类型检查和构建。
7. 按用户要求使用独立 Codex 对 design/checklist/git diff 逐项 PASS/FAIL 审查；只在桌面流程需要手工检查时交付验收步骤，不使用 Playwright。

## 风险与边界

- `WorkspaceAdmission` 是应用层受控 API，不等同于 Windows OS 级沙箱。此切片不执行不受信任代码；插件与 MCP 进入之前必须先补受限 Worker/OS 隔离，不能继承 Runtime 进程权限。
- 普通 Provider 支持工具调用不代表每个 OpenAI-compatible 服务端都实现一致。用本地 SSE 假 Provider 验证 Pi wire protocol 与往返；具体用户服务商仍需手动验收。
- 文件系统检查与后续打开存在 TOCTOU 风险；以真实路径重校验、拒绝链接、只读及大小限制缩小风险。不能宣称抵御同用户权限下并发篡改的强隔离。
- 当前脱敏覆盖完整 API Key 字符串，不能识别任意变形或部分泄露。旧密钥与新凭据库中相同 ID 的密钥冲突时启动中止并保留原数据。
- 设置更新期间若 RPC 断连，主进程重新读取 Runtime 设置来确认新凭据是否已提交。确认已提交时返回已提交配置并尽力删除旧凭据；确认未提交时删除新凭据；Runtime 无法应答时保留新旧两份加密凭据，避免已提交配置失效。状态无法对账或旧凭据删除失败时仍可能留下加密文件。
- 旧明文凭据迁移在写入临时文件前和替换前各校验一次设置快照，并由 Electron 单实例锁避免新版进程并发迁移。若快照变化，迁移仅清理本次创建且未被当前可读设置引用的凭据；无法读取当前设置时保留凭据。内容检查与文件替换之间仍有极窄竞态，也未证明与仍在运行的旧版本进程互斥。
- SQLite 数据库及其备份包含对话正文和工具结果，需要按本地敏感数据管理。镜像也包含相同内容。
- 多轮 transcript 格式随 Pi 升级可能变化；依赖锁定 `1.5.2`，保存结构化消息并覆盖重启回放测试。
- 用户没有在本轮提供可用于真实 Provider 的 API Key；自动测试不得访问/计费外部服务，真实 Provider 结果需用户本机手动验收。
- 现有工作区含大量未提交修改。本切片只对目标文件增量编辑，不回滚其他工作。

## 明确后置

受控 Skills/MCP、Agent 创建/测试/确认启用的本地插件闭环、任意第三方插件安装、公开市场、写文件、删除、shell、文档解析、网页搜索和持久任务规划均不在本切片交付范围。产品方向要求的插件草稿、受限 Worker、用户确认和本地开发记录保持为下一阶段验收约束。
