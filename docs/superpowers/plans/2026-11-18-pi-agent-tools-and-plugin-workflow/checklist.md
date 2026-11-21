# Pi 对话与受控工作区工具验收清单

设计依据：[design.md](design.md)。严格按序实现；每完成代码项即注明文件并勾选。验收层在有可复核证据后才勾选。

## 代码层

- [x] C1 为 WorkspaceAdmission 增加根目录边界、父级 symlink/reparse、缺失文件、文本读取大小限制、直接子项列举与数量上限测试；观察新风险测试失败。文件：`test/permissions.test.mjs`。证据：定向测试和全量测试覆盖目录替换、列表截断及边界。
- [x] C2 实现分段路径检查、只读文本读取和有界目录列举；拒绝绝对路径、`..`、链接组件、过大与非文本内容。文件：`src/runtime/workspace.mjs`。证据：`test/permissions.test.mjs` 覆盖路径、大小、文本、列举及目录身份。
- [x] C3 为 Pi Runtime 往返写集成测试：本地 SSE 服务驱动真实 Pi AI Provider，模型调用工作区工具，收到工具结果后继续生成最终答案；同时验证未授权/越界路径不被读取。文件：`test/pi-agent.test.mjs`、`test/runtime.test.mjs`。证据：`node --test test/permissions.test.mjs test/pi-agent.test.mjs test/runtime-request.test.mjs test/runtime-logging.test.mjs`，定向测试通过；本地 SSE 仅证明协议和 Harness 往返，不代表真实供应商验收。
- [x] C4 锁定 `@earendil-works/pi-agent-core`、`@earendil-works/pi-ai`、`@earendil-works/pi-schema` 为 `1.5.2` 并更新 lockfile。文件：`package.json`、`package-lock.json`。证据：`npm ls @earendil-works/pi-agent-core @earendil-works/pi-ai @earendil-works/pi-schema --depth=0` 三项均为 `1.5.2`。
- [x] C5 将当前模型设置适配为 Pi AI Responses/Completions Provider，保留 HTTPS/loopback 检查、超时、API Key 桥接、凭据版本一致性、RPC 断连后的设置对账与未知费用状态。文件：`src/runtime/pi-agent.mjs`、`src/runtime.mjs`、`src/runtime-request.mjs`、`src/credential-vault.mjs`。证据：`test/model-provider.test.mjs`、`test/pi-agent.test.mjs`、`test/runtime-request.test.mjs` 与 `test/credential-vault.test.mjs` 覆盖协议、端点、密钥回显、设置失败对账、提交后断连时回收旧引用、迁移并发变化时清理未引用的新凭据和旧密钥迁移。
- [x] C6 注册固定的 `workspace_list` / `workspace_read` Pi 工具，通过 PermissionGateway 与 WorkspaceAdmission 执行；Pi 生命周期工具状态记脱敏本地日志。文件：`src/runtime/pi-tools.mjs`、`src/runtime.mjs`、`src/runtime/permission-gateway.mjs`、`src/runtime/logging.mjs`。证据：`test/pi-agent.test.mjs`、`test/permissions.test.mjs`、`test/runtime-logging.test.mjs` 覆盖工具往返、边界拒绝与日志不含提示词/凭据/文件正文。
- [x] C7 保存 Pi 结构化 transcript 并串行化会话请求；验证后续轮次和 Runtime 重启回放 tool-call/tool-result。文件：`src/runtime.mjs`、`src/runtime/pi-agent.mjs`、`test/pi-agent.test.mjs`。证据：`test/pi-agent.test.mjs` 覆盖工具往返、重启回放、SQLite 原子提交、镜像故障、旧格式迁移及并发冲突。SQLite 保存权威状态，JSON 文件为镜像。模型配置身份变更和无身份旧记录不会重放先前上下文。
- [x] C8 增加 Electron 系统目录选择器及 Runtime 授权持久化；阻断 Renderer 直接提交任意授权路径。文件：`src/main.mjs`、`src/runtime-request.mjs`、`src/runtime.mjs`、`test/preload-bridge.test.mjs`、`test/runtime-request.test.mjs`。证据：目录选择委托主进程、控制 token 授权、SQLite 持久化和重启恢复测试通过；Renderer 不能提交任意授权路径。
- [x] C9 UI 提供工作区授权状态/选择入口，并显示已完成的工具执行摘要和状态；不显示未实现的任务执行能力。文件：`src/ui/main.tsx`、`src/ui/styles.css`。证据：`npm run typecheck` 与 `npm run build` 通过；UI 仅展示已实现的对话、工作区授权和工具状态，任务入口仍明确标为本地任务提案。
- [x] C10 复核 C1-C9 与 design 风险并记录边界。文件：本文 `自检记录`、`design.md`。自检结果：持久化、凭据、Provider、工作区 admission、工具往返、transcript、Renderer 授权边界均有对应测试；剩余风险为工作区 TOCTOU、迁移替换窗口窄竞态、Runtime 状态无法对账或旧凭据清理失败时可能留下加密凭据、兼容 Provider 差异。A5 桌面人工验收、A6 真实 Provider 验收及 A7 独立审查分别跟踪。

