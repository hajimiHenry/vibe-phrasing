import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import {
  applyAdjustmentsToRgb,
  DEFAULT_ADJUSTMENTS,
  mergeAdjustments
} from "./adjustments.js";
import type {
  AdjustmentPatch,
  AdjustmentTarget,
  CropRect,
  MaskLayerState,
  PaintStroke,
  SessionState
} from "../types.js";

type InternalMaskLayer = MaskLayerState & {
  mask: Uint8Array;
};

type InternalSession = {
  id: string;
  revision: number;
  sourcePath: string;
  width: number;
  height: number;
  sourceRgba: Uint8Array;
  crop: CropRect | null;
  globalAdjustments: typeof DEFAULT_ADJUSTMENTS;
  masks: InternalMaskLayer[];
};

export class ImageEngine {
  private sessions = new Map<string, InternalSession>();
  private activeSessionId: string | null = null;

  async openImage(sourcePath: string): Promise<SessionState> {
    const resolved = path.resolve(sourcePath);
    await fs.access(resolved);

    const image = sharp(resolved, { failOn: "none" }).rotate().ensureAlpha();
    const { data, info } = await image
      .raw()
      .toBuffer({ resolveWithObject: true });

    if (info.channels !== 4) {
      throw new Error("Expected an RGBA decoded image.");
    }

    const session: InternalSession = {
      id: randomUUID(),
      revision: 1,
      sourcePath: resolved,
      width: info.width,
      height: info.height,
      sourceRgba: new Uint8Array(data),
      crop: null,
      globalAdjustments: { ...DEFAULT_ADJUSTMENTS },
      masks: []
    };

    this.sessions.set(session.id, session);
    this.activeSessionId = session.id;
    return this.toPublicState(session);
  }

  getSessionState(sessionId: string): SessionState {
    return this.toPublicState(this.requireSession(sessionId));
  }

  getActiveSessionState(): SessionState | null {
    if (!this.activeSessionId) {
      return null;
    }
    return this.toPublicState(this.requireSession(this.activeSessionId));
  }

  activateSession(sessionId: string): SessionState {
    const session = this.requireSession(sessionId);
    this.activeSessionId = session.id;
    return this.toPublicState(session);
  }

  applyCrop(sessionId: string, rect: CropRect | null): SessionState {
    const session = this.requireSession(sessionId);
    if (rect === null) {
      session.crop = null;
      this.markUpdated(session);
      return this.toPublicState(session);
    }

    const x = clampInt(rect.x, 0, session.width - 1);
    const y = clampInt(rect.y, 0, session.height - 1);
    const width = clampInt(rect.width, 1, session.width - x);
    const height = clampInt(rect.height, 1, session.height - y);
    session.crop = {
      x,
      y,
      width,
      height,
      feather: clampNumber(rect.feather, 0, 200)
    };
    this.markUpdated(session);
    return this.toPublicState(session);
  }

  createMaskLayer(sessionId: string, name: string): SessionState {
    const session = this.requireSession(sessionId);
    const layer: InternalMaskLayer = {
      id: randomUUID(),
      name: name.trim() || `Mask ${session.masks.length + 1}`,
      visible: true,
      opacity: 1,
      feather: 8,
      adjustments: { ...DEFAULT_ADJUSTMENTS },
      mask: new Uint8Array(session.width * session.height)
    };
    session.masks.push(layer);
    this.markUpdated(session);
    return this.toPublicState(session);
  }

  setMaskLayerOptions(
    sessionId: string,
    maskId: string,
    options: Partial<Pick<MaskLayerState, "name" | "visible" | "opacity" | "feather">>
  ): SessionState {
    const session = this.requireSession(sessionId);
    const layer = this.requireMask(sessionId, maskId);
    if (options.name !== undefined) {
      layer.name = options.name.trim() || layer.name;
    }
    if (options.visible !== undefined) {
      layer.visible = options.visible;
    }
    if (options.opacity !== undefined) {
      layer.opacity = clampNumber(options.opacity, 0, 1);
    }
    if (options.feather !== undefined) {
      layer.feather = clampNumber(options.feather, 0, 80);
    }
    this.markUpdated(session);
    return this.toPublicState(session);
  }

