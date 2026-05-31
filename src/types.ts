export type AdjustmentParams = {
  exposure: number;
  contrast: number;
  saturation: number;
  temperature: number;
  tint: number;
  highlights: number;
  shadows: number;
  blacks: number;
  whites: number;
};

export type AdjustmentPatch = Partial<AdjustmentParams>;

export type CropRect = {
  x: number;
  y: number;
  width: number;
  height: number;
  feather: number;
};

export type MaskLayerState = {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  feather: number;
  adjustments: AdjustmentParams;
};

export type SessionState = {
  id: string;
  revision: number;
  sourcePath: string;
  width: number;
  height: number;
  crop: CropRect | null;
  globalAdjustments: AdjustmentParams;
  masks: MaskLayerState[];
};

export type AdjustmentTarget =
  | { type: "global" }
  | { type: "mask"; maskId: string };

export type PaintPoint = {
  x: number;
  y: number;
};

export type PaintStroke = {
  points: PaintPoint[];
  brushSize: number;
  opacity: number;
  mode: "add" | "erase";
};
