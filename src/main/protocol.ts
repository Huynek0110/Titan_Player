import { app, net, protocol } from "electron"
import path from "node:path"
import { pathToFileURL } from "node:url"

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

export function publishCover(trackId: string, entry: CoverEntry): void {
  covers.set(trackId, entry)
}

export function clearCovers(keep?: Set<string>): void {
  if (!keep) {
    covers.clear()
    return
  }
  for (const key of [...covers.keys()]) {
    if (!keep.has(key)) covers.delete(key)
  }
}

export function setAudioRoots(roots: string[]): void {
  audioRoots.clear()
  for (const root of roots) audioRoots.add(path.resolve(root))
}

function isAllowedAudio(target: string): boolean {
  const resolved = path.resolve(target)
  for (const root of audioRoots) {
    if (resolved === root) continue
    const rel = path.relative(root, resolved)
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
          "cache-control": "no-cache",
        },
      })
    }

    // media://audio/<url-encoded absolute path>
    if (url.hostname === "audio") {
      const raw = decodeURIComponent(url.pathname.replace(/^\//, ""))
      if (!raw || !isAllowedAudio(raw)) {
        return new Response("forbidden", { status: 403 })
      }
      // net.fetch on a file:// URL honours Range requests, which is what makes
      // seeking in <audio> work.
      return net.fetch(pathToFileURL(raw).toString())
    }

    return new Response("not found", { status: 404 })
  })
}

/** URL builders exposed to the renderer. Strings only, no fs handles. */
export function audioUrl(absolutePath: string): string {
  return `media://audio/${encodeURIComponent(absolutePath)}`
}

export function coverUrl(trackId: string): string {
  return `media://cover/${encodeURIComponent(trackId)}`
}

/** The Windows Music folder, resolved once so the audio jail can include it. */
export function defaultAudioRoot(): string {
  return app.getPath("music")
}
