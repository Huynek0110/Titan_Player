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

/** Parse raw LRC text. Never throws; malformed input degrades to plain text. */
export function parseLrc(raw: string): ParsedLyrics {
  const source = raw.replace(/\r\n?/g, "\n").replace(/\u0000/g, "")
  const lines: LyricLine[] = []
  const words: Word[] = []
  let sawTimestamp = false

  for (const rawLine of source.split("\n")) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    // Skip [ar:...], [ti:...], [offset:...] and other ID tags.
    if (!LINE_TAG.test(line) && ID_TAG.test(line)) continue

    LINE_TAG.lastIndex = 0
    const stamps: number[] = []
    let match: RegExpExecArray | null
    let consumed = 0
    while ((match = LINE_TAG.exec(line)) !== null) {
      // Only accept tags that form a contiguous prefix of the line.
      if (match.index !== consumed) break
      consumed = match.index + match[0].length
      stamps.push(toSeconds(match[1], match[2], match[3]))
    }

    if (stamps.length === 0) continue
    sawTimestamp = true

    const body = line.slice(consumed).trim()

    // Word-level tags inside the body.
    WORD_TAG.lastIndex = 0
    const parts: Word[] = []
    let cursor = 0
    let wm: RegExpExecArray | null
    while ((wm = WORD_TAG.exec(body)) !== null) {
      const between = body.slice(cursor, wm.index).trim()
      if (between.length > 0) {
        parts.push({ time: stamps[0] + Number(wm[1]) * 60 + Number(wm[2]), text: between })
      }
      cursor = wm.index + wm[0].length
    }
    const tail = body.slice(cursor).trim()
    if (tail.length > 0) {
      const lastTag = body.match(WORD_TAG)
      const base = lastTag ? toSeconds(lastTag[1], lastTag[2], lastTag[3]) : stamps[0]
      parts.push({ time: base, text: tail })
    }

    if (parts.length > 0) {
      for (const part of parts) words.push(part)
    }

    // Strip word tags for the plain line text, collapsing the extra spacing.
    const text = body.replace(WORD_TAG, "").replace(/\s+/g, " ").trim()
    for (const start of stamps) {
      lines.push({ time: start, text })
    }
  }

  lines.sort((a, b) => a.time - b.time)
  words.sort((a, b) => a.time - b.time)

  if (!sawTimestamp) {
    return { lines: [], words: [], synced: false, plain: source.trim() }
  }

  return { lines, words, synced: true }
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

/** Merge two lyric sources, preferring whichever has line timing. */
export function preferSynced(a: Lyrics, b: Lyrics): Lyrics {
  if (a.synced && !b.synced) return a
  if (b.synced && !a.synced) return b
  if (a.lines.length >= b.lines.length) return a
  return b
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
