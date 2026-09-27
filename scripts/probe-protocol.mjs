/**
 * Exercises the audio half of the media:// protocol in a real Electron runtime,
 * because that is the only way to know whether `net.fetch` over `file://` can
 * serve these files with Range support. A UI click cannot be trusted as a test
 * signal; this can.
 *
 * Usage: npx electron scripts/probe-protocol.mjs <file>
 */
import { app, net, protocol } from "electron"
import path from "node:path"
import { pathToFileURL } from "node:url"

const target = process.argv[2] ? path.resolve(process.argv[2]) : null
if (!target) {
  console.error("usage: electron scripts/probe-protocol.mjs <file>")
  app.quit()
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: "media",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      bypassCSP: false,
    },
  },
])

const results = []
const log = (line) => {
  results.push(line)
  console.log(line)
}

// Mirrors src/main/protocol.ts serveAudio. Duplicated deliberately: this probe
// runs as plain JS and cannot import the TypeScript module, and the point is to
// prove the approach before trusting it in the app.
const MIME = {
  ".flac": "audio/flac",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
}

async function serveAudio(filePath, request) {
  const fs = await import("node:fs")
  const path = await import("node:path")
  const { Readable } = await import("node:stream")

  let stat
  try {
    stat = await fs.stat(filePath)
  } catch {
    return new Response("not found", { status: 404 })
  }

  const total = stat.size
  const type = MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream"

  let start = 0
  let end = total - 1
  let status = 200

  const range = request.headers.get("Range")
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range)
    if (m) {
      const hasStart = m[1].length > 0
      const hasEnd = m[2].length > 0
      if (hasStart) start = Number(m[1])
      if (hasEnd) end = Number(m[2])
      if (!hasStart && hasEnd) start = Math.max(0, total - Number(m[2]))
      if (start >= total || end < start) {
        return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${total}` } })
      }
      end = Math.min(end, total - 1)
      status = 206
    }
  }

  const headers = {
    "Content-Type": type,
    "Accept-Ranges": "bytes",
    "Content-Length": String(end - start + 1),
  }
  if (status === 206) headers["Content-Range"] = `bytes ${start}-${end}/${total}`
  headers["Cache-Control"] = "no-cache"

  const stream = fs.createReadStream(filePath, { start, end })
  return new Response(Readable.toWeb(stream), { status, headers })
}

app.whenReady().then(async () => {
  protocol.handle("media", async (request) => {
    const url = new URL(request.url)
    if (url.hostname === "audio") {
      const raw = decodeURIComponent(url.pathname.replace(/^\//, ""))
      return serveAudio(raw, request)
    }
    return new Response("not found", { status: 404 })
  })

  log(`file exists: ${target}`)

  // 1. Plain fetch, no Range. This is what an initial play does.
  try {
    const res = await net.fetch(pathToFileURL(target).toString())
    log(`plain fetch      -> status ${res.status} ${res.statusText}`)
    log(`  content-type   : ${res.headers.get("content-type")}`)
    log(`  accept-ranges  : ${res.headers.get("accept-ranges")}`)
    log(`  content-length : ${res.headers.get("content-length")}`)
    const buf = Buffer.from(await res.arrayBuffer())
    log(`  bytes received : ${buf.length}`)
    log(`  first 4 bytes  : ${buf.subarray(0, 4).toString("ascii")} (${buf.subarray(0, 4).toString("hex")})`)
  } catch (err) {
    log(`plain fetch      -> THREW: ${err instanceof Error ? err.message : err}`)
  }

  // 2. With a Range header, which is what seeking sends.
  try {
    const res = await net.fetch(pathToFileURL(target).toString(), {
      headers: { Range: "bytes=0-1023" },
    })
    log(`range fetch      -> status ${res.status} (206 means Range honoured)`)
    log(`  content-range  : ${res.headers.get("content-range")}`)
    const buf = Buffer.from(await res.arrayBuffer())
    log(`  bytes received : ${buf.length}`)
  } catch (err) {
    log(`range fetch      -> THREW: ${err instanceof Error ? err.message : err}`)
  }

  // 3. The real question: can a media element decode it through the protocol?
  const { BrowserWindow } = await import("electron")
  const window = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  })

  // Load from a real file rather than a data: URL. A data: page has an opaque
  // origin, so every media:// request counts as cross-origin and is refused
  // with code 4 regardless of how correct the response is. The packaged app
  // runs on file://, so the probe has to match that or it proves nothing.
  const { writeFile, unlink } = await import("node:fs/promises")
  const os = await import("node:os")
  const htmlPath = path.join(os.tmpdir(), "titan-probe.html")
  const mediaUrl = `media://audio/${encodeURIComponent(target)}`
  await writeFile(
    htmlPath,
    `<!doctype html><meta charset="utf-8"><body><script>
      window.__r = new Promise((resolve) => {
        const a = new Audio();
        a.addEventListener('loadedmetadata', () => resolve(
          'loadedmetadata duration=' + a.duration.toFixed(2) + 's readyState=' + a.readyState));
        a.addEventListener('error', () => resolve('ERROR code=' + (a.error ? a.error.code : '?')));
        setTimeout(() => resolve('timeout readyState=' + a.readyState), 8000);
        a.src = ${JSON.stringify(mediaUrl)};
      });
    </script></body>`,
    "utf8",
  )

  await window.loadFile(htmlPath)
  log(`media element    -> ${await window.webContents.executeJavaScript("window.__r")}`)

  // 4. Can it actually start playing?
  const play = await window.webContents.executeJavaScript(`(async () => {
    const a = new Audio();
    a.src = ${JSON.stringify(mediaUrl)};
    try {
      await a.play();
      await new Promise(r => setTimeout(r, 1200));
      return 'PLAYING currentTime=' + a.currentTime.toFixed(2) + 's of ' + a.duration.toFixed(2) + 's';
    } catch (e) {
      return 'play() rejected: ' + e.name + ' - ' + e.message;
    }
  })()`)
  log(`playback         -> ${play}`)

  // 5. Seeking, which needs the range path.
  const seek = await window.webContents.executeJavaScript(`(async () => {
    const a = new Audio();
    a.src = ${JSON.stringify(mediaUrl)};
    try {
      await a.play();
      a.currentTime = 40;
      await new Promise(r => setTimeout(r, 1200));
      return 'seeked to ' + a.currentTime.toFixed(2) + 's readyState=' + a.readyState;
    } catch (e) {
      return 'seek failed: ' + e.message;
    }
  })()`)
  log(`seek to 40s      -> ${seek}`)

  /*
   * The decisive test: load the same bytes straight off disk with no custom
   * protocol involved. If this also fails, the problem is Chromium refusing the
   * file itself — a known issue with FLAC whose METADATA_BLOCK_PICTURE block has
   * a malformed MIME type, which makes the demuxer reject the whole file — and
   * no amount of protocol work will fix it.
   */
  const { pathToFileURL } = await import("node:url")
  const directUrl = pathToFileURL(target).toString()
  const direct = await window.webContents.executeJavaScript(`(async () => {
    const a = new Audio();
    a.src = ${JSON.stringify(directUrl)};
    return await new Promise((resolve) => {
      a.addEventListener('loadedmetadata', () => {
        a.play().then(() => setTimeout(() => resolve(
          'DIRECT file:// PLAYS duration=' + a.duration.toFixed(2) + 's t=' + a.currentTime.toFixed(2)),
          1200)).catch(e => resolve('metadata ok but play rejected: ' + e.name));
      });
      a.addEventListener('error', () => resolve('DIRECT file:// ERROR code=' + (a.error ? a.error.code : '?')));
      setTimeout(() => resolve('DIRECT file:// timeout readyState=' + a.readyState), 8000);
    });
  })()`)
  log(direct)

  await unlink(htmlPath).catch(() => {})
  window.destroy()
  app.quit()
})
