# Pi Personal Agent Runtime 设计

**状态：** 历史架构提案，不是当前已批准的实施契约
**日期：** 2026-11-17  
**工作名称：** Pi Personal Agent

> 2026-11-18 已确认的产品方向文档优先于本文。本文中关于 Pi Durable、执行内核、任务和 worker 的提案仍需按具体切片验证，不构成开始产品实现前的全局门槛。当前 Pi 对话与受控工作区工具切片以 [`2026-11-18-pi-agent-tools-and-plugin-workflow/design.md`](../plans/2026-11-18-pi-agent-tools-and-plugin-workflow/design.md) 为实施设计。

## 目标与动机

构建一个 Windows 优先、个人使用的桌面 Agent。核心体验是持续对话、Agent 提出结构化任务、用户审核、后台长时间执行、程序中断后恢复，最后把成果和异常主动通知用户。代表性演示任务是收集并整理资料，按验收规则生成报告，再通过用户配置的外部渠道交付。

会话、长期记忆、任务状态和产物索引优先保存在本地；允许调用用户配置的云模型、网页工具、Langfuse 和外部消息渠道。首版只服务一个用户，不开放局域网或公网访问；后续应能增加 Web 和多端客户端。

桌面 UI 包含持续对话、任务中心（审批/运行/异常/历史）、模型与 Provider 配置、插件管理、通知渠道设置、Langfuse 连接设置和记忆管理。任务只有在完成、失败、超时或需要用户处理时才发桌面/外部通知，不为普通步骤进展频繁打扰。

## 构建路线

1. **在 Pi 上重新实现全部运行时能力。** 运行时一致，但需要重新建立已经在 CowAgent 中验证过的渠道接入、权限和运维能力。
2. **以 Pi 为执行核心，适配 CowAgent 已验证的能力。** 复用其渠道接入流程、权限实践和操作经验，同时由新 Runtime 定义任务、恢复和权限契约。**用户已选择此路线。**
3. **以 CowAgent 为主体并嵌入 Pi。** 可复用更多 CowAgent 代码，但 Pi 会成为组件，不再是运行时底座。

CowAgent 是 Python 项目，Pi 是 TypeScript 项目，所以“迁移”指把能力、接入流程和协议适配到 Pi，不代表直接导入原实现。个别依赖难以移植的渠道，可在能力矩阵评估后考虑受控桥接。

## 执行内核与权威状态

首选验证并采用 Pi `pi-durable` 作为对话执行和任务执行的唯一内核。它负责模型轮次、工具调用任务、会话条目、执行检查点、排队输入及恢复；`pi-ai` 负责模型/provider 调用。首版不使用 Pi `AgentSession` 管理同一批对话，避免两套历史、工具结果和重试状态互相竞争。

Durable SQLite 状态是会话与执行状态的权威来源。一次业务状态转换关联的任务状态、审批决定、预算预留和 outbox 事件必须在同一个 Durable/SQLite 原子事务中全部提交或全部回滚。串行写入队列只解决并发写入顺序，不能替代原子事务；禁止把一个业务转换拆成多次提交。若 Durable API 不能在同一 commit 中表达这些状态，spike 必须验证一个通过同一连接和事务队列提交的适配器；未验证前不接受最终状态写入与 outbox 分离的方案。任何独立数据库投影都只能作为可重建索引，不能反向覆盖 Durable 状态。测试、展示或通知进程均不得打开同一 Durable 数据库写入。

`pi-durable` 文档将 API 标为实验性，且其任务、工具、恢复模型与 SDK 的 `AgentSession` 不同。因此，在创建产品应用前，先做一个可丢弃的兼容性 spike；spike 不通过就停止，不开始产品实现，也不以未验证的组合写正式实施计划。

**Spike 通过条件：**

- SQLite Durable Harness 能提交一条对话输入、模型输出、工具调用、工具结果和业务任务 checkpoint。
- 分别在模型请求中、工具运行中强制结束 Runtime 后，重新打开唯一写入者，恢复状态可解释且无损坏。
- 可安全重放工具能从已记录输入恢复；非幂等工具不会被误当作安全重放。
- 任务状态、`completionContract`、权限快照和插件版本约束能与 Durable commit 原子保存。
- Pi SDK 与 Durable 没有同时管理同一会话或同一工具调用；测试可证明只有 Durable 是权威历史。

