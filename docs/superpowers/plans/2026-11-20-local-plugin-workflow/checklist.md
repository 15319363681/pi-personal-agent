# 本地插件实施与验收清单

依据 [design.md](design.md)，按编号顺序推进。完成即填写文件和证据。

## 代码层

- [x] C1 编写定义校验、草稿默认停用、版本持久化、并发更新、测试及用户确认规则的失败测试。文件为 test/plugins.test.mjs，RED 为插件模块缺失。
- [x] C2 实现 SQLite 插件生命周期和严格请求/输入校验，文件为 src/runtime/plugins.mjs 和 src/runtime/logging.mjs，定向测试 6 项通过。
- [x] C3 编写并运行真实 Windows Worker 测试，覆盖 JSON 往返、API 收窄、超时、隔离失败拒绝和清理。文件为 test/plugin-worker.test.mjs，已进入全量回归并通过。
- [x] C4 实现产品 AppContainer + Job Worker、身份校验、资源限制和失败清理，运行 Node/Electron 验证。文件为 src/runtime/plugin-worker.mjs、src/runtime/windows-plugin-process.mjs、src/runtime/plugin-bootstrap.cjs 和 fixtures/plugin-worker-electron-host.fixture.cjs。Node、Electron 可执行文件及 Electron 两种宿主测试通过。
- [x] C5 编写 Runtime/Pi 对话闭环测试并接入草稿、测试和已启用版本工具，覆盖撤销和旧版本拒绝。文件为 src/runtime.mjs、src/runtime/pi-agent.mjs、src/runtime/plugins.mjs 和 test/pi-agent.test.mjs，真实 Pi 与本地 SSE Provider 闭环通过。
- [x] C6 增加桌面插件审核管理入口，展示源码、schema、测试记录、版本和错误，支持确认启用、停用及删除。文件为 src/ui/PluginPanel.tsx、src/ui/main.tsx、src/ui/styles.css、test/ui-main.test.mjs、test/plugin-ui.test.mjs 和 fixtures/plugin-ui-electron.cjs。真实 Electron DOM 操作及生产 Runtime 子进程验收通过。
- [x] C7 逐项自检正常 RPC/Pi/桌面入口、重启恢复、版本并发、脱敏及正常退出清理。补充 src/main.mjs、src/rpc.mjs、test/rpc.test.mjs、test/plugins.test.mjs 和 fixtures/plugin-ui-electron.cjs 及 test/main-lifecycle.test.mjs。真实生产 before-quit 回调的重复退出、等待及恢复退出回归通过。真实 Runtime 在途插件退出及目录清理通过，强制终止后的残留元数据回收列为后续可靠性项。

## 验收层

- [x] A1 插件状态和 Runtime/Pi 集成测试通过。test/plugins.test.mjs 的 10 项及 test/pi-agent.test.mjs 的 20 项在全量运行中通过。
- [x] A2 产品 Worker 在本机 Windows 实测 AppContainer 与 Job 身份、越界文件限制、网络收包隔离及前后正向对照、超时回收，Electron 两种宿主启动验证通过。文件为 test/plugin-worker.test.mjs 和 fixtures/plugin-worker-boundary.fixture.cjs，33 项全量回归通过。
- [x] A3 全量 npm test 为 148 passed、0 failed、0 skipped，耗时 58806.1317 ms。npm run typecheck、npm run build 和 git diff --check 均退出 0。Vite 成功构建 16 个模块并生成 dist-ui。
- [x] A4 独立 Codex 已完成两轮审查，第 1 轮发现生产退出 P1，第 2 轮 C1–C7 与 A1–A5 全部 PASS。review.md 记录逐项理由、修复和验证边界。
- [x] A5 记录可手动验收步骤、预期结果、日志位置和真实 Provider/桌面点击的待验证项。见 design.md 的手动验收、数据与诊断章节。

## 实施记录

- 2026-11-20 已检查工作区，保留已有未提交修改。主实施顺序无字面量换行损坏。本目录首次创建。

- 2026-11-20 本轮实现已进入全量回归。首轮 130 项中 129 通过，旧工作区替换测试仍假定工具集合为空，正在按当前插件开发工具集合修正断言。原有工作区安全限制继续单独验证。

- 2026-11-20 修复测试探针在 Job 拒绝子进程时同步抛出 EPERM 导致提前退出的问题，保留边界断言。网络实测结合相同可执行文件前后对照成功与受限期间服务端零收包。
- 2026-11-20 补充桌面优雅退出回归，先观察旧 RpcClient.close 无法等待的失败，再完成实现。真实 Runtime 接收 EOF 后完成插件测试、写入 SQLite 并清空运行目录。RPC 定向 4 项通过，包含插件状态与 preload 的组合定向 15 项通过。
- 2026-11-20 当前代码全量 144 项通过，类型检查、构建及 diff check 通过。独立审查第 1 轮发现生产 before-quit 仍立即 kill Runtime，C7 重新打开。正在修复并增加生产回调回归，等待第 2 轮复审。

- 2026-11-20 第 1 轮独立审查确认正常托盘退出立即 kill 的 P1。修复 src/main.mjs 并新增 test/main-lifecycle.test.mjs，先观察 3 项失败、1 项通过，再验证 4 项通过。主线组合定向 19 项通过，随后完成第 2 轮独立复审与全量重跑，最终结果见下文。

- 2026-11-20 第 2 轮代码由主线亲自重跑全量，148 项通过、0 失败、0 跳过。类型检查、构建与 git diff --check 全部退出 0。第 2 轮独立复审全部 PASS，第一轮 P1 已关闭。

## 最终自检

C1–C7 与 A1–A5 全部复核完成。主线全量 148 项通过，独立复审者另跑生命周期与 RPC 定向 8 项通过，生产回调与真实 RpcClient 的内存组合顺序验证通过。

当前切片没有未关闭审查缺陷。后续项包括真实付费 Provider 自主生成质量、用户亲自桌面/托盘点击、安装包发布，以及系统崩溃或超时强制终止后的 profile 和运行目录自动回收。首切片采用同步纯 JSON 数据处理插件，后续受控文件、网络及其他能力尚未接入。所有工作区原有修改保留。
