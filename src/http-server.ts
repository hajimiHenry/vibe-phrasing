import express, { type Request, type Response } from "express";
import { z } from "zod";
import { imageEngine } from "./engine/singleton.js";

const app = express();

app.use(express.json({ limit: "10mb" }));
app.use((_request, response, next) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  next();
});
app.options(/.*/, (_request, response) => response.sendStatus(204));

const adjustmentPatchSchema = z
  .object({
    exposure: z.number().optional(),
    contrast: z.number().optional(),
    saturation: z.number().optional(),
    temperature: z.number().optional(),
    tint: z.number().optional(),
    highlights: z.number().optional(),
    shadows: z.number().optional(),
    blacks: z.number().optional(),
    whites: z.number().optional()
  })
  .strict();

const targetSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("global") }),
  z.object({ type: z.literal("mask"), maskId: z.string().min(1) })
]);

app.get("/health", (_request, response) => {
  response.json({ ok: true });
});

app.post("/sessions/open", asyncRoute(async (request, response) => {
  const body = z.object({ path: z.string().min(1) }).parse(request.body);
  response.json(await imageEngine.openImage(body.path));
}));

app.get("/sessions/active", route((_request, response) => {
  const active = imageEngine.getActiveSessionState();
  if (!active) {
    response.status(404).json({ error: "No active image session." });
    return;
  }
  response.json(active);
}));

app.get("/sessions/:sessionId", route((request, response) => {
  response.json(imageEngine.getSessionState(param(request, "sessionId")));
}));

app.post("/sessions/:sessionId/activate", route((request, response) => {
  response.json(imageEngine.activateSession(param(request, "sessionId")));
}));

app.post("/sessions/:sessionId/crop", route((request, response) => {
  const body = z
    .object({
      rect: z
        .object({
          x: z.number(),
          y: z.number(),
          width: z.number(),
          height: z.number(),
          feather: z.number().default(0)
        })
        .nullable()
    })
    .parse(request.body);
  response.json(imageEngine.applyCrop(param(request, "sessionId"), body.rect));
}));

app.post("/sessions/:sessionId/masks", route((request, response) => {
  const body = z.object({ name: z.string().default("Mask") }).parse(request.body);
  response.json(imageEngine.createMaskLayer(param(request, "sessionId"), body.name));
}));

app.post("/sessions/:sessionId/masks/:maskId/options", route((request, response) => {
  const body = z
    .object({
      name: z.string().optional(),
      visible: z.boolean().optional(),
      opacity: z.number().optional(),
      feather: z.number().optional()
    })
    .strict()
    .parse(request.body);
  response.json(
    imageEngine.setMaskLayerOptions(
      param(request, "sessionId"),
      param(request, "maskId"),
      body
    )
  );
}));

app.delete("/sessions/:sessionId/masks/:maskId", route((request, response) => {
  response.json(
    imageEngine.deleteMaskLayer(
      param(request, "sessionId"),
      param(request, "maskId")
    )
  );
}));

app.post("/sessions/:sessionId/masks/:maskId/stroke", route((request, response) => {
  const body = z
    .object({
      points: z.array(z.object({ x: z.number(), y: z.number() })).min(1),
      brushSize: z.number().min(1).max(400),
      opacity: z.number().min(0).max(1),
      mode: z.enum(["add", "erase"])
    })
    .parse(request.body);
  response.json(
    imageEngine.paintMaskStroke(
      param(request, "sessionId"),
      param(request, "maskId"),
      body
    )
  );
}));

app.post("/sessions/:sessionId/adjustments", route((request, response) => {
  const body = z
    .object({
      target: targetSchema,
      params: adjustmentPatchSchema
    })
    .parse(request.body);
  response.json(
    imageEngine.applyAdjustments(
      param(request, "sessionId"),
      body.target,
      body.params
    )
  );
}));

app.get("/sessions/:sessionId/preview", asyncRoute(async (request, response) => {
  const maxSize = Number(request.query.max ?? 1400);
  const buffer = await imageEngine.renderPreview(param(request, "sessionId"), maxSize);
  response.type("image/jpeg").send(buffer);
}));

app.get("/sessions/:sessionId/masks/:maskId/overlay", asyncRoute(async (request, response) => {
  const maxSize = Number(request.query.max ?? 1400);
  const buffer = await imageEngine.renderMaskOverlay(
    param(request, "sessionId"),
    param(request, "maskId"),
    maxSize
  );
  response.type("image/png").send(buffer);
}));

app.post("/sessions/:sessionId/export", asyncRoute(async (request, response) => {
  const body = z
    .object({
      outputPath: z.string().min(1),
      quality: z.number().min(1).max(100).default(92)
    })
    .parse(request.body);
  response.json(
    await imageEngine.exportJpeg(
      param(request, "sessionId"),
      body.outputPath,
      body.quality
    )
  );
}));

const port = parsePort(process.argv);
app.listen(port, "127.0.0.1", () => {
  console.log(`Image editor HTTP API listening at http://127.0.0.1:${port}`);
});

function parsePort(argv: string[]): number {
  const index = argv.indexOf("--port");
  if (index >= 0 && argv[index + 1]) {
    return Number(argv[index + 1]);
  }
  return Number(process.env.IMAGE_EDITOR_PORT ?? 43110);
}

function param(request: Request, key: string): string {
  const value = request.params[key];
  if (typeof value !== "string") {
    throw new Error(`Missing route parameter: ${key}`);
  }
  return value;
}

function route(handler: (request: Request, response: Response) => void) {
  return (request: Request, response: Response) => {
    try {
      handler(request, response);
    } catch (error) {
      sendError(response, error);
    }
  };
}

function asyncRoute(
  handler: (request: Request, response: Response) => Promise<void>
) {
  return async (request: Request, response: Response) => {
    try {
      await handler(request, response);
    } catch (error) {
      sendError(response, error);
    }
  };
}

function sendError(response: Response, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  response.status(400).json({ error: message });
}
