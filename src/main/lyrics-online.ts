/**
 * Online lyrics lookup.
 *
 * Provider: LRCLib. It is the only credible option — free, no API key, no
 * account, and it serves real LRC with timing rather than scraped plain text.
 * The alternatives are closed: Spotify and Apple expose no lyrics API at all,
 * and Musixmatch and Genius both require credentials for anything resembling
 * bulk access. See RESEARCH-LYRICS-AND-DESIGN.md for the full comparison.
 *
 * Why this runs in the main process rather than the renderer:
 *
 *  - The renderer's Content-Security-Policy stays free of third-party origins.
 *    A `connect-src` widened to a lyrics host is a policy relaxation that exists
 *    only to serve this feature, and it would apply to the whole app for the
 *    whole session rather than only while a lookup is in flight.
 *  - Caching and rate limiting live in one place instead of following the user
 *    between views.
 *  - The preload bridge keeps its rule of carrying plain, already-validated
 *    values. Nothing here returns a URL for the renderer to fetch.
 *
 * Everything crossing back is parsed and size-capped before it leaves, so a
 * hostile or merely broken response cannot reach the lyrics pane as markup or as
 * an unbounded string.
 */
import { createHash } from "node:crypto"
import { promises as fs } from "node:fs"
import path from "node:path"
import { app } from "electron"
import { parseLrc } from "../shared/lyrics.js"
import type { Lyrics } from "../shared/types.js"

const ENDPOINT = "https://lrclib.net/api"
/**
 * A track's lyrics are a few kilobytes. Anything past this is a sign the
 * response is not what it claims to be, and it is refused rather than truncated,
 * because a silently cut lyric file is worse than no lyric file.
 */
const MAX_BYTES = 512 * 1024
const TIMEOUT_MS = 8000
const CACHE_VERSION = 1

/**
 * A real User-Agent identifying the app and a contact, which is what LRCLib asks
 * for. Sending a browser-shaped string would be a lie about who is calling, and
 * the service is free because people identify themselves.
 */
const USER_AGENT = "TitanPlayer/0.1.0 (https://github.com/Huynek0110/Titan_Player)"

export type LookupOutcome = "found" | "not-found" | "offline" | "error" | "disabled"

export interface LookupResult {
  outcome: LookupOutcome
  lyrics: Lyrics | null
  /** Human-readable detail, for the UI and the log. */
  detail?: string
  /** True when the answer came from the on-disk cache rather than the network. */
  cached?: boolean
}

/** The subset of a track this lookup needs. */
export interface LookupTarget {
  id: string
  title: string
  artist: string
  album: string
  /** Seconds. The strongest signal for picking the right recording. */
  duration: number
}

interface CacheEntry {
  /** When the entry was written, for pruning. */
  at: number
  /** Null records a confirmed miss, so a track with no lyrics is not re-queried. */
  lyrics: Lyrics | null
}

/**
 * Collapse the tag noise that makes an exact lookup fail.
 *
 * "Wtf Bby I'm Lit (feat. Marzuz)", "(Remastered 2011)", "- Single Version" and
 * a trailing " - 2011 Remaster" are all things a database indexes under the bare
 * title. Stripping them is what turns a 60% hit rate into a 90% one, and it is
 * also how the search is scored below, so a candidate and the query are folded
 * the same way.
 */
function normaliseTitle(value: string): string {
  return value
    .replace(/\s*[([][^)\]]*(remaster|remix|version|edit|mix|mono|stereo|live|acoustic|bonus)[^)\]]*[)\]]/gi, " ")
    .replace(/\s*[-–—]\s*[^–—]*\b(remaster|remix|version|edit|live|acoustic)\b.*$/i, " ")
    .replace(/\s*[-–—]\s*\d{4}\s*(remaster)?\s*$/i, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function normaliseArtist(value: string): string {
  return value
    // Featured artists are usually not in the database's artist field.
    .replace(/\s*[([]?\s*(feat|ft|featuring|with)\.?\s+[^)\]]+[)\]]?/gi, " ")
    .replace(/\s*&\s*.*$/, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function fold(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/đ/g, "d")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
}

/** Cache key. Metadata rather than the path, so a re-tag or a moved file still hits. */
function cacheKey(target: LookupTarget): string {
  return createHash("sha1")
    .update(
      [fold(target.artist), fold(normaliseTitle(target.title)), Math.round(target.duration)].join(" "),
    )
    .digest("hex")
}

function cacheFile(): string {
  return path.join(app.getPath("userData"), "lyrics-cache.json")
}

let cache: Record<string, CacheEntry> | null = null
let writeQueued: Promise<void> = Promise.resolve()

