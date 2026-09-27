import { promises as fs } from "node:fs"
import path from "node:path"
import { app } from "electron"
import { createHash } from "node:crypto"
import {
  parseFile,
  selectCover,
  UnsupportedFileTypeError,
  CouldNotDetermineFileTypeError,
} from "music-metadata"
import type { IAudioMetadata, ILyricsTag } from "music-metadata"
import { extractEmbeddedLyrics, parseLrc, preferSynced } from "../shared/lyrics.js"
import { publishCover, setAudioRoots } from "./protocol.js"
import type { Lyrics, ScanProgress, ScanResult, Track } from "../shared/types.js"

/** Folders never worth walking into when hunting for music. */
const SKIP_DIRS = new Set([
  "$RECYCLE.BIN",
  "System Volume Information",
  "node_modules",
  ".git",
  ".svn",
  ".cache",
  "AppData",
  "Application Data",
  "Local Settings",
])

/**
 * Vorbis comment keys that can hold lyrics. Picard writes plain text to
 * `LYRICS`; `UNSYNCEDLYRICS` and `SYNCEDLYRICS` are the community conventions
 * that Jellyfin and LrcGet use. There is no standard, so all three are read.
 */
const VORBIS_LYRIC_KEYS = ["SYNCEDLYRICS", "LYRICS", "UNSYNCEDLYRICS"] as const

/** The per-user Music folder that Electron itself reports. */
export function windowsMusicFolder(): string {
  return app.getPath("music")
}

/** Stable id for a track: a short hash of its absolute path. */
function trackId(absolutePath: string): string {
  return createHash("sha1").update(absolutePath.toLowerCase()).digest("hex").slice(0, 20)
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim()
    if (Array.isArray(value) && typeof value[0] === "string" && value[0].trim()) {
      return value[0].trim()
    }
  }
  return ""
}

/** Fall back to the filename when a file carries no title tag. */
function titleFromPath(filePath: string): string {
  return path.basename(filePath, path.extname(filePath)).replace(/_/g, " ").trim()
}

const EMPTY_LYRICS: Lyrics = { synced: false, lines: [], source: "none" }

/**
 * `music-metadata` already auto-detects LRC inside a lyrics tag and exposes it
 * as `syncText`, but it only maps `LYRICS` and `UNSYNCEDLYRICS` out of Vorbis
 * comments. `SYNCEDLYRICS` is never mapped, so it has to be pulled from the
 * raw native tag list by hand and parsed locally.
 */
