/**
 * Isolates why a media element refuses a custom-protocol audio source.
 *
 * Established already: the same FLAC plays fine straight off disk over file://,
 * so the file is not the problem. This compares candidate handler strategies
 * from an identical file:// origin, because that is what the packaged app uses.
 *
 * Usage: npx electron scripts/probe-strategies.mjs <file>
 */
import { app, net, protocol, BrowserWindow } from "electron"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { Readable } from "node:stream"
import { pathToFileURL } from "node:url"

const target = process.argv[2] ? path.resolve(process.argv[2]) : null
if (!target) {
  console.error("usage: electron scripts/probe-strategies.mjs <file>")
  app.quit()
}

const log = (line) => console.log(line)

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

// A: the manual range-capable stream.
async function strategyStream(filePath, request) {
  const stat = await fs.promises.stat(filePath)
  const total = stat.size
  let start = 0
  let end = total - 1
  let status = 200
  const range = request.headers.get("Range")
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range)
    if (m) {
      if (m[1]) start = Number(m[1])
      if (m[2]) end = Number(m[2])
      if (!m[1] && m[2]) start = Math.max(0, total - Number(m[2]))
      if (start >= total || end < start) {
        return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${total}` } })
      }
      end = Math.min(end, total - 1)
      status = 206
    }
  }
  const headers = {
    "Content-Type": "audio/flac",
    "Accept-Ranges": "bytes",
    "Content-Length": String(end - start + 1),
  }
  if (status === 206) headers["Content-Range"] = `bytes ${start}-${end}/${total}`
  return new Response(Readable.toWeb(fs.createReadStream(filePath, { start, end })), { status, headers })
}

// B: hand the whole file over as bytes, no range, no streaming.
async function strategyWholeFile(filePath) {
  const buf = await fs.promises.readFile(filePath)
  return new Response(buf, {
    status: 200,
    headers: { "Content-Type": "audio/flac", "Content-Length": String(buf.length) },
  })
}

// C: net.fetch over file://, forwarding Range.
async function strategyNetFetch(filePath, request) {
  const headers = new Headers()
  const range = request.headers.get("Range")
  if (range) headers.set("Range", range)
  return net.fetch(pathToFileURL(filePath).toString(), { headers })
}

// D: net.fetch over file:// with the custom-handler bypass.
async function strategyNetFetchBypass(filePath, request) {
  return net.fetch(request, { bypassCustomProtocolHandlers: true })
}

const STRATEGIES = { stream: strategyStream, whole: strategyWholeFile, net: strategyNetFetch, bypass: strategyNetFetchBypass }
let active = "stream"

app.whenReady().then(async () => {
  protocol.handle("media", (request) => {
    const url = new URL(request.url)
    const file = decodeURIComponent(url.pathname.replace(/^\//, ""))
    return STRATEGIES[active](file, request)
  })

  const window = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  })
  const htmlPath = path.join(os.tmpdir(), "titan-strategies.html")
  await fs.promises.writeFile(htmlPath, "<!doctype html><meta charset='utf-8'><body>", "utf8")
  await window.loadFile(htmlPath)

  const mediaUrl = `media://audio/${encodeURIComponent(target)}`
  const directUrl = pathToFileURL(target).toString()

  const tryPlay = async (url) =>
    window.webContents.executeJavaScript(`(async () => {
      const a = new Audio();
      a.src = ${JSON.stringify(url)};
      return await new Promise((resolve) => {
        a.addEventListener('loadedmetadata', () => {
          a.play().then(() => setTimeout(() => resolve('PLAYS ' + a.duration.toFixed(1) + 's t=' + a.currentTime.toFixed(2)),
            1200)).catch(e => resolve('meta ok, play rejected: ' + e.name));
        });
        a.addEventListener('error', () => resolve('ERROR code=' + (a.error ? a.error.code : '?')));
        setTimeout(() => resolve('timeout readyState=' + a.readyState), 7000);
      });
    })()`)

  log(`baseline direct file:// -> ${await tryPlay(directUrl)}`)
  log("")
  for (const name of Object.keys(STRATEGIES)) {
    active = name
    log(`media:// via ${name.padEnd(7)} -> ${await tryPlay(mediaUrl)}`)
  }

  await fs.promises.unlink(htmlPath).catch(() => {})
  window.destroy()
  app.quit()
})
