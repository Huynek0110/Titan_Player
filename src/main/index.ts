import { app, BrowserWindow, dialog, ipcMain, shell, nativeTheme } from "electron"
import path from "node:path"
import fs from "node:fs"
import { fileURLToPath } from "node:url"
import { scanLibrary, windowsMusicFolder } from "./library.js"
import { registerMediaScheme, handleMediaProtocol, pruneCovers } from "./protocol.js"
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
import type { LibrarySettings } from "../shared/types.js"

const __dirname_ = path.dirname(fileURLToPath(import.meta.url))

/**
 * Locate the built preload.
 *
 * electron-vite forces the `.mjs` extension for the preload when the output
 * format is ES, which `"type": "module"` guarantees. Hard-coding one name here
 * previously produced a silently blank window: the preload never loaded,
 * `window.titan` stayed undefined, and the renderer threw on its first call.
 * Probing both names, and failing loudly if neither exists, keeps that class of
 * mistake impossible to ship again.
 */
function preloadPath(): string {
  const base = path.join(__dirname_, "../preload/index")
  for (const name of [".mjs", ".js", ".cjs"]) {
    const candidate = `${base}${name}`
    if (fs.existsSync(candidate)) return candidate
  }
  console.error(`[titan] preload not found. Looked for index.mjs/.js/.cjs next to ${base}`)
  // Still hand back a path. Electron will report the failure itself, which is
  // a clearer diagnostic than a preload silently resolving to nothing.
  return `${base}.mjs`
}

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
      preload: preloadPath(),
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
  let scanInFlight = false

  ipcMain.handle("library:scan", async (_event, folders: string[], extensions: string[]) => {
    // Concurrent scans would fight over the shared audio jail and cover map and
    // interleave their progress events on one channel.
    if (scanInFlight) throw new Error("A scan is already running")
    scanInFlight = true

    try {
      const settings = getSettings()

      // The renderer supplies a folder list, but the jail is the security
      // boundary, so it is built from what the main process has on record
      // rather than from renderer input. A compromised renderer therefore
      // cannot widen the set of readable files by passing a different array.
      const trusted = new Set(settings.musicFolders.map((f) => path.resolve(f).toLowerCase()))
      const requested = (folders ?? [])
        .map((f) => path.resolve(f).toLowerCase())
        .filter((f) => trusted.has(f))

      const targets = [...requested]
      if (settings.useSystemMusicFolder) {
        const music = windowsMusicFolder()
        if (!targets.some((f) => f === path.resolve(music).toLowerCase())) targets.push(music)
      }

      let lastSent = 0
      const result = await scanLibrary({
        folders: targets,
        extensions: extensions?.length ? extensions : settings.extensions,
        onProgress: (progress) => {
          // Throttle. Reporting every discovered file would mean tens of
          // thousands of IPC messages carrying a full path each.
          const now = Date.now()
          const done = progress.phase === "done"
          if (!done && now - lastSent < 80) return
          lastSent = now
          send("library:scan-progress", done ? { ...progress, currentFile: undefined } : progress)
        },
      })

      // Only prune once we are confident the scan actually covered the library.
      // An unplugged drive or a temporarily missing folder would otherwise
      // silently and permanently erase every playlist and favourite.
      if (result.tracks.length > 0) {
        await prunePlaylists(new Set(result.tracks.map((t) => t.id)))
        pruneCovers(new Set(result.tracks.map((t) => t.id)))
      } else {
        console.warn("[titan] scan returned no tracks; keeping playlists and favourites intact")
      }

      return result
    } finally {
      scanInFlight = false
    }
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
