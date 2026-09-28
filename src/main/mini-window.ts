import { app, BrowserWindow, ipcMain, screen, shell } from "electron"
import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import type { MiniCommand, MiniState, MiniWindowCommand } from "../shared/mini.js"

/**
 * The floating mini player.
 *
 * A second window that is a *remote control*, not a second player. The `<audio>`
 * element lives in the main window's renderer and stays there: a second element
 * would be a second copy of the same file playing at its own clock, and the two
 * would drift within seconds. So this window holds no audio at all. It sends
 * commands, the main window performs them through the same handlers its own
 * transport buttons use, and the resulting state is pushed back here to be
 * rendered.
 *
 * That has one consequence worth knowing about: the mini bar is only as fresh as
 * the last packet the main window managed to send, and the main window's audio
 * clock is the only clock. A paused main window is fine — the position does not
 * change, so there is nothing stale to show. A *playing* main window that has
 * become unresponsive will leave the bar frozen at the last position it was told
 * about, which is the correct thing to display and the reason the bar
 * interpolates between packets rather than trusting them absolutely.
 */

/** Geometry is kept apart from `PersistedState` on purpose. */
interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

const DEFAULT_BOUNDS: Bounds = { x: 0, y: 0, width: 400, height: 76 }
const MIN_WIDTH = 340
const MIN_HEIGHT = 68

let miniWindow: BrowserWindow | null = null
/** The main window, so a command can be routed to whoever owns the audio. */
let owner: BrowserWindow | null = null
let bounds: Bounds = { ...DEFAULT_BOUNDS }
let loaded = false

function boundsPath(): string {
  return path.join(app.getPath("userData"), "mini-window.json")
}

function readBounds(): void {
  try {
    const raw = JSON.parse(fs.readFileSync(boundsPath(), "utf8")) as Partial<Bounds>
    if (typeof raw.x === "number" && typeof raw.y === "number") bounds = { ...DEFAULT_BOUNDS, ...raw }
  } catch {
    // No file, or one written by a version that stored something else. The
    // default is fine and is placed sensibly below.
  }
}

/**
 * Move the bar back onto a display that exists.
 *
 * A saved position is only meaningful on the arrangement of monitors it was
 * saved on. Unplug the second screen and the saved `x` of 2400 is off to the
 * right of a 1920 desktop, so the window would open where the user cannot see
 * it and conclude the feature is broken. `screen.getAllDisplays` and a
 * `workArea` intersection is the check.
 */
function clampToDisplay(b: Bounds): Bounds {
  const area = screen.getDisplayMatching({ x: b.x, y: b.y, width: b.width, height: b.height }).workArea
  const width = Math.max(MIN_WIDTH, Math.min(b.width, area.width))
  const height = Math.max(MIN_HEIGHT, Math.min(b.height, area.height))
  const x = Math.min(Math.max(b.x, area.x), area.x + area.width - width)
  const y = Math.min(Math.max(b.y, area.y), area.y + area.height - height)
  return { x, y, width, height }
}

function saveBounds(): void {
  void fsp
    .writeFile(boundsPath(), JSON.stringify(bounds, null, 2), "utf8")
    .catch(() => {
      // Losing the position is not worth an error dialog. It is re-saved on the
      // next move.
    })
}

/** A default position: bottom-right of the primary display's work area. */
function defaultPlaced(): Bounds {
  const area = screen.getPrimaryDisplay().workArea
  return clampToDisplay({
    ...DEFAULT_BOUNDS,
    x: area.x + area.width - DEFAULT_BOUNDS.width - 24,
    y: area.y + area.height - DEFAULT_BOUNDS.height - 24,
  })
}

function preloadPath(): string {
  const base = path.join(__dirname, "../preload/index")
  for (const name of [".mjs", ".js", ".cjs"]) {
    const candidate = `${base}${name}`
    if (fs.existsSync(candidate)) return candidate
  }
  return `${base}.mjs`
}

function rendererFile(name: string): string {
  return path.join(__dirname, "../renderer", name)
}

