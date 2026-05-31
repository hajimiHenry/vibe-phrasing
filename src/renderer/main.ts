import "./styles.css";
import type {
  AdjustmentParams,
  AdjustmentTarget,
  CropRect,
  PaintPoint,
  SessionState
} from "../types.js";

declare global {
  interface Window {
    editorApi: {
      apiBase: string;
      openImage(): Promise<string | null>;
      saveJpeg(): Promise<string | null>;
    };
  }
}

type ToolMode = "crop" | "mask";

const app = document.querySelector<HTMLDivElement>("#app")!;
const apiBase = window.editorApi?.apiBase ?? "http://127.0.0.1:43110";

let state: SessionState | null = null;
let mode: ToolMode = "mask";
let activeMaskId: string | null = null;
let adjustmentTarget: AdjustmentTarget = { type: "global" };
let previewBitmap: ImageBitmap | null = null;
let maskOverlayBitmap: ImageBitmap | null = null;
let brushPreviewPoint: PaintPoint | null = null;
let cropStart: PaintPoint | null = null;
let cropCurrent: PaintPoint | null = null;
let painting = false;
let lastPaintPoint: PaintPoint | null = null;
let brushMode: "add" | "erase" = "add";
let brushSize = 80;
let brushOpacity = 0.85;
let showMaskOverlay = true;
let renderToken = 0;

renderShell();
window.setInterval(() => {
  void syncActiveSession();
}, 1000);

window.addEventListener("error", (event) => {
  setStatus(`错误：${event.message}`);
});

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason instanceof Error ? event.reason.message : String(event.reason);
  setStatus(`错误：${reason}`);
});

function renderShell() {
  app.innerHTML = `
    <div class="app">
      <div class="toolbar">
        <button id="open" class="button primary">打开 JPEG</button>
        <button id="export" class="button">导出</button>
        <div class="segmented" role="group">
          <button id="tool-mask" class="active">蒙版</button>
          <button id="tool-crop">裁切</button>
        </div>
        <div class="spacer"></div>
        <div id="status" class="status">未打开图片</div>
      </div>
      <main class="workspace">
        <div id="empty" class="empty">
          <div>打开一张 JPEG 开始编辑。</div>
        </div>
        <canvas id="canvas" hidden></canvas>
      </main>
      <aside id="panel" class="panel"></aside>
    </div>
  `;

  document.querySelector<HTMLButtonElement>("#open")!.addEventListener("click", openImage);
  document.querySelector<HTMLButtonElement>("#export")!.addEventListener("click", exportImage);
  document.querySelector<HTMLButtonElement>("#tool-mask")!.addEventListener("click", () => setMode("mask"));
  document.querySelector<HTMLButtonElement>("#tool-crop")!.addEventListener("click", () => setMode("crop"));

  const canvas = getCanvas();
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointerleave", onPointerLeave);
  renderPanel();
}