## 进程与数据所有权

Windows 桌面端采用 Electron + React + TypeScript 作为提案，原因是 Pi 和 CowAgent Desktop 均使用 TypeScript/Electron 生态，且 Electron 提供窗口、托盘和子进程管理能力。

```text
Electron Main / UI Supervisor
  ├── React Renderer：仅通过窄接口读写产品状态
  └── Runtime Process：唯一 Durable / SQLite 写入者
        ├── Pi Durable + pi-ai：对话、规划、任务状态和恢复
        ├── Permission Gateway：统一审批和权限校验
        ├── Tool Worker：受限执行文件、命令和插件工具
        └── Provider Adapters：模型、通知和 Langfuse
```

Electron Main 管理单实例、窗口/托盘、Runtime 生命周期与健康检查；Runtime Process 是唯一 Durable 数据库写入者；每个可能卡死或需要强制终止的命令/工具由独立 worker 执行。Electron `utilityProcess` 只提供进程管理，不等同操作系统安全沙箱。Electron Main 是 Job Object 的唯一 handle owner，Runtime 和 worker 不继承、复制或接收 Job handle。Job 配置 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`，不启用 breakaway；worker 在开始执行前必须已加入 Job Object。Runtime 崩溃或需强制停止 worker 时，Main 调用 `TerminateJobObject`，保留 Job handle 并等待活动进程数归零；只有确认 Job 无活动进程后才能启动新 Runtime。若 Main 自身崩溃，最后 Job handle 关闭会触发清理；应用下次启动先用当前用户 SID 对应的专属名称打开遗留 Job，若成功则查询活动进程数，必要时调用 `TerminateJobObject` 并等待成员退出，再创建 Runtime。Windows 文档规定 Job 在最后一个 handle 关闭且关联进程全部终止后销毁，因此只有 `OpenJobObject` 明确返回对象不存在时才可视为旧进程树已清理；访问拒绝、名称/会话不匹配或其他错误都必须 fail closed。该生命周期、打开与终止的竞争、进程树覆盖和重新启动屏障列入 Windows spike。Runtime 单写入 Mutex 是第二道防线，不能代替 worker 回收屏障。Job handle 使用不继承的受限 ACL；创建 worker 必须保证进程在加入 Job 前不能执行用户代码。

单实例 Mutex 防止多个 Runtime 抢写数据库。启动时先获取写入所有权、执行 Durable 恢复和 SQLite 健康检查，再开放 UI/API。关闭窗口进入托盘继续运行。开机启动提供手动启动、后台启动、启动并打开窗口三种选项。首版不开放 LAN/公网端口，未来 Web 客户端通过独立 transport 接入同一 Runtime API。

## 任务提案与完成契约

Agent 只能生成不可执行的提案；持久化并展示给用户后进入 `approval_pending`。执行前，用户审核任务契约、权限摘要、预算、交付对象和验收规则。任务提案必须包含：

- `goal`：可检查的目标描述；
- `inputs`：引用的对话内容、文件、时间范围和来源范围；
- `deliverables`：报告、文件、消息等产物及目标渠道；
- `acceptanceCriteria`：每项可验证规则及其验证方式；
- `allowedTools`：允许的工具和外部来源范围；
- `budget`：模型轮次、工具调用次数、并发、耗时和费用上限；
- `completionEvidence`：来源列表、产物路径/哈希、验证结果、投递回执等证据。

批准绑定 `taskId + contractHash + taskVersion + permissionSnapshot`。收件人、渠道实例、来源/工具范围、验收规则、预算、交付内容的实质变化都生成新版本并重新审批；旧授权不自动扩展。

模型输出完毕只代表一次模型轮次结束。业务任务只有在验收器全部通过后才算工作完成；若契约要求外部交付，还需独立记录交付结果。至少分别显示 `artifact_ready`、`delivery_status` 和 `completion_notice_status`。确定性检查优先用于文件存在、格式、来源和结构；主观质量由用户审核或评分器辅助判断，模型自评不能单独证明完成。

对资料研究任务，默认验收包括：达到批准的时间/主题/来源范围；报告中的外部事实带来源；来源冲突被标注而非静默择一；网站部分失败时按契约决定继续或待处理；产物满足格式要求；投递目标与批准目标一致。来源不足或验收失败时允许最多 **2 次重新规划**，之后转 `needs_attention` 等待用户决定。

## 状态机

状态由 Runtime 唯一写入，插件不能创建新的顶层状态。`reasonCode`、`substate`、attempt 和版本化 metadata 用来细分原因。

| 当前状态 | 允许的下一状态 | 触发方与含义 |
|---|---|---|
| `proposed` | `approval_pending`, `cancelled` | Agent 提案经校验后展示，或用户丢弃草案 |
| `approval_pending` | `queued`, `cancelled` | 用户批准，或拒绝/撤回 |
| `queued` | `running`, `paused`, `cancelled` | 调度器启动，或用户暂停/取消 |
| `running` | `waiting`, `retry_wait`, `paused`, `needs_attention`, `interrupted`, `completed`, `failed`, `timed_out`, `cancelled` | Runtime/worker 结果、用户停止、预算/超时或进程异常 |
| `waiting` | `queued`, `paused`, `cancelled`, `needs_attention` | 依赖/外部事件到达，用户暂停/取消，或等待条件失效 |
| `retry_wait` | `queued`, `needs_attention`, `failed`, `timed_out`, `cancelled` | 退避结束重试、次数耗尽、超时或用户取消 |
| `paused` | `queued`, `cancelled` | 仅用户恢复或取消；不自动续跑 |
| `needs_attention` | `queued`, `paused`, `failed`, `cancelled` | 用户选择重试/改计划、继续暂停、终止或放弃 |
| `interrupted` | `queued`, `paused`, `needs_attention`, `failed`, `cancelled` | 启动恢复分类后，由 Runtime 或用户决定 |
| `completed`, `failed`, `timed_out`, `cancelled` | 无 | 终态；新尝试创建新 task version 或新 task |

普通“停止”请求是协作式暂停：向任务及其 worker 发送 cancel signal，等待安全点，落盘 checkpoint 后成为 `paused`。用户另选“取消任务”才进入 `cancelled`，但也不承诺回滚已经产生的外部副作用。worker 无法及时响应时由 Runtime 强制终止其 Job Object 进程树；如果副作用结果未知，优先进入 `needs_attention`，不能宣称已停止所有外部动作。

恢复时先从 `interrupted` 分类：无副作用且有 checkpoint 的步骤自动排队恢复；幂等且可对账的副作用按协议核验后恢复；无法核验的副作用进入 `needs_attention`；Durable 任务定义或插件版本缺失时也进入 `needs_attention`，保留原数据，不静默跳过。

## 重试、预算、并发与冲突

网络临时错误、限流和临时 5xx 最多在首次失败后重试 3 次，退避间隔提案为 1s、2s、4s。认证/授权失败、无效输入和验收规则本身失败不走网络重试。另行计数模型生成重试、工具重试、交付重试和重新规划，不能用一个总 retry counter 混淆它们。预算耗尽进入 `needs_attention` 或 `failed`，并保存实际消耗。

每个任务都要带硬预算：模型轮次、工具调用次数、活跃执行时长、provider 报价费用、并发步骤数；全局设置控制最大并行任务数。预算超限后禁止新模型/工具调用，已开始的受限 worker 安全收尾。提高预算需生成新 task version 并重新审批。等待外部事件的日历时间不计入活跃执行时长。

预算默认值提案：单任务最多 40 次模型轮次、100 次工具调用、2 次重新规划；最多 3 个并行顶层任务；单个工具调用默认 10 分钟超时；单任务费用上限由用户在模型设置中配置，未设置时创建任务前要求确认本任务预算。最终数值待用户审核。

费用控制采用调用前预留，而不是调用结束后才检查：

- 每次模型请求先在同一原子事务中预留估算费用和 token 配额，再提交请求；并发请求的预留合计不得超过任务及全局预算。
- 预留上限由当前输入 token 估算、provider/model 价格、请求的 `maxOutputTokens` 和安全余量构成。请求设置单次输出 token 上限；流式输出达到限制时立即中断并记录部分用量。
- 重试、失败的模型调用和上下文压缩都消耗同一预算，不能通过 retry 或 compaction 绕过上限。完成后以 provider 返回的 usage/cost 结算并释放未使用预留。
- 若 provider 无可靠价格或最大输出约束，不能把估算值称为硬费用上限：要求任务改用 token 上限并由用户确认，或拒绝以费用上限模式运行。请求超时/崩溃且用量未知时保留该预留，标记 `usage_unknown` 并暂停新的付费调用，直到 provider 查询、账单同步或用户处理。
- UI 分开展示本地预估/已知 usage 成本与 provider 最终账单。应用限制的是按已知价格和上限计算的预算；不承诺供应商账单结算金额绝对等于本地估算。

工作区写入采用规范化路径锁。相同目标路径的并发写入串行化；不同路径可并行。文件版本/哈希在写前复核，检测到用户或其他任务并发修改则不覆盖，转为 `needs_attention` 并展示差异。

## 权限与凭证

所有聊天请求与后台任务都通过同一 `PermissionGateway`，不存在绕过网关的另一路工具调用。权限策略有三种模式：`read-only`、`workspace-write`、`full-access`。高风险的发送、删除、提交、发布操作默认需要单独确认；长期授权必须有明确动作范围、资源范围和有效期。

“只访问选择的工作区”必须同时由应用和 Windows 执行环境强制，而不能只依赖模型提示或字符串前缀判断：

- File API 对路径做 Windows 规范化、大小写无关比较、`.`/`..` 解析、硬/符号链接和 junction/reparse point 检查；操作时再次验证最终目标，拒绝越出允许根的路径。
- `workspace-write` 下，文件和 shell worker 使用仅授予所选目录权限的受限 Windows 身份/AppContainer；`read-only` 目录授权为只读。Shell 和所有子进程加入同一个 Job Object，停止/超时后杀死整棵进程树。
- Shell worker 默认没有 Internet、Intranet 或 server/network capability；禁止直接 DNS、TCP/UDP、HTTP(S) 和任意代理访问。所有联网必须调用 Runtime 提供的受控 web 工具或 provider adapter，并按任务批准的 domain/recipient/scope 校验。通知/provider 凭证留在 Runtime，shell worker 不获得凭证或 provider 直连能力。
- 启用联网的 AppContainer capability 必须单独显式配置和测试。需要联网的任务仍使用 brokered network；插件不能自行给 worker 打开网络权限。若 Windows 网络隔离无法验证，shell worker 在首版保持离线，web 能力仅经受控工具提供。
- 若受限身份/AppContainer 不能通过文件越界、链接逃逸、shell 子进程和终止测试，则首版禁用任意 shell，只允许经同一网关实现的结构化工具；不得退回普通用户权限运行后仍声称工作区隔离。
- 模型、任务、工具、插件都不能直接读取 API Key。Provider 通过 Credential Manager 能力读取其所需凭证；凭证不进入 prompt、task payload、通知内容或 Langfuse trace。
- Pi Durable 生命周期扩展若运行在 Runtime 内，视为受信任代码，不属于沙箱边界；首版只加载用户显式安装/启用的扩展，不允许不可信插件直接执行任意代码。

用户批准任务不等同于批准任务内所有高风险动作。外部发送授权至少绑定具体 provider instance、收件人、允许内容/产物版本和 task contract hash；任一变化则重新确认。

## 外部副作用与通知 Outbox

SQLite 无法单独保证第三方服务“恰好一次”发送。每次副作用先把业务状态和 `delivery_intent` 在同一个事务中提交，再把带稳定 `deliveryId` 的 `attempting` 记录追加到主数据库备份之外的本地 append-only delivery journal 并 fsync，之后才能调用 provider。Provider 返回后，先把 `delivered`（含 provider receipt/message id）、`failed` 或 `unknown` 结果追加到 journal 并 fsync，再提交 SQLite 状态；因此旧备份恢复时可重建已确认的结果。若进程在 provider 返回后、结果记录 fsync 前崩溃，该次尝试仍视为 `unknown`，按下述规则对账，不能盲目重发。恢复流程用 journal 重建备份中缺失的尝试记录及已 fsync 的结果。网络中断导致结果不明时：

1. Provider 支持幂等键时，始终使用相同的 `deliveryId` 重放；
2. Provider 支持查询时先按回执/幂等键对账；
3. 两者都不支持时，标记 `unknown` 并进入 `needs_attention`，不自动再次发送。

若发送前 delivery journal 写入/fsync 失败，则禁止发起外部副作用；发送后的结果追加/fsync 失败，则不得把 SQLite 状态标成已确认成功，必须保留 `unknown` 并阻止同一 delivery 自动重试。每条 journal 记录包括 delivery id、task/contract hash、provider instance、目标摘要、内容哈希、尝试时间及结果状态，不保存凭证；journal 清理必须晚于所有可能回滚到该发送意图之前的备份过期。主数据库从备份恢复时进入 `recovery_mode`：暂停调度、模型请求和所有外部写操作/通知；使用恢复后的 outbox 与 journal 交叉核对，provider 支持查询/幂等时先对账，无法证明是否已发送的记录统一变为 `unknown` 并要求用户逐条确认。只有所有恢复窗口中的外部副作用完成对账或人工确认后，用户显式退出恢复模式，才恢复执行。

任务状态转换与站内待投递通知 outbox 在同一 Durable 原子 commit 中提交。外部通道回执另行提交，并通过 delivery journal 保留发送尝试证据。用户可分别看到“报告已生成”“报告已发送/结果不明”“完成提醒已送达”。桌面站内通知用稳定 event key 去重，重启后补发未送达事件。

## CowAgent 渠道迁移边界

迁移全部现有渠道实现之前，先生成逐 provider 能力矩阵：主动发起文本、文件/附件能力、认证步骤、是否要求公网回调 URL、回执/发送状态查询、幂等键、限流策略、Windows SDK/运行依赖、撤销连接操作。

渠道统一为 Pi 侧 provider contract：`validateConfig`、`connect`、`disconnect`、`capabilities`、`send`、可选的 `lookupDelivery`。设置页只呈现该 provider 确实支持的能力。首版“通知渠道”只包含能主动发起用户批准的 outbound 交付、Windows 包装验证通过且认证流程可用的 provider；被动收消息或必须依赖公网 webhook 的能力不伪装成可用的主动通知。完整候选列表来自 CowAgent 源码盘点，最终 v1 清单由能力矩阵确定，而非假设所有渠道等价。

Langfuse 不作为通知渠道或任务事实来源。模型与通道设置、启用/断开、凭证生命周期参考 CowAgent，但凭证落入 Windows Credential Manager，配置元数据进入本地 SQLite。

## 插件与版本

插件扩展 Pi Durable Registry 中的工具、提示片段和受控生命周期事件（提案、审批、步骤前后、恢复、交付通知）。Runtime 仍是唯一的任务状态机所有者。首版不支持插件自行注册顶层任务状态或修改审批结果。

运行中任务必须能以原插件定义恢复。首版升级策略采用保守规则：禁用插件只阻止新任务使用，旧代码保持安装供在途任务恢复；若插件有未完成任务绑定该版本，阻止升级/卸载，直到这些任务完成或被用户显式取消。新任务加载当前启用版本。后续若实现 side-by-side 插件包与迁移验证，再考虑允许并行升级。

## 本地记忆与对话上下文

长期记忆与聊天 transcript、Durable checkpoint 分开建模。每条记忆保存来源 conversation/message 或用户输入、创建时间、置信状态、失效时间/策略和修订历史。检索时提供来源；冲突信息并存并标注冲突，不静默覆盖。用户可检查、修改、禁用或删除记忆。删除写入 tombstone 并立即停止检索，后台索引清理不得重新引入被删内容。

长对话压缩不得修改已批准 task contract。正在执行任务始终读取其不可变契约快照；用户修改目标时创建新版本并重新审批。压缩摘要保留目标、用户约束、审批记录、尚未完成事项及来源指针。

## SQLite、备份与崩溃

使用 SQLite WAL。进程崩溃恢复与突然断电保障分开定义：Durable 当前的 `synchronous=NORMAL` 对进程崩溃可恢复，但突然断电/系统崩溃可能丢失最近提交。由于审批、checkpoint、outbox 直接影响副作用，Runtime 应对关键 commit 采用 `synchronous=FULL` 或等效的强持久化设置，并通过 Windows 断电/进程终止故障测试确认行为；若性能不可接受，必须明确降级边界。

数据库升级先备份、再执行有版本号且原子的 schema migration；迁移失败恢复备份并保持 UI 可读。备份使用 SQLite backup API（包含一致的 WAL 状态），提案为保留最近 7 份日备份和 4 份周备份；恢复前运行 `integrity_check`，不得覆盖损坏原文件，需复制原件、恢复最新有效备份并列出可能丢失的任务/提交。磁盘剩余空间低于 1 GiB 时停止接纳新任务和新副作用，优先持久化正在进行步骤的必要终态，提示用户清理/备份。Runtime 锁被异常遗留时由 OS mutex 生命周期回收，随后单写入 Runtime 检查数据库并分类未完成任务。

## Langfuse 与质量评估

开发/测试环境按用户要求完整记录 prompt、模型输出、工具输入/结果、审批、重试、恢复、异常、耗时和 task/step id；Credential、Authorization header、API Key 必须在 trace 构造前过滤。生产个人模式提供脱敏开关和保留期限；Langfuse 不可用时任务继续，本地观测 outbox 提案上限为 100 MiB 或 7 天，达到任一上限后优先丢弃最旧 telemetry，不得阻塞任务或删除权威任务日志。

建立固定的 20 个验收任务集，覆盖研究与来源、文件交付、审批范围、prompt injection、超预算、恢复/重复副作用、并发文件修改和渠道失败。评分包括正确性、完整性、证据支持、契约遵循、预算消耗；内容质量合格线提案为平均至少 80%，无关键无来源事实。确定性权限和故障恢复测试必须 100% 通过。每次模型、prompt、工具或 provider 变更运行同一数据集并保存 Langfuse scores/experiment 对比；追踪存在但没有评分不算完成质量验收。

## 验收与关键故障场景

1. 对话生成提案；未批准时无模型任务、文件写入或外部副作用开始。
2. 对方已接收消息但本地尚未写回执时崩溃：支持幂等/查询的 provider 对账；其他 provider 显示 `unknown` 并要求用户处理，不重复发送。
3. 工具忽略取消信号：Runtime 强制结束 Job Object 整棵进程树，确认退出后才报告暂停/取消；不允许遗留子进程继续改文件。
4. 网页 prompt injection 要求读工作区外文件、改收件人或发秘密：路径隔离阻止读取，shell worker 的直接网络被拒绝，高风险操作因审批绑定不匹配而被拒绝。
5. Agent 无进展反复规划：到达 replan/model/tool/cost budget 后不再调模型/工具，转待处理并保留消耗证据；并发模型请求的预留也不能使实际预留总量超过上限。
6. 两个任务同时改同一文件：写锁串行处理，版本哈希不匹配则报冲突，不静默覆盖。
7. 插件更新/卸载时有旧任务：操作被拒绝或延后，旧版本仍可恢复任务。
8. Runtime 在工具 worker 正运行时崩溃：Main 调用 `TerminateJobObject`，保留 handle 并确认活动进程数归零后才允许启动新 Runtime；Main 崩溃后重启程序按专属名称打开遗留 Job、检查活动进程，并终止/等待残留成员。只有明确收到对象不存在，或已查询到活动进程数为零，才允许创建新 Runtime；访问拒绝等异常必须 fail closed。上述关闭、重开竞争与进程树回收需由 Windows spike 验证。
9. 主数据库从旧备份恢复且备份后已经发出消息：应用进入 `recovery_mode`，journal 重建缺失尝试并对账；未确认记录解决前不得恢复任何外部副作用。
10. Langfuse 离线、磁盘满、数据库损坏或重复启动：本地权威状态不被遥测依赖；拒绝第二写入者；数据库损坏时只读恢复/备份流程保留用户可恢复数据。

成功标准不只是“任务跑通”：完成度还要求结果质量评估、权限负向测试、故障恢复正确性、交付状态可解释，以及预算行为可复现。

## 待审核的提案决策

- `pi-durable` 是唯一对话/任务执行状态来源；不将 `AgentSession` 与 Durable 叠加管理同一会话。
- Electron + React + TypeScript 桌面栈；Runtime 独立进程是唯一 SQLite 写入者，命令/工具 worker 分离。
- AppContainer/受限身份和 Job Object 是 Windows 权限/进程树边界的实现候选；兼容性 spike 失败时禁用任意 shell，不降级成无约束执行。
- 第三方发送至少是 at-most-once 的保守策略：不确定且无法对账时转人工处理，接受有时需要人工确认是否漏发。
- 首版插件升级对有在途任务的版本采取阻塞策略，保留旧代码恢复；不实现 side-by-side 版本包。
- 首版外部渠道清单先做能力矩阵，只承诺具备已验证主动发送能力的 provider。
- 顶层任务之间首版不建依赖；同一任务内的步骤可声明依赖并并行执行就绪步骤。
- 临时网络错误的退避间隔提案为 1s/2s/4s；任务上限提案为 40 次模型轮次、100 次工具调用、2 次重新规划、最多 3 个并行顶层任务、单工具 10 分钟。
- 质量评估提案为固定 20 个任务、内容质量平均至少 80%、权限/恢复确定性场景 100% 通过。
- 数据维护默认提案为 7 份日备份 + 4 份周备份、剩余磁盘 1 GiB 时停止接纳新任务；Langfuse 离线积压上限提案为 100 MiB 或 7 天。
- SQLite 主库恢复后默认进入冻结外部操作的 `recovery_mode`；journal 保留周期与备份保留窗口联动。
- 单任务费用预算必须在调用前预留；费用未知的模型调用不释放预留，须先对账或人工处理。
- 上述数值、是否支持跨顶层任务依赖、费用估算安全余量及账单未知时的处理均待用户审核或修改。

## 参考实现与官方资料

- 本地 Pi：`D:\Atry\pi agent`；SDK 持久会话与 `pi-durable` 执行内核是不同抽象，Durable API 标记为 experimental。
- 本地 CowAgent：`D:\Atry\cowagent-master-extracted\CowAgent-master`；参考 channel settings/lifecycle/send、permission policy、scheduler run store 与通知流程。
- [Pi SDK](https://docs.pi.dev/latest/sdk)、[Pi 安全说明](https://docs.pi.dev/latest/security)、[Pi Durable README](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md)
- [Electron utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process)、[SQLite transactions](https://www.sqlite.org/transactional.html)、[SQLite backup API](https://www.sqlite.org/backup.html)、[SQLite synchronous pragma](https://www.sqlite.org/pragma.html)
- [Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)、[Windows AppContainer isolation](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation)、[Pi AI cost/token tracking](https://github.com/earendil-works/pi/blob/main/packages/ai/README.md)、[Langfuse Evaluations](https://langfuse.com/docs/evaluation/overview)

## 后续计划说明

本节原有“先完成全部 Spike 才进入产品实现”的全局门槛已由 2026-11-18 确认的产品方向取代。未验证的 Pi Durable、Windows worker、Provider 或单写入能力应作为边界明确的工程任务处理；若某项风险阻塞特定能力，应对该能力采用受控降级并继续不依赖它的产品工作。当前实施顺序以 [`2026-11-18-pi-agent-tools-and-plugin-workflow.md`](../plans/2026-11-18-pi-agent-tools-and-plugin-workflow.md) 为准。
