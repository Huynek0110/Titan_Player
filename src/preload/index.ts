import { contextBridge, ipcRenderer } from "electron"
import type {
  LibrarySettings,
  Lyrics,
  LyricsSaveRequest,
  LyricsWriteResponse,
  Playlist,
  ScanProgress,
  ScanResult,
} from "../shared/types.js"
import type { MiniCommand, MiniState, MiniWindowCommand } from "../shared/mini.js"
import type { ListeningHistory } from "../shared/listening.js"

/**
 * What an online lookup needs. Metadata rather than a path or a URL, so the main
 * process never has to trust a location and never reads a file on this account.
 */
export interface LyricsLookupTarget {
  id: string
  title: string
  artist: string
  album: string
  duration: number
}

export type LyricsLookupOutcome = "found" | "not-found" | "offline" | "error" | "disabled"

export interface LyricsLookupResult {
  outcome: LyricsLookupOutcome
  lyrics: Lyrics | null
  detail?: string
  cached?: boolean
}

/**
 * The only surface the renderer gets. Everything crossing this bridge is a
 * plain serialisable value: no `fs`, no `Buffer`, no `ipcRenderer` handle. Media
 * is reached through `media://` URLs, which the main process serves from a jail
 * rooted at the user's music folders.
 */
const api = {
  /** URL for an <audio> source. `absolutePath` must be inside a known root. */
  audioUrl: (absolutePath: string): string => `media://audio/${encodeURIComponent(absolutePath)}`,

  /** URL for cover art, or null when the track has none. */
  coverUrl: (trackId: string, hasArtwork: boolean): string | null =>
    hasArtwork ? `media://cover/${encodeURIComponent(trackId)}` : null,

  // --- library -----------------------------------------------------------
  scan: (folders: string[], extensions: string[]): Promise<ScanResult> =>
    ipcRenderer.invoke("library:scan", folders, extensions),

  onScanProgress: (handler: (progress: ScanProgress) => void): (() => void) => {
    const listener = (_event: unknown, progress: ScanProgress) => handler(progress)
    ipcRenderer.on("library:scan-progress", listener)
    return () => ipcRenderer.removeListener("library:scan-progress", listener)
  },

  pickFolders: (): Promise<string[]> => ipcRenderer.invoke("library:pick-folders"),
  defaultMusicFolder: (): Promise<string> => ipcRenderer.invoke("library:default-folder"),
  revealInExplorer: (absolutePath: string): Promise<void> =>
    ipcRenderer.invoke("fs:reveal", absolutePath),

  // --- settings ----------------------------------------------------------
  getSettings: (): Promise<LibrarySettings> => ipcRenderer.invoke("settings:get"),
  updateSettings: (patch: Partial<LibrarySettings>): Promise<LibrarySettings> =>
    ipcRenderer.invoke("settings:update", patch),

  // --- playlists ---------------------------------------------------------
  getPlaylists: (): Promise<Playlist[]> => ipcRenderer.invoke("playlists:get"),
  createPlaylist: (name: string): Promise<Playlist> => ipcRenderer.invoke("playlists:create", name),
  updatePlaylist: (
    id: string,
    patch: Partial<Pick<Playlist, "name" | "trackIds">>,
  ): Promise<Playlist | undefined> => ipcRenderer.invoke("playlists:update", id, patch),
  deletePlaylist: (id: string): Promise<boolean> => ipcRenderer.invoke("playlists:delete", id),

  // --- favourites / exclusions -------------------------------------------
  getFavourites: (): Promise<string[]> => ipcRenderer.invoke("favourites:get"),
  toggleFavourite: (trackId: string): Promise<string[]> =>
    ipcRenderer.invoke("favourites:toggle", trackId),

  getHidden: (): Promise<string[]> => ipcRenderer.invoke("hidden:get"),
  setHidden: (trackId: string, hidden: boolean): Promise<string[]> =>
    ipcRenderer.invoke("hidden:set", trackId, hidden),

  // --- listening history --------------------------------------------------
  /*
   * The renderer measures, the main process decides.
   *
   * `recordListen` sends what happened to a finished session — how much was really
   * heard and how far playback reached — and the main process applies the
   * threshold. The alternative, sending "count this as a play", moves the rule to
   * the renderer and leaves the one policy in the codebase with two possible
   * implementations of it.
   *
   * Both return the whole history rather than one record, so the renderer can
   * update everything from a single reply with no way to be left holding a stale
   * count for a row it is about to render.
   */
  getListeningHistory: (): Promise<ListeningHistory> => ipcRenderer.invoke("listening:get"),

  recordListen: (
    trackId: string,
    outcome: "play" | "skip",
    listenedMs: number,
  ): Promise<ListeningHistory> =>
    ipcRenderer.invoke("listening:record", trackId, outcome, listenedMs, new Date().toISOString()),

  // --- window ------------------------------------------------------------
  minimize: (): void => ipcRenderer.send("window:minimize"),
  maximize: (): void => ipcRenderer.send("window:maximize"),
  close: (): void => ipcRenderer.send("window:close"),
  isMaximized: (): Promise<boolean> => ipcRenderer.invoke("window:is-maximized"),
  onMaximizeChange: (handler: (maximized: boolean) => void): (() => void) => {
    const listener = (_event: unknown, value: boolean) => handler(value)
    ipcRenderer.on("window:maximize-changed", listener)
    return () => ipcRenderer.removeListener("window:maximize-changed", listener)
  },

  // --- lyrics ------------------------------------------------------------
  pickLyricsFile: (): Promise<{ path: string; content: string } | null> =>
    ipcRenderer.invoke("lyrics:pick-file"),

  /**
   * Look lyrics up online.
   *
   * The target is metadata, never a URL: the host is chosen in the main process,
   * so this is not a way to make the app fetch an arbitrary address. The reply is
   * already parsed and capped, and `null` for the lyrics means there was no
   * trustworthy match rather than that something went wrong.
   */
  lookupLyrics: (target: LyricsLookupTarget): Promise<LyricsLookupResult> =>
    ipcRenderer.invoke("lyrics:lookup", target),
  /** Forget a cached lookup so the next one reaches the network. */
  forgetLyrics: (target: LyricsLookupTarget): Promise<boolean> =>
    ipcRenderer.invoke("lyrics:lookup-forgot", target),

  /*
   * The lyrics editor's write path.
   *
   * `readLyricsSidecar` takes a path rather than a track id, which is the one
   * place in this bridge where the renderer names a file. That is unavoidable:
   * the id is a one-way hash of the path, so the main process cannot go the other
   * way without keeping a track index it does not have. The main process treats
   * the path as untrusted for the same reason it treats every other value here —
   * and the jail it checks against is the same one that serves audio, so a track
   * the user can play is a track the user can write lyrics beside, and nothing
   * else.
   */
  readLyricsSidecar: (audioPath: string): Promise<string | null> =>
    ipcRenderer.invoke("lyrics:read-sidecar", audioPath),

  /**
   * Write the lyric file beside the track.
   *
   * Never rejects for an ordinary refusal: a read-only folder, a path outside the
   * library and a track with no lyric lines all come back as `ok: false` with a
   * sentence to display. The audio is still playing and the app is still fine in
   * every one of those cases, so a rejection would be the wrong shape for it.
   */
  saveLyrics: (request: LyricsSaveRequest): Promise<LyricsWriteResponse> =>
    ipcRenderer.invoke("lyrics:save-sidecar", request),

  /** Remove the sidecar so the embedded tag takes over again. */
  removeLyricsSidecar: (audioPath: string): Promise<LyricsWriteResponse> =>
    ipcRenderer.invoke("lyrics:remove-sidecar", audioPath),

  // --- the floating mini player ------------------------------------------
  /*
   * Two separate surfaces, because the bar and the main window are on opposite
   * sides of the same conversation.
   *
   * `pushMini` is the main window *sending*: it hands the bar a state packet.
   * `onMini` is the main window *listening* for the bar's commands, which the
   * main process forwards verbatim so that there is one implementation of every
   * transport action in the app.
   *
   * The bar itself gets a different global entirely — see `titanMini` at the
   * bottom of this file. It has no `scan`, no `settings` and no filesystem
   * access, because a 400px control strip does not need any of them, and the
   * narrowest surface that works is the safest one.
   */

  /** Tell the bar what is playing. Silently dropped if the bar is closed. */
  pushMini: (state: MiniState): void => {
    ipcRenderer.send("mini:publish", state)
  },
  showMini: (): void => {
    ipcRenderer.send("mini:show")
  },
  hideMini: (): void => {
    ipcRenderer.send("mini:hide")
  },
  toggleMini: (): void => {
    ipcRenderer.send("mini:toggle")
  },
  /**
   * Whether the bar is currently on screen.
   *
   * The main window's own button has to reflect it, and the bar can be dismissed
   * from three places — this button, its own ✕, and the window manager's close —
   * so the renderer cannot be the one keeping the truth. A query covers the
   * first paint and an event covers every change after it.
   */
  isMiniOpen: (): Promise<boolean> => ipcRenderer.invoke("mini:is-open"),
  onMiniOpen: (handler: (open: boolean) => void): (() => void) => {
    const listener = (_event: unknown, open: boolean) => handler(open)
    ipcRenderer.on("mini:open-changed", listener)
    return () => ipcRenderer.removeListener("mini:open-changed", listener)
  },
  /** The bar's commands, forwarded by the main process to whichever window owns the audio. */
  onMiniCommand: (handler: (command: MiniCommand) => void): (() => void) => {
    const types: MiniCommand["type"][] = [
      "play-pause",
      "next",
      "previous",
      "seek",
      "volume",
      "toggle-mute",
      "toggle-shuffle",
      "cycle-repeat",
      "toggle-favourite",
      "open-now-playing",
    ]
    const listeners = types.map((type) => {
      const fn = (_event: unknown, command: MiniCommand) => handler(command)
      ipcRenderer.on(`mini-command:${type}`, fn)
      return () => ipcRenderer.removeListener(`mini-command:${type}`, fn)
    })
    return () => listeners.forEach((off) => off())
  },
}

