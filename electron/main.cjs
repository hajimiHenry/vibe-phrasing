const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");

const apiPort = Number(process.env.IMAGE_EDITOR_PORT || 43110);
const apiBase = `http://127.0.0.1:${apiPort}`;
let apiProcess = null;
let mainWindow = null;

async function createWindow() {
  await ensureApiServer();

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 680,
    title: "Vibe 图像编辑器",
    backgroundColor: "#111315",
    center: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [`--api-base=${apiBase}`]
    }
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    mainWindow.focus();
    mainWindow.setAlwaysOnTop(true);
    setTimeout(() => {
      if (!mainWindow?.isDestroyed()) {
        mainWindow.setAlwaysOnTop(false);
      }
    }, 800);
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    await mainWindow.loadURL(devUrl);
  } else {
    await mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

ipcMain.handle("dialog:openImage", async () => {
  if (mainWindow) {
    mainWindow.focus();
  }
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "打开 JPEG",
    properties: ["openFile"],
    filters: [{ name: "JPEG 图片", extensions: ["jpg", "jpeg"] }]
  });
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths[0];
});

ipcMain.handle("dialog:saveJpeg", async () => {
  if (mainWindow) {
    mainWindow.focus();
  }
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "导出 JPEG",
    defaultPath: "edited.jpg",
    filters: [{ name: "JPEG 图片", extensions: ["jpg", "jpeg"] }]
  });
  if (result.canceled || !result.filePath) {
    return null;
  }
  return result.filePath;
});

app.whenReady().then(createWindow).catch((error) => {
  console.error(error);
  dialog.showErrorBox("Vibe 图像编辑器启动失败", error.message || String(error));
  app.quit();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  if (apiProcess) {
    apiProcess.kill();
  }
});

async function ensureApiServer() {
  if (await isHealthy()) {
    return;
  }

  const command = process.platform === "win32" ? "cmd.exe" : "npx";
  const args =
    process.platform === "win32"
      ? ["/d", "/s", "/c", "npx", "tsx", "src/http-server.ts", "--port", String(apiPort)]
      : ["tsx", "src/http-server.ts", "--port", String(apiPort)];

  apiProcess = spawn(command, args, {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, IMAGE_EDITOR_PORT: String(apiPort) },
    stdio: "inherit",
    windowsHide: true
  });

  const started = Date.now();
  while (Date.now() - started < 15000) {
    if (await isHealthy()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for the local image API server.");
}

function isHealthy() {
  return new Promise((resolve) => {
    const request = http.get(`${apiBase}/health`, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on("error", () => resolve(false));
    request.setTimeout(1000, () => {
      request.destroy();
      resolve(false);
    });
  });
}
