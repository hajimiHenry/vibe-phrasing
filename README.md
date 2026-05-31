# Vibe 图像编辑器原型

这是一个 JPEG-first 的本地图像编辑原型，目标是让人和 AI 在同一张图片、同一个编辑状态上协作。

## 已实现

- 本地 Electron 编辑窗口。
- 本地 HTTP 图像编辑服务，Electron UI 和 MCP server 共用同一个 active session。
- MCP server，供 Codex / Claude Code 这类客户端通过工具调用控制图片。
- JPEG 导入、裁切、蒙版图层、画笔添加/擦除、全局/局部调色、预览渲染、JPEG 导出。
- 选中蒙版时显示类似 Lightroom 的红色半透明蒙版覆盖层。
- 调色参数是结构化对象，方便 AI 把自然语言审美描述翻译成参数 diff。

## 启动

安装依赖：

```bash
npm install
```

启动 Electron 编辑器：

```bash
npm run dev
```

只启动 MCP server：

```bash
npm run dev:mcp
```

只启动本地 HTTP API：

```bash
npm run dev:http
```

## MCP 工具

- `open_image(path)`
- `get_session_state(session_id?)`
- `activate_session(session_id)`
- `apply_crop(session_id?, rect)`
- `create_mask_layer(session_id?, name)`
- `set_mask_layer_options(session_id?, mask_id, ...)`
- `delete_mask_layer(session_id?, mask_id)`
- `paint_mask_stroke(session_id?, mask_id, points, brushSize, opacity, mode)`
- `apply_adjustments(session_id?, target, params)`
- `render_preview(session_id?, output_path?, max_size?)`
- `export_jpeg(session_id?, output_path, quality)`

大多数 MCP 工具的 `session_id` 都可以省略。省略时默认操作 Electron 当前打开的 active session。

## 开发检查

```bash
npm run typecheck
npm run smoke
npx vite build
```

## 当前边界

- 输入格式只支持 JPEG。
- session 保存在内存里，服务退出后会丢失。
- 语义分割还没有接入真实 AI provider；当前先提供蒙版图层和画笔接口。
- RAW 解码后续会作为 image IO adapter 接入，不改变现有编辑模型。
