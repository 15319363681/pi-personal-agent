# 网页调研实施与验收清单

## 代码层

- [x] W1 固定目标的有界搜索适配，输入、结果及失败处理，来源归一化。文件为 src/runtime/web-research.mjs、test/web-search.test.mjs。
- [x] W2 用 Pi 生成可追溯结论，调研与普通聊天上下文和工具隔离，结果持久化及脱敏日志。文件为 src/runtime.mjs、src/runtime/pi-agent.mjs、src/runtime/web-research.mjs、test/web-research-runtime.test.mjs。
- [x] W3 搜索凭据独立本机保护，发送模式、外发范围、来源与不可核实状态可见。文件为 src/main.mjs、src/runtime-request.mjs、src/ui/main.tsx、src/ui/ResearchPanel.tsx、src/ui/styles.css。

## 验收层

- [x] Q1 本地协议夹具覆盖正常、无结果、无效引用、超限、网络失败、凭据隔离、重启和普通聊天回归。文件为 test/web-search.test.mjs、test/web-research-runtime.test.mjs、test/web-research-bridge.test.mjs。
- [x] Q2 Electron 离线验证入口、键盘、900px 窗口及失败反馈，全量 216 项、类型检查、构建及差异检查通过。文件为 test/web-research-ui.test.mjs、fixtures/web-research-ui-electron.cjs。
- [ ] Q3 独立 Codex 审查逐项通过，最多三轮。
