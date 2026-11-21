# Agent 创建本地插件闭环设计

日期为 2026-11-20。实现和验收证据随 checklist.md 更新。

## 调研

### 可复用

- RuntimeController.handle 统一承载 Harness 请求入口，RuntimeStore 的 SQLite transaction 可用于原子更新版本和确认状态。
- runPiAgentTurn 已运行 Pi Agent 顺序工具循环，支持增加 Harness 提供的工具，已有本地 SSE Provider 集成测试。
- LocalRuntimeLogger 的字段白名单可扩充插件 ID 和版本等元数据。
- 桌面 React 轮询和主进程请求桥可承载插件管理操作。凭据保留现有主进程边界。
- Windows Spike 的 Koffi 调用已覆盖 AppContainer profile、挂起创建进程、Job Object 和回收。产品模块需要独立接入、运行和验证。

### 缺失

- 产品缺少插件定义、不可变版本、开发测试记录和用户确认状态。
- 产品缺少 AppContainer Worker、调用结果协议、资源限制、宿主退出回收和隔离失败拒绝路径。
- 产品缺少 Pi 创建草稿与测试工具、已启用插件注册和桌面源码审核入口。

## 目标与接口

首个纵向切片实现 Pi 创建或更新草稿、隔离测试、用户审核确认、启停与调用。插件是同步 JavaScript 函数表达式，接收 JSON 对象，返回有界 JSON 值。Harness 校验 inputSchema 和输入。首切片开放纯数据转换能力，插件权限集合为空。文件、网络、凭据和 MCP 能力留待后续具体能力接入。

定义包含 id、name、description、source、inputSchema、tests。tests 至少一项，每项包含 name、input、expected。id 使用小写英文、数字和下划线，最长 40 字符。源码最多 32 KiB，schema 最多 8 KiB，JSON 输入和输出各最多 32 KiB，测试最多 8 项。递归结构深度和节点数有上限。

SQLite 保存 plugins、plugin_versions 和 plugin_tests。版本不可变，内容哈希绑定源码、schema 和测试。保存更新时使用 baseVersion 做乐观并发校验，同时停用旧版本并清除确认。测试只为其执行快照的版本记账。当前版本测试全部通过，且用户确认相同版本后才可启用。历史版本与测试记录保留本地，运行重启后仍可查看。

Runtime 请求采用 plugins.list、plugins.get、plugins.save_draft、plugins.test、plugins.set_enabled、plugins.run 和 plugins.remove。所有请求校验字段，更新、测试、启用、调用和删除带具体版本。启用要求 confirm 为 true。Pi 获得只读 plugin_inspect、plugin_save_draft、plugin_test 和已启用版本的 plugin_<id>_v<version> 工具。每次调用都重新检查当前版本、通过测试、确认版本和启用状态。

## Worker 接入

新增产品级 Windows x64 Koffi 模块，使用无网络 capability 的 AppContainer profile。进程先挂起创建，加入设置 KILL_ON_JOB_CLOSE、单活动进程和内存限制的 Job，检查 TokenIsAppContainer、AppContainer SID 及 Job 身份，再恢复运行。任何步骤失败都终止并拒绝调用。

每次执行使用唯一暂存目录，只给当前 profile 的 SID 授予所需读写权限。可信 bootstrap 和运行时为只读，数据目录限于本次输入和结果。环境变量由 Harness 显式构造，保留启动必需项。插件函数在 Worker 的独立 vm context 中运行，vm 仅用于收窄 API。OS AppContainer 和 Job 承担隔离。

宿主使用独立复制的 Node/Electron 运行文件，Electron 通过显式 ELECTRON_RUN_AS_NODE 启动。产品测试必须同时覆盖本机 Node 与桌面 Electron 环境。结果文件先检查普通文件、大小和有界 JSON，再读取。外部输入、源码、错误文本和插件输出不得作为 Runtime 日志字段。超时终止整个 Job，等待回收后释放句柄、删除 profile 与暂存目录。关闭 Runtime 等待在途插件操作。桌面退出先关闭标准输入，等待当前请求和 Worker 清理完成，45 秒超时后终止 Runtime。

## 改动点和顺序

1. test/plugins.test.mjs 先锁定状态、并发、校验和确认规则，src/runtime/plugins.mjs 实现 SQLite 生命周期。
2. test/plugin-worker.test.mjs 先锁定真实 Worker 行为，新增 src/runtime/plugin-worker.mjs、src/runtime/windows-plugin-process.mjs 和 src/runtime/plugin-bootstrap.cjs，安装固定 koffi 依赖。
3. 扩展 Runtime 和 Pi 接线，测试模型保存草稿、测试、用户确认后调用和撤销，插件集合纳入 transcript 身份。
4. 新增 PluginPanel.tsx 审核源码、schema、测试用例和状态，提供隔离测试、确认启用、停用、删除及更新草稿入口。
5. 更新 checklist、自检、全量测试、类型检查和构建，再由独立 Codex 逐项审查。最多三轮修复回归。

## 风险和验收

