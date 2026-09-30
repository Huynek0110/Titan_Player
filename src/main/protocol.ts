import { protocol } from "electron"
import fs from "node:fs"
import { Readable } from "node:stream"
import path from "node:path"
import { DEFAULT_EXTENSIONS } from "../shared/types.js"

/**
 * A privileged `media://` scheme serving cover art and audio bytes.
 *
 * Why not base64 data URLs over IPC: a 400 KB cover inflates to ~533 KB of
 * JSON, so a thousand-track library would push half a gigabyte across the
 * bridge on first scan. Serving from a protocol keeps the bytes out of the IPC
 * layer entirely, stays lazy, and lets the HTTP cache dedupe one shared cover
 * across every track on an album.
 *
 * The audio half also solves a dev-mode problem: in development the renderer is
 * served from `http://localhost`, which cannot load a `file://` media source.
 * Routing both through one scheme makes dev and production behave identically.
 */

export interface CoverEntry {
  mime: string
  bytes: Uint8Array
}

/** Cover art keyed by track id. Populated during a library scan. */
const covers = new Map<string, CoverEntry>()

/** Absolute paths a user has explicitly added. Audio outside these is refused. */
const audioRoots = new Set<string>()

/**
 * Extensions the jail will serve.
 *
 * The jail's purpose is that a music root cannot be used to read arbitrary files
 * that happen to live under it, so it needs an allowlist. It starts from the
 * shared default and is then widened by whatever the user has configured, because
 * the extension list is editable in Settings and the scanner honours it: a
 * hardcoded list meant that adding `.m4b` produced tracks that appeared in the
 * library and then failed every play with a 403, which surfaces as a confident
 * and completely wrong "unsupported format" message.
 *
 * Only a leading dot and alphanumeric characters are accepted, so a
 * misconfigured value cannot turn the allowlist into a wildcard.
 */
let audioExt = new Set(DEFAULT_EXTENSIONS.map((e) => e.toLowerCase()))

function setAudioExtensions(extensions: readonly string[]): void {
  const next = new Set<string>()
  for (const raw of extensions) {
    const ext = raw.trim().toLowerCase()
    if (!/^\.[a-z0-9]{1,8}$/.test(ext)) continue
    next.add(ext)
  }
  // Never let a bad configuration empty the allowlist, which would make the app
  // unable to play anything at all.
  audioExt = next.size > 0 ? next : new Set(DEFAULT_EXTENSIONS)
}

export function publishCover(trackId: string, entry: CoverEntry): void {
  covers.set(trackId, entry)
}

/** Keep only the covers whose track is still in the library. */
export function pruneCovers(keep: Set<string>): void {
  for (const key of [...covers.keys()]) {
    if (!keep.has(key)) covers.delete(key)
  }
}

export function setAudioRoots(roots: string[]): void {
  audioRoots.clear()
  for (const root of roots) {
    // Normalise case here so the comparison downstream is case-insensitive.
    audioRoots.add(path.resolve(root).toLowerCase())
  }
}

/**
 * Update the served extension list. Called with the user's configured
 * extensions at every scan, so the jail and the scanner never disagree about
 * what counts as a track.
 */
export function configureAudioExtensions(extensions: readonly string[]): void {
  setAudioExtensions(extensions)
}

/**
 * Whether `target` sits inside one of the trusted roots.
 *
 * The comparison is case-insensitive because `path.win32.relative` folds
 * nothing while NTFS is case-preserving only. Skipping this makes a folder
 * renamed from `Music` to `music` start failing with a 403, which reads as a
 * playback bug rather than a permissions one.
 *
 * Exported because the lyrics writer needs the same guarantee for a different
 * reason: it turns a path the renderer supplied into a file it writes to. That
 * is a strictly larger privilege than serving it, so it is gated on the identical
 * check rather than on a second, subtly different one.
 */
export function isAllowedAudio(target: string): boolean {
  const resolved = path.resolve(target)
  if (!audioExt.has(path.extname(resolved).toLowerCase())) return false

  const lowered = resolved.toLowerCase()
  for (const root of audioRoots) {
    if (lowered === root) continue
    const rel = path.relative(root, lowered)
    // A leading ".." or an absolute result means the path escaped the root.
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return true
  }
  return false
}

/** Must run before `app.whenReady()`. */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: "media",
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        // Required for the palette extractor. Without it the cover response is
        // opaque to the renderer, `getImageData` throws a SecurityError, and
        // the accent colour silently falls back to the default.
        corsEnabled: true,
        // Without `stream`, Chromium buffers the whole response and seeking
        // stops working on long tracks.
        stream: true,
        bypassCSP: false,
      },
    },
  ])
}

