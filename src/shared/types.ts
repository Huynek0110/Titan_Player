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

/**
 * One timed word inside a line, from an Enhanced LRC file.
 *
 * `start` and `end` are character offsets into the parent line's `text`, not
 * fractions and not pixels. The renderer converts them to a gradient percentage
 * once per animation frame, and character position is the only geometry it can
 * know without measuring the DOM — which it must never do, because measuring
 * forces layout.
 */
export interface LyricWord {
  /** When the word starts, in seconds. */
  time: number
  /** Character offset of the word's first character in the line text. */
  start: number
  /** Character offset one past the word's last character. */
  end: number
}

export interface LyricLine {
  /** Start time of the line, in seconds. */
  time: number
  /** Optional end time when the source provides one. */
  end?: number
  /** The words of the line. */
  text: string
  /**
   * Per-word timing, present only for Enhanced LRC.
   *
   * The words hang off the line rather than off the enclosing `Lyrics` object.
   * A flat, file-wide array would have to be re-joined to lines on every render
   * (and would double the size of the lyrics payload crossing the IPC bridge for
   * every track in the library), whereas riding along inside `lines` means every
   * path that already passes `lines` through — the sidecar reader, the
   * embedded-tag reader, and `parseLrc` on a file the user picked — carries the
   * word timing with no extra plumbing and no chance of the two drifting apart.
   */
  words?: LyricWord[]
}

export interface Lyrics {
  /** True when at least one line carries a timestamp. */
  synced: boolean
  lines: LyricLine[]
  /** Plain text fallback when the source has no timing information at all. */
  plain?: string
  /**
   * Where the lyrics came from, for the UI to explain an empty view.
   *
   * `online` is fetched from a third-party lyrics database rather than read off
   * the file, so the UI credits it and Settings can explain what it cost.
   */
  source: "embedded" | "lrc-sidecar" | "online" | "none"
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
  /** Last opened playlist, so a relaunch lands back where the user left off. */
  lastPlaylistId: string | null
  volume: number
  /** Repeat mode for the player. */
  repeat: "off" | "all" | "one"
  shuffle: boolean
  /** Sort order for track lists. */
  sortBy: "title" | "artist" | "album" | "duration" | "added"
  sortDir: "asc" | "desc"
  /**
   * Look lyrics up online when a track has none locally.
   *
   * This is off by default and the reason is not caution for its own sake: an
   * automatic lookup sends the artist, the title and the album of every track
   * you play to a third-party server, which is a record of your listening. The
   * app works completely without it, so the user turns it on deliberately rather
   * than discovering it happened.
   */
  fetchOnlineLyrics: boolean
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

/** A file the scanner found but could not read, and why. */
export interface ScanFailure {
  path: string
  reason: string
}

export interface ScanResult {
  tracks: Track[]
  /** Absolute paths that looked like audio but could not be parsed. */
  failed: ScanFailure[]
  scannedFolders: string[]
  durationMs: number
}