  paintMaskStroke(
    sessionId: string,
    maskId: string,
    stroke: PaintStroke
  ): SessionState {
    const session = this.requireSession(sessionId);
    const layer = this.requireMask(sessionId, maskId);
    if (stroke.points.length === 0) {
      return this.toPublicState(session);
    }

    const radius = Math.max(1, stroke.brushSize / 2);
    const opacity = clampNumber(stroke.opacity, 0, 1);
    for (let i = 0; i < stroke.points.length; i += 1) {
      const current = stroke.points[i]!;
      const previous = stroke.points[Math.max(0, i - 1)]!;
      this.paintLine(session, layer, previous, current, radius, opacity, stroke.mode);
    }
    this.markUpdated(session);
    return this.toPublicState(session);
  }

  applyAdjustments(
    sessionId: string,
    target: AdjustmentTarget,
    patch: AdjustmentPatch
  ): SessionState {
    const session = this.requireSession(sessionId);
    if (target.type === "global") {
      session.globalAdjustments = mergeAdjustments(session.globalAdjustments, patch);
      this.markUpdated(session);
      return this.toPublicState(session);
    }

    const layer = this.requireMask(sessionId, target.maskId);
    layer.adjustments = mergeAdjustments(layer.adjustments, patch);
    this.markUpdated(session);
    return this.toPublicState(session);
  }

  async renderPreview(sessionId: string, maxSize = 1400): Promise<Buffer> {
    const session = this.requireSession(sessionId);
    const rendered = await this.render(session, maxSize);
    return sharp(rendered.data, {
      raw: {
        width: rendered.width,
        height: rendered.height,
        channels: 4
      }
    })
      .jpeg({ quality: 86, mozjpeg: true })
      .toBuffer();
  }

  async exportJpeg(
    sessionId: string,
    outputPath: string,
    quality = 92
  ): Promise<{ outputPath: string; width: number; height: number }> {
    const session = this.requireSession(sessionId);
    const rendered = await this.render(session, Number.POSITIVE_INFINITY);
    const resolved = path.resolve(outputPath);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await sharp(rendered.data, {
      raw: {
        width: rendered.width,
        height: rendered.height,
        channels: 4
      }
    })
      .jpeg({ quality: clampInt(quality, 1, 100), mozjpeg: true })
      .toFile(resolved);
    return { outputPath: resolved, width: rendered.width, height: rendered.height };
  }

  private async render(
    session: InternalSession,
    maxSize: number
  ): Promise<{ data: Uint8Array; width: number; height: number }> {
    const crop = session.crop ?? {
      x: 0,
      y: 0,
      width: session.width,
      height: session.height,
      feather: 0
    };
    const scale =
      Number.isFinite(maxSize) && Math.max(crop.width, crop.height) > maxSize
        ? maxSize / Math.max(crop.width, crop.height)
        : 1;
    const outWidth = Math.max(1, Math.round(crop.width * scale));
    const outHeight = Math.max(1, Math.round(crop.height * scale));
    const output = new Uint8Array(outWidth * outHeight * 4);
    const masks = await Promise.all(
      session.masks.map(async (layer) => ({
        layer,
        alpha: layer.visible
          ? await this.renderMaskForView(session, layer, crop, outWidth, outHeight)
          : null
      }))
    );

    for (let y = 0; y < outHeight; y += 1) {
      const sourceY = clampInt(
        Math.floor(crop.y + (y / outHeight) * crop.height),
        0,
        session.height - 1
      );
      for (let x = 0; x < outWidth; x += 1) {
        const sourceX = clampInt(
          Math.floor(crop.x + (x / outWidth) * crop.width),
          0,
          session.width - 1
        );
        const sourceIndex = (sourceY * session.width + sourceX) * 4;
        let r = session.sourceRgba[sourceIndex]!;
        let g = session.sourceRgba[sourceIndex + 1]!;
        let b = session.sourceRgba[sourceIndex + 2]!;

        [r, g, b] = applyAdjustmentsToRgb(r, g, b, session.globalAdjustments);

        const maskIndex = y * outWidth + x;
        for (const { layer, alpha } of masks) {
          if (!alpha) {
            continue;
          }
          const amount = (alpha[maskIndex]! / 255) * layer.opacity;
          if (amount <= 0) {
            continue;
          }
          const [lr, lg, lb] = applyAdjustmentsToRgb(r, g, b, layer.adjustments);
          r = blend(r, lr, amount);
          g = blend(g, lg, amount);
          b = blend(b, lb, amount);
        }

        const outputIndex = maskIndex * 4;
        output[outputIndex] = r;
        output[outputIndex + 1] = g;
        output[outputIndex + 2] = b;
        output[outputIndex + 3] = 255;
      }
    }

    return { data: output, width: outWidth, height: outHeight };
  }