## 验收层

- [x] A1 定向回归通过：`node --test test/runtime-request.test.mjs test/credential-vault.test.mjs`，14 passed / 0 failed / 0 skipped；完整套件同时覆盖工作区、Pi 工具往返、拒绝越界、transcript 回放和日志脱敏。
- [x] A2 桌面全量 `npm test`：75 passed / 0 failed / 0 skipped。
- [x] A3 桌面 `npm run typecheck` 通过，`tsc --noEmit` 退出码 0。
- [x] A4 桌面 `npm run build` 通过。Electron 隔离进程烟测结果保存在 `D:\Temp\pi-agent-final2-c1e98206030749d7bc39e4adacb52a3e`，输出确认设置读取、连接测试、本地 SSE Pi 对话、系统选择器模拟、`workspace_read` 与最终回答均完成。该烟测不是人工桌面点击或真实 Provider 验收。
- [ ] A5 手动验收：启动桌面程序，配置模型并测试连接，点击选择工作区，发送要求列举/读取某个文本文件的问题；确认模型答案引用实际工具返回内容，UI 显示工具状态，`logs/runtime.jsonl` 只有工具名/状态等元数据且没有提示词、文件内容和 Key。
- [ ] A6 真实模型 Provider 手动验收已完成；若未配置凭据，明确保持未完成，不用本地 SSE 测试冒充。
- [ ] A7 独立 Codex 审查 design.md、checklist.md 和本轮目标文件 `git diff`，逐项给出 PASS/FAIL 与理由；FAIL 必须回到对应步骤修复并回归。第三轮审查发现的两项凭据状态问题已修复并完成回归，修复复核待完成。审查限定在当前切片和相关文档，不把工作区中其他既有未提交改动并入本轮范围。

## 自检记录

- 2026-11-20 第一轮独立审查发现目录身份、Provider 请求安全、对话记录一致性、工具摘要和测试覆盖问题。修复后定向测试 25 项、全量测试 61 项通过，类型检查和构建通过。
- Electron 隔离进程使用本地 SSE 服务与模拟目录选择，完成连接、授权、Pi `workspace_read` 工具调用及回答。`D:\Temp\pi-agent-desktop-tool-gwa1hvxr` 保存脚本和日志，检查日志未发现测试 Key、提示词或文件正文。真实桌面人工点击及真实 Provider 仍待验收，独立审查需对当前修改重新执行。
- 工作区是应用层 admission，存在文件系统检查与访问之间的 TOCTOU 风险。旧版仅路径授权需要重新选择。SQLite、其备份及 JSON 镜像包含对话正文和工具结果。
- OpenAI-compatible 服务的工具调用兼容性需按实际服务商验收。受控 Skills/MCP、插件闭环和受限 Worker 属于后续实施内容。

- 第二轮独立审查结论 FAIL。已修复服务商切换跨端点发送、成功响应回显密钥、旧版密钥迁移及旧消息状态展示，并增加回归测试。第三轮又发现设置更新失败与旧凭据迁移并发风险，已使用每版本独立密钥引用、Electron 单实例锁和设置快照变更校验修复并增加竞态测试。目录链接测试明确报告跳过，当前环境实际执行且无跳过。第一轮新增测试的原始红灯输出未保留，无法事后核验。第三轮独立审查已发现的设置更新失败与迁移并发问题已修复并完成回归，正进行针对修复的审查复核。

- 最新回归：全量测试 72 项通过，类型检查和构建通过。Electron 隔离进程于 `D:\Temp\pi-agent-final-fa26d409b2e4448f9b21fb1287e80ad5` 完成模拟目录选择、本地 SSE 对话及读取工具往返，日志未出现测试 Key、提示词或文件正文。

- 凭据一致性修复新增两个回归用例，`test/runtime-request.test.mjs` 与 `test/credential-vault.test.mjs` 定向测试 11 项通过。最终复跑结果：`npm test` 72 passed / 0 failed / 0 skipped，`npm run typecheck` 与 `npm run build` 通过。Electron 45.3.3 隔离进程模拟目录选择并完成 `workspace_read` 工具往返，结果目录为 `D:\Temp\pi-agent-final2-c1e98206030749d7bc39e4adacb52a3e`，日志无测试凭据、提示词或正文。


- 2026-11-20 回归修复：移除凭据测试文件中的重复导入；设置更新 RPC 断连后核对 Runtime 状态，确认提交时返回已提交配置并清理旧凭据，确认未提交时删除新凭据，无法确认时保留新旧凭据；迁移设置并发变化时仅清理本次创建且不再被当前设置引用的凭据。定向回归 14 项、全量测试 75 项通过，类型检查、构建和 `git diff --check` 通过。状态无法对账或凭据清理失败时仍可能遗留加密文件，迁移文件快照检查与替换之间仍有窄竞态。第三轮独立审查发现的两项问题已修复，修复复核、两项人工验收尚未完成。
