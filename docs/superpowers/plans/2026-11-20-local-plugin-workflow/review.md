# 本地插件独立审查记录

## 第 1 轮

审查输入为 design.md、checklist.md 及目标 git diff，快照包含 24 个目标文件及未跟踪新增文件，补正后为 300190 字符。独立 Codex 逐 hunk 核对实际源码、执行路径、测试断言及必要依赖。

总判定为 FAIL，发现一项 P1。

| 项目 | 判定 | 理由 |
| --- | --- | --- |
| C1 | PASS | 定义、草稿、不可变版本、并发和确认有实际测试断言，历史 RED 根据实施记录判断。 |
| C2 | PASS | SQLite 事务、版本冲突、失败测试、调用前后批准复核和删除重建一致。 |
| C3 | PASS | 真实 Worker、Node/Electron、token/Job、文件和网络对照、超时及故障清理有执行证据。 |
| C4 | PASS | 挂起创建、Job、零 capability AppContainer、SID、ACL、环境、资源限制和回收接入产品路径。 |
| C5 | PASS | 真实 Pi 调用开发及启用版本工具，工具身份变化调整 transcript。 |
| C6 | PASS | 源码、schema、样例和历史可见，确认绑定版本身份，实际 Electron DOM 流程通过。 |
| C7 | FAIL | src/main.mjs 的 before-quit 仍立即终止 Runtime，绕过异步关闭等待。 |
| A1 | PASS | 插件状态 10 项与 Pi 20 项全量通过，核查了实质断言。 |
| A2 | PASS | 真实 Windows 和 Electron 隔离、前后网络对照、故障注入与超时回收有证据。 |
| A3 | PASS | 当前快照全量 144 项通过，类型检查、构建和差异空白检查退出 0。 |
| A4 | PASS | 独立审查动作完成，最终验收仍等待缺陷修复和复审通过。 |
| A5 | PASS | 操作步骤、预期结果、日志与本地数据位置及待验证范围已记录。 |

### P1 与修复要求

src/main.mjs 第 92–96 行仍在调用异步 runtimeClient.close() 后立即 runtimeProcess.kill()。正常托盘退出会中断插件测试记录提交及 profile、暂存目录清理。RpcClient 已支持 EOF 和关闭等待，生产入口需要 preventDefault 并等待单一 shutdown Promise，完成后再次 app.quit()。

现有真实 Runtime EOF 与 Electron DOM fixture 覆盖了关闭能力，生产 before-quit 回调仍需专门回归。已确认多行文本替换未命中原文件，是本次漏接的直接原因。

系统崩溃或超时强制终止后的残留元数据回收已列为后续可靠性项，审查接受此披露。正常退出清理属于本轮承诺，必须修复。

## 第 2 轮

总判定为 PASS。第二轮差异包含 25 个文件，305275 字符，逐 hunk 与实际源码一致。第一轮唯一 P1 已关闭，未发现新增可复现缺陷。

| 项目 | 判定 | 理由 |
| --- | --- | --- |
| C1 | PASS | 定义、默认停用、版本、并发、测试与确认的断言完整，新增生命周期 GREEN 已亲自核验。 |
| C2 | PASS | 生命周期事务与版本约束符合设计，退出修复能够等待在途操作完成。 |
| C3 | PASS | 真实 Worker 的身份、文件和网络对照、失败拒绝、故障及超时清理断言有最终全量证据。 |
| C4 | PASS | 产品 AppContainer、Job、ACL、环境、结果校验和回收接线完整，正常退出已等待清理链。 |
| C5 | PASS | 真实 Pi 草稿、测试及已批准版本调用受 Harness 控制，工具身份与 transcript 关联。 |
| C6 | PASS | UI 审核绑定版本身份，管理流程有真实 Electron DOM 通过证据。 |
| C7 | PASS | 实际 before-quit 回调等待单一关闭 Promise，重复退出与引用清空仍持续等待，完成后允许退出。 |
| A1 | PASS | 状态、Pi 和新增退出用例有实质断言，主线组合定向 19 项及全量 148 项通过。 |
| A2 | PASS | 最终全量包含本机 Windows/Electron 隔离与故障回收验证。 |
| A3 | PASS | npm test 为 148 passed、0 failed、0 skipped，58806.1317 ms，typecheck、build、diff check 均退出 0。 |
| A4 | PASS | 第二轮独立复审完成，第一轮唯一 P1 关闭。 |
| A5 | PASS | 启动、验收、日志与数据位置和待验证范围有完整记录。 |

### 本轮验证

独立审查者亲自运行生命周期与 RPC 定向测试，8 passed、0 failed。另将实际生产回调和真实 RpcClient 组合，用内存子进程事件验证 stdin.end、exit 清空引用、close、恢复 app.quit 的顺序，等待期间重复退出均受阻。

主线亲自重跑全量 148 项、类型检查、构建和差异检查。真实 Runtime EOF、Worker 和 Electron DOM 由这些测试动态执行。生产退出回调重入使用内存 Electron 事件替身，用户实际托盘点击和付费 Provider 的自主生成质量保留待验证状态。

### 后续边界

系统崩溃或退出等待超时后，AppContainer profile 与运行目录的启动扫描回收尚待实现。正常托盘退出已具备清理等待期，独立审查按已承诺的同步纯 JSON 首切片接受此边界。
