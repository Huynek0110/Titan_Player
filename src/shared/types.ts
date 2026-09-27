/** Types shared between the main process, the preload bridge and the renderer. */

/**
 * Audio extensions Titan Player recognises. Every one of these decodes natively
 * in Electron 44, so nothing here needs a bundled codec.
 */
export const DEFAULT_EXTENSIONS = [
  ".mp3",
  ".flac",
  ".m4a",
  ".aac",
  ".ogg",
  ".oga",
  ".opus",
  ".wav",
  ".wma",
  ".aiff",
  ".ape",
  ".wv",
  ".mp4",
]

export interface LyricLine {
  /** Start time of the line, in seconds. */
  time: number
  /** Optional end time when the source provides one. */
  end?: number
  /** The words of the line. */
  text: string
  /** Translation or secondary line shown beneath the primary one, when present. */
  translation?: string
}

export interface Lyrics {
  /** True when at least one line carries a timestamp. */
  synced: boolean
  lines: LyricLine[]
  /** Plain text fallback when the source has no timing information at all. */
  plain?: string
  /** Where the lyrics came from, for the UI to explain an empty view. */
  source: "embedded" | "lrc-sidecar" | "none"
}

export interface Track {
  /** Stable id derived from the absolute file path. */
  id: string
  path: string
  title: string
  artist: string
  album: string
  albumArtist: string
  /** Track number within its album, 1-based, when tagged. */
  trackNo: number | null
  discNo: number | null
  year: number | null
  genre: string[]
  /** Duration in seconds. */
  duration: number
  /** Bitrate in kbps as reported by the tagger. */
  bitrate: number | null
  sampleRate: number | null
  /** Number of channels, when the format reports it. */
  channels: number | null
  lossless: boolean
  /** True when the file carries cover art. Bytes live in the main process and
   *  are fetched over `media://cover/<id>`, never inlined as data URLs. */
  hasArtwork: boolean
  lyrics: Lyrics
  /** Original file size in bytes, for the details panel. */
  fileSize: number
  /** ISO date the file was last modified. */
  modifiedAt: string
  addedAt: string
}

export interface Playlist {
  id: string
  name: string
  /** Ordered track ids. Order is meaningful and user-editable. */
  trackIds: string[]
  createdAt: string
  updatedAt: string
  /** Built-in playlists cannot be deleted or renamed. */
  system: boolean
  kind: "all" | "albums" | "artists" | "favourites" | "custom"
}

export interface LibrarySettings {
  /** Absolute paths scanned for audio. Empty means the Windows Music folder. */
  musicFolders: string[]
  /** When true the Windows Music folder is appended to musicFolders implicitly. */
  useSystemMusicFolder: boolean
  /** Extensions treated as playable. */
  extensions: string[]
  /** Last opened tab. */
  lastView: string
  volume: number
  /** Repeat mode for the player. */
  repeat: "off" | "all" | "one"
  shuffle: boolean
  /** Sort order for track lists. */
  sortBy: "title" | "artist" | "album" | "duration" | "added"
  sortDir: "asc" | "desc"
}

export interface ScanProgress {
  phase: "idle" | "walking" | "parsing" | "done" | "error"
  /** Folders discovered so far. */
  found: number
  /** Files fully parsed so far. */
  parsed: number
  /** Total audio files discovered, known once walking finishes. */
  total: number
  /** File currently being parsed, for the progress label. */
  currentFile?: string
  error?: string
}

export interface ScanResult {
  tracks: Track[]
  /** Absolute paths that looked like audio but could not be parsed. */
  failed: Array<{ path: string; reason: string }>
  scannedFolders: string[]
  durationMs: number
}
