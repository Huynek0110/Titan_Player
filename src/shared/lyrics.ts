import type { LyricLine, LyricWord, Lyrics } from "./types.js"

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

export interface ParsedLyrics {
  lines: LyricLine[]
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

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value
}

/**
 * Split an Enhanced LRC body into timed words.
 *
 * A `<...>` tag *prefixes* the word that follows it, so each text segment is
 * timed by the tag in front of it and text ahead of the first tag falls back to
 * the line's own timestamp. Getting that wrong is worth naming: an earlier
 * version timed every segment by the tag that *followed* it, so every word lit
 * up one word early.
 *
 * The character offsets cannot be read off the body, because the line's own text
 * is built by stripping tags and collapsing whitespace. Searching forward for
 * each segment in the finished text keeps the two aligned, and a segment that
 * cannot be found verbatim degrades to a running position rather than costing
 * the whole line its timing.
 */
function extractWords(body: string, text: string, lineTime: number): LyricWord[] | undefined {
  // Cheap gate: no "<" means no `<...>` tag, and the loop below is the only
  // authority on that.
  if (!body.includes("<")) return undefined

  const segments: Array<{ time: number; text: string }> = []
  let cursor = 0
  let pending = lineTime
  let tags = 0
  WORD_TAG.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = WORD_TAG.exec(body)) !== null) {
    const chunk = body.slice(cursor, match.index)
    if (chunk.trim().length > 0) segments.push({ time: pending, text: chunk })
    pending = toSeconds(match[1], match[2], match[3])
    cursor = match.index + match[0].length
    tags++
  }
  if (tags === 0) return undefined
  const tail = body.slice(cursor)
  if (tail.trim().length > 0) segments.push({ time: pending, text: tail })

  const starts: Array<{ time: number; start: number }> = []
  let at = 0
  for (const segment of segments) {
    const needle = segment.text.replace(/\s+/g, " ").trim()
    if (needle.length === 0) continue
    const found = text.indexOf(needle, at)
    const start = found >= 0 ? found : at
    at = Math.min(text.length, start + needle.length)
    starts.push({ time: segment.time, start })
  }
  // A single word is not a karaoke fill: there is no segment to interpolate
  // across, so the caller has to fall back to the line-span sweep.
  if (starts.length < 2) return undefined

  // The fill walks the words in text order and the bracketing search walks them
  // in time order, so both have to agree. A file whose word tags run backwards
  // has no single correct sweep to draw, and sorting by time would make the fill
  // run right-to-left through the words ΓÇö so the timing is dropped instead and
  // the line falls back to the line-span sweep. Every real Enhanced LRC file is
  // already in order, so this costs nothing.
  for (let i = 1; i < starts.length; i++) {
    if (starts[i].time < starts[i - 1].time) return undefined
  }

  return starts.map((word, i) => ({
    time: word.time,
    start: word.start,
    // Ends are derived here, and the final word runs to the end of the line so
    // the trailing sweep has somewhere to reach.
    end: i + 1 < starts.length ? starts[i + 1].start : text.length,
  }))
}

/** Parse raw LRC text. Never throws; malformed input degrades to plain text. */
export function parseLrc(raw: string): ParsedLyrics {
  const source = raw.replace(/\r\n?/g, "\n").replace(/\u0000/g, "")
  const lines: LyricLine[] = []
  // Positive offset shifts lyrics earlier, so subtract it as the times are read
  // rather than in a pass at the end. Mutating afterwards meant a line carrying
  // two timestamps ΓÇö which shares one `words` array ΓÇö had that array shifted
  // twice.
  const offsetSeconds = readOffset(source) / 1000
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
      lines.push({ time: Math.max(0, start - offsetSeconds), text })
    }

    // Word-level timing, only meaningful when the body carries <...> tags.
    // Built once and shared by every copy of the line, so a doubled timestamp
    // does not duplicate the work.
    const words = extractWords(body, text, Math.max(0, stamps[0] - offsetSeconds))
    if (words) {
      for (const word of words) word.time = Math.max(0, word.time - offsetSeconds)
      for (const entry of lines.slice(-stamps.length)) entry.words = words
    }
  }

  if (!sawTimestamp) {
    return { lines: [], synced: false, plain: source.trim() }
  }

  lines.sort((a, b) => a.time - b.time)

  return { lines, synced: true }
}

/**
 * One run of text with a character range in the line it came from.
 *
 * The ranges concatenate back to the line exactly, which is the property the
 * whole word-timing path depends on: `extractWords` rebuilds offsets by
 * *searching* for each segment in the parsed text, so a set of segments that
 * does not reassemble is one it cannot align.
 */
export interface WordSegment {
  text: string
  start: number
  end: number
}

/**
 * Split a line into the units a word sweep can be timed against.
 *
 * Whitespace is carried inside a segment rather than left between them, for the
 * same reason the renderer puts it inside the span: a gap between two segments
 * is a region no word owns, so it would never light up. Leading whitespace
 * belongs to the first segment for the same reason — the contract is that the
 * segments reassemble the line, and a caller cannot verify that if the leading
 * spaces quietly go missing.
 *
 * A string that is nothing but whitespace comes back as one segment covering
 * all of it, for the same reason. Callers drop such lines themselves; quietly
 * returning nothing here would make the reassembly property untestable.
 */
