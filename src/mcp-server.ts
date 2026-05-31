import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const apiBase = process.env.VIBE_IMAGE_EDITOR_API ?? "http://127.0.0.1:43110";

const adjustmentPatchSchema = {
  exposure: z.number().min(-3).max(3).optional(),
  contrast: z.number().min(-100).max(100).optional(),
  saturation: z.number().min(-100).max(100).optional(),
  temperature: z.number().min(-100).max(100).optional(),
  tint: z.number().min(-100).max(100).optional(),
  highlights: z.number().min(-100).max(100).optional(),
  shadows: z.number().min(-100).max(100).optional(),
  blacks: z.number().min(-100).max(100).optional(),
  whites: z.number().min(-100).max(100).optional()
};

const server = new McpServer({
  name: "vibe-phrasing-image-editor",
  version: "0.2.0"
});

server.tool(
  "open_image",
  "Open a local JPEG in the shared editor session. The Electron UI will see this session after polling.",
  { path: z.string().min(1) },
  async ({ path: imagePath }) => text(await apiPost("/sessions/open", { path: imagePath }))
);

server.tool(
  "get_session_state",
  "Return the active shared edit session, or a specific session if session_id is provided.",
  { session_id: z.string().min(1).optional() },
  async ({ session_id }) => text(await apiGet(session_id ? `/sessions/${session_id}` : "/sessions/active"))
);

server.tool(
  "activate_session",
  "Make an existing session the active shared session.",
  { session_id: z.string().min(1) },
  async ({ session_id }) => text(await apiPost(`/sessions/${session_id}/activate`, {}))
);

server.tool(
  "apply_crop",
  "Set or clear the crop rectangle on the active shared session unless session_id is provided.",
  {
    session_id: z.string().min(1).optional(),
    rect: z
      .object({
        x: z.number(),
        y: z.number(),
        width: z.number(),
        height: z.number(),
        feather: z.number().default(0)
      })
      .nullable()
  },
  async ({ session_id, rect }) => {
    const sessionId = await resolveSessionId(session_id);
    return text(await apiPost(`/sessions/${sessionId}/crop`, { rect }));
  }
);

server.tool(
  "create_mask_layer",
  "Create an empty mask layer on the active shared session. The human can paint it in Electron.",
  {
    session_id: z.string().min(1).optional(),
    name: z.string().default("Mask")
  },
  async ({ session_id, name }) => {
    const sessionId = await resolveSessionId(session_id);
    return text(await apiPost(`/sessions/${sessionId}/masks`, { name }));
  }
);

server.tool(
  "set_mask_layer_options",
  "Update mask layer metadata such as visibility, opacity, feather, or name.",
  {
    session_id: z.string().min(1).optional(),
    mask_id: z.string().min(1),
    name: z.string().optional(),
    visible: z.boolean().optional(),
    opacity: z.number().min(0).max(1).optional(),
    feather: z.number().min(0).max(80).optional()
  },
  async ({ session_id, mask_id, ...options }) => {
    const sessionId = await resolveSessionId(session_id);
    return text(await apiPost(`/sessions/${sessionId}/masks/${mask_id}/options`, options));
  }
);

server.tool(
  "paint_mask_stroke",
  "Programmatically paint or erase a stroke on a mask layer using image coordinates.",
  {
    session_id: z.string().min(1).optional(),
    mask_id: z.string().min(1),
    points: z.array(z.object({ x: z.number(), y: z.number() })).min(1),
    brushSize: z.number().min(1).max(400).default(80),
    opacity: z.number().min(0).max(1).default(0.8),
    mode: z.enum(["add", "erase"]).default("add")
  },
  async ({ session_id, mask_id, points, brushSize, opacity, mode }) => {
    const sessionId = await resolveSessionId(session_id);
    return text(
      await apiPost(`/sessions/${sessionId}/masks/${mask_id}/stroke`, {
        points,
        brushSize,
        opacity,
        mode
      })
    );
  }
);

server.tool(
  "apply_adjustments",
  "Apply a parameterized adjustment diff to the active shared session unless session_id is provided.",
  {
    session_id: z.string().min(1).optional(),
    target: z.discriminatedUnion("type", [
      z.object({ type: z.literal("global") }),
      z.object({ type: z.literal("mask"), maskId: z.string().min(1) })
    ]),
    params: z.object(adjustmentPatchSchema).strict()
  },
  async ({ session_id, target, params }) => {
    const sessionId = await resolveSessionId(session_id);
    return text(await apiPost(`/sessions/${sessionId}/adjustments`, { target, params }));
  }
);

server.tool(
  "render_preview",
  "Render the active shared edit stack to a JPEG preview file and return the file path.",
  {
    session_id: z.string().min(1).optional(),
    output_path: z.string().optional(),
    max_size: z.number().min(100).max(3000).default(1400)
  },
  async ({ session_id, output_path, max_size }) => {
    const sessionId = await resolveSessionId(session_id);
    const buffer = await apiGetBuffer(`/sessions/${sessionId}/preview?max=${max_size}`);
    const previewPath =
      output_path ??
      path.join(os.tmpdir(), `vibe-preview-${sessionId.slice(0, 8)}.jpg`);
    await fs.mkdir(path.dirname(previewPath), { recursive: true });
    await fs.writeFile(previewPath, buffer);
    return text({ outputPath: previewPath });
  }
);

server.tool(
  "export_jpeg",
  "Export the active shared edit stack as a JPEG file unless session_id is provided.",
  {
    session_id: z.string().min(1).optional(),
    output_path: z.string().min(1),
    quality: z.number().min(1).max(100).default(92)
  },
  async ({ session_id, output_path, quality }) => {
    const sessionId = await resolveSessionId(session_id);
    return text(await apiPost(`/sessions/${sessionId}/export`, { outputPath: output_path, quality }));
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);

async function resolveSessionId(sessionId: string | undefined): Promise<string> {
  if (sessionId) {
    return sessionId;
  }
  const active = await apiGet<{ id: string }>("/sessions/active");
  return active.id;
}

async function apiGet<T = unknown>(route: string): Promise<T> {
  const response = await fetch(`${apiBase}${route}`);
  return parseJsonResponse<T>(response);
}

async function apiPost<T = unknown>(route: string, body: unknown): Promise<T> {
  const response = await fetch(`${apiBase}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return parseJsonResponse<T>(response);
}

async function apiGetBuffer(route: string): Promise<Buffer> {
  const response = await fetch(`${apiBase}${route}`);
  if (!response.ok) {
    throw new Error(await responseError(response));
  }
  return Buffer.from(await response.arrayBuffer());
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(await responseError(response));
  }
  return (await response.json()) as T;
}

async function responseError(response: Response): Promise<string> {
  let detail = await response.text();
  try {
    const parsed = JSON.parse(detail) as { error?: string };
    detail = parsed.error ?? detail;
  } catch {
    // Keep the raw response body.
  }
  return `${detail || response.statusText}. Start the Electron editor with npm run dev so the shared local image service is running at ${apiBase}.`;
}

function text(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}