async function loadCache(): Promise<Record<string, CacheEntry>> {
  if (cache) return cache
  try {
    const raw = await fs.readFile(cacheFile(), "utf8")
    const parsed = JSON.parse(raw) as { version?: number; entries?: Record<string, CacheEntry> }
    // A shape change invalidates the whole file rather than risking a read of
    // entries this version would misinterpret.
    cache = parsed.version === CACHE_VERSION && parsed.entries ? parsed.entries : {}
  } catch {
    cache = {}
  }
  return cache
}

function persistCache(entries: Record<string, CacheEntry>): void {
  writeQueued = writeQueued.then(async () => {
    const file = cacheFile()
    const tmp = `${file}.tmp`
    try {
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(
        tmp,
        JSON.stringify({ version: CACHE_VERSION, entries }),
        "utf8",
      )
      await fs.rename(tmp, file)
    } catch (err) {
      console.warn("[titan] could not write the lyrics cache:", err)
    }
  })
}

/** Drop entries older than a month so the file cannot grow without bound. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

function pruneCache(entries: Record<string, CacheEntry>): Record<string, CacheEntry> {
  const cutoff = Date.now() - MAX_AGE_MS
  const out: Record<string, CacheEntry> = {}
  let dropped = 0
  for (const [key, entry] of Object.entries(entries)) {
    if (entry.at >= cutoff) out[key] = entry
    else dropped += 1
  }
  if (dropped > 0) console.log(`[titan] pruned ${dropped} stale lyrics cache entries`)
  return out
}

async function remember(key: string, lyrics: Lyrics | null): Promise<void> {
  const entries = await loadCache()
  entries[key] = { at: Date.now(), lyrics }
  const pruned = pruneCache(entries)
  persistCache(pruned)
  // Keep the in-memory copy in step with what was written.
  cache = pruned
}

/** The shape LRCLib returns. Only the fields this app reads are typed. */
interface LrclibItem {
  id: number
  trackName: string
  artistName: string
  albumName: string
  duration: number | null
  instrumental: boolean
  plainLyrics: string | null
  syncedLyrics: string | null
}

async function getJson<T>(url: string, signal: AbortSignal): Promise<T | null> {
  const res = await fetch(url, { signal, headers: { Accept: "application/json", "User-Agent": USER_AGENT } })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`LRCLib responded ${res.status}`)
  const text = await res.text()
  if (text.length > MAX_BYTES) throw new Error("response too large")
  return JSON.parse(text) as T
}

/**
 * Score a candidate against the track.
 *
 * Duration is the strongest signal available, because two recordings of the same
 * song by the same artist share a title but not a length, and a lyric file
 * timed for the other one is visibly wrong within seconds of playing. A mismatch
 * of more than a few seconds is treated as a different recording.
 */
function score(item: LrclibItem, target: LookupTarget): number {
  const wantArtist = fold(normaliseArtist(target.artist))
  const wantTitle = fold(normaliseTitle(target.title))
  const gotArtist = fold(item.artistName)
  const gotTitle = fold(item.trackName)

  let value = 0
  if (wantTitle && gotTitle) {
    if (gotTitle === wantTitle) value += 100
    else if (gotTitle.includes(wantTitle) || wantTitle.includes(gotTitle)) value += 70
    else value += 40 * similarity(wantTitle, gotTitle)
  }
  if (wantArtist && gotArtist) {
    if (gotArtist === wantArtist) value += 100
    else if (gotArtist.includes(wantArtist) || wantArtist.includes(gotArtist)) value += 70
    else value += 30 * similarity(wantArtist, gotArtist)
  }

  if (target.duration > 0 && item.duration && item.duration > 0) {
    const delta = Math.abs(item.duration - target.duration)
    if (delta <= 2) value += 120
    else if (delta <= 5) value += 60
    else if (delta <= 12) value -= 80
    else return -1 // a different recording; not a candidate at all
  }

  // Synced lyrics are worth a real amount: they are the whole feature.
  if (item.syncedLyrics) value += 25

  return value
}

/** Token overlap, 0..1. Crude, but enough to rank near-misses. */
function similarity(a: string, b: string): number {
  const at = new Set(a.split(" ").filter(Boolean))
  const bt = new Set(b.split(" ").filter(Boolean))
  if (at.size === 0 || bt.size === 0) return 0
  let shared = 0
  for (const token of at) if (bt.has(token)) shared += 1
  return shared / Math.max(at.size, bt.size)
}

