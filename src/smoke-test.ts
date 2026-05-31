import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { ImageEngine } from "./engine/image-engine.js";

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vibe-image-editor-"));
const inputPath = path.join(tempDir, "input.jpg");
const outputPath = path.join(tempDir, "output.jpg");

await sharp({
  create: {
    width: 320,
    height: 220,
    channels: 3,
    background: { r: 110, g: 145, b: 175 }
  }
})
  .composite([
    {
      input: Buffer.from(
        `<svg width="320" height="220">
          <rect x="0" y="130" width="320" height="90" fill="rgb(70,95,62)"/>
          <circle cx="170" cy="105" r="48" fill="rgb(210,160,120)"/>
        </svg>`
      )
    }
  ])
  .jpeg()
  .toFile(inputPath);

const engine = new ImageEngine();
const session = await engine.openImage(inputPath);
let state = engine.createMaskLayer(session.id, "Subject");
const maskId = state.masks[0]!.id;
state = engine.paintMaskStroke(session.id, maskId, {
  points: [
    { x: 170, y: 105 },
    { x: 172, y: 106 }
  ],
  brushSize: 96,
  opacity: 1,
  mode: "add"
});
state = engine.applyAdjustments(session.id, { type: "global" }, { exposure: 0.2 });
state = engine.applyAdjustments(
  session.id,
  { type: "mask", maskId },
  { temperature: 25, saturation: 12 }
);
state = engine.applyCrop(session.id, {
  x: 20,
  y: 20,
  width: 260,
  height: 170,
  feather: 0
});
const preview = await engine.renderPreview(session.id, 200);
await engine.exportJpeg(session.id, outputPath, 88);
const exported = await sharp(outputPath).metadata();

console.log(
  JSON.stringify(
    {
      session: state.id,
      previewBytes: preview.length,
      outputPath,
      exported: {
        width: exported.width,
        height: exported.height,
        format: exported.format
      }
    },
    null,
    2
  )
);
