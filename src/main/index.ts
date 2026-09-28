import { app, BrowserWindow, dialog, ipcMain, shell, nativeTheme } from "electron"
import path from "node:path"
import fs from "node:fs"
import { fileURLToPath } from "node:url"
import { DEFAULT_EXTENSIONS } from "../shared/types.js"
import { scanLibrary, windowsMusicFolder } from "./library.js"
import {
  registerMediaScheme,
  handleMediaProtocol,
  pruneCovers,
  configureAudioExtensions,
} from "./protocol.js"
import { lookupLyrics, forgetLyrics, type LookupTarget } from "./lyrics-online.js"
import {
  createPlaylist,
  deletePlaylist,
  flush,
  getFavourites,
  getHidden,
  getPlaylists,
  getSettings,
  loadState,
  prunePlaylists,
  resolveFirstSeen,
  setHidden,
  toggleFavourite,
  updatePlaylist,
  updateSettings,
} from "./store.js"
import type { LibrarySettings, ScanResult } from "../shared/types.js"

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
    // Hide the title bar but do NOT request a native overlay. An overlay draws
    // the system minimise/maximise/close on top of the custom ones the title bar
    // component renders, which put five window buttons in the corner. Drawing
    // all three ourselves keeps the chrome consistent with the rest of the app.
    titleBarStyle: "hidden",
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

/** The in-flight scan, or null. Also lets a duplicate request await the first. */
let scanInFlight: Promise<ScanResult> | null = null

/**
 * Walk the library and reconcile it with what is actually on disk.
 *
 * Shared by the IPC handler and the OS "open this file" path, so both go through
 * exactly the same reconciliation and neither can skip the pruning guard.
 */
function runScan(folders?: string[], extensions?: string[]): Promise<ScanResult> {
  if (scanInFlight) return scanInFlight

  const job = (async (): Promise<ScanResult> => {
    const settings = getSettings()
    const wantedExtensions = extensions?.length ? extensions : settings.extensions

    // The audio jail and the scanner must agree on what a track is. Updating the
    // served extension list from the same value the scan uses is what stops a
    // user-configured extension from producing tracks that cannot be played.
    configureAudioExtensions(wantedExtensions)

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
      extensions: wantedExtensions,
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

    /*
     * Pruning is destructive and irreversible, so the guard has to be about
     * *coverage*, not about whether any tracks came back. Checking
     * `tracks.length > 0` was not enough: with a library split across C: and an
     * external E:, one scan that could not reach E: still returned C:'s tracks,
     * passed the check, and permanently erased every E: track from every
     * playlist and from favourites. Nothing brings them back on replug.
     *
     * So: only prune when every folder the user asked for was actually
     * reachable this time.
     */
    const expected = new Set(targets.map((f) => path.resolve(f).toLowerCase()))
    const reached = new Set(result.scannedFolders.map((f) => path.resolve(f).toLowerCase()))
    const missing = [...expected].filter((f) => !reached.has(f))

    if (missing.length === 0 && result.tracks.length > 0) {
      await prunePlaylists(new Set(result.tracks.map((t) => t.id)))
      pruneCovers(new Set(result.tracks.map((t) => t.id)))
      await resolveFirstSeen(result.tracks)
    } else if (missing.length > 0) {
      // Keep every playlist, favourite and first-seen date intact.
      const names = missing.map((f) => path.basename(f)).join(", ")
      console.warn(
        `[titan] ${missing.length} folder(s) unreachable (${names}); keeping playlists and favourites intact`,
      )
      send("library:scan-progress", {
        phase: "error",
        found: result.tracks.length,
        parsed: result.tracks.length,
        total: result.tracks.length,
        error: `Could not reach: ${names}. Playlists and favourites were left alone.`,
      })
    } else {
      console.warn("[titan] scan returned no tracks; keeping playlists and favourites intact")
    }

    return result
  })()

  scanInFlight = job
  // Clear the guard on settle, but only if this is still the current job, so a
  // failure in an earlier one cannot release a later one's lock.
  void job.catch(() => {}).finally(() => {
    if (scanInFlight === job) scanInFlight = null
  })
  return job
}

