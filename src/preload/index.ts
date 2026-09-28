import { contextBridge, ipcRenderer } from "electron"
import type {
  LibrarySettings,
  Lyrics,
  Playlist,
  ScanProgress,
  ScanResult,
} from "../shared/types.js"

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
}

export type TitanApi = typeof api

contextBridge.exposeInMainWorld("titan", api)
