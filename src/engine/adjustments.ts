import type { AdjustmentParams, AdjustmentPatch } from "../types.js";

export const DEFAULT_ADJUSTMENTS: AdjustmentParams = {
  exposure: 0,
  contrast: 0,
  saturation: 0,
  temperature: 0,
  tint: 0,
  highlights: 0,
  shadows: 0,
  blacks: 0,
  whites: 0
};

export function mergeAdjustments(
  base: AdjustmentParams,
  patch: AdjustmentPatch
): AdjustmentParams {
  return {
    exposure: clampNumber(patch.exposure ?? base.exposure, -3, 3),
    contrast: clampNumber(patch.contrast ?? base.contrast, -100, 100),
    saturation: clampNumber(patch.saturation ?? base.saturation, -100, 100),
    temperature: clampNumber(patch.temperature ?? base.temperature, -100, 100),
    tint: clampNumber(patch.tint ?? base.tint, -100, 100),
    highlights: clampNumber(patch.highlights ?? base.highlights, -100, 100),
    shadows: clampNumber(patch.shadows ?? base.shadows, -100, 100),
    blacks: clampNumber(patch.blacks ?? base.blacks, -100, 100),
    whites: clampNumber(patch.whites ?? base.whites, -100, 100)
  };
}

export function applyAdjustmentsToRgb(
  r: number,
  g: number,
  b: number,
  params: AdjustmentParams
): [number, number, number] {
  // MVP 阶段的 RGB 调色模型。保持参数化和确定性，方便 AI 修改后回看、微调和撤换。
  let nr = r / 255;
  let ng = g / 255;
  let nb = b / 255;

  const exposureFactor = Math.pow(2, params.exposure);
  nr *= exposureFactor;
  ng *= exposureFactor;
  nb *= exposureFactor;

  const luminance = 0.2126 * nr + 0.7152 * ng + 0.0722 * nb;
  const shadowWeight = clamp01((0.55 - luminance) / 0.55);
  const highlightWeight = clamp01((luminance - 0.45) / 0.55);

  nr += (params.shadows / 100) * 0.35 * shadowWeight;
  ng += (params.shadows / 100) * 0.35 * shadowWeight;
  nb += (params.shadows / 100) * 0.35 * shadowWeight;

  nr += (params.highlights / 100) * 0.35 * highlightWeight;
  ng += (params.highlights / 100) * 0.35 * highlightWeight;
  nb += (params.highlights / 100) * 0.35 * highlightWeight;

  nr += (params.blacks / 100) * 0.18 * (1 - luminance);
  ng += (params.blacks / 100) * 0.18 * (1 - luminance);
  nb += (params.blacks / 100) * 0.18 * (1 - luminance);

  nr += (params.whites / 100) * 0.18 * luminance;
  ng += (params.whites / 100) * 0.18 * luminance;
  nb += (params.whites / 100) * 0.18 * luminance;

  const contrastFactor =
    (259 * (params.contrast + 255)) / (255 * (259 - params.contrast));
  nr = contrastFactor * (nr - 0.5) + 0.5;
  ng = contrastFactor * (ng - 0.5) + 0.5;
  nb = contrastFactor * (nb - 0.5) + 0.5;

  const temp = params.temperature / 100;
  const tint = params.tint / 100;
  nr *= 1 + temp * 0.12;
  nb *= 1 - temp * 0.12;
  ng *= 1 + tint * 0.08;
  nr *= 1 - tint * 0.04;
  nb *= 1 - tint * 0.04;

  const sat = 1 + params.saturation / 100;
  const gray = 0.2126 * nr + 0.7152 * ng + 0.0722 * nb;
  nr = gray + (nr - gray) * sat;
  ng = gray + (ng - gray) * sat;
  nb = gray + (nb - gray) * sat;

  return [toByte(nr * 255), toByte(ng * 255), toByte(nb * 255)];
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function toByte(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value)));
}