function create(): BrowserWindow {
  loaded = false
  readBounds()
  const placed = bounds === DEFAULT_BOUNDS ? defaultPlaced() : clampToDisplay(bounds)
  bounds = placed

  const win = new BrowserWindow({
    ...placed,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    // Fully transparent, not a dark rectangle. The window is a rounded panel
    // with a shadow, and a `backgroundColor` here would be a visible square
    // behind it — including in the four corners outside the radius, which is
    // exactly where an opaque window looks broken.
    backgroundColor: "#00000000",
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    // No taskbar button: this is a satellite of the main window, and a second
    // entry that closes one window and leaves the other running is worse than
    // no entry at all.
    skipTaskbar: true,
    // A satellite over the main window, and over most other windows too, which
    // is the point of a mini player. "Normal" would let anything on top of it.
    alwaysOnTop: true,
    title: "Titan Player",
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      /*
       * The bar and the main window share one preload file, so the preload has
       * to know which surface it is running in — otherwise it exposes the main
       * window's full API into a 400px strip, and the narrowest surface in the
       * app ends up with the most reach.
       *
       * An explicit argument rather than a look at the URL. Branching on
       * `location.pathname` would work, and would also break silently the day the
       * file is renamed or served from a different route, with the failure being
       * a security boundary quietly removed. This cannot drift.
       */
      additionalArguments: ["--titan-surface=mini"],
    },
  })

  win.setAlwaysOnTop(true, "floating")
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false })

  /*
   * Dragging.
   *
   * A frameless window has no title bar, so there is nothing to grab. The region
   * is declared to the OS instead, which gives the real system drag — snap
   * layouts, multi-monitor, the taskbar edge behaviours — rather than a
   * hand-rolled mousemove loop that gets all of those subtly wrong.
   */
  win.setMovable(true)
  win.setResizable(true)

  const persist = () => {
    if (!win.isDestroyed() && !win.isMinimized()) {
      bounds = win.getBounds()
      saveBounds()
    }
  }
  win.on("moved", persist)
  win.on("resized", persist)

  win.on("close", (event) => {
    // Closing the bar is not closing the app. Swallow it, remember, and hide —
    // otherwise clicking the bar's own ✕ quits the program.
    event.preventDefault()
    saveBounds()
    win.hide()
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: "deny" }
  })

  win.once("ready-to-show", () => {
    loaded = true
    win.showInactive()
  })

  const url = process.env.ELECTRON_RENDERER_URL
  if (url) void win.loadURL(`${url}/mini.html`)
  else void win.loadFile(rendererFile("mini.html"))

  return win
}

export function isOpen(): boolean {
  return miniWindow !== null && !miniWindow.isDestroyed()
}

export function isVisible(): boolean {
  return isOpen() && miniWindow!.isVisible()
}

export function show(ownerWindow: BrowserWindow | null): void {
  owner = ownerWindow
  if (!isOpen()) {
    miniWindow = create()
    miniWindow.on("closed", () => {
      miniWindow = null
    })
  }
  if (miniWindow!.isMinimized()) miniWindow!.restore()
  miniWindow!.show()
  // Deliberately not focused. A mini player that steals focus every time a track
  // changes would be unusable; the buttons still work, because clicking one
  // focuses the window on its own.
  miniWindow!.showInactive()
  announce()
}

export function hide(): void {
  if (!isOpen()) return
  miniWindow!.hide()
  announce()
}

export function toggle(ownerWindow: BrowserWindow | null): void {
  if (isVisible()) hide()
  else show(ownerWindow)
}

/** Push state to the bar. Silently dropped if it is not open. */
export function push(state: MiniState): void {
  if (isOpen()) miniWindow!.webContents.send("mini:state", state)
}

/** Register the bar's own verbs. Called once, from the main process's IPC setup. */
export function registerIpc(): void {
  /*
   * Transport. Forwarded to the window that owns the audio, which is the whole
   * design: there is one implementation of "next track" in this app, and the
   * mini bar calls it rather than duplicating it.
   */
  ipcMain.on("mini:command", (_event, command: MiniCommand) => {
    if (!owner || owner.isDestroyed()) return
    /*
     * Opening Now Playing is the one command that also has to bring the main
     * window forward. Every other verb is invisible from outside — the music
     * does not stop and the main window looks the same — but "show me the full
     * player" while the main window is minimised produces no visible response at
     * all, and the button looks broken.
     */
    if (command.type === "open-now-playing") {
      if (owner.isMinimized()) owner.restore()
      owner.show()
    }
    owner.webContents.send(`mini-command:${command.type}`, command)
  })

  ipcMain.on("mini:window", (_event, command: MiniWindowCommand) => {
    switch (command.type) {
      case "close-mini":
        hide()
        break
      case "show-main":
        if (owner && !owner.isDestroyed()) {
          if (owner.isMinimized()) owner.restore()
          owner.show()
          owner.focus()
        }
        break
      case "mini-moved":
        bounds = { ...bounds, x: command.x, y: command.y }
        saveBounds()
        break
      case "mini-resized":
        bounds = { ...bounds, width: command.width, height: command.height }
        saveBounds()
        break
    }
  })
}

/**
 * Close the bar for good.
 *
 * `hide` is for the user pressing ✕. This is for the main window going away,
 * where the bar has no reason to exist: it controls an audio element that is
 * about to be destroyed, so leaving it on screen would show a frozen player and
 * every button on it would do nothing.
 */
export function dispose(): void {
  if (!isOpen()) return
  const win = miniWindow!
  miniWindow = null
  win.removeAllListeners("close")
  win.destroy()
}

export function attachOwner(win: BrowserWindow | null): void {
  owner = win
  // The renderer may already be mounted and asking, if the owner is being
  // replaced rather than created for the first time.
  announce()
}

export function isReady(): boolean {
  return loaded
}

/**
 * Tell the main window whether the bar is on screen.
 *
 * The main window's own toggle button has to reflect it, and the bar can be
 * dismissed from three directions — that button, its own ✕, and the window
 * manager's close event — so the renderer cannot be the one holding the truth.
 * Called from every path that changes visibility, which is the only way this
 * stays correct as paths are added.
 */
function announce(): void {
  if (owner && !owner.isDestroyed()) owner.webContents.send("mini:open-changed", isVisible())
}