- AppContainer 支持和 ACL 配置必须在本机产品 Worker 验证，失败返回 plugin_isolation_unavailable，验收项保留未通过状态。
- 原生绑定与 Electron ABI、运行文件复制、文件句柄释放和 profile 删除需要真实测试。
- 测试证明样例满足预期。用户必须能查看完整源码和测试，确认与版本绑定。
- 在途执行与更新、停用、删除交错时，对快照记账并重新校验结果准入，避免旧版本重新启用。
- 日志保存在 Runtime 数据目录 logs/runtime.jsonl，只记录操作元数据。版本、源码及开发测试记录保存在 agent.sqlite。
- 第三方插件安装、市场、异步插件及扩展宿主能力另行推进。


## 当前接入与自检

- 桌面通过 PluginPanel.tsx 调用 Runtime RPC，展示完整当前源码、输入 Schema、测试样例、版本哈希与本地测试历史。确认状态绑定插件 ID、版本、哈希和当前测试状态，更新后重新审核。
- Pi 只获得草稿保存、测试、查看和已确认版本的调用工具。启用与删除由桌面管理入口发起，删除有独立确认。
- 对话保留 UI 历史。启用工具集合变化后重新建立 Pi transcript，Agent 在本轮更新已启用插件时，提交回复并按当前工具身份清空旧上下文。
- 测试同时覆盖受控本地 SSE Provider 的真实 Pi 工具循环和真实 Electron 窗口中的 DOM 操作。Electron 界面测试通过生产 preload、RpcClient 及 ELECTRON_RUN_AS_NODE Runtime 子进程访问实际 Worker，所有数据位于临时目录。
- 测试 Provider 的输出由本地 fixture 指定。付费模型 Provider 的自主生成质量、用户亲自桌面点击及安装包发布仍待实际环境验证。
- 当前 Job 设置 KILL_ON_JOB_CLOSE。系统崩溃或超过退出等待时间后，残留 AppContainer profile 和运行目录的启动扫描回收尚未实现，属于后续可靠性项。
- 首切片的插件函数采用同步纯 JSON 数据处理。这是本轮的实施选择，后续文件、网络和其他受控能力按产品方向增量接入。

- 自检补充 src/rpc.mjs 与 src/main.mjs 的退出流程，正常托盘退出等待 Runtime 完成在途请求并清理 Worker。test/main-lifecycle.test.mjs 抽取生产 before-quit 回调覆盖退出等待、重复退出和完成后退出，test/rpc.test.mjs 覆盖退出等待、拒绝新请求及超时兜底，test/plugins.test.mjs 覆盖真实 Runtime 在途插件测试后的退出和目录清理。

## 手动验收

在 D:\Atry\pi agent\apps\desktop 执行以下命令启动本次构建。

~~~powershell
npm run build
npm start
~~~

1. 在模型设置填写真实 Provider、模型、端点和 API Key，保存并点击测试连接。预期出现成功、用量与关联 ID。真实请求可能计费。
2. 在普通对话发送“创建一个 text_stats 本地插件，输入对象的 text 字段为字符串，返回 length 字段，统计 JavaScript 字符串长度。添加 abc 返回 3 的测试并运行测试，完成后等待我审核”。预期对话显示 plugin_save_draft 和 plugin_test 的执行结果，右侧本地插件出现停用草稿。
3. 选择插件，查看当前源码、输入 Schema、测试样例和本地测试记录。预期测试通过时审核复选框可选。未勾选前确认启用按钮禁用，测试失败时继续禁用。
4. 勾选版本审核确认并点击确认启用。再次对话“用 text_stats 插件处理 hello”。预期出现 plugin_text_stats_v1 的真实调用记录并得到 length 为 5。
5. 让 Agent 更新此插件，增加测试用例并重新运行测试。预期版本递增、旧版本停用，新版需要再次审核确认。期间旧版本工具调用被拒绝。
6. 在插件面板停用插件，再次要求调用。预期工具从下一轮模型工具列表移除。删除按钮显示确认，确认后插件从列表移除。
7. 从托盘退出后重新启动。预期未删除插件的版本、测试记录和启停状态恢复。测试失败时展开本地测试记录查看错误码。

## 数据与诊断

- 桌面 Runtime 数据目录为 Electron userData 下的 runtime。界面顶部显示完整日志文件路径。
- 运行元数据位于 runtime/logs/runtime.jsonl。可按 pluginId、pluginVersion 或对话 correlationId 检索。源码、输入、输出和任意插件抛错正文不会写入该日志。
- 插件版本、源码、Schema、样例及测试历史保存在 runtime/agent.sqlite 的 plugins、plugin_versions 与 plugin_tests。
- 每次 Worker 使用 runtime/plugin-runs 下的独立暂存目录，执行结束应清理，测试会检查空目录。删除插件采用软删除并保留历史计数，重建相同 ID 时版本继续递增。
- 测试产生的 SQLite、日志、窗口数据和 AppContainer 资源均使用临时隔离目录并清理，正式用户数据沿用现有目录。
