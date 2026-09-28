/**
 * Drives the app the way a person would, through the DevTools protocol, and then
 * reports whether the audio element is actually producing sound.
 *
 * Synthetic mouse events from outside the process never reached the window on
 * this machine, so clicking a row by coordinates was not a usable test. Events
 * injected over CDP arrive at the compositor and go through the real handler
 * chain, so this exercises the same path a user does.
 *
 * Usage: node scripts/play-a-track.mjs [port] [rowIndex]
 */
const port = process.argv[2] ?? "9222"
const rowIndex = Number(process.argv[3] ?? 0)

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const target = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl)
if (!target) {
  console.error("no page target on port", port)
  process.exit(1)
}

const ws = new WebSocket(target.webSocketDebuggerUrl)
let nextId = 1
const pending = new Map()
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
  }
})
await new Promise((r) => ws.addEventListener("open", r, { once: true }))

const send = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })

const evaluate = async (expression) => {
  const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })
  if (res.result?.exceptionDetails) return { threw: res.result.exceptionDetails.text }
  return res.result?.result?.value
}

// Where is the row we want to click?
const spot = await evaluate(`(() => {
  const rows = [...document.querySelectorAll('.tracklist-body .row')];
  if (!rows.length) return { none: true };
  const r = rows[${rowIndex}] || rows[0];
  const b = r.getBoundingClientRect();
  return { x: Math.round(b.left + 260), y: Math.round(b.top + b.height / 2), total: rows.length,
           title: r.querySelector('.row-title')?.textContent ?? '?' };
})()`)

if (spot?.none) {
  console.log("no rows rendered yet")
  process.exit(1)
}
console.log(`clicking "${spot.title}" at ${spot.x},${spot.y} (of ${spot.total} rendered rows)`)

const click = async (type) => {
  await send("Input.dispatchMouseEvent", {
    type,
    x: spot.x,
    y: spot.y,
    button: "left",
    clickCount: 2,
  })
}
await click("mousePressed")
await click("mouseReleased")
await new Promise((r) => setTimeout(r, 90))
await click("mousePressed")
await click("mouseReleased")

const probe = `(() => {
  const a = document.querySelector('audio');
  if (!a) return { missing: true };
  return {
    currentTime: Number(a.currentTime.toFixed(3)),
    duration: Number.isFinite(a.duration) ? Number(a.duration.toFixed(2)) : String(a.duration),
    paused: a.paused,
    muted: a.muted,
    volume: Number(a.volume.toFixed(2)),
    readyState: a.readyState,
    networkState: a.networkState,
    errorCode: a.error ? a.error.code : null,
    // The decisive field: if a MediaElementSource exists, output only lives in
    // the Web Audio graph and a suspended context means silence.
    routedThroughWebAudio: Boolean(a.__titanSource),
    audioContext: a.__titanCtx ? a.__titanCtx.state : '(none)',
  };
})()`

for (let i = 1; i <= 4; i += 1) {
  console.log(`t+${i * 1.5}s`, JSON.stringify(await evaluate(probe)))
  if (i < 4) await new Promise((r) => setTimeout(r, 1500))
}

ws.close()
process.exit(0)
