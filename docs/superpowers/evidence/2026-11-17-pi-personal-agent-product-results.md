# Pi Personal Agent Product Results

日期：2026-11-17  
工作区：`D:\Atry`  
计划：`D:\Atry\docs\superpowers\plans\2026-11-17-pi-personal-agent-product.md`

## 已交付

2026-11-17 产品快照包含以下桌面运行时与任务骨架；这些条目不等于完成了模型驱动 Agent：

- Electron Main 管理窗口、托盘和 Runtime 子进程；
- Runtime 是 SQLite 的唯一业务写入者；对话记录当时使用固定确认回显。任务提案由本地确定性逻辑创建，任务执行生成本地 Markdown 报告；不包含模型规划或模型驱动工具循环；
- 任务合同包含目标、输入、交付物、验收规则、预算和权限快照；审批事务同时预留预算并创建 outbox 意图；
- 工作区准入和 PermissionGateway 对每次文件操作重新检查范围；worker 生成可验收的 Markdown 产物；
- outbox 记录成功、失败和 unknown 投递结果，unknown 不会自动重发；local-file provider 可用于确定性演示；
- 记忆、备份恢复冻结、本地有界 telemetry 和恢复模式骨架已接入；
- 原始 UI 展示对话记录、待审批任务、任务状态、工作区/通知目录、模型元数据和投递状态。原始模型表单没有 API Key、连接测试或模型请求路径。

截至 2026-11-18，本工作会话补入 OpenAI Responses API 与 Chat Completions 调用、Windows Electron safeStorage 凭据库、用户主动连接测试和脱敏调用日志代码。Responses API 请求关闭服务端响应存储，升级前聊天内容不会进入新请求。除自动测试外，已通过用户授权对配置中的第三方端点完成一次连接测试和一次真实模型对话；Electron UI 的 safeStorage 输入桥仍待用户手动点击验收。

## Code Review 修复与手动验收状态

- Spike `sendDelivery(db, journalPath, deliveryId, provider)` 现在要求调用方提供 delivery ID、SQLite 中存在已提交且状态为 `intent` 的唯一记录；在事务中、缺失 intent、重复/非 intent 状态时拒绝，拒绝路径的 provider 调用数为 0。
- Spike 的 G3 恢复补测经过实际 `Conversation.submit` → Harness scheduler → Pi AI provider 入口。恢复冻结时 Harness 提交被标为 unanswered，fake provider 调用数为 0。这个 fixture 没有通知 dispatch 接口，因此 Harness notification path 仍明确未验证，G3 不再标为完整 PASS。
- 产品 `recovery.exit` 在没有对账状态/实现时返回 `recovery_reconciliation_unavailable`，保留 `recovery_mode=true`。运行时打开冻结数据库时跳过 interrupted 状态改写和调度；RPC、schedule、execute 和通知派发入口均在调用副作用前拒绝。
- 本地结构化日志：Electron `app.getPath('userData')\logs\runtime.jsonl`。启动后 UI 顶栏显示实际完整路径。每行是一条 JSON，可用 VS Code/记事本打开，或 PowerShell 执行 `Get-Content -Wait -LiteralPath '<UI 显示的日志路径>'` 实时查看。日志只含字段白名单，不记录 API Key、完整提示词、文件内容或凭据。
- **代码级检查已通过；用户界面黑盒点击验收尚待用户进行。** 桌面窗口使用独立目录 `D:\Temp\pi-agent-manual-acceptance-20261118-v2` 启动，不读取旧聊天或旧密钥。按用户授权，从配置文件仅提取模型、端点和 `OPENAI_API_KEY` 字段用于两次真实请求；配置文本的其他指令不执行。该配置指向第三方 API 中转端点，Key 未写入 UI 凭据库或日志。当前 UI 验收目录未保存 Key，用户需在窗口内重新输入新凭据。

真实请求（2026-11-18）：

- Runtime `settings.test` 成功，关联 ID `2aa3f732-8341-4ad1-8929-e991889305cb`，用量 4,390 输入 / 5 输出 tokens。
- Runtime `chat.send` 成功并返回非空模型回复，关联 ID `dfcf646f-2169-440f-9b22-5aecc583220f`，用量 4,394 输入 / 8 输出 tokens。
- 两次请求均报告 `costStatus=unknown`，无法确认或报告结算金额。
- 真实调用日志：`D:\Temp\pi-agent-provider-live-20261118\logs\runtime.jsonl`。检查确认其中没有 Key 或测试提示词。
- 这两次验证调用了 Runtime 的 Provider 路径，未经过 Electron UI 的 safeStorage 输入桥；该 UI 凭据路径仍待用户手动点击验收。

