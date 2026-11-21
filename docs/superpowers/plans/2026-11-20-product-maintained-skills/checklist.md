# 产品维护 Skills 管理验收清单

设计依据：[design.md](design.md)。严格按项顺序实现，代码项完成即注明文件。

## 代码层

- [x] C1 为固定 Skill catalog、未知 ID 拒绝、状态规范化及只生成启用 Skill 系统指令编写测试。文件：`test/skills.test.mjs`，定向测试通过。原始 RED 输出不在本轮记录中。
- [x] C2 实现 `PRODUCT_SKILLS`、默认状态、状态规范化及稳定 system prompt 构建。文件：`src/runtime/skills.mjs`，现有工作区实现已通过定向测试。
- [x] C3 为 Runtime `skills.list`/`skills.set_enabled`、未知字段/ID 拒绝、SQLite 重启持久化及安全日志编写测试。文件：`test/runtime.test.mjs`。本轮新增未知字段拒绝与状态不变断言，RED 输出为预期的 `true !== false`。
- [x] C4 实现 Runtime Skill 状态读写和事件记录。请求只接受固定 Skill ID 与布尔启用状态，不接受提示词或工具定义。文件：`src/runtime.mjs`、`src/runtime/logging.mjs`。现在严格限制请求字段；拒绝时状态不变，日志仍只记录错误码。
- [x] C5 为 Pi 模型请求包含已启用 Skill 指令、停用指令不出现、Skill 集合变化后 transcript 不回放编写集成测试。文件：`test/pi-agent.test.mjs`，定向测试通过。原始 RED 输出不在本轮记录中。
- [x] C6 接入 Pi system prompt 并将 Skill ID 纳入 transcript context identity。文件：`src/runtime.mjs`、`src/runtime/pi-agent.mjs`。
- [x] C7 在桌面 UI 显示产品 Skills 的说明和启用状态，提供启停控件、错误与成功反馈；不可编辑 Skill 内容。文件：`src/ui/main.tsx`、`src/ui/styles.css`，TypeScript 检查及构建通过，未替代真实桌面手测。
- [x] C8 对照 design.md 自检。当前轮文件：`src/runtime.mjs`、`test/runtime.test.mjs`、本目录 `design.md`、本目录 `checklist.md`。其余 Skills 实现已存在于开始时的未提交工作区。接口不接受正文/工具字段，启停持久化并改变 transcript 身份；残余边界见 design.md 验收结果记录。

## 验收层

- [x] A1 `node --test test/skills.test.mjs test/runtime.test.mjs test/pi-agent.test.mjs` 35 passed / 0 failed / 0 skipped。
- [x] A2 桌面全量 `npm test` 通过，81 passed / 0 failed / 0 skipped。
- [x] A3 `npm run typecheck` 通过。
- [x] A4 `npm run build` 通过，Vite 产物输出至 `dist-ui/`。
- [ ] A5 运行桌面程序，启用 `工作区调研`，检查状态可见；发送读取工作区文件的问题，确认模型收到工具结果并按 Skill 指引标注相对路径；停用 Skill 后确认状态保存。记录日志路径和结果。此项需用户桌面手动验收。
- [ ] A6 独立审查 design.md、checklist.md 与本切片目标 diff，逐项给出 PASS/FAIL 和理由。失败项需修复并回归。
- [ ] A7 最终复核全部清单。记录待完成的 MCP/本地插件阶段，不得把提示词 Skill 描述成隔离或权限能力。

## 自检记录

- Runtime 只接受恰好含 `id` 和 `enabled` 的 Skill 状态请求；未知字段被拒绝后，Skill 状态保持原值。未知 Skill ID 和非布尔状态仍通过既有校验拒绝。
- SQLite 重启恢复、Skill prompt 注入、状态变化后 transcript 隔离、安全日志白名单及不可编辑 UI 均有现存测试或构建证据。
- 当前实现依据工作区原有未提交 Skills 代码继续完善。本轮只新增 Runtime 输入校验及其回归测试，保留其他未提交修改。
- 自动验收已完成。桌面人工操作和独立审查待完成。