export function splitWords(text: string): WordSegment[] {
  if (text.length === 0) return []
  if (text.trim().length === 0) return [{ text, start: 0, end: text.length }]
  const out: WordSegment[] = []
  const run = /\s*\S+\s*/g
  let match: RegExpExecArray | null
  while ((match = run.exec(text)) !== null) {
    out.push({ text: match[0], start: match.index, end: match.index + match[0].length })
  }
  return out
}

/**
 * Format seconds as an LRC `mm:ss.xx` timestamp.
 *
 * The fraction is **floored, never rounded**, and the reason is worth being
 * precise about, because the obvious justification is wrong: rounding is
 * monotonic, so it can never reverse the order of two stamps the way this file
 * once could.
 *
 * What rounding actually does is *collapse* two genuinely distinct timestamps
 * onto one centisecond. Words 4ms apart at 12.998s and 13.002s round to 13.00
 * and 13.00, and a zero-length segment is not a sweep: `wordFillFraction` has to
 * treat a `step` under a millisecond as "finish this word immediately", so the
 * two words light up together and the line reads as one movement. Floored they
 * stay 12.99 and 13.00, and the sweep advances.
 *
 * The same collapse hits line tags: two lines 4ms apart would come back from
 * `parseLrc` as two entries with an identical time, and the one after the other
 * would jump in with no interval to interpolate across.
 *
 * Flooring also never writes a time later than the true one, so a saved lyric is
 * never *ahead* of the singer — the error that is audible, rather than the one
 * that merely wastes precision.
 *
 * Computed from the total in centiseconds rather than from the seconds field
 * and a separate fraction, so a carry out of the fraction cannot be written as
 * `.100` — which a parser would read as 0.1s and not as 1.0s.
 */
function formatStamp(seconds: number): string {
  const total = Math.max(0, Number.isFinite(seconds) ? seconds : 0)
  const centis = Math.floor(total * 100)
  const minutes = Math.floor(centis / 6000)
  const secs = Math.floor(centis / 100) % 60
  const frac = centis % 100
  return (
    `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.` +
    `${String(frac).padStart(2, "0")}`
  )
}

export interface LrcMeta {
  title?: string
  artist?: string
  album?: string
  /** Track length in seconds, written as the conventional `[length:]` tag. */
  length?: number
}

/**
 * Why a line's word timing could not be written.
 *
 * Reported rather than swallowed, because every one of these means the line
 * silently loses its karaoke sweep and the user has no other way to find out. An
 * editor that showed the same line as the one next to it, and nothing about
 * why, would be indistinguishable from a bug.
 */
export type WordBodyReason =
  | "no-words"
  | "single-word"
  | "gap"
  | "overlap"
  | "short-cover"
  | "backwards"

export type WordBody =
  | { kind: "words"; body: string }
  | { kind: "line"; reason: WordBodyReason }

/**
 * Build the text that follows a line's `[mm:ss.xx]` tag.
 *
 * When the line carries word timing, each segment is emitted as
 * `<mm:ss.xx>text`. Otherwise the plain line is returned, so a line with no
 * timing at all is a valid line-level lyric rather than an error.
 *
 * Every way the word array can be unusable is a *degrade*, not a throw. A
 * half-timed line saved as a line-level lyric still displays correctly; a
 * half-timed line saved as word timing displays a sweep that jumps ahead of the
 * voice, which is worse than no sweep.
 */
function wordsToBody(text: string, line: LyricLine): WordBody {
  const words = line.words
  if (!words || words.length === 0) return { kind: "line", reason: "no-words" }
  // A single timed word is not a fill: there is nothing to interpolate across.
  if (words.length < 2) return { kind: "line", reason: "single-word" }

  const parts: string[] = []
  let at = 0
  let previousTime = -Infinity
  for (const word of words) {
    if (!Number.isFinite(word.time) || !Number.isInteger(word.start) || !Number.isInteger(word.end)) {
      return { kind: "line", reason: "gap" }
    }
    if (word.time < previousTime) return { kind: "line", reason: "backwards" }
    previousTime = word.time
    if (word.start > at) return { kind: "line", reason: "gap" }
    if (word.start < at) return { kind: "line", reason: "overlap" }
    if (word.end <= word.start) return { kind: "line", reason: "overlap" }
    if (word.end > text.length) return { kind: "line", reason: "short-cover" }
    parts.push(`<${formatStamp(word.time)}>${text.slice(word.start, word.end)}`)
    at = word.end
  }
  if (at < text.length) return { kind: "line", reason: "short-cover" }
  return { kind: "words", body: parts.join("") }
}

/** Strip the characters that would break out of an `[id:value]` tag. */
function idValue(value: string): string {
  return value.replace(/[\r\n\]]/g, " ").trim()
}

