/**
 * Rasterise `build/icon.svg` to `build/icon.png` at 1024x1024.
 *
 * Why this exists rather than a checked-in binary: electron-builder refuses an
 * SVG for a Windows target and silently falls back to the default Electron icon,
 * so a PNG is required. Rather than add a rasteriser dependency for a one-off,
 * this uses the Chromium that Electron already ships. The output is committed,
 * so this script is a maintenance tool, not a build step.
 *
 * Run: node_modules\.bin\electron.cmd scripts\render-icon.mjs
 */
import { app, BrowserWindow } from "electron"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, "..")
const SIZE = 1024

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  const svg = await readFile(path.join(root, "build", "icon.svg"), "utf8")

  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    useContentSize: true,
    // Offscreen so a build script never flashes a window at the user.
    show: false,
    frame: false,
    transparent: false,
    backgroundColor: "#0d0a18",
    webPreferences: { offscreen: true },
  })

  // The SVG declares a 512 viewBox, so it scales cleanly to any multiple.
  const page = `<!doctype html><meta charset="utf-8">
    <style>
      html, body { margin: 0; padding: 0; background: transparent; }
      svg { display: block; width: ${SIZE}px; height: ${SIZE}px; }
    </style>
    ${svg}`

  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`)
  // One frame of slack: capturePage can race the first paint of a data URL.
  await new Promise((resolve) => setTimeout(resolve, 400))

  const image = await win.webContents.capturePage()
  const png = image.toPNG()
  if (png.length === 0) throw new Error("capturePage returned an empty image")

  await mkdir(path.join(root, "build"), { recursive: true })
  const out = path.join(root, "build", "icon.png")
  await writeFile(out, png)

  const size = image.getSize()
  console.log(`wrote ${out} (${size.width}x${size.height}, ${(png.length / 1024).toFixed(1)} kB)`)

  win.destroy()
  app.quit()
})

app.on("window-all-closed", () => app.quit())
