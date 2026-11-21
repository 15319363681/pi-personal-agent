# 本地资料读取与文本产物设计

日期为 2026-11-20。依据产品方向第 58 行与近期实现顺序第 4 项交付一个可运行切片。用户本轮采用离线自动化验证，人工验收暂缓。

## 调研

### 可复用

- RuntimeController 维护授权目录身份、串行 Pi 会话、SQLite、关联日志与恢复模式。
- WorkspaceAdmission 已检查目录身份、相对路径、链接和文件大小，提供 TXT/Markdown 读取。
- Pi 的工具执行结果、Skills 提示与桌面 RPC 已贯通。Electron 已有真实 DOM 自动测试入口。
- koffi 已固定为 2.14.1，可以在 Windows 上固定目录句柄。
- 改动前 npm test 实测 148 项通过，0 失败、0 跳过。全量日志保存在 D:/Temp/pi-documents-20261120-zX0t3A/baseline-test.log。

### 缺失

- PDF/DOCX 文本提取、页码和来源摘要。
- 文档解析的超时、输入与输出限制及明确错误。
- Agent 生成可审核文本产物、绑定实际读取来源、用户确认落盘、持久化与异常恢复。
- 对应桌面来源展示、产物预览和创建确认。

## 改动与接入方式

### 文档读取

新增 DocumentReader，使用固定版本 pdfjs-dist 与 mammoth 的文本提取接口。可信解析代码在 Worker thread 内执行，设置解析超时与 V8 堆限制。Worker thread 负责资源与故障隔离，普通插件继续使用原有 AppContainer Worker。文档内容以 Buffer 传入解析器，DOCX 只提取正文文本，PDF 禁用 eval、外部字体加载和渲染。输入限制为 20 MiB，单次输出最多 60000 个字符。PDF 每次最多读取 20 页，并返回总页数、页码及截断标记。扫描 PDF 无可提取文本时返回明确状态。DOCX 在解析前检查 ZIP 目录的条目数与声明解压体积。

workspace_read_document 接入 Pi，只接受工作区内相对路径，支持 .pdf、.docx、.txt、.md。沿用 workspace_read 的行为。来源只在实际读取成功后记录，包含相对路径、格式、SHA-256 与页码。

### 文本产物

新增 WorkspaceArtifacts，使用独立 SQLite 表保存产物文本、相对路径、哈希、来源和状态。现有目录授权只读，因此 Pi 的 workspace_prepare_text 仅准备产物。用户在桌面查看后，以 artifacts.create 的 confirm=true 对具体 id 与哈希授予一次创建权限。Agent 无法调用创建 RPC。目标只支持 .txt/.md，最大 256 KiB，父目录必须已存在。

状态按 pending → writing → created 迁移，失败保存 reasonCode。创建前重新核验当前授权目录身份及记录的目录身份，固定 Windows 目录句柄，使用独占新建 wx 并 fsync。同名文件报错。审批使用数据库条件更新，避免并发重复执行。启动时对 writing 状态检查目标的实际内容哈希，确认匹配后标为 created，其他结果进入 needs_attention，恢复过程保持只读。

### 桌面与来源

新增 ArtifactPanel，提供持久化产物列表、文本和来源预览、确认创建、状态及错误原因。会话展示本轮读取的来源和页码。无授权时工具不向 Pi 暴露。工作区改变时清空模型 transcript，保留 UI 历史。日志只保存白名单状态、格式和诊断 ID，正文与路径保存在业务数据中。

## 文件安排

- src/runtime/document-reader.mjs 和 document-parser.mjs 负责解析边界与可信解析代码。
- src/runtime/windows-workspace.mjs 和 workspace.mjs 负责固定路径及有界读写。
- src/runtime/workspace-artifacts.mjs 负责持久化、确认、创建和恢复。
- src/runtime/pi-tools.mjs、pi-agent.mjs 和 src/runtime.mjs 接入真实 Pi 与 RPC。
- src/ui/ArtifactPanel.tsx、main.tsx 和 styles.css 负责审核及来源呈现。
- test/document-reader.test.mjs、workspace-artifacts.test.mjs、document-workflow.test.mjs 和真实 Electron fixture 提供离线证据。

## 推进顺序

1. C1 完成授权目录的有界读取和独占新建，验证路径攻击及目录替换。
2. C2 接通 TXT/Markdown、PDF、DOCX 解析和来源。
3. C3 实现产物持久化、确认、创建、并发保护和恢复。
4. C4 接入 Pi 工具、Runtime RPC、工作区上下文与日志。
5. C5 完成桌面审核入口、来源展示和错误状态。
6. A1–A4 运行离线端到端、Electron DOM、全量测试、构建和独立审查，逐项保存证据。

## 风险与后续范围

- PDF/DOCX 为文本提取，图片理解、OCR、版式与表格保真属于后续切片。
- Worker thread 的 V8 堆限制无法等同操作系统总内存上限。输入、ZIP 声明体积、页数、文本长度和时间共同限制解析规模。
- 新建文件确认覆盖具体路径与内容，已有文件更新审批后续实现。
- 离线 SSE fixture 用来验证真实 Pi 工具循环，真实付费模型的自主规划质量仍需后续验证。
- 本轮人工验收暂缓，保留步骤与预期结果，独立记录自动测试结果。

## 离线与人工验收

自动验证覆盖真实文件样例、越界路径、链接、超限、损坏与扫描 PDF、DOCX、产物确认、并发、重启、目录更换、日志脱敏和本地 SSE 驱动的 Pi 完整流程。Electron 隐藏窗口使用生产 preload 和构建页面，通过 executeJavaScript 进行 DOM 操作。

人工路径为 npm run build 后 npm start，选择工作区，要求 Agent 阅读资料并准备 summary.md，在产物面板检查内容与来源，确认创建，检查实际文件及重启后状态。当前按用户要求暂缓执行。

Runtime 日志位于界面显示的 runtime/logs/runtime.jsonl，业务数据位于 runtime/agent.sqlite。本轮自动化日志目录为 D:/Temp/pi-documents-20261120-zX0t3A。

## 桌面交互验收补充

文件产物放在对话工作区下方，默认折叠列表，按需打开正文预览，保持自然语言输入的主操作地位。每次确认显示完整目标目录、相对文件名、完整正文和实际来源，勾选只覆盖当前 id、哈希与工作区。切换产物、授权变化和操作后重置确认。界面提供加载、连接失败、重试、同名冲突和结果未知的可操作反馈。使用原生按钮与折叠控件，保持可见键盘焦点、文本对比与小窗口可读性。通过 Electron DOM 和键盘事件验证，人工审美验收本轮暂缓。