function readLyrics(meta: IAudioMetadata): Lyrics {
  // Step 1: structured lyrics from ID3 USLT/SYLT and Vorbis LYRICS/UNSYNCEDLYRICS.
  // Collected rather than returned, so step 2 can still win with something richer.
  const candidates: Lyrics[] = []
  const common = meta.common?.lyrics
  if (Array.isArray(common) && common.length > 0) {
    const tags = common as ILyricsTag[]
    const synced = tags.find((tag) => Array.isArray(tag.syncText) && tag.syncText.length > 0)
    if (synced?.syncText?.length) {
      const lines = synced.syncText
        .map((cue) => ({
          time: (cue.timestamp ?? 0) / 1000,
          text: (cue.text ?? "").trim(),
        }))
        .filter((line) => line.text.length > 0)
        .sort((a, b) => a.time - b.time)
      if (lines.length > 0) {
        candidates.push({
          synced: true,
          lines,
          plain: synced.text ?? undefined,
          source: "embedded",
        })
      }
    }
    const plainTag = tags.find((tag) => typeof tag.text === "string" && tag.text.trim())
    if (plainTag?.text) {
      // A plain-text tag can still turn out to be LRC once parsed properly.
      const parsed = parseLrc(plainTag.text)
      if (parsed.synced) {
        candidates.push({ synced: true, lines: parsed.lines, plain: parsed.plain, source: "embedded" })
      } else {
        candidates.push({ synced: false, lines: [], plain: plainTag.text, source: "embedded" })
      }
    }
  }

  // Step 2: `SYNCEDLYRICS` is never mapped by music-metadata's Vorbis mapper, so
  // it only exists in the raw native tag list. This has to be scanned even when
  // step 1 produced something, because the common case (LrcGet) writes plain
  // text to `LYRICS` *and* LRC to `SYNCEDLYRICS` — returning on the first
  // mapped tag would discard the timing and silently downgrade every such file.
  const nativeTags = (meta.native as Record<string, Array<{ id: string; value: unknown }>>) ?? {}
  for (const container of Object.values(nativeTags)) {
    if (!Array.isArray(container)) continue
    for (const tag of container) {
      const key = String(tag?.id ?? "").toUpperCase()
      if (!VORBIS_LYRIC_KEYS.includes(key as (typeof VORBIS_LYRIC_KEYS)[number])) continue
      const value = tag.value
      const text = typeof value === "string" ? value : firstString(value)
      if (!text.trim()) continue
      const parsed = parseLrc(text)
      if (parsed.synced) {
        candidates.push({ synced: true, lines: parsed.lines, plain: parsed.plain, source: "embedded" })
      } else {
        candidates.push({ synced: false, lines: [], plain: text, source: "embedded" })
      }
    }
  }

  if (candidates.length === 0) return EMPTY_LYRICS

  // Reduce by richness rather than taking the first hit: a synced source always
  // beats a plain one, and among equals the one with more text wins.
  return candidates.reduce((best, candidate) => preferSynced(best, candidate))
}

/** Look for a sidecar `.lrc` next to the audio file. */
async function readSidecarLrc(audioPath: string): Promise<Lyrics | null> {
  const candidate = path.join(
    path.dirname(audioPath),
    `${path.basename(audioPath, path.extname(audioPath))}.lrc`,
  )
  try {
    const raw = await fs.readFile(candidate, "utf8")
    const parsed = extractEmbeddedLyrics({ lyrics: raw })
    if (parsed.source !== "none") {
      // Relabel: this came from a file next to the track, not from its tags.
      return { ...parsed, source: "lrc-sidecar" }
    }
  } catch {
    // No sidecar, or unreadable. Embedded tags are the main path anyway.
  }
  return null
}

async function parseTrack(audioPath: string): Promise<Track> {
  const stat = await fs.stat(audioPath)
  const meta = await parseFile(audioPath, { duration: true })
  const common = meta.common ?? {}
  const format = meta.format ?? {}

  const id = trackId(audioPath)

  // selectCover prefers the front cover over a back scan or a band logo.
  const picture = selectCover(common.picture)
  if (picture?.data?.length) {
    publishCover(id, { mime: picture.format || "image/jpeg", bytes: picture.data })
  }

  let lyrics = readLyrics(meta)
  const sidecar = await readSidecarLrc(audioPath)
  if (sidecar) lyrics = preferSynced(lyrics, sidecar)

  const title = firstString(common.title) || titleFromPath(audioPath)
  const artist = firstString(common.artist, common.albumartist) || "Unknown Artist"

  // Some containers report a bogus duration. A NaN here would travel over IPC
  // and poison the sort comparator for the whole library.
  const rawDuration = format.duration
  const duration = typeof rawDuration === "number" && Number.isFinite(rawDuration) ? rawDuration : 0

  return {
    id,
    path: audioPath,
    title,
    artist,
    album: firstString(common.album) || "Unknown Album",
    albumArtist: firstString(common.albumartist) || artist,
    trackNo: common.track?.no ?? null,
    discNo: common.disk?.no ?? null,
    year: common.year ?? null,
    genre: Array.isArray(common.genre) ? common.genre : common.genre ? [String(common.genre)] : [],
    duration,
    bitrate: format.bitrate ? Math.round(format.bitrate / 1000) : null,
    sampleRate: format.sampleRate ?? null,
    channels: format.numberOfChannels ?? null,
    lossless: Boolean(format.lossless),
    hasArtwork: Boolean(picture?.data?.length),
    lyrics,
    fileSize: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    addedAt: new Date().toISOString(),
  }
}

