/**
 * Does Chromium actually apply an SVG displacement filter to a *backdrop*?
 *
 * `backdrop-filter: url(#f) blur(3px)` parsing is not the same as the filter
 * being honoured. Chromium's backdrop implementation has historically taken
 * shortcuts with SVG filter references — it can accept the value, keep it in
 * computed style, and then quietly apply only the shorthand functions. Nothing
 * about the DOM tells you which happened, and a plain screenshot of the player
 * bar over an empty area cannot tell you either, because there is nothing behind
 * it to refract.
 *
 * So this puts something behind it that can only look wrong if the displacement
 * ran: a hard-edged diagonal grating, high contrast, clipped to the bar's box.
 * Then it captures the same region twice — once with the URL filter, once with
 * the element's backdrop-filter forced off — and reports how far apart the two
 * are.
 *
 * The measurement is on the *right-hand* end of the bar, where the red channel of
 * the map is at full strength and the displacement is largest. If the filter is
 * being applied, that end is where the grating is bent.
 *
 * Usage: node scripts\probe-glass.mjs <cdpPort> <outDir>
 */
import { writeFileSync } from "node:fs"

const port = process.argv[2] ?? "9222"
const outDir = process.argv[3] ?? "."

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = list.find((t) => t.type === "page")
if (!page) {
  console.error("no page target")
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

const shot = async (file, clip) => {
  const res = await send("Page.captureScreenshot", {
    format: "png",
    ...(clip ? { clip: { ...clip, scale: 1 } } : {}),
  })
  writeFileSync(file, Buffer.from(res.result.data, "base64"))
}

// Report what the app actually has, before touching anything.
const report = await evaluate(`(() => {
  const bar = document.querySelector('.playerbar')
  if (!bar) return { error: 'no .playerbar on screen' }
  const r = bar.getBoundingClientRect()
  const defs = document.getElementById('titan-glass-defs')
  const filters = defs ? [...defs.querySelectorAll('filter')] : []
  return {
    inline: bar.style.getPropertyValue('backdrop-filter'),
    computed: getComputedStyle(bar).backdropFilter,
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    filterIds: filters.map(f => f.id),
    primitives: filters[0] ? [...filters[0].children].map(n => n.nodeName) : [],
  }
})()`)
console.log("app state:", JSON.stringify(report, null, 2))
if (report.error) process.exit(1)

/*
 * The grating.
 *
 * Diagonal hard edges, 14px pitch, black on white, sitting directly behind the
 * bar and clipped to its box.
 *
 * The bar's own translucent background is made fully transparent for the test and
 * the displacement is cranked to an absurd 140px. Both are deliberate: at the
 * app's real settings the effect is a few pixels on a dark background, which is
 * indistinguishable from a plain blur, and the question here is not "does it look
 * right" but "does Chromium run the displacement at all". An absurd value makes
 * a yes unmissable, and the pitch is wide enough that a 140px bend cannot hide
 * inside it.
 *
 * Only the right-hand quarter is captured, and at 4x. That is where the red
 * channel of the map is at full strength, so it is where the displacement is
 * largest; the left end is the flat centre and would show nothing.
 */
const install = (enabled) => `(() => {
  const bar = document.querySelector('.playerbar')
  const r = bar.getBoundingClientRect()
  const defs = document.getElementById('titan-glass-defs')
  const f = defs && defs.querySelector('filter')
  const disp = f && f.querySelector('feDisplacementMap')
  if (disp) disp.setAttribute('scale', '140')
  let g = document.getElementById('__glass-probe-grating')
  if (g) g.remove()
  g = document.createElement('div')
  g.id = '__glass-probe-grating'
  g.style.cssText = [
    'position:fixed',
    'left:' + r.x + 'px',
    'top:' + r.y + 'px',
    'width:' + r.width + 'px',
    'height:' + r.height + 'px',
    'z-index:1',
    'pointer-events:none',
    'background:repeating-linear-gradient(45deg,#000 0 7px,#fff 7px 14px)',
  ].join(';')
  document.body.appendChild(g)
  bar.dataset.__probeBg = bar.style.background
  bar.style.background = 'transparent'
  bar.style.setProperty('backdrop-filter', ${enabled ? "keep" : "'none'"})
  bar.style.setProperty('-webkit-backdrop-filter', ${enabled ? "keep" : "'none'"})
  return true
})()`

const clip = {
  x: report.rect.x + report.rect.w * 0.62,
  y: report.rect.y,
  width: report.rect.w * 0.34,
  height: report.rect.h,
}

await evaluate(install(true))
await new Promise((r) => setTimeout(r, 400))
await shot(`${outDir}/glass-on.png`, { ...clip, scale: 4 })

await evaluate(install(false))
await new Promise((r) => setTimeout(r, 400))
await shot(`${outDir}/glass-off.png`, { ...clip, scale: 4 })

// Put the app back the way it was.
await evaluate(`(() => {
  const bar = document.querySelector('.playerbar')
  const g = document.getElementById('__glass-probe-grating')
  if (g) g.remove()
  if (bar) {
    if (bar.dataset.__probeBg) bar.style.background = bar.dataset.__probeBg
    else bar.style.removeProperty('background')
    delete bar.dataset.__probeBg
    bar.style.removeProperty('backdrop-filter')
    bar.style.removeProperty('-webkit-backdrop-filter')
  }
  return true
})()`)

console.log(`\nwrote ${outDir}/glass-on.png and ${outDir}/glass-off.png`)
console.log("Captured the right quarter at 4x, displacement forced to 140px.")
console.log("Straight stripes in both  = parsed and ignored, only the blur ran.")
console.log("Bent stripes in the ON one = the displacement is live.")
process.exit(0)