function toLyrics(item: LrclibItem): Lyrics | null {
  if (item.instrumental) return null

  if (item.syncedLyrics) {
    const parsed = parseLrc(item.syncedLyrics)
    if (parsed.synced && parsed.lines.length > 0) {
      return { synced: true, lines: parsed.lines, source: "online" }
    }
  }
  // A plain lyric file is still better than an empty pane.
  if (item.plainLyrics && item.plainLyrics.trim().length > 0) {
    const parsed = parseLrc(item.plainLyrics)
    if (parsed.synced && parsed.lines.length > 0) {
      return { synced: true, lines: parsed.lines, source: "online" }
    }
    return { synced: false, lines: [], plain: item.plainLyrics.trim(), source: "online" }
  }
  return null
}

/**
 * Look up one track.
 *
 * `enabled` is passed in rather than read from the store so this module does not
 * depend on load order, and so the renderer stays the single place a decision to
 * go online is made.
 *
 * `external` lets a caller abandon a lookup that is no longer wanted. Skipping a
 * track should not leave its request running to completion and then overwrite the
 * answer for whatever is playing now.
 */
export async function lookupLyrics(
  target: LookupTarget,
  enabled: boolean,
  external?: AbortSignal,
): Promise<LookupResult> {
  if (!enabled) {
    return { outcome: "disabled", lyrics: null }
  }

  const wantTitle = normaliseTitle(target.title)
  const wantArtist = normaliseArtist(target.artist)
  if (!wantTitle || !wantArtist) {
    return {
      outcome: "not-found",
      lyrics: null,
      detail: "the file is missing an artist or title tag",
    }
  }

  const key = cacheKey(target)
  const entries = await loadCache()
  const hit = entries[key]
  if (hit) {
    return { outcome: hit.lyrics ? "found" : "not-found", lyrics: hit.lyrics, cached: true }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  const onExternalAbort = () => controller.abort()
  external?.addEventListener("abort", onExternalAbort, { once: true })

  try {
    const query = new URLSearchParams({
      track_name: wantTitle,
      artist_name: wantArtist,
    })
    if (target.album.trim()) query.set("album_name", target.album.trim())
    if (target.duration > 0) query.set("duration", String(Math.round(target.duration)))

    // /api/get is a single best guess. /api/search is the fallback, because the
    // single endpoint 404s on a duration that is off by a second, which happens
    // constantly with tags written by hand or rounded by a converter.
    let best: LrclibItem | null = null
    let bestScore = 0

    const direct = await getJson<LrclibItem>(
      `${ENDPOINT}/get?${query.toString()}`,
      controller.signal,
    )
    if (direct) {
      const value = score(direct, target)
      if (value > 0) {
        best = direct
        bestScore = value
      }
    }

    if (!best) {
      const found = await getJson<LrclibItem[]>(
        `${ENDPOINT}/search?${query.toString()}`,
        controller.signal,
      )
      if (Array.isArray(found)) {
        for (const item of found) {
          const value = score(item, target)
          if (value > bestScore) {
            best = item
            bestScore = value
          }
        }
      }
    }

    if (!best || bestScore < 60) {
      // Below the threshold the candidates are a different song with a similar
      // name. Showing those lyrics is worse than showing none, because the user
      // has no way to tell and will trust them.
      await remember(key, null)
      return { outcome: "not-found", lyrics: null }
    }

    const lyrics = toLyrics(best)
    await remember(key, lyrics)
    if (!lyrics) {
      return { outcome: "not-found", lyrics: null, detail: "the match is an instrumental" }
    }
    return {
      outcome: "found",
      lyrics,
      detail: `${best.artistName} — ${best.trackName}`,
    }
  } catch (err) {
    if (controller.signal.aborted) {
      return { outcome: "error", lyrics: null, detail: "the lookup timed out" }
    }
    // A network failure must never surface as a fatal error. The app is a local
    // player; the online lookup is an extra, and losing it changes nothing.
    const message = err instanceof Error ? err.message : String(err)
    console.warn("[titan] online lyrics lookup failed:", message)
    return { outcome: "offline", lyrics: null, detail: message }
  } finally {
    clearTimeout(timer)
    external?.removeEventListener("abort", onExternalAbort)
  }
}

/**
 * Drop the cached answer for a track, including a recorded miss.
 *
 * The escape hatch for a lookup that returned the wrong recording: the user
 * corrects the tags or presses retry, and the next attempt actually reaches the
 * network instead of replaying the same cached miss for a month.
 */
export async function forgetLyrics(target: LookupTarget): Promise<void> {
  const key = cacheKey(target)
  const entries = await loadCache()
  if (!(key in entries)) return
  delete entries[key]
  persistCache(entries)
  console.log("[titan] cleared the cached lyrics lookup for", target.title)
}
