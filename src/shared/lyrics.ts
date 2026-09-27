import type { LyricLine, Lyrics } from "./types.js"

/**
 * LRC parsing.
 *
 * Supports three shapes, in order of how much timing detail they carry:
 *
 *  1. Word-level ("enhanced" LRC) - `[00:12.00]<00:12.00>word <00:12.40>next`.
 *     Each `<...>` tag opens a new word and carries that word's own start time.
 *  2. Line-level - one `[mm:ss.xx]` tag followed by the whole line.
 *  3. Untimed - bare text, split on newlines.
 *
 * Timestamp fractions vary by file: two digits mean centiseconds, three mean
 * milliseconds. `[mm:ss:xx]` with a colon before the fraction also appears in
 * the wild, so both separators are accepted.
 */

const LINE_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g
const WORD_TAG = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g
const ID_TAG = /^\[[a-z]+:.*\]$/i

function toSeconds(minutes: string, seconds: string, fraction: string | undefined): number {
  let frac = 0
  if (fraction !== undefined) {
    // Normalise to a fraction of a second regardless of digit count.
    frac = Number(fraction.padEnd(3, "0").slice(0, 3)) / 1000
  }
  return Number(minutes) * 60 + Number(seconds) + frac
}

export interface Word {
  time: number
  text: string
}

export interface ParsedLyrics {
  lines: LyricLine[]
  words: Word[]
  synced: boolean
  plain?: string
}

/** LRC's whole-file timing adjustment, in milliseconds. Positive means the
 *  lyrics should appear *earlier*, which is the opposite of the intuitive sign. */
function readOffset(source: string): number {
  const match = source.match(/\[offset:\s*([+-]?\d+)\s*\]/i)
  if (!match) return 0
  const ms = Number(match[1])
  return Number.isFinite(ms) ? ms : 0
}

/** Parse raw LRC text. Never throws; malformed input degrades to plain text. */
export function parseLrc(raw: string): ParsedLyrics {
  const source = raw.replace(/\r\n?/g, "\n").replace(/\u0000/g, "")
  const lines: LyricLine[] = []
  const words: Word[] = []
  const offset = readOffset(source)
  let sawTimestamp = false

  for (const rawLine of source.split("\n")) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    // [ar:...], [ti:...], [offset:...] and other ID tags carry no lyric.
    if (!LINE_TAG.test(line) && ID_TAG.test(line)) continue

    LINE_TAG.lastIndex = 0
    const stamps: number[] = []
    let match: RegExpExecArray | null
    let consumed = 0
    while ((match = LINE_TAG.exec(line)) !== null) {
      // Only accept tags forming a contiguous prefix; stop at the first
      // non-timestamp character so a bracketed word mid-lyric is not eaten.
      if (match.index !== consumed) break
      consumed = match.index + match[0].length
      stamps.push(toSeconds(match[1], match[2], match[3]))
    }

    if (stamps.length === 0) continue
    sawTimestamp = true

    // The body is whatever follows the *last* accepted stamp, not the first.
    // Taking the first left a literal "[00:40.00]" visible in the rendered line
    // whenever a line carried more than one timestamp.
    const body = line.slice(consumed).trim()
    // Strip any further stray line-tags so they never reach the screen.
    const text = body
      .replace(LINE_TAG, "")
      .replace(WORD_TAG, "")
      .replace(/\s+/g, " ")
      .trim()

    for (const start of stamps) {
      lines.push({ time: start, text })
    }

    // Word-level timing, only meaningful when the body carries <...> tags.
    WORD_TAG.lastIndex = 0
    const parts: Word[] = []
    let cursor = 0
    let wm: RegExpExecArray | null
    while ((wm = WORD_TAG.exec(body)) !== null) {
      const between = body.slice(cursor, wm.index).trim()
      const at = toSeconds(wm[1], wm[2], wm[3])
      if (between.length > 0) {
        // Text before the first <...> belongs to the line start; text after one
        // belongs to that tag's own timestamp. Using the line start for both
        // was the arithmetic error that made every word share one time.
        parts.push({ time: parts.length === 0 ? stamps[0] : at, text: between })
      }
      cursor = wm.index + wm[0].length
    }
    const tail = body.slice(cursor).trim()
    if (tail.length > 0) {
      const lastTag = lastWordTag(body)
      parts.push({ time: lastTag ? lastTag.time : stamps[0], text: tail })
    }
    for (const part of parts) words.push(part)
  }

  if (!sawTimestamp) {
    return { lines: [], words: [], synced: false, plain: source.trim() }
  }

  // Positive offset shifts lyrics earlier, so subtract it.
  for (const line of lines) {
    line.time = Math.max(0, line.time - offset / 1000)
  }
  for (const word of words) {
    word.time = Math.max(0, word.time - offset / 1000)
  }

  lines.sort((a, b) => a.time - b.time)
  words.sort((a, b) => a.time - b.time)

  return { lines, words, synced: true }
}

/** The last `<mm:ss.xx>` tag in a body, with its time already in seconds. */
function lastWordTag(body: string): { time: number } | null {
  let found: { time: number } | null = null
  WORD_TAG.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = WORD_TAG.exec(body)) !== null) {
    found = { time: toSeconds(m[1], m[2], m[3]) }
  }
  return found
}

/**
 * Pull lyrics out of a tagger's raw tag bag. Tagger libraries disagree about
 * casing and about which key holds synchronised lyrics, so every known spelling
 * is checked and the richest result wins.
 */
export function extractEmbeddedLyrics(tags: Record<string, unknown> | undefined): Lyrics {
  if (!tags) return { synced: false, lines: [], source: "none" }

  const normalised: Record<string, string> = {}
  for (const [key, value] of Object.entries(tags)) {
    if (typeof value === "string" && value.trim().length > 0) {
      normalised[key.toLowerCase().replace(/[_\s]/g, "")] = value
    }
  }

  // Ordered by preference: synchronised variants first.
  const candidates = [
    "syncedlyrics",
    "lyricsynced",
    "lrc",
    "lyrics",
    "unsyncedlyrics",
    "unsyncedlyric",
    "uslt",
  ]

  let best: ParsedLyrics | null = null
  let found = false

  for (const key of candidates) {
    const value = normalised[key]
    if (!value) continue
    found = true
    const parsed = parseLrc(value)
    // Prefer the first entry that actually carries timing.
    if (!best || (parsed.synced && !best.synced)) best = parsed
  }

  if (!found || !best) return { synced: false, lines: [], source: "none" }

  return {
    synced: best.synced,
    lines: best.lines,
    plain: best.plain,
    source: "embedded",
  }
}

/**
 * Merge two lyric sources, preferring whichever carries more information.
 *
 * Comparing `lines.length` alone was wrong: an unsynced source always has zero
 * lines, so plain text embedded in the file would silently beat a richer
 * sidecar file regardless of content. Fall back to text length when neither
 * side is synced.
 */
export function preferSynced(a: Lyrics, b: Lyrics): Lyrics {
  if (a.synced && !b.synced) return a
  if (b.synced && !a.synced) return b
  if (a.synced && b.synced) return a.lines.length >= b.lines.length ? a : b
  return (a.plain?.length ?? 0) >= (b.plain?.length ?? 0) ? a : b
}

/**
 * Index of the line active at `time`, or -1 before the first line.
 * Binary search so this is cheap enough to call on every animation frame.
 */
export function activeLineIndex(lines: readonly LyricLine[], time: number): number {
  if (lines.length === 0) return -1
  let lo = 0
  let hi = lines.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (lines[mid].time <= time) {
      found = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return found
}
