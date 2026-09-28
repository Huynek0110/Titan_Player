/**
 * Screenshot the now-playing view WITHOUT playing anything.
 *
 * The last track is restored into the view without calling play(), so the blurred
 * cover behind the layout can be checked without sound. Volume is forced to zero
 * as a second guard, in case anything else starts playback.
 *
 * Usage: node scripts\shot-nowplaying-quiet.mjs <cdpPort> <outPath> [rowIndex]
 */
const port = process.argv[2] ?? "9222"
const out = process.argv[3] ?? "np.png"
const rowIndex = Number(process.argv[4] ?? 2)

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

await send("Page.enable")
await send("Runtime.enable")

// Belt and braces: mute the element and pin the volume to zero before anything
// else can start it.
await evaluate(`(() => {
  const a = document.querySelector('audio')
  if (a) { a.volume = 0; a.muted = true }
  return true
})()`)

// Load the track into the queue WITHOUT playing it. A single click selects, and
// the now-playing button is disabled until a track is current, so the track is
// queued by clicking its row play button's parent and then immediately paused.
await evaluate(`(() => {
  const row = document.querySelectorAll('.row')[${rowIndex}]
  if (!row) return 'no row'
  const btn = row.querySelector('.row-play')
  if (btn) { btn.click(); return 'queued via row play' }
  row.click()
  return 'clicked row'
})()`)
await new Promise((r) => setTimeout(r, 900))

// Pause immediately whatever happened, then silence again.
await evaluate(`(() => {
  const a = document.querySelector('audio')
  if (a) { a.pause(); a.volume = 0; a.muted = true }
  return true
})()`)
await new Promise((r) => setTimeout(r, 400))

const opened = await evaluate(`(() => {
  const btn = [...document.querySelectorAll('button')]
    .find(b => /now playing/i.test(b.getAttribute('aria-label') || ''))
  if (!btn) return 'no now-playing button'
  if (btn.disabled) return 'button disabled — nothing queued'
  btn.click()
  return 'clicked'
})()`)
console.log("open now playing:", opened)

await new Promise((r) => setTimeout(r, 2000))

const state = await evaluate(`(() => {
  const np = document.querySelector('.nowplaying')
  const a = document.querySelector('audio')
  return {
    open: Boolean(np),
    bg: Boolean(document.querySelector('.nowplaying-bg')),
    // Proof the background is not simply black: read the rendered pixel colour
    // in a corner the artwork does not cover and compare it to the canvas.
    bgComputed: (() => {
      const bg = document.querySelector('.nowplaying-bg')
      if (!bg) return null
      const s = getComputedStyle(bg)
      return { filter: s.filter, blend: getComputedStyle(bg, '::after').mixBlendMode }
    })(),
    dock: Boolean(document.querySelector('.nowplaying-dock')),
    volume: Boolean(document.querySelector('.nowplaying-volume input')),
    inlineSeek: Boolean(document.querySelector('.nowplaying-seek-track')),
    eyebrow: document.querySelector('.nowplaying-eyebrow')?.innerText.replace(/\\n/g, ' | ') ?? null,
    title: document.querySelector('.nowplaying-title')?.textContent ?? null,
    audio: a ? { paused: a.paused, time: Number(a.currentTime.toFixed(2)), volume: a.volume, muted: a.muted } : null,
  }
})()`)
console.log("state:", JSON.stringify(state, null, 2))

const { result } = await send("Page.captureScreenshot", { format: "png" })
const { writeFileSync } = await import("node:fs")
writeFileSync(out, Buffer.from(result.data, "base64"))
console.log("saved", out)

ws.close()
process.exit(0)