export type TitanApi = typeof api

/**
 * Which surface this preload is running in.
 *
 * The main process passes `--titan-surface=mini` in `additionalArguments` for the
 * floating bar and nothing for the main window, and the two are told apart by that
 * rather than by inspecting the document.
 *
 * This matters because both windows load the *same* preload file, and a preload
 * that exposes `titan` unconditionally hands the main window's whole API —
 * scanning, settings, playlists, the filesystem jail — to a 400px control strip.
 * The narrowest surface in the app should be the one with the least reach, and
 * checking the URL instead of an explicit flag would remove that guarantee the
 * first time a file is renamed.
 */
const IS_MINI = process.argv.some((arg) => arg === "--titan-surface=mini")

/**
 * The mini bar's entire surface.
 *
 * Separate from `titan` on purpose, and exposed under a different name so the
 * bar's document cannot reach the main window's API even if something in it
 * tried. It can send commands, receive state, and ask to be moved. That is the
 * whole vocabulary of a remote control.
 */
const miniApi = {
  onState: (handler: (state: MiniState) => void): (() => void) => {
    const listener = (_event: unknown, state: MiniState) => handler(state)
    ipcRenderer.on("mini:state", listener)
    return () => ipcRenderer.removeListener("mini:state", listener)
  },

  send: (command: MiniCommand): void => {
    ipcRenderer.send("mini:command", command)
  },

  window: (command: MiniWindowCommand): void => {
    ipcRenderer.send("mini:window", command)
  },

  /**
   * The one URL the bar needs that the main window's API cannot give it.
   *
   * The main renderer is a *different document*, so `window.titan` does not
   * exist there and it cannot call `coverUrl`. Media still has to come through
   * the privileged scheme, because that is what makes the artwork readable from a
   * window with no node integration — a `file://` image would be blocked by the
   * same-origin policy and the cover would silently not paint.
   */
  coverUrl: (trackId: string, hasArtwork: boolean): string | null =>
    hasArtwork ? `media://cover/${encodeURIComponent(trackId)}` : null,
}

export type TitanMiniApi = typeof miniApi

/*
 * Exactly one surface per window, and never both.
 *
 * The bar gets `titanMini` and nothing else — `titan` is not exposed, so there is
 * no handle in that document that reaches scanning, settings, playlists or the
 * filesystem jail. The main window gets `titan` and no `titanMini`, so the
 * publisher and the command listener stay private to the side that owns them.
 *
 * Both of these run after both objects are declared, which is why they are at the
 * bottom: `miniApi` is a `const`, and exposing it above its own declaration
 * throws a temporal-dead-zone ReferenceError inside the preload — which
 * Electron reports as the preload failing to load, not as the line that caused
 * it.
 */
if (IS_MINI) {
  contextBridge.exposeInMainWorld("titanMini", miniApi)
} else {
  contextBridge.exposeInMainWorld("titan", api)
}
