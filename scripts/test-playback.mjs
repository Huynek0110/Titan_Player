/**
 * Focused playback test: does clicking a track actually start it?
 *
 * This is the app's central action, so it is worth testing the way a user
 * reaches it — a real double-click dispatched through CDP — and then reading the
 * media element's own state rather than any React value.
 *
 * Usage: node scripts\test-playback.mjs <cdpPort> [rowIndex]
 */
const port = process.argv[2] ?? "9222"
const rowIndex = Number(process.argv[3] ?? 2)

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
  if (res.result?.exceptionDetails) {
    return { threw: res.result.exceptionDetails.text }
  }
  return res.result?.result?.value
}

await send("Runtime.enable")

const media = () =>
  evaluate(`(() => {
    const a = document.querySelector('audio')
    if (!a) return { missing: true }
    return {
      src: a.currentSrc || a.src || '',
      paused: a.paused,
      time: Number(a.currentTime.toFixed(2)),
      duration: Number((isFinite(a.duration) ? a.duration : 0).toFixed(1)),
      error: a.error ? a.error.code : null,
      readyState: a.readyState,
    }
  })()`)

const ui = () =>
  evaluate(`(() => ({
    nowPlayingLabel: document.querySelector('.playerbar-title')?.textContent?.trim() ?? null,
    currentRow: document.querySelector('.row.current .row-title')?.textContent?.trim() ?? null,
    currentRowCount: document.querySelectorAll('.row.current').length,
    accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
    amb1: getComputedStyle(document.documentElement).getPropertyValue('--amb-1').trim(),
  }))()`)

console.log("before:", JSON.stringify(await media()), JSON.stringify(await ui()))

// A real double-click on the row's text, not its artwork.
const spot = await evaluate(`(() => {
  const rows = [...document.querySelectorAll('.row')]
  const row = rows[${rowIndex}]
  if (!row) return null
  const title = row.querySelector('.row-title') ?? row
  const r = title.getBoundingClientRect()
  return { x: Math.round(r.left + 8), y: Math.round(r.top + r.height / 2) }
})()`)

if (!spot) {
  console.error(`no row at index ${rowIndex}`)
  process.exit(1)
}
console.log("clicking at", spot)

for (let i = 1; i <= 2; i += 1) {
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed", x: spot.x, y: spot.y, button: "left", clickCount: i,
  })
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased", x: spot.x, y: spot.y, button: "left", clickCount: i,
  })
  await new Promise((r) => setTimeout(r, 60))
}

const samples = []
for (let i = 0; i < 4; i += 1) {
  await new Promise((r) => setTimeout(r, 1500))
  samples.push({ t: `${(i + 1) * 1.5}s`, ...(await media()) })
}

console.log("samples:", JSON.stringify(samples, null, 2))
console.log("after ui:", JSON.stringify(await ui(), null, 2))

const advanced = samples[samples.length - 1].time > samples[0].time
const playing = samples.some((s) => !s.paused)
console.log(advanced && playing && !samples.some((s) => s.error)
  ? "\nPASS: the track is playing and the playhead is advancing"
  : "\nFAIL: playback did not start or did not advance")

ws.close()
process.exit(advanced && playing ? 0 : 1)
