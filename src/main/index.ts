import { app, BrowserWindow, dialog, ipcMain, shell, nativeTheme } from "electron"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { scanLibrary, windowsMusicFolder } from "./library.js"
import { registerMediaScheme, handleMediaProtocol } from "./protocol.js"
import {
  createPlaylist,
  deletePlaylist,
  flush,
  getFavourites,
  getPlaylists,
  getSettings,
  loadState,
  prunePlaylists,
  toggleFavourite,
  updatePlaylist,
  updateSettings,
} from "./store.js"
import type { LibrarySettings, ScanProgress } from "../shared/types.js"

const __dirname_ = path.dirname(fileURLToPath(import.meta.url))

// The scheme must be declared before the app becomes ready.
registerMediaScheme()

let mainWindow: BrowserWindow | null = null

function send(channel: string, payload?: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: "#06060a",
    // Keep the native Windows controls but hand the title bar strip to the app,
    // which is what makes the chrome look bespoke rather than default.
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#00000000",
      symbolColor: "#a1a1aa",
      height: 44,
    },
    webPreferences: {
      preload: path.join(__dirname_, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  })

  window.once("ready-to-show", () => window.show())

  const notifyMaximize = () => send("window:maximize-changed", window.isMaximized())
  window.on("maximize", notifyMaximize)
  window.on("unmaximize", notifyMaximize)

  // External links open in the real browser, never inside the app shell.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: "deny" }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(path.join(__dirname_, "../renderer/index.html"))
  }

  return window
}

function registerIpc(): void {
  ipcMain.handle("library:scan", async (_event, folders: string[], extensions: string[]) => {
    const settings = getSettings()
    const targets = [...(folders ?? [])]
    if (settings.useSystemMusicFolder) {
      const music = windowsMusicFolder()
      if (!targets.includes(music)) targets.push(music)
    }

    const result = await scanLibrary({
      folders: targets,
      extensions: extensions?.length ? extensions : settings.extensions,
      onProgress: (progress: ScanProgress) => send("library:scan-progress", progress),
    })

    await prunePlaylists(new Set(result.tracks.map((t) => t.id)))
    return result
  })

  ipcMain.handle("library:pick-folders", async () => {
    if (!mainWindow) return []
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory", "multiSelections", "createDirectory"],
      title: "Choose music folders",
    })
    return result.canceled ? [] : result.filePaths
  })

  ipcMain.handle("library:default-folder", () => windowsMusicFolder())
  ipcMain.handle("fs:reveal", (_event, absolutePath: string) => shell.showItemInFolder(absolutePath))

  ipcMain.handle("settings:get", () => getSettings())
  ipcMain.handle("settings:update", (_event, patch: Partial<LibrarySettings>) => updateSettings(patch))

  ipcMain.handle("playlists:get", () => getPlaylists())
  ipcMain.handle("playlists:create", (_event, name: string) => createPlaylist(name))
  ipcMain.handle("playlists:update", (_event, id: string, patch) => updatePlaylist(id, patch))
  ipcMain.handle("playlists:delete", (_event, id: string) => deletePlaylist(id))

  ipcMain.handle("favourites:get", () => getFavourites())
  ipcMain.handle("favourites:toggle", (_event, trackId: string) => toggleFavourite(trackId))

  ipcMain.handle("lyrics:pick-file", async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openFile"],
      filters: [{ name: "Lyrics", extensions: ["lrc", "txt"] }],
      title: "Open lyrics file",
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const { promises: fs } = await import("node:fs")
    return { path: result.filePaths[0], content: await fs.readFile(result.filePaths[0], "utf8") }
  })

  ipcMain.on("window:minimize", () => mainWindow?.minimize())
  ipcMain.on("window:maximize", () => {
    if (!mainWindow) return
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  })
  ipcMain.on("window:close", () => mainWindow?.close())
  ipcMain.handle("window:is-maximized", () => mainWindow?.isMaximized() ?? false)
}

app.whenReady().then(async () => {
  nativeTheme.themeSource = "dark"
  handleMediaProtocol()
  await loadState()
  registerIpc()
  mainWindow = createWindow()

  // A crash must not leave a half-written settings file behind.
  app.on("before-quit", () => void flush())

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})

// Defence in depth: never let the renderer navigate away from the app shell.
app.on("web-contents-created", (_event, contents) => {
  contents.on("will-navigate", (event) => event.preventDefault())
})
