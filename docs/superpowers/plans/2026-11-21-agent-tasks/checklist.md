# 可跟踪 Agent 任务实施与验收清单

## 代码层

- [x] D1 任务记录、迁移、状态机、检查点与断点恢复。文件为 src/runtime/agent-task-store.mjs 和 test/agent-task-store.test.mjs。
- [x] D2 Pi 实际规划与读工具步骤、资源边界、暂停和取消。文件为 src/runtime/agent-tasks.mjs、src/runtime/pi-agent.mjs、src/runtime.mjs、test/agent-task-runtime.test.mjs。
- [x] D3 桌面发送模式与任务详情、凭据隔离和状态操作。

## 验收层

- [x] E1 离线覆盖重启、暂停竞态、模型和目录变化、工具与结果可见。
- [x] E2 Electron、全量测试、类型检查、构建和差异检查。
- [ ] E3 独立 Codex 审查逐项 PASS，最多三轮。

D3 文件为 src/ui/AgentTaskPanel.tsx、src/ui/main.tsx、src/ui/styles.css、src/runtime-request.mjs、src/main.mjs、test/agent-task-bridge.test.mjs、test/agent-task-ui.test.mjs 和 fixtures/agent-task-ui-electron.cjs。主进程有界写入剪贴板供报告和来源复制。E1 的 15 项边界测试通过，覆盖授权撤销、同目录重新授权、根替换、预算、超时、取消迟到结果和恢复检查点。真实 Electron 启动、读取资料、失败目标保留、键盘暂停、重启继续、复制报告及取消通过，相关日志在 D:/Temp/pi-agent-tasks-20261121。

E2 全量实测为 233 passed、0 failed、0 skipped，耗时 52227.8209 ms。typecheck、build 与 git diff --check 退出 0。证据为 full-test.log、typecheck.log、build.log、diff-check.log。