## 实际通过的验证

在 `D:\Atry\pi agent\apps\desktop` 执行：

```text
npm test
34 tests, 34 passed, 0 failed, exit 0

npm run typecheck
exit 0

npm run build
Vite build completed, exit 0
```

按产品任务分组的测试也全部通过：

- RPC：2/2；
- store/recovery：3/3；
- permissions/runner：4/4；
- outbox/providers：3/3；
- memory/backup/telemetry：3/3；
- runtime/e2e：6/6（包含默认工作区和恢复入口回归测试）。
- logging：1/1；outbox/provider：3/3。
- credential vault、模型 Provider、脱敏、旧聊天隔离与 Runtime request bridge：新增测试全部通过。
- Responses API：请求 `store:false`、输入/响应解析和 usage 映射测试通过。
- credential vault、模型 Provider、脱敏、旧聊天隔离与 Runtime request bridge：新增测试全部通过。

Spike 最终重跑：

```text
npm test -- --reporter=dot
15 test files, 41 tests passed, exit 0

npm run typecheck
exit 0
```

SQLite 运行时实测为 `journal_mode=wal`、`synchronous=2`（FULL）。

Electron 冒烟使用 Spike 已下载的本地 Electron 45.3.3：

```text
ELECTRON_OVERRIDE_DIST_PATH=D:\Atry\spikes\pi-durable-validation\node_modules\electron\dist
npm run start -- --user-data-dir=D:\Temp\pi-agent-electron-smoke-20261117d --disable-gpu
```

应用保持运行并创建了 `D:\Temp\pi-agent-electron-smoke-20261117d\runtime\agent.sqlite`，随后用 SIGINT 人工停止。该验证只证明本地桌面启动和 Runtime 初始化，不代表突然断电保障。

## 未验证和明确限制

- 已对第三方模型端点发出真实连接测试和对话请求；供应商账单金额不可用，费用状态保持 `unknown`。没有真实发送到邮箱、企业微信或 Telegram；这些 provider 目前只有本地 fake/local 验证和合同适配器证据。
- 没有验证 Langfuse 真实连接；当前只验证 telemetry exporter 失败不阻塞任务，并限制本地队列大小。
- 没有做突然断电测试；进程崩溃、旧 worker 回收和强持久化结论来自 Spike 的受控测试，不能扩大为断电保证。
- 没有完成 Windows 跨用户 ACL、全部 reparse point 变体和 TOCTOU 的完整证明；产品级 worker 的真实 Job Object/AppContainer 网络边界仍需单独验证。
- 没有实现局域网、远程 Web 或手机访问；这符合已批准的 v1 本机范围。
- Electron 包管理器自动下载受到当前网络环境限制，因此冒烟使用已有的本地 Electron 二进制；代码构建和启动链路均已实际验证。

## 最终结论

**产品状态：尚未完成 Agent。** 桌面 Runtime、确定性本地任务/报告流程及可观测性骨架可运行；模型设置和真实模型对话代码已实现，并已通过第三方 Provider Runtime 路径实测。任务提案不是模型规划，任务执行不是模型驱动 Agent。Spike G3 通知恢复调用路径仍未验证，Electron UI 凭据输入桥的手动黑盒验收尚未完成。

**真实集成：部分验收。** Provider 连接/对话已通过用户授权的 Runtime 真实请求验证，响应费用仍为未知；用户需在隔离 UI 验收目录重新输入 Key，以验证 safeStorage 设置闭环。用户提供的设置指向非 OpenAI 官方域名。真实消息渠道、Langfuse 连接、Windows 安全边界和故障恢复仍需各自验证。没有授权的情况下不做真实渠道发送、发布或推送。

最终审查由当前会话单独完成，记录为：`Final review: self-review (no subagent tool)`。这不是独立审阅者结论。

自审期间发现并修复了一个默认工作区输入边界：UI 留空目录时，Runtime 现在会显式补上配置的 `workspaceRoot`；该修复经过 RED→GREEN 回归测试和最终 20/20 套件验证。
