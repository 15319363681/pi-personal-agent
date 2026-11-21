# 受控 MCP 接入验收清单

设计依据：[design.md](design.md)。严格按顺序实施，每完成一项记录实际文件与验证结果。

## 代码层

- [x] C1 为 MCP URL/服务器定义、严格字段、工具状态默认拒绝、工具名映射与结果限长编写失败测试。文件：`pi agent/apps/desktop/test/mcp.test.mjs`。
- [x] C2 实现 MCP 数据规范化、SQLite 持久化、服务器及逐工具授权 API。文件：`pi agent/apps/desktop/src/runtime/mcp.mjs`、`pi agent/apps/desktop/src/runtime.mjs`、`pi agent/apps/desktop/test/mcp.test.mjs`。
- [x] C3 实现 HTTPS/loopback URL 校验、禁止重定向和敏感 URL 字段，新增对应测试。文件：`pi agent/apps/desktop/src/runtime/mcp.mjs`、`pi agent/apps/desktop/test/mcp.test.mjs`。
- [x] C4 集成官方 MCP Client Streamable HTTP SDK，实现连接、工具发现、JSON Schema 校验与调用。文件：`pi agent/apps/desktop/package.json`、`pi agent/apps/desktop/package-lock.json`、`pi agent/apps/desktop/src/runtime/mcp.mjs`、`pi agent/apps/desktop/test/mcp.test.mjs`。
- [x] C5 将仅获准工具经 PermissionGateway 接入 Pi，逐次重查授权，并增加真实模型协议模拟往返测试。文件：`pi agent/apps/desktop/src/runtime/mcp.mjs`、`pi agent/apps/desktop/src/runtime/pi-agent.mjs`、`pi agent/apps/desktop/src/runtime.mjs`、`pi agent/apps/desktop/test/mcp.test.mjs`、`pi agent/apps/desktop/test/pi-agent.test.mjs`。
- [x] C6 服务器和工具日志仅包含白名单元数据，不记录凭据、参数、结果和外部描述。文件：`pi agent/apps/desktop/src/runtime/logging.mjs`、`pi agent/apps/desktop/src/runtime/mcp.mjs`、`pi agent/apps/desktop/test/mcp.test.mjs`、`pi agent/apps/desktop/test/runtime-logging.test.mjs`。
- [x] C7 Electron 主进程通过 CredentialVault 加密管理 Bearer Token，恢复、更新失败和删除均保持密钥状态一致。文件：`pi agent/apps/desktop/src/credential-vault.mjs`、`pi agent/apps/desktop/src/main.mjs`、`pi agent/apps/desktop/src/runtime-request.mjs`、`pi agent/apps/desktop/test/credential-vault.test.mjs`、`pi agent/apps/desktop/test/runtime-request.test.mjs`。
- [x] C8 UI 可新增/编辑/删除 HTTP MCP 服务、连接/刷新工具、逐工具授权和启停，密钥不回显。文件：`pi agent/apps/desktop/src/ui/main.tsx`、`pi agent/apps/desktop/src/ui/styles.css`、`pi agent/apps/desktop/test/ui-main.test.mjs`、`pi agent/apps/desktop/test/preload-bridge.test.mjs`。
- [ ] C9 对照 design.md 检查所有入口、权限边界、失败清理、旧状态恢复和日志脱敏。文件：待独立审查与最终自检完成后填写。

## 验收层

- [x] A1 MCP 模块单元测试通过，包含拒绝未授权调用、无效 URL/schema 与结果限长。证据：`npm test`，95 项全部通过。
- [x] A2 Runtime 集成测试通过，证明状态重启恢复和授权撤销立即生效。证据：`pi agent/apps/desktop/test/mcp.test.mjs`，Runtime 重启后工具授权保留，未授权调用和撤销授权调用均被拒绝。
- [x] A3 本地 Streamable HTTP MCP 测试服务器经官方 SDK 完成发现与工具调用往返，且断连清理。证据：`pi agent/apps/desktop/test/mcp.test.mjs`，官方 Client/Node Server SDK 往返通过并关闭连接。
- [x] A4 Pi 对话中模型请求获准 MCP 工具并收到工具结果，日志和 transcript 均不暴露凭据。证据：`pi agent/apps/desktop/test/mcp.test.mjs` 中 `Runtime Pi conversation uses the saved MCP bearer token and keeps it out of transcript and logs` 集成测试。
- [x] A5 CredentialVault 测试证明密钥不出现在 Runtime 配置、Renderer 响应和日志中，并覆盖失败恢复。证据：`pi agent/apps/desktop/test/credential-vault.test.mjs`、`pi agent/apps/desktop/test/runtime-request.test.mjs`。
- [x] A6 桌面全量 `npm test` 通过。结果：95 passed, 0 failed。
- [x] A7 `npm run typecheck` 与 `npm run build` 通过。结果：TypeScript 检查通过，Vite 生成 `dist-ui` 构建产物。
- [ ] A8 真实桌面验收：连接配置的 MCP 服务、批准单工具、在 Pi 对话触发工具、撤销后验证不能再次调用。记录运行日志路径和实际 MCP 服务。待用户进行真实黑盒点击并提供实际 MCP 服务地址。
- [ ] A9 独立 Codex 按本设计、checklist 与本切片 diff 输出逐项 PASS/FAIL 和理由。失败项修复后复测。
- [ ] A10 最终自检 checklist 并列出所有未完成或存疑项。不得把远程 MCP 接入描述为 stdio/AppContainer 隔离已交付。

## 实施记录

- 2026-11-20：完成 C1–C8 的实现和定向测试。
- 2026-11-20：修复 `runtime-request.mjs` 在旧 Runtime 返回缺少 `servers` 字段时的兼容性回退，避免普通对话桥请求挂起。
- 2026-11-20：增加 `ui-main.test.mjs`，锁定 UI 刷新必须请求 `mcp.servers.list`。
- 2026-11-20：全量测试、typecheck、build、diff check 已执行并通过。独立审查和真实桌面黑盒验收待完成。
