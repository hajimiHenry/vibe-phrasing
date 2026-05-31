# Vibe Image Editor Prototype

JPEG-first prototype for an MCP-driven local image editor.

## What is implemented

- Local MCP server exposing image-editing tools over stdio.
- Local HTTP API used by both the Electron UI and the MCP server.
- Shared in-memory non-destructive sessions with an active session.
- JPEG import, preview rendering, crop, mask layers, brush painting, global/local adjustments, and JPEG export.
- Adjustment parameters are structured so Claude Code, Codex, or another MCP client can translate natural language into tool calls.

## Run

Install dependencies:

```bash
npm install
```

Start the Electron editor:

```bash
npm run dev
```

Run only the MCP server:

```bash
npm run dev:mcp
```

Run only the HTTP API:

```bash
npm run dev:http
```

## MCP tools

- `open_image(path)`
- `get_session_state(session_id)`
- `apply_crop(session_id, rect)`
- `create_mask_layer(session_id, name)`
- `set_mask_layer_options(session_id, mask_id, ...)`
- `paint_mask_stroke(session_id, mask_id, points, brushSize, opacity, mode)`
- `apply_adjustments(session_id, target, params)`
- `render_preview(session_id, output_path, max_size)`
- `export_jpeg(session_id, output_path, quality)`

Most MCP tools accept an optional `session_id`. If omitted, they operate on the active image currently shared with the Electron UI.

## Development checks

```bash
npm run typecheck
npm run smoke
```

## Current boundaries

- Input is JPEG only.
- Sessions are in memory and reset when the server exits.
- Semantic segmentation is intentionally not implemented yet; the MCP/API surface leaves room for a future provider.
- The Electron UI owns manual crop and brush interaction; MCP clients own natural-language orchestration against the same shared session.
