import { contextBridge, ipcRenderer } from "electron"
import type {
  LibrarySettings,
  Playlist,
  ScanProgress,
  ScanResult,
} from "../shared/types.js"

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
}

export type TitanApi = typeof api

contextBridge.exposeInMainWorld("titan", api)
