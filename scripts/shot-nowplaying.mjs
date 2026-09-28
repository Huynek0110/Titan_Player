/**
 * Open the now-playing view and screenshot it.
 *
 * The view is the one screen with the blurred cover behind it, the volume rail,
 * the inline transport and the lyrics column all at once, so it is the screen
 * most worth looking at rather than assuming.
 *
 * Usage: node scripts\shot-nowplaying.mjs <cdpPort> <outPath> [rowIndex]
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

// Play something first, so the artwork behind the view is a real cover.
const spot = await evaluate(`(() => {
  const row = document.querySelectorAll('.row')[${rowIndex}]
  if (!row) return null
  const t = row.querySelector('.row-title') ?? row
  const r = t.getBoundingClientRect()
  return { x: Math.round(r.left + 8), y: Math.round(r.top + r.height / 2) }
})()`)

if (spot) {
  for (let i = 1; i <= 2; i += 1) {
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed", x: spot.x, y: spot.y, button: "left", clickCount: i,
    })
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased", x: spot.x, y: spot.y, button: "left", clickCount: i,
    })
    await new Promise((r) => setTimeout(r, 60))
  }
  await new Promise((r) => setTimeout(r, 2500))
}

// Open it by clicking the artwork in the player bar, the way a user does.
const opened = await evaluate(`(() => {
  // The "Now playing" chevron in the player bar, matched on its accessible name
  // rather than on a class, so a stylesheet rename cannot silently break this.
  const btn = [...document.querySelectorAll('button')]
    .find(b => /now playing/i.test(b.getAttribute('aria-label') || ''))
  if (!btn) return 'no now-playing button'
  if (btn.disabled) return 'button disabled'
  btn.click()
  return 'clicked'
})()`)
console.log("open now playing:", opened)

await new Promise((r) => setTimeout(r, 1800))

const state = await evaluate(`(() => {
  const np = document.querySelector('.nowplaying')
  if (!np) return { open: false }
  const a = document.querySelector('audio')
  return {
    open: true,
    bg: Boolean(document.querySelector('.nowplaying-bg')),
    dock: Boolean(document.querySelector('.nowplaying-dock')),
    volume: Boolean(document.querySelector('.nowplaying-volume input')),
    inlineSeek: Boolean(document.querySelector('.nowplaying-seek-track')),
    inlinePlay: Boolean(document.querySelector('.np-play')),
    eyebrow: document.querySelector('.nowplaying-eyebrow')?.innerText.replace(/\\n/g, ' | ') ?? null,
    title: document.querySelector('.nowplaying-title')?.textContent ?? null,
    audio: a ? { paused: a.paused, time: Number(a.currentTime.toFixed(1)) } : null,
  }
})()`)
console.log("state:", JSON.stringify(state, null, 2))

const { result } = await send("Page.captureScreenshot", { format: "png" })
const { writeFileSync } = await import("node:fs")
writeFileSync(out, Buffer.from(result.data, "base64"))
console.log("saved", out)

ws.close()
process.exit(0)