/** Must run after `app.whenReady()`. */
export function handleMediaProtocol(): void {
  protocol.handle("media", async (request) => {
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return new Response("bad request", { status: 400 })
    }

    // media://cover/<trackId>
    if (url.hostname === "cover") {
      const key = decodeURIComponent(url.pathname.replace(/^\//, ""))
      const hit = covers.get(key)
      if (!hit) return new Response("not found", { status: 404 })
      return new Response(hit.bytes, {
        headers: {
          "content-type": hit.mime,
          // Lets the renderer read the pixels for palette extraction.
          "access-control-allow-origin": "*",
          "x-content-type-options": "nosniff",
          // An immutable id means the bytes cannot change, so let the HTTP
          // cache dedupe one shared album cover across every track.
          "cache-control": "public, max-age=31536000, immutable",
        },
      })
    }

    // media://audio/<url-encoded absolute path>
    if (url.hostname === "audio") {
      const raw = decodeURIComponent(url.pathname.replace(/^\//, ""))
      if (!raw || !isAllowedAudio(raw)) {
        return new Response("forbidden", { status: 403 })
      }

      /*
       * Served here rather than delegated to `net.fetch`, and the reason is
       * seeking.
       *
       * `net.fetch` on a `file://` URL loads and plays correctly, but the
       * response it produces does not advertise `Accept-Ranges`, and Chromium
       * therefore reports the media as non-seekable: `seekable.end(0)` stays 0
       * and every attempt to set `currentTime` is silently ignored. Playback
       * works, `readyState` reaches 4, the duration is right, and dragging the
       * seek bar does nothing at all — with no error anywhere. Doing it by hand
       * means the range handling, the `206` and the `Content-Range` header are
       * all explicit, and the audio element can actually seek.
       */
      return serveAudioFile(raw, request.headers.get("Range"))
    }

    return new Response("not found", { status: 404 })
  })
}

/** Content types for the formats the scanner will find. */
const AUDIO_MIME: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".m4b": "audio/mp4",
  ".mp4": "audio/mp4",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".wav": "audio/wav",
  ".aif": "audio/aiff",
  ".aiff": "audio/aiff",
  ".ape": "audio/x-ape",
  ".wv": "audio/x-wavpack",
  ".wma": "audio/x-ms-wma",
}

/**
 * Parse a single byte range.
 *
 * Only the forms a media element actually sends are handled: `bytes=start-`,
 * `bytes=start-end` and `bytes=-suffix`. Anything else returns null, which the
 * caller answers with the whole file — a 200 is always a valid response to a
 * range request, so an unparseable header degrades to "plays from the start"
 * rather than to an error.
 */
function parseRange(header: string | null, size: number): { start: number; end: number } | null {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null

  const [, rawStart, rawEnd] = match
  if (rawStart === "" && rawEnd === "") return null

  let start: number
  let end: number
  if (rawStart === "") {
    // A suffix range: the final N bytes.
    const suffix = Number(rawEnd)
    if (!Number.isFinite(suffix) || suffix <= 0) return null
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === "" ? size - 1 : Number(rawEnd)
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  if (start > end || start >= size) return null
  return { start, end: Math.min(end, size - 1) }
}

async function serveAudioFile(absolute: string, rangeHeader: string | null): Promise<Response> {
  let size: number
  try {
    // `fs.promises`, not `fs`: the callback form returns void rather than
    // rejecting, so `await fs.stat(...)` yields undefined and every property
    // read below fails with a confusing error instead of a 404.
    const stat = await fs.promises.stat(absolute)
    if (!stat.isFile()) return new Response("not a file", { status: 404 })
    size = stat.size
  } catch {
    return new Response("not found", { status: 404 })
  }

  const type = AUDIO_MIME[path.extname(absolute).toLowerCase()] ?? "application/octet-stream"
  // Sent on every response, including the 200. A media element decides whether
  // it can seek from this header, so omitting it on the first response is enough
  // to make the whole resource non-seekable even though later ranges would work.
  const base = {
    "content-type": type,
    "accept-ranges": "bytes",
    "access-control-allow-origin": "*",
    "x-content-type-options": "nosniff",
    // The bytes never change for a given path, and a range response must not be
    // cached separately from the full one or a seek can read a stale slice.
    "cache-control": "no-cache",
  } as const

  const range = parseRange(rangeHeader, size)
  if (!range) {
    const stream = Readable.toWeb(fs.createReadStream(absolute)) as ReadableStream<Uint8Array>
    return new Response(stream, { status: 200, headers: { ...base, "content-length": String(size) } })
  }

  const { start, end } = range
  const stream = Readable.toWeb(
    fs.createReadStream(absolute, { start, end }),
  ) as ReadableStream<Uint8Array>
  return new Response(stream, {
    status: 206,
    headers: {
      ...base,
      "content-length": String(end - start + 1),
      "content-range": `bytes ${start}-${end}/${size}`,
    },
  })
}

/*
 * No URL builders live here. The preload bridge builds both URLs itself, from
 * plain strings, so the renderer never needs a handle into this module and the
 * scheme's shape has exactly one definition. Duplicating them in the main
 * process meant two places to keep in step and neither was imported.
 */