  private async renderMaskForView(
    session: InternalSession,
    layer: InternalMaskLayer,
    crop: CropRect,
    outWidth: number,
    outHeight: number
  ): Promise<Uint8Array> {
    let pipeline = sharp(layer.mask, {
      raw: { width: session.width, height: session.height, channels: 1 }
    });
    if (layer.feather > 0) {
      pipeline = pipeline.blur(layer.feather);
    }
    const data = await pipeline
      .extract({
        left: crop.x,
        top: crop.y,
        width: crop.width,
        height: crop.height
      })
      .resize(outWidth, outHeight, { kernel: "linear" })
      .raw()
      .toBuffer();
    return new Uint8Array(data);
  }

  private paintLine(
    session: InternalSession,
    layer: InternalMaskLayer,
    from: { x: number; y: number },
    to: { x: number; y: number },
    radius: number,
    opacity: number,
    mode: "add" | "erase"
  ): void {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / Math.max(1, radius / 2)));
    for (let step = 0; step <= steps; step += 1) {
      const t = step / steps;
      this.paintCircle(
        session,
        layer,
        from.x + dx * t,
        from.y + dy * t,
        radius,
        opacity,
        mode
      );
    }
  }

  private paintCircle(
    session: InternalSession,
    layer: InternalMaskLayer,
    cx: number,
    cy: number,
    radius: number,
    opacity: number,
    mode: "add" | "erase"
  ): void {
    const minX = clampInt(Math.floor(cx - radius), 0, session.width - 1);
    const maxX = clampInt(Math.ceil(cx + radius), 0, session.width - 1);
    const minY = clampInt(Math.floor(cy - radius), 0, session.height - 1);
    const maxY = clampInt(Math.ceil(cy + radius), 0, session.height - 1);
    const radiusSquared = radius * radius;
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const distanceSquared = (x - cx) * (x - cx) + (y - cy) * (y - cy);
        if (distanceSquared > radiusSquared) {
          continue;
        }
        const falloff = 1 - Math.sqrt(distanceSquared) / radius;
        const amount = opacity * (0.35 + falloff * 0.65);
        const index = y * session.width + x;
        const current = layer.mask[index]!;
        layer.mask[index] =
          mode === "add"
            ? Math.max(current, Math.round(255 * amount))
            : Math.max(0, Math.round(current * (1 - amount)));
      }
    }
  }

  private requireSession(sessionId: string): InternalSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    return session;
  }

  private requireMask(sessionId: string, maskId: string): InternalMaskLayer {
    const session = this.requireSession(sessionId);
    const layer = session.masks.find((mask) => mask.id === maskId);
    if (!layer) {
      throw new Error(`Unknown mask layer: ${maskId}`);
    }
    return layer;
  }

  private toPublicState(session: InternalSession): SessionState {
    return {
      id: session.id,
      revision: session.revision,
      sourcePath: session.sourcePath,
      width: session.width,
      height: session.height,
      crop: session.crop,
      globalAdjustments: { ...session.globalAdjustments },
      masks: session.masks.map(({ mask: _mask, ...layer }) => ({
        ...layer,
        adjustments: { ...layer.adjustments }
      }))
    };
  }

  private markUpdated(session: InternalSession): void {
    session.revision += 1;
    this.activeSessionId = session.id;
  }
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

function clampInt(value: number, min: number, max: number): number {
  return Math.round(clampNumber(value, min, max));
}

function blend(base: number, overlay: number, amount: number): number {
  return Math.round(base * (1 - amount) + overlay * amount);
}