/** Recursively collect audio file paths under `root`. */
export async function walkAudioFiles(
  root: string,
  extensions: string[],
  onProgress?: (found: number) => void,
): Promise<string[]> {
  const accepted = new Set(extensions.map((e) => e.toLowerCase()))
  const results: string[] = []

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 12) return
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      // Unreadable directory (permissions, or a broken junction). Skip it.
      return
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name)

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        if (entry.name.startsWith(".")) continue
        await walk(full, depth + 1)
      } else if (entry.isFile()) {
        if (accepted.has(path.extname(entry.name).toLowerCase())) {
          results.push(full)
          onProgress?.(results.length)
        }
      }
    }
  }

  await walk(root, 0)
  return results
}

export interface ScanOptions {
  folders: string[]
  extensions: string[]
  onProgress?: (progress: ScanProgress) => void
  /** Audio tags are IO-bound, so a small worker pool beats both extremes. */
  concurrency?: number
}

export async function scanLibrary(options: ScanOptions): Promise<ScanResult> {
  const started = Date.now()
  const { folders, extensions, onProgress } = options
  const concurrency = options.concurrency ?? 6

  onProgress?.({ phase: "walking", found: 0, parsed: 0, total: 0 })

  // Drop folders nested inside another so the same file is never scanned twice.
  const roots = [...new Set(folders.filter(Boolean).map((f) => path.resolve(f)))].sort(
    (a, b) => a.length - b.length,
  )
  const minimalRoots = roots.filter(
    (dir, index) => !roots.slice(0, index).some((parent) => isInside(dir, parent)),
  )

  const discovered: string[] = []
  const reachable: string[] = []
  for (const root of minimalRoots) {
    try {
      await fs.access(root)
    } catch {
      // A root that is not currently present is skipped, and deliberately kept
      // out of the audio jail so an unplugged drive does not stay readable.
      continue
    }
    reachable.push(root)
    const files = await walkAudioFiles(root, extensions, (found) => {
      onProgress?.({ phase: "walking", found, parsed: 0, total: 0 })
    })
    discovered.push(...files)
  }

  // The jail is populated only from folders that actually responded, and before
  // any cover is published, so it is never wider than the library on screen.
  setAudioRoots(reachable)

  const uniqueFiles = [...new Set(discovered)]
  const total = uniqueFiles.length

  const tracks: Track[] = []
  const failed: Array<{ path: string; reason: string }> = []
  let cursor = 0
  let parsed = 0

  async function worker(): Promise<void> {
    while (cursor < uniqueFiles.length) {
      const file = uniqueFiles[cursor++]
      try {
        tracks.push(await parseTrack(file))
      } catch (err) {
        failed.push({ path: file, reason: describeError(err) })
      }
      parsed += 1
      onProgress?.({ phase: "parsing", found: total, parsed, total, currentFile: file })
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(1, total)) }, () => worker()),
  )

  // Stable ordering so the library does not reshuffle between scans.
  tracks.sort((a, b) => a.path.localeCompare(b.path))

  onProgress?.({ phase: "done", found: total, parsed, total })

  return { tracks, failed, scannedFolders: reachable, durationMs: Date.now() - started }
}

function describeError(err: unknown): string {
  if (err instanceof UnsupportedFileTypeError) return "Unsupported format"
  if (err instanceof CouldNotDetermineFileTypeError) return "Unrecognised format"
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ENOENT") return "File disappeared during scan"
    if (code === "EACCES" || code === "EPERM") return "Access denied"
    return err.message
  }
  return String(err)
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent.toLowerCase(), child.toLowerCase())
  return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel)
}
