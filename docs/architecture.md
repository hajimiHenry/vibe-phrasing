# 架构说明

这个项目的核心目标是让人和 AI 在同一张图片、同一个编辑状态上协作。Electron 窗口负责人工编辑和预览，MCP server 负责让 Codex / Claude Code 这类客户端用工具控制同一套编辑状态。

## 进程结构

```text
Electron Renderer  ┐
Electron Main      ├─ 本地 HTTP 图像服务：127.0.0.1:43110
MCP Server         ┘
```

- Electron Renderer：画布、裁切框、画笔、参数面板。
- Electron Main：打开/保存文件对话框，并确保本地 HTTP 服务存在。
- HTTP 图像服务：唯一事实源，持有图片 session、蒙版、调色参数和导出逻辑。
- MCP Server：不持有图片状态，只把 MCP 工具调用转发到本地 HTTP 服务。

## 共享 Session

图片导入后会创建一个 session，并自动成为 active session。大部分 MCP 工具的 `session_id` 可以省略；省略时会操作当前 active session。

每个 session 包含：

- 原始 JPEG 路径和解码后的 RGBA 像素。
- 当前裁切矩形。
- 全局调色参数。
- mask 图层列表。
- 每个 mask 的灰度 alpha 数据、可见性、不透明度、羽化和局部调色参数。
- `revision` 版本号。

每次裁切、画 mask、删除 mask 或调色都会递增 `revision`。Electron Renderer 每秒轮询 active session；如果 `revision` 变化，就重新取预览并刷新画布。这就是 AI 编辑能同步显示在窗口里的机制。

## 渲染管线

图像引擎目前是 JPEG-first：

1. 用 Sharp 解码 JPEG，统一转为 RGBA。
2. 预览时根据裁切区域和 `max_size` 生成缩放后的输出画布。
3. 先应用全局调色。
4. 对每个可见 mask 生成与预览同尺寸的 alpha 图。
5. 在 mask alpha 范围内混合局部调色结果。
6. 预览输出 JPEG，导出输出全尺寸 JPEG。

红色蒙版显示不是最终图像的一部分。它由单独的 overlay 接口输出 PNG，Electron 只在画布上叠加显示。

## MCP 工具边界

MCP 工具偏向“AI 可稳定调用”的结构化操作：

- 打开图片：`open_image`
- 读取状态：`get_session_state`
- 切换 active session：`activate_session`
- 裁切：`apply_crop`
- 蒙版管理：`create_mask_layer`、`delete_mask_layer`、`set_mask_layer_options`
- 程序化画 mask：`paint_mask_stroke`
- 调色：`apply_adjustments`
- 预览/导出：`render_preview`、`export_jpeg`

自然语言理解不在本项目内部做。Codex / Claude Code 负责把“让人物更暖一点”“降低背景饱和度”翻译成这些 MCP 工具调用。

## 当前限制

- 只支持 JPEG 输入。
- session 只在内存中，服务重启后会丢失。
- 调色模型是 MVP 级近似，不是专业 RAW 色彩管线。
- 语义分割还没有接入真实 provider。
- mask 的程序化绘制目前是坐标笔触，不是文本语义分割。

## 后续扩展点

- RAW：新增 image IO adapter，保持 session/mask/adjustment 模型不变。
- 语义分割：新增 provider，把文本区域描述转成 mask alpha。
- 持久化：把 session edit stack 保存成项目文件。
- 更高质量色彩：把当前 RGB 近似调色替换成更专业的颜色空间/曲线管线。
- 双向实时同步：把轮询替换成 WebSocket 或 Server-Sent Events。