function registerIpc(): void {
  ipcMain.handle("library:scan", async (_event, folders: string[], extensions: string[]) => {
    // Concurrent scans would fight over the shared audio jail and cover map and
    // interleave their progress events on one channel. A rejected second scan is
    // a normal outcome of a double click, not a fault, so it resolves quietly
    // rather than throwing: the throw reached the renderer's global error path
    // and rendered a full-screen fatal modal over a working app.
    if (scanInFlight) {
      console.warn("[titan] scan already running; ignoring the duplicate request")
      return scanInFlight
    }
    return runScan(folders, extensions)
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

  ipcMain.handle("hidden:get", () => getHidden())
  ipcMain.handle("hidden:set", (_event, trackId: string, hidden: boolean) =>
    setHidden(trackId, hidden),
  )

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

  /*
   * Online lyrics lookup.
   *
   * The renderer supplies the track's metadata rather than a URL, so there is no
   * value here for a compromised renderer to redirect at a host of its choosing.
   * The host is fixed in main/lyrics-online.ts, and the response is parsed and
   * size-capped before it is returned, so nothing unvalidated reaches the pane.
   *
   * One in flight at a time and the newest wins: skipping past a track should
   * abandon its lookup rather than queue it behind the next one, and letting a
   * superseded answer land would overwrite the lyrics for whatever is playing.
   */
  let onlineInFlight: AbortController | null = null
  ipcMain.handle("lyrics:lookup", async (_event, target: LookupTarget) => {
    onlineInFlight?.abort()
    const controller = new AbortController()
    onlineInFlight = controller
    try {
      return await lookupLyrics(target, getSettings().fetchOnlineLyrics, controller.signal)
    } finally {
      if (onlineInFlight === controller) onlineInFlight = null
    }
  })

  // Forgets a cached answer so the next request reaches the network. The escape
  // hatch for a lookup that returned the wrong recording.
  ipcMain.handle("lyrics:lookup-forgot", async (_event, target: LookupTarget) => {
    await forgetLyrics(target)
    return true
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

/**
 * Audio files in a process argument list.
 *
 * `electron-builder.yml` registers mp3/flac/m4a/ogg as file associations, so
 * "Open with Titan Player" in Explorer's context menu passes the path as an
 * argument. With no handler the app launched and ignored it, which is worse than
 * not registering the association at all. Paths are matched against the
 * configured extension list so Electron's own switches and the packaged app path
 * are not mistaken for tracks.
 */
function audioFilesIn(argv: readonly string[]): string[] {
  return argv
    .slice(1)
    .map((arg) => arg.replace(/^"(.*)"$/, "$1"))
    .filter((arg) => !arg.startsWith("-"))
    .map((arg) => path.resolve(arg))
    .filter((arg) => DEFAULT_EXTENSIONS.includes(path.extname(arg).toLowerCase()))
    .filter((arg) => fs.existsSync(arg))
}

/**
 * Handle a track the OS asked us to open.
 *
 * The library is folder-based, so a single file cannot be played on its own. The
 * honest interpretation of "open this track" is "show me this track's folder":
 * the containing directory is added to the library if it is not already there,
 * the library is rescanned so the file is actually present, and the folder is
 * revealed in Explorer so the user is not left guessing where it went.
 */
async function revealInLibrary(file: string): Promise<void> {
  const folder = path.dirname(file)
  const settings = getSettings()

  const already = settings.musicFolders.some(
    (f) => path.resolve(f).toLowerCase() === folder.toLowerCase(),
  )

  if (!already) {
    const folders = [...settings.musicFolders, folder]
    await updateSettings({
      musicFolders: folders,
      // An explicitly added folder should not disappear when the toggle is off.
      useSystemMusicFolder: settings.useSystemMusicFolder || folders.length > 1,
    })
  }

  mainWindow?.focus()
  shell.showItemInFolder(file)

  // Only rescan if the folder is genuinely new, so a repeated open does not
  // trigger a full library re-read.
  if (!already) await runScan()
}

/*
 * One instance, one writer.
 *
 * `flush()` writes every change to a fixed `<file>.tmp` and then renames it over
 * the real state file. Two processes doing that concurrently interleave their
 * writes to the *same* temp path and rename over each other, so playlist edits
 * and favourites are silently lost. Launching twice is easy to do by accident —
 * the portable exe in particular invites it — so the second instance hands its
 * arguments to the first and exits instead of opening a rival window.
 */
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on("second-instance", (_event, argv) => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
    // "Open with Titan Player" from Explorer, or a file dropped on the exe.
    for (const file of audioFilesIn(argv)) void revealInLibrary(file)
  })

  app.whenReady().then(async () => {
    nativeTheme.themeSource = "dark"
    handleMediaProtocol()
    await loadState()
    registerIpc()
    mainWindow = createWindow()

    // `before-quit` does not block, and the promise was being discarded, so any
    // settings write issued in the last few hundred milliseconds before the
    // window closed was lost. Debounce the quit, flush, then really quit.
    let quitting = false
    app.on("before-quit", (event) => {
      if (quitting) return
      event.preventDefault()
      quitting = true
      void flush().finally(() => app.quit())
    })

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
    })

    // A cold launch with a file argument, from Explorer's context menu.
    for (const file of audioFilesIn(process.argv)) void revealInLibrary(file)
  })
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})

// Defence in depth: never let the renderer navigate away from the app shell.
app.on("web-contents-created", (_event, contents) => {
  contents.on("will-navigate", (event) => event.preventDefault())
})