/**
 * Serialise lines back to LRC text.
 *
 * The counterpart to `parseLrc`, and the round trip is the point: this is what
 * the editor saves, and `parseLrc` is what reads it back. It has to be exact
 * rather than close, because the only test available is whether the file that
 * comes back still shows the same lyric in the same place.
 *
 * The text of every line is whitespace-collapsed and trimmed on the way out,
 * because the parser does the same to the text it reads. A line written with a
 * double space or a trailing one would come back with different character
 * offsets than the words recorded against it, and every word after the first
 * discrepancy would be drawn in the wrong place.
 *
 * Lines come out in time order even if they went in unsorted, since that is
 * what every LRC reader assumes and `parseLrc` would only sort on the way back
 * in anyway.
 */
export function formatLrc(lines: readonly LyricLine[], meta?: LrcMeta): string {
  const out: string[] = []

  if (meta) {
    if (meta.title) out.push(`[ti:${idValue(meta.title)}]`)
    if (meta.artist) out.push(`[ar:${idValue(meta.artist)}]`)
    if (meta.album) out.push(`[al:${idValue(meta.album)}]`)
    if (meta.length !== undefined && meta.length > 0) {
      // `[length:]` is conventionally mm:ss with no fraction.
      out.push(`[length:${formatStamp(meta.length).slice(0, 5)}]`)
    }
    out.push("[by:Titan Player]")
  }

  const ordered = [...lines].sort((a, b) => a.time - b.time)
  for (const line of ordered) {
    const text = line.text.replace(/\s+/g, " ").trim()
    if (text.length === 0) continue
    const body = wordsToBody(text, line)
    out.push(`[${formatStamp(line.time)}]${body.kind === "words" ? body.body : text}`)
  }

  return out.length === 0 ? "" : `${out.join("\n")}\n`
}

/**
 * Why a line's word timing will not be written, or null when it will be.
 *
 * The editor asks this before showing a line as karaoke, so the two answers
 * cannot disagree: both go through `wordsToBody`.
 */
export function wordBodyProblem(line: LyricLine): WordBodyReason | null {
  const text = line.text.replace(/\s+/g, " ").trim()
  if (text.length === 0) return "no-words"
  const body = wordsToBody(text, line)
  return body.kind === "words" ? null : body.reason
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
  if (a.synced && b.synced) {
    if (a.lines.length !== b.lines.length) return a.lines.length > b.lines.length ? a : b
    // Equal line counts are a genuine tie, so the first argument wins. Per-word
    // timing used to break it, and the parser still produces it, but nothing in
    // the interface reads it any more.
    return a
  }
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

/**
 * How far through the active line the karaoke fill should be, as a 0-1 fraction
 * of the line's rendered width.
 *
 * Word timing is used when the file provides it, and the line's own time span is
 * used when it does not. That fallback is the *guaranteed* path, not a
 * degraded one: FLAC only ever stores LRC in a Vorbis comment, which is
 * line-level, and the MP3 `SYLT` frame that is genuinely word-level is written
 * by almost nothing. So the line-span sweep has to read correctly on its own and
 * word timing is a bonus for the files that happen to carry it.
 *
 * Pure, so it can be called once per animation frame without allocating, and it
 * takes the already-offset time from the caller rather than reading a clock.
 */
export function lineFillFraction(
  line: LyricLine,
  lineEnd: number | undefined,
  time: number,
): number {
  const words = line.words
  if (words && words.length >= 2) {
    const fraction = wordFillFraction(words, line.text.length, lineEnd, time)
    if (fraction !== null) return fraction
  }
  // Hold the line fully filled if there is no following timestamp to interpolate
  // towards, rather than snapping back to empty.
  const span = lineEnd !== undefined ? Math.max(0.35, lineEnd - line.time) : 6
  return clamp01((time - line.time) / span)
}

/**
 * Fill position interpolated between the two words bracketing `time`.
 *
 * Returns null when the line has no usable word timing, which tells the caller
 * to use the line-span sweep rather than guessing. Character counts stand in for
 * widths: measuring the text would force layout on every frame, and proportional
 * glyph widths make the difference between the two a few percent of a character.
 */
function wordFillFraction(
  words: readonly LyricWord[],
  textLength: number,
  lineEnd: number | undefined,
  time: number,
): number | null {
  if (textLength <= 0) return null

  const first = words[0]
  const last = words[words.length - 1]
  if (time <= first.time) return 0

  if (time >= last.time) {
    // The tail of a line has no word of its own, so the last segment sweeps from
    // the start of the final word to the end of the text, finishing when the line
    // does.
    const finish = lineEnd !== undefined ? Math.max(last.time + 0.35, lineEnd) : last.time + 2
    const k = (time - last.time) / (finish - last.time)
    return clamp01((last.start + clamp01(k) * (textLength - last.start)) / textLength)
  }

  let lo = 0
  let hi = words.length - 1
  let i = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (words[mid].time <= time) {
      i = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  if (i < 0) return 0
  const word = words[i]
  const next = words[i + 1]
  // Several words sharing one timestamp: finish that word rather than dividing
  // by a zero-length segment.
  const step = next.time - word.time
  const k = step > 0.001 ? clamp01((time - word.time) / step) : 1
  return clamp01((word.start + k * (word.end - word.start)) / textLength)
}

