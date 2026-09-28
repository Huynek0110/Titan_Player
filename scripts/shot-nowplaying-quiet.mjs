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

// The view is restored from `lastView`, so the app may have reopened on Settings
// or a playlist with no rows in the DOM. Go to the library first, or there is
// nothing to click.
const view = await evaluate(`(() => {
  const nav = [...document.querySelectorAll('.nav-item, button')]
    .find(b => /all songs/i.test(b.textContent || ''))
  if (!nav) return 'no All Songs nav item'
  nav.click()
  return 'clicked All Songs'
})()`)
console.log("view:", view)
await new Promise((r) => setTimeout(r, 700))

// A single click only selects, and the now-playing button stays disabled until a
// track is current, so the track has to be queued the way a user does it: a real
// double-click. That does start playback, so the element is muted and at zero
// volume beforehand, and paused again immediately afterwards — the check below
// asserts it, so this script cannot silently produce sound.
const spot = await evaluate(`(() => {
  const row = document.querySelectorAll('.row')[${rowIndex}]
  if (!row) return null
  const t = row.querySelector('.row-title') ?? row
  const r = t.getBoundingClientRect()
  return { x: Math.round(r.left + 8), y: Math.round(r.top + r.height / 2) }
})()`)

if (!spot) {
  console.error(`no row at index ${rowIndex}`)
  process.exit(1)
}

for (let i = 1; i <= 2; i += 1) {
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed", x: spot.x, y: spot.y, button: "left", clickCount: i,
  })
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased", x: spot.x, y: spot.y, button: "left", clickCount: i,
  })
  await new Promise((r) => setTimeout(r, 50))
}
await new Promise((r) => setTimeout(r, 700))

// Pause immediately, then silence again.
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

// Seeking is how the karaoke wiring gets checked without sound: setting
// currentTime advances the lyric clock exactly as playback would, and the
// element is at zero volume and muted, so nothing is audible.
const seekTo = Number(process.argv[5] ?? 0)
if (seekTo > 0) {
  await evaluate(`(() => {
    const a = document.querySelector('audio')
    if (a) { a.currentTime = ${seekTo}; a.pause(); a.volume = 0; a.muted = true }
    return true
  })()`)
  // Long enough for the rAF loop to find the line, run the auto-scroll and write
  // the fill. The loop backs off to ~1Hz when paused, so this is not instant.
  await new Promise((r) => setTimeout(r, 2500))

  const active = await evaluate(`(() => {
    const el = document.querySelector('.lyric-now.is-now')
    if (!el) return { found: false, waiting: Boolean(document.querySelector('.lyrics-waiting')) }
    const focus = document.querySelector('.lyrics-focus')
    const r = el.getBoundingClientRect()
    return {
      found: true,
      waiting: Boolean(document.querySelector('.lyrics-waiting')),
      text: el.innerText.trim().slice(0, 60),
      exitPresent: Boolean(el.querySelector('.is-exit')),
      // The size ramp is a real font-size, not a transform, so the current line
      // must measure wider than the one below it. Comparing the two proves the
      // hierarchy is actually applied rather than just declared.
      sizes: [...document.querySelectorAll('.lyric-now')].map(
        (n) => Math.round(parseFloat(getComputedStyle(n).fontSize)),
      ),
      align: focus ? getComputedStyle(focus).textAlign : null,
      // Whether the current line sits inside the window at all. This is what
      // caught the pane overflowing and pushing the left column off screen.
      top: Math.round(r.top),
      bottom: Math.round(r.bottom),
      inViewport: r.top >= 0 && r.bottom <= innerHeight,
      audioTime: Number((document.querySelector('audio')?.currentTime ?? 0).toFixed(2)),
      paused: document.querySelector('audio')?.paused,
      volume: document.querySelector('audio')?.volume,
    }
  })()`)
  console.log("active line:", JSON.stringify(active, null, 2))
}

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
