# 本地图片资料设计

日期为 2026-11-21。接续本地文档与多模型切片，覆盖授权目录内常见图片理解与来源。

## 调研

可复用 WorkspaceAdmission 的有界读取与 Windows 目录固定、Pi 工具结果的 image content、ModelSettings 的 supportsImages 字段，以及 DocumentSources 与文本产物的来源绑定。

当前 Pi 模型输入固定为 text，缺少图片解码和图片工具，无法把实际像素提交给兼容服务。已安装 Pi 的类型定义支持 ImageContent。文档解析已有可信 Worker 的超时与 V8 资源隔离模式。

## 实现与接入

I1 新增 ImageReader 与可信解码 Worker，固定 sharp 版本 0.35.5。输入仅接受 JPEG/PNG/WebP/GIF 的对应扩展名与实际格式，最多 10 MiB、1600 万像素，拒绝 SVG 与未知格式。完整解码后按方向旋转，长边最多 1600，去除元数据并输出 JPEG。解码限定 10 秒，Worker 结束后 terminate，V8 堆与时间限制按现有文档模式设置。像素限制约束原生解码规模。

I2 仅在当前服务声明支持图片且目录已授权时提供 workspace_read_image。工具返回实际 image content 和原文件相对路径、SHA-256、格式、字节数、原始尺寸、提交尺寸和多帧提示。多帧 GIF 先读首帧并明确标记。图片来源并入本轮来源台账，可用于 workspace_prepare_text，未读取来源不能声明。

I3 模型 input 根据 supportsImages 包含 image。上下文指纹纳入该能力与配置 revision。持久化 transcript 用可读占位替换二进制 image content，保留工具文本元数据。后续再次观察时重新读取文件，避免长期存储 base64 或让密钥脱敏破坏二进制内容。UI 来源显示尺寸、压缩与首帧状态。

## 推进顺序

I1 图片读取与解码，I2 Pi 工具与来源，I3 持久化和桌面呈现，T1 针对性及真实 Pi 测试，T2 全量/类型/构建，T3 独立审查。

## 风险

- 图片理解依赖具体服务的视觉能力，能力开关由用户配置，错误保留真实 Provider 状态。
- 缩放可能降低小字识别精度，来源中显示实际提交尺寸。
- 可信原生解码器通过输入、像素、超时与 Worker 约束，V8 堆限制覆盖 JavaScript 堆。
- 本轮图像识别测试验证真实字节与协议，识别正确率及用户真实模型效果仍待真实服务验证。

## 验收

配置支持图片的服务并测试连接，授权包含图片的目录，请求读取图片并生成 Markdown。预期模型收到实际 JPEG 像素，来源展示原文件哈希、尺寸与转换情况，产物依照既有确认流程创建。关闭图片能力后图片工具不可用。证据目录为 D:/Temp/pi-images-20261121-8Ii9S4，运行日志沿用 UI 中显示的 runtime/logs/runtime.jsonl。
