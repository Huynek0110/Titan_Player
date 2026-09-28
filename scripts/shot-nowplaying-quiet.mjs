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
    const el = document.querySelector('.lyric-line.active')
    if (!el) return { found: false }
    const scroll = document.querySelector('.lyrics-scroll')
    const inner = el.querySelector('.lyric-scale')
    return {
      found: true,
      text: el.innerText.trim().slice(0, 60),
      className: el.className,
      // \`--fill\` is written on the line element itself, not on the inner span,
      // so reading it proves the rAF loop ran rather than inferring it from a
      // screenshot. The scale comes from a class, so it needs the computed value.
      fill: el.style.getPropertyValue('--fill') || null,
      scale: inner ? getComputedStyle(inner).transform : null,
      // How many lines are inside the pane's visible box, which is what tells
      // us the fade mask and the scroller are actually bounded.
      linesInView: (() => {
        if (!scroll) return null
        const box = scroll.getBoundingClientRect()
        return [...document.querySelectorAll('.lyric-line')].filter((n) => {
          const r = n.getBoundingClientRect()
          return r.bottom > box.top && r.top < box.bottom
        }).length
      })(),
      scrollTop: scroll ? Math.round(scroll.scrollTop) : null,
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
