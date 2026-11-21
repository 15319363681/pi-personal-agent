# 产品维护 Skills 管理设计

日期：2026-11-20

状态：实现复核中

## 调研结论

### 可复用

- Pi `Agent` 的 `initialState.systemPrompt` 可以携带产品指令，`initialState.tools` 持有本轮 Harness 提供的工具。这是本切片接入点，沿用现有 Pi Agent，不另造 Agent 抽象层。
- `RuntimeStore` 的 SQLite `meta` 表及 `getMeta`/`setMeta` 提供本机权威持久化，适合保存启用的产品 Skill ID。
- `RuntimeController.handle` 是 Renderer 请求的受控入口，`LocalRuntimeLogger` 默认字段白名单适合记录 Skill 管理事件。
- `handleChat` 已有模型配置身份与 transcript 一致性判断。Skill 集合可以并入该上下文身份，使指令变化后不重放旧 Skill 上下文。
- React 主界面定时调用 `refresh`，沿用此模式可读取 Skill 列表并展示启用状态。
- 已存在 `workspace_list` 与 `workspace_read`，首个产品 Skill 可指导模型组合这些只读能力。

### 缺失

- 当前没有产品维护的 Skill 清单、启停 RPC、本机持久化状态或 UI 管理入口。
- 当前 Pi system prompt 没有产品 Skill 指令，无法确认启用的 Skill 真正影响模型请求。
- 当前 transcript context ID 不包含 Skill 配置变化，新增系统指令后可能沿用旧上下文。
- 不存在来自 Renderer 的 Skill 身份、指令或工具定义白名单校验。

## 目标与边界

交付一个可运行的产品维护 Skills 管理切片。UI 可查看并启停内置 `workspace-research` Skill。Harness 在每次 Pi 对话时只注入已启用的内置指令。启停状态保存到 Runtime 的 SQLite，并在重启后恢复。Skill 身份和正文由产品代码固定提供。

Skill 只提供工作方法指引。它不会扩大 `PermissionGateway`、工作区授权或 Pi 工具清单授予的能力。没有工作区授权时，模型仍不能读取本地文件。Renderer 只能请求启停一个已知 Skill，不能提交自定义提示词或可执行代码。

本切片不接入远端或 stdio MCP，不运行用户代码，不实现 Agent 生成插件草稿。它们需要独立完成 Worker 隔离与工具授权设计，继续排在当前产品 Skills 切片之后。

## 接入设计

1. 新建 `src/runtime/skills.mjs`，导出固定的 `PRODUCT_SKILLS`、状态规范化函数和稳定的系统提示词构建函数。初始只提供 `workspace-research`，内容要求先检查目录、按需读取有限文本、基于工具结果作答并注明相对路径；不得将提示词描述为权限控制。
2. `RuntimeController` 用 `meta.product_skills_enabled_v1` 持久化启用 ID 数组。新增 `skills.list` 与 `skills.set_enabled` 请求。`skills.set_enabled` 仅接受恰好包含 `id`、`enabled` 的对象，分别验证固定 catalog ID 与布尔值，其他字段一律拒绝且不改变状态；任何路径都不能传入 Skill 正文。历史状态读取时规范化非数组、未知 ID、重复 ID 和无效值。
3. `handleChat` 读取规范化 Skill 集合，将其构建为 Pi `initialState.systemPrompt`。把启用 ID 的稳定序列化值并入 `contextId(setting, enabledSkillIds)`。Skill 状态变更后，旧 transcript 不进入新配置会话。UI 历史消息仍保留显示。
4. Skill 更新只写本地脱敏元数据日志。日志字段只包括固定 Skill ID 与 enabled/disabled 状态，不包括指令正文或用户对话。
5. Renderer `refresh` 获取 Skill 状态，并显示名称、说明与开关。开关通过 `skills.set_enabled` 更新，返回成功后刷新状态；失败时显示 Runtime 错误。

## 改动点

- 新建 `pi agent/apps/desktop/src/runtime/skills.mjs`
- 修改 `pi agent/apps/desktop/src/runtime.mjs`
- 修改 `pi agent/apps/desktop/src/runtime/pi-agent.mjs`
- 修改 `pi agent/apps/desktop/src/runtime/logging.mjs`
- 修改 `pi agent/apps/desktop/src/ui/main.tsx` 与 `src/ui/styles.css`
- 新建或扩展 `test/skills.test.mjs`、`test/pi-agent.test.mjs`、`test/runtime.test.mjs`

## 推进顺序

1. 先写 Skill catalog 规范化和未知 Skill 拒绝测试，运行观察预期失败。
2. 实现固定 Skill 清单、规范化状态与系统提示词构建，跑定向测试。
3. 写 Runtime 状态持久化、RPC 校验、Pi 注入和启停后 transcript 隔离测试，再观察失败。
4. 实现 Runtime/Pi 接线与脱敏日志，跑定向测试并确认重启行为。
5. 写 UI 状态与启停控制，按现有 TypeScript 构建验证。
6. 逐项更新 checklist，运行全量测试、类型检查、构建和 diff 检查。
7. 自检后进行独立审查。桌面真实 UI 手动验收仍由用户运行确认，不使用 Playwright。

## 主要风险

- 模型可能不遵循 Skill 指令。权限与安全仍完全由 Harness、工具准入和 `PermissionGateway` 强制。
- 启用 Skill 会改变 Pi 系统上下文。启用 ID 纳入 context ID，避免旧工具 transcript 与新系统指令混合。
- SQLite 和 JSON 对话镜像继续保存对话内容。Skill 正文来自程序文件，不需要复制到日志或独立用户数据文件。
- Skill catalog 是可信产品代码。后续引入 MCP 或 Agent 生成插件前，必须另行落实受限 Worker、能力白名单和用户确认闭环，不得把本设计误用成代码执行授权。

## 验收结果记录

- 当前工作区原有未提交修改中已包含 Skills catalog、Runtime 持久化、Pi 注入、transcript 隔离和桌面开关实现。本轮复核补上 `skills.set_enabled` 请求严格字段白名单，并确认带未知字段的请求被拒绝且不会改变启用状态。
- 当前自动验证：定向测试 35 项通过；桌面全量测试 81 项通过；TypeScript 检查与 Vite 构建通过；`git diff --check` 通过。Node 为 SQLite 输出实验性功能提示。
- 尚需桌面手动验收：在真实运行桌面端选择已授权工作区，启用 `工作区调研`，以用户模型配置完成工具往返并停用确认持久化。真实 Provider 行为不由本地 SSE 测试替代。
- 尚需独立审查：按 design/checklist 对目标切片变更审查，并记录逐项 PASS/FAIL。
- 安全边界：Skill 指令只影响模型上下文，不提供隔离或权限；MCP 和 Agent 生成插件仍需受控能力授权及受限 Worker。
