# 多模型配置实施与验收清单

按 design.md 顺序执行，每项记录文件和证据。

## 代码层

- [x] M1 兼容旧配置数组，命名、能力字段、串行原子保存与删除。
- [x] M2 当前配置持久化，Pi 和连接测试使用所选配置，确认删除与凭据清理、断连核对。
- [x] M3 桌面新建、编辑、切换、测试和删除，未保存输入与测试状态正确绑定。

## 验收层

- [x] V1 针对性存储、Runtime、main bridge 及真实 Pi 端点切换回归。
- [x] V2 实际 Electron DOM 流程覆盖多配置管理、快速重复操作、失败、重启和键盘。
- [x] V3 全量 npm test、typecheck、build 与 diff 检查通过。
- [ ] V4 独立 Codex 按 design/checklist/diff 审查逐项 PASS，最多三轮。

## 未完成与存疑

人工验收本轮暂缓。真实付费模型及后续图片处理单独记录。

M1 文件为 src/runtime/model-settings.mjs 与 test/model-profiles.test.mjs。m1-red.log 复现并发保存只剩一项、命名丢失和无效元数据被保存，m1-green.log 为存储与既有记忆配置测试共 6 项通过。

M2 文件为 src/runtime.mjs、src/runtime-request.mjs 与 test/model-profiles.test.mjs。m2-red.log 复现当前配置缺失、错误密钥选择和断连清理缺失，m2-green.log 为新增及既有模型/桥接/存储测试 27 项通过。

M3 与 V2 文件为 src/ui/ModelSettingsPanel.tsx、src/ui/main.tsx、src/ui/styles.css、test/ui-main.test.mjs、test/model-profiles-ui.test.mjs 和 fixtures/model-profiles-ui-electron.cjs。electron-round1.log 发现重启选择错误，electron-round2.log 发现旧状态提示干扰，修复后 electron-round3.log 为真实 Electron 11 类场景通过。使用生产 preload、真实 Runtime/Pi、本机 SSE 和 Electron safeStorage。m3-green.log 为 11 项通过，初次类型检查通过。

V3 实跑 full-test-round1.log 为 184 passed、0 failed、0 skipped，49361.3082 ms。typecheck.log 与 build.log 退出 0，桌面目录 git diff --check 通过。独立审查前补齐新增文件检查。
