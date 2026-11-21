# 本地资料工作流实施与验收清单

依据同目录 design.md。按下列顺序实现，完成后补充文件与实测证据。人工验收按用户 2026-11-20 指示暂缓。

## 代码层

- [x] C1 授权目录支持有界二进制读取、固定目录身份和独占新建文本，拒绝越界、链接、设备/ADS 路径及同名覆盖。
- [x] C2 TXT/Markdown、PDF、DOCX 文本提取有大小、页数、输出、超时限制，返回真实来源与明确失败状态。
- [x] C3 产物状态和内容持久化，确认绑定 id/哈希/工作区，支持并发防重及启动只读核对。
- [x] C4 接入真实 Pi 工具和 Runtime RPC，来源来自实际读取，授权改变隔离 transcript，恢复模式阻断写操作，日志默认脱敏。
- [x] C5 桌面可查看来源、预览产物、确认创建、查看状态与失败原因，加载和错误状态有效。

C1 文件包括 workspace.mjs、windows-workspace.mjs 与 workspace-files.test.mjs。c1-red.log 验证缺失行为，c1-green.log 为新增及既有权限测试 16 项通过。原目录只读授权保持有效，创建权限由后续具体产物确认授予。

C2 文件包括 document-reader.mjs、document-parser.mjs、document-reader.test.mjs 与 fixtures/document-samples.mjs。固定依赖 pdfjs-dist 6.5.438 和 mammoth 1.13.0。c2-red.log 与 c2-green.log 记录先失败后通过，5 项测试通过。

## 验收层

- [x] A1 针对性测试覆盖格式、损坏文件、资源限制、路径边界、确认、并发、重启与恢复。
- [x] A2 本地 SSE Provider 驱动真实 Pi 读取资料和准备产物，经确认后产生实际文件，来源和日志可核对。
- [x] A3 真实 Electron 构建页面与生产 preload 的 DOM 流程通过，全量测试、typecheck、build 和 diff 空白检查通过。
- [x] A4 独立 Codex 审查 design.md、checklist.md 和本轮完整 diff，逐项 PASS/FAIL，最多 3 轮，缺陷修复后回归。

## 本轮暂缓与后续项

- 人工操作验收按用户指示暂缓，步骤保留在 design.md。
- 图片/OCR、已有文件覆盖确认、更多产物格式，以及真实付费 Provider 自主规划质量属于后续范围。

C3 文件包括 workspace-artifacts.mjs 与 workspace-artifacts.test.mjs。c3-green.log 为 20 项测试通过，确认绑定内容与工作区、并发防重、同名冲突以及文件身份加哈希的启动核对。

C4 文件包括 pi-tools.mjs、pi-agent.mjs、runtime.mjs、logging.mjs 与 document-workflow.test.mjs。c4-green.log 为 44 项测试通过。补充验证关闭等待已确认写入、恢复冻结、授权改变、来源与产物凭据脱敏。

C5 文件包括 ArtifactPanel.tsx、DocumentSources.tsx、main.tsx、styles.css、document-ui.test.mjs 与 fixtures/document-ui-electron.cjs。electron-documents.log 记录真实 Electron/生产 preload/Runtime/Pi/PDF/DOCX 的动态流程，10 项场景通过。覆盖确切预览、来源页码、键盘、切换清空确认、重复提交、冲突、断连重试、重启和小窗口。

A1–A3 证据保存在 D:/Temp/pi-documents-20261120-zX0t3A。full-test-round1.log 为 175 passed、0 failed、0 skipped，46841.5684 ms。typecheck.log 与 build.log 退出 0。Electron 流程动态执行，付费 Provider 与用户人工验收仍暂缓。差异空白检查在独立审查前单独补证。

独立审查报告位于 D:/Temp/pi-images-20261121-8Ii9S4/review-joint-report.md。文档第二轮 C1–C5、A1–A4 全部 PASS，图片第一轮 I1–I3、T1–T3 全部 PASS。
