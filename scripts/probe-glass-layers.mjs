/**
 * Which layer is eating the backdrop?
 *
 * The blurred cover is configured correctly and the cover loads, yet the result is
 * much darker than the reference at comparable settings. Something between the
 * picture and the eye is dimming it, and the candidates are a fixed list: the
 * scrim, the palette tint, the grain, and the panels.
 *
 * Rather than reason about the alpha values, this hides each layer in turn and
 * captures the same crop each time. A layer whose removal makes the picture jump
 * is the one doing the work, and a layer whose removal changes nothing was never
 * in the way.
 *
 * "Picture strength" is the standard deviation of the luminance across the crop.
 * A flat field has almost none however dark or light it is, which is the whole
 * problem being measured: a backdrop that is technically present but uniform
 * reads as a black panel.
 *
 * Usage: node scripts\probe-glass-layers.mjs <cdpPort> <outDir>
 */
import { writeFileSync } from "node:fs"

const port = process.argv[2] ?? "9222"
const outDir = process.argv[3] ?? "."

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = list.find((t) => t.type === "page" && !/mini\.html/.test(t.url))
if (!page) {
  console.error("no main page target")
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
const pending = new Map()
let nextId = 1
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
  }
})
await new Promise((r) => ws.addEventListener("open", r, { once: true }))

const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = nextId++
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })

const evaluate = async (expression) => {
  const res = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })
  if (res.result?.exceptionDetails) return { threw: res.result.exceptionDetails.text }
  return res.result?.result?.value
}

const art = await evaluate(
  `getComputedStyle(document.documentElement).getPropertyValue('--art') || ''`,
)
if (!art || art === "none") {
  console.log("no cover is loaded, so there is nothing to measure. Start a track first.")
  process.exit(1)
}

// A crop in the gutter between the sidebar and the content card, where the
// backdrop is fully visible and no panel is in the way.
const crop = await evaluate(`(() => {
  const side = document.querySelector('.sidebar').getBoundingClientRect()
  const main = document.querySelector('.app-main').getBoundingClientRect()
  return {
    x: Math.round(side.right + (main.left - side.right) / 2 - 30),
    y: Math.round(innerHeight * 0.3),
    width: 60,
    height: 400,
  }
})()`)

/*
 * Luminance spread, measured in the page rather than by decoding a PNG.
 *
 * The gutter crop is composited by the browser, and there is no API to read a
 * rendered pixel. What there *is* is the ability to hide every layer, in which
 * case the crop shows the raw art — and hiding them one at a time and comparing
 * screenshots is enough for a human to see which layer mattered, and cheap enough
 * to do for each.
 */
const hide = (selectors, on) => `(() => {
  for (const sel of ${JSON.stringify(selectors)}) {
    const el = document.querySelector(sel)
    if (!el) continue
    el.style.visibility = ${on ? "hidden" : ""}
  }
  return true
})()`

const LAYERS = [
  { name: "everything on", hide: [] },
  { name: "no scrim", hide: [] },
  { name: "no palette tint", hide: [".ambient"] },
  { name: "no grain", hide: [".grain"] },
  { name: "no panels", hide: [".sidebar", ".app-main", ".playerbar"] },
  { name: "raw art only", hide: [".ambient", ".grain", ".sidebar", ".app-main", ".playerbar"] },
]

for (const layer of LAYERS) {
  if (layer.name === "no scrim") {
    // The scrim is a pseudo-element, so it is hidden by zeroing the parent's
    // ::after rather than by touching the layer list.
    await evaluate(`(() => {
      const s = document.createElement('style')
      s.id = '__probe-noscrim'
      s.textContent = '.ambient-art::after { display: none !important }'
      document.head.appendChild(s)
      return true
    })()`)
  } else {
    await evaluate(hide(layer.hide, true))
  }
  await new Promise((r) => setTimeout(r, 500))
  const res = await send("Page.captureScreenshot", {
    format: "png",
    clip: { ...crop, scale: 1 },
  })
  const file = `${outDir}/layer-${layer.name.replace(/\s+/g, "-")}.png`
  writeFileSync(file, Buffer.from(res.result.data, "base64"))
  console.log("captured", file)
}

await evaluate(`(() => {
  document.getElementById('__probe-noscrim')?.remove()
  for (const sel of ['.ambient', '.grain', '.sidebar', '.app-main', '.playerbar']) {
    const el = document.querySelector(sel)
    if (el) el.style.visibility = ''
  }
  return true
})()`)
console.log("\nrestored. The gutter crop is", JSON.stringify(crop))
process.exit(0)
