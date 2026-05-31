const { contextBridge, ipcRenderer } = require("electron");

const apiBaseArg = process.argv.find((arg) => arg.startsWith("--api-base="));
const apiBase = apiBaseArg ? apiBaseArg.slice("--api-base=".length) : "http://127.0.0.1:43110";

contextBridge.exposeInMainWorld("editorApi", {
  apiBase,
  openImage: () => ipcRenderer.invoke("dialog:openImage"),
  saveJpeg: () => ipcRenderer.invoke("dialog:saveJpeg")
});