async function openImage() {
  try {
    if (!window.editorApi?.openImage) {
      throw new Error("Electron preload 不可用。请用 npm run dev 启动应用。");
    }
    const path = await window.editorApi.openImage();
    if (!path) {
      setStatus("已取消打开");
      return;
    }
    setStatus("正在打开图片...");
    state = await post<SessionState>("/sessions/open", { path });
    activeMaskId = state.masks[0]?.id ?? null;
    adjustmentTarget = { type: "global" };
    await refreshPreview();
    renderPanel();
    setStatus(path);
  } catch (error) {
    setStatus(`打开失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function exportImage() {
  if (!state) {
    return;
  }
  try {
    if (!window.editorApi?.saveJpeg) {
      throw new Error("Electron preload 不可用。请用 npm run dev 启动应用。");
    }
    const outputPath = await window.editorApi.saveJpeg();
    if (!outputPath) {
      setStatus("已取消导出");
      return;
    }
    setStatus("正在导出 JPEG...");
    await post(`/sessions/${state.id}/export`, { outputPath, quality: 92 });
    setStatus(`已导出：${outputPath}`);
  } catch (error) {
    setStatus(`导出失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function createMask() {
  if (!state) {
    return;
  }
  state = await post<SessionState>(`/sessions/${state.id}/masks`, {
    name: `蒙版 ${state.masks.length + 1}`
  });
  activeMaskId = state.masks.at(-1)?.id ?? null;
  adjustmentTarget = activeMaskId ? { type: "mask", maskId: activeMaskId } : { type: "global" };
  renderPanel();
}

async function deleteMask(maskId: string) {
  if (!state) {
    return;
  }
  state = await remove<SessionState>(`/sessions/${state.id}/masks/${maskId}`);
  if (activeMaskId === maskId) {
    activeMaskId = state.masks[0]?.id ?? null;
  }
  if (adjustmentTarget.type === "mask" && adjustmentTarget.maskId === maskId) {
    adjustmentTarget = activeMaskId ? { type: "mask", maskId: activeMaskId } : { type: "global" };
  }
  await refreshPreview();
  renderPanel();
}

async function refreshPreview() {
  if (!state) {
    return;
  }
  const token = ++renderToken;
  const response = await fetch(`${apiBase}/sessions/${state.id}/preview?max=1400&t=${Date.now()}`);
  if (!response.ok) {
    throw new Error(await response.text());
  }
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);
  if (token !== renderToken) {
    bitmap.close();
    return;
  }
  previewBitmap?.close();
  previewBitmap = bitmap;
  await refreshMaskOverlay();
  drawCanvas();
  document.querySelector<HTMLCanvasElement>("#canvas")!.hidden = false;
  document.querySelector<HTMLDivElement>("#empty")!.hidden = true;
}

async function refreshMaskOverlay() {
  maskOverlayBitmap?.close();
  maskOverlayBitmap = null;
  if (!state || !activeMaskId || !showMaskOverlay) {
    return;
  }
  const response = await fetch(
    `${apiBase}/sessions/${state.id}/masks/${activeMaskId}/overlay?max=1400&t=${Date.now()}`
  );
  if (!response.ok) {
    return;
  }
  const blob = await response.blob();
  maskOverlayBitmap = await createImageBitmap(blob);
}

async function syncActiveSession() {
  if (painting || cropStart) {
    return;
  }
  try {
    const active = await get<SessionState>("/sessions/active");
    if (state?.id === active.id && state.revision === active.revision) {
      return;
    }

    const previousId = state?.id;
    state = active;
    if (activeMaskId && !state.masks.some((mask) => mask.id === activeMaskId)) {
      activeMaskId = state.masks[0]?.id ?? null;
    }
    const target = adjustmentTarget;
    if (target.type === "mask" && !state.masks.some((mask) => mask.id === target.maskId)) {
      adjustmentTarget = activeMaskId ? { type: "mask", maskId: activeMaskId } : { type: "global" };
    }
    await refreshPreview();
    renderPanel();
    setStatus(previousId === active.id ? "已同步 AI 编辑" : active.sourcePath);
  } catch {
    // No active session yet, or the API is temporarily unavailable during startup.
  }
}

function drawCanvas() {
  const canvas = getCanvas();
  const context = canvas.getContext("2d")!;
  if (!previewBitmap) {
    return;
  }
  canvas.width = previewBitmap.width;
  canvas.height = previewBitmap.height;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(previewBitmap, 0, 0);
  if (maskOverlayBitmap && showMaskOverlay) {
    context.drawImage(maskOverlayBitmap, 0, 0, canvas.width, canvas.height);
  }

  if (mode === "crop" && cropStart && cropCurrent) {
    const left = Math.min(cropStart.x, cropCurrent.x);
    const top = Math.min(cropStart.y, cropCurrent.y);
    const width = Math.abs(cropCurrent.x - cropStart.x);
    const height = Math.abs(cropCurrent.y - cropStart.y);
    context.save();
    context.fillStyle = "rgba(0, 0, 0, 0.45)";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.clearRect(left, top, width, height);
    context.strokeStyle = "#d6f36a";
    context.lineWidth = 2;
    context.strokeRect(left + 0.5, top + 0.5, width, height);
    context.restore();
  }

  if (mode === "mask" && brushPreviewPoint) {
    drawBrushPreview(context, canvas);
  }
}

function onPointerDown(event: PointerEvent) {
  if (!state || !previewBitmap) {
    return;
  }
  getCanvas().setPointerCapture(event.pointerId);
  const point = canvasPoint(event);
  brushPreviewPoint = point;
  if (mode === "crop") {
    cropStart = point;
    cropCurrent = point;
    drawCanvas();
    return;
  }
  if (!activeMaskId) {
    void createMask().then(() => startPainting(point));
    return;
  }
  startPainting(point);
}

function onPointerMove(event: PointerEvent) {
  if (!state || !previewBitmap) {
    return;
  }
  const point = canvasPoint(event);
  brushPreviewPoint = point;
  if (mode === "crop" && cropStart) {
    cropCurrent = point;
    drawCanvas();
    return;
  }
  if (painting) {
    void paintTo(point);
  }
}

function onPointerUp() {
  if (!state || !previewBitmap) {
    resetPointerState();
    return;
  }
  if (mode === "crop" && cropStart && cropCurrent) {
    const rect = cropRectFromCanvas(cropStart, cropCurrent);
    resetPointerState();
    if (rect.width > 8 && rect.height > 8) {
      void post<SessionState>(`/sessions/${state.id}/crop`, { rect }).then(async (next) => {
        state = next;
        await refreshPreview();
        renderPanel();
      });
    } else {
      drawCanvas();
    }
    return;
  }
  if (painting) {
    painting = false;
    lastPaintPoint = null;
    void refreshPreview();
  }
}

function onPointerLeave() {
  brushPreviewPoint = null;
  onPointerUp();
  drawCanvas();
}

function startPainting(point: PaintPoint) {
  painting = true;
  lastPaintPoint = point;
  void paintTo(point);
}

async function paintTo(point: PaintPoint) {
  if (!state || !activeMaskId || !lastPaintPoint) {
    return;
  }
  const imagePoints = [lastPaintPoint, point].map(canvasToImagePoint);
  lastPaintPoint = point;
  state = await post<SessionState>(
    `/sessions/${state.id}/masks/${activeMaskId}/stroke`,
    {
      points: imagePoints,
      brushSize,
      opacity: brushOpacity,
      mode: brushMode
    }
  );
}

function resetPointerState() {
  cropStart = null;
  cropCurrent = null;
  painting = false;
  lastPaintPoint = null;
}

function setMode(next: ToolMode) {
  mode = next;
  document.querySelector<HTMLButtonElement>("#tool-mask")!.classList.toggle("active", mode === "mask");
  document.querySelector<HTMLButtonElement>("#tool-crop")!.classList.toggle("active", mode === "crop");
  resetPointerState();
  brushPreviewPoint = null;
  drawCanvas();
}

function renderPanel() {
  const panel = document.querySelector<HTMLDivElement>("#panel")!;
  if (!state) {
    panel.innerHTML = `<div class="section"><h2>会话</h2><div class="muted">打开一张 JPEG 后会创建共享编辑会话。</div></div>`;
    return;
  }

  const targetParams = getTargetParams();
  const selectedMaskId =
    adjustmentTarget.type === "mask" ? adjustmentTarget.maskId : null;
  panel.innerHTML = `
    <div class="section">
      <h2>图片</h2>
      <div class="muted">${state.width} x ${state.height}px</div>
      <div class="muted">${state.crop ? `裁切：${state.crop.width} x ${state.crop.height}` : "未裁切"}</div>
      <button id="clear-crop" class="button">清除裁切</button>
    </div>
    <div class="section">
      <h2>蒙版</h2>
      <button id="add-mask" class="button primary">添加蒙版</button>
      <label class="checkbox-row">
        <input id="show-mask-overlay" type="checkbox" ${showMaskOverlay ? "checked" : ""}>
        <span>显示红色蒙版覆盖层</span>
      </label>
      <div class="field">
        <label><span>画笔大小</span><span>${brushSize}px</span></label>
        <input id="brush-size" type="range" min="4" max="240" value="${brushSize}">
      </div>
      <div class="field">
        <label><span>画笔不透明度</span><span>${Math.round(brushOpacity * 100)}%</span></label>
        <input id="brush-opacity" type="range" min="0.05" max="1" step="0.05" value="${brushOpacity}">
      </div>
      <div class="field">
        <label>画笔模式</label>
        <select id="brush-mode">
          <option value="add" ${brushMode === "add" ? "selected" : ""}>添加</option>
          <option value="erase" ${brushMode === "erase" ? "selected" : ""}>擦除</option>
        </select>
      </div>
      <div class="mask-list">
        ${state.masks.map(maskRow).join("") || `<div class="muted">还没有蒙版。</div>`}
      </div>
    </div>
    <div class="section">
      <h2>调色</h2>
      <div class="field">
        <label>作用目标</label>
        <select id="target">
          <option value="global" ${adjustmentTarget.type === "global" ? "selected" : ""}>全局</option>
          ${state.masks.map((mask) => `<option value="${mask.id}" ${selectedMaskId === mask.id ? "selected" : ""}>${mask.name}</option>`).join("")}
        </select>
      </div>
      ${slider("exposure", "曝光", targetParams.exposure, -3, 3, 0.05)}
      ${slider("contrast", "对比度", targetParams.contrast, -100, 100, 1)}
      ${slider("saturation", "饱和度", targetParams.saturation, -100, 100, 1)}
      ${slider("temperature", "色温", targetParams.temperature, -100, 100, 1)}
      ${slider("tint", "色调", targetParams.tint, -100, 100, 1)}
      ${slider("highlights", "高光", targetParams.highlights, -100, 100, 1)}
      ${slider("shadows", "阴影", targetParams.shadows, -100, 100, 1)}
      ${slider("blacks", "黑色色阶", targetParams.blacks, -100, 100, 1)}
      ${slider("whites", "白色色阶", targetParams.whites, -100, 100, 1)}
    </div>
  `;

  panel.querySelector<HTMLButtonElement>("#clear-crop")!.addEventListener("click", async () => {
    state = await post<SessionState>(`/sessions/${state!.id}/crop`, { rect: null });
    await refreshPreview();
    renderPanel();
  });
  panel.querySelector<HTMLButtonElement>("#add-mask")!.addEventListener("click", createMask);
  panel.querySelector<HTMLInputElement>("#show-mask-overlay")!.addEventListener("change", async (event) => {
    showMaskOverlay = (event.target as HTMLInputElement).checked;
    await refreshMaskOverlay();
    drawCanvas();
    renderPanel();
  });
  panel.querySelector<HTMLInputElement>("#brush-size")!.addEventListener("input", (event) => {
    brushSize = Number((event.target as HTMLInputElement).value);
    drawCanvas();
    renderPanel();
  });
  panel.querySelector<HTMLInputElement>("#brush-opacity")!.addEventListener("input", (event) => {
    brushOpacity = Number((event.target as HTMLInputElement).value);
    renderPanel();
  });
  panel.querySelector<HTMLSelectElement>("#brush-mode")!.addEventListener("change", (event) => {
    brushMode = (event.target as HTMLSelectElement).value as "add" | "erase";
  });
  panel.querySelector<HTMLSelectElement>("#target")!.addEventListener("change", (event) => {
    const value = (event.target as HTMLSelectElement).value;
    adjustmentTarget = value === "global" ? { type: "global" } : { type: "mask", maskId: value };
    renderPanel();
  });
  panel.querySelectorAll<HTMLInputElement>("[data-adjustment]").forEach((input) => {
    input.addEventListener("input", () => {
      void updateAdjustment(input.dataset.adjustment as keyof AdjustmentParams, Number(input.value));
    });
  });
  panel.querySelectorAll<HTMLButtonElement>("[data-mask-id]").forEach((button) => {
    button.addEventListener("click", () => {
      activeMaskId = button.dataset.maskId!;
      adjustmentTarget = { type: "mask", maskId: activeMaskId };
      void refreshMaskOverlay().then(drawCanvas);
      renderPanel();
    });
  });
  panel.querySelectorAll<HTMLButtonElement>("[data-delete-mask-id]").forEach((button) => {
    button.addEventListener("click", () => {
      void deleteMask(button.dataset.deleteMaskId!);
    });
  });
}

function maskRow(mask: SessionState["masks"][number]) {
  return `
    <div class="mask-row ${activeMaskId === mask.id ? "active" : ""}">
      <div>
        <strong>${mask.name}</strong>
        <div class="muted">不透明度 ${Math.round(mask.opacity * 100)}% · 羽化 ${mask.feather}px</div>
      </div>
      <div class="mask-actions">
        <button class="button" data-mask-id="${mask.id}">选择</button>
        <button class="button danger" data-delete-mask-id="${mask.id}">删除</button>
      </div>
    </div>
  `;
}

function slider(
  key: keyof AdjustmentParams,
  label: string,
  value: number,
  min: number,
  max: number,
  step: number
) {
  return `
    <div class="field">
      <label><span>${label}</span><span>${Number(value).toFixed(step < 1 ? 2 : 0)}</span></label>
      <input data-adjustment="${key}" type="range" min="${min}" max="${max}" step="${step}" value="${value}">
    </div>
  `;
}

function drawBrushPreview(context: CanvasRenderingContext2D, canvas: HTMLCanvasElement) {
  if (!state || !brushPreviewPoint) {
    return;
  }
  const crop = state.crop ?? {
    x: 0,
    y: 0,
    width: state.width,
    height: state.height
  };
  const scaleX = canvas.width / crop.width;
  const scaleY = canvas.height / crop.height;
  const radius = Math.max(2, (brushSize / 2) * Math.min(scaleX, scaleY));

  context.save();
  context.beginPath();
  context.arc(brushPreviewPoint.x, brushPreviewPoint.y, radius, 0, Math.PI * 2);
  context.fillStyle = "rgba(255, 24, 36, 0.12)";
  context.fill();
  context.lineWidth = 2;
  context.strokeStyle = "rgba(255, 255, 255, 0.92)";
  context.shadowColor = "rgba(0, 0, 0, 0.85)";
  context.shadowBlur = 4;
  context.stroke();
  context.shadowBlur = 0;
  context.setLineDash([6, 4]);
  context.strokeStyle = "rgba(255, 24, 36, 0.95)";
  context.stroke();
  context.beginPath();
  context.arc(brushPreviewPoint.x, brushPreviewPoint.y, 2.5, 0, Math.PI * 2);
  context.fillStyle = "rgba(255, 255, 255, 0.96)";
  context.fill();
  context.restore();
}

async function updateAdjustment(key: keyof AdjustmentParams, value: number) {
  if (!state) {
    return;
  }
  state = await post<SessionState>(`/sessions/${state.id}/adjustments`, {
    target: adjustmentTarget,
    params: { [key]: value }
  });
  await refreshPreview();
}

function getTargetParams(): AdjustmentParams {
  const target = adjustmentTarget;
  if (!state || target.type === "global") {
    return state?.globalAdjustments ?? emptyParams();
  }
  return (
    state.masks.find((mask) => mask.id === target.maskId)?.adjustments ??
    emptyParams()
  );
}

function emptyParams(): AdjustmentParams {
  return {
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
}

function cropRectFromCanvas(start: PaintPoint, end: PaintPoint): CropRect {
  const crop = state?.crop ?? {
    x: 0,
    y: 0,
    width: state?.width ?? 1,
    height: state?.height ?? 1
  };
  const left = Math.min(start.x, end.x);
  const top = Math.min(start.y, end.y);
  const right = Math.max(start.x, end.x);
  const bottom = Math.max(start.y, end.y);
  return {
    x: Math.round(crop.x + (left / getCanvas().width) * crop.width),
    y: Math.round(crop.y + (top / getCanvas().height) * crop.height),
    width: Math.round(((right - left) / getCanvas().width) * crop.width),
    height: Math.round(((bottom - top) / getCanvas().height) * crop.height),
    feather: 0
  };
}

function canvasToImagePoint(point: PaintPoint): PaintPoint {
  const crop = state?.crop ?? {
    x: 0,
    y: 0,
    width: state?.width ?? 1,
    height: state?.height ?? 1
  };
  return {
    x: crop.x + (point.x / getCanvas().width) * crop.width,
    y: crop.y + (point.y / getCanvas().height) * crop.height
  };
}

function canvasPoint(event: PointerEvent): PaintPoint {
  const canvas = getCanvas();
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * canvas.width,
    y: ((event.clientY - rect.top) / rect.height) * canvas.height
  };
}

function getCanvas(): HTMLCanvasElement {
  return document.querySelector<HTMLCanvasElement>("#canvas")!;
}

function setStatus(message: string) {
  document.querySelector<HTMLDivElement>("#status")!.textContent = message;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json() as Promise<T>;
}

async function remove<T>(path: string): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    method: "DELETE"
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json() as Promise<T>;
}

async function get<T>(path: string): Promise<T> {
  const response = await fetch(`${apiBase}${path}`);
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json() as Promise<T>;
}
