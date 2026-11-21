# 审核个人记忆清单

## 代码层

- [x] M1 SQLite 审核、版本、编辑、删除及旧数据迁移。文件 `src/runtime/reviewed-memory.mjs`、`test/reviewed-memory.test.mjs`。
- [x] M2 Pi 提议工具、审核记忆共享和对话/任务版本边界。文件 `src/runtime.mjs`、`src/runtime/agent-tasks.mjs`、`test/reviewed-memory-runtime.test.mjs`。
- [x] M3 桌面审核、编辑、删除与明确外发范围。文件 `src/ui/MemoryPanel.tsx`、`src/ui/styles.css`。

## 验收层

- [ ] V1 专项测试覆盖迁移、迟到确认、拒绝、编辑和删除后上下文。
- [ ] V2 真实 Electron、全量测试、类型检查和构建。
- [ ] V3 独立 Codex 审查逐项 PASS，最多三轮。
