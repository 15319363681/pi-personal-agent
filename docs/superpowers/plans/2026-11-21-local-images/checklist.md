# 本地图片实施与验收清单

依据 design.md 顺序实现。

## 代码层

- [x] I1 图片有界读取、实际格式校验、像素限制、可信 Worker 解码及规范化输出。文件为 src/runtime/image-reader.mjs、image-parser.mjs、test/image-reader.test.mjs，6 项通过。
- [x] I2 真实 Pi 图片工具受目录与模型能力控制，来源可核对并用于产物。
- [x] I3 模型能力与上下文隔离、transcript 图片占位、桌面来源尺寸与首帧提示。

## 验收层

- [x] T1 正常图片、损坏、超限、伪装、授权变化、能力关闭、实际 Pi 多模态协议及重启回归。
- [x] T2 全量测试 207 项通过，类型检查、构建与差异检查通过。证据为 full-test-final.log、typecheck.log、build.log。
- [x] T3 独立 Codex 逐项 PASS，最多三轮。

I2 文件为 src/runtime/pi-tools.mjs、test/image-tools.test.mjs。I3 文件为 src/runtime/pi-agent.mjs、src/runtime.mjs、src/ui/DocumentSources.tsx、test/image-workflow.test.mjs、fixtures/document-ui-electron.cjs。T1 的图片专项和真实 Electron 共 13 项通过，证据为 electron-and-image.log。

## 未完成与存疑

用户人工验收本轮暂缓。真实服务视觉识别质量后续验证。

独立审查报告位于 D:/Temp/pi-images-20261121-8Ii9S4/review-joint-report.md。文档第二轮 C1–C5、A1–A4 全部 PASS，图片第一轮 I1–I3、T1–T3 全部 PASS。
