/**
 * Minimal playback clock check: is the audio element's clock actually moving?
 *
 * Written because the animation probe reported a zero-second span while the
 * element's position had demonstrably advanced, and guessing which of the two was
 * wrong had already cost a cycle. Ten plain reads, printed, no filtering.
 *
 * Usage: node scripts\probe-clock.mjs <cdpPort>
 */
const port = process.argv[2] ?? "9222"

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

const ev = async (expression, userGesture = false) => {
  const res = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture,
  })
  if (res.result?.exceptionDetails) return `THREW: ${res.result.exceptionDetails.text}`
  return res.result?.result?.value
}

const snap = () =>
  ev(`(() => {
    const a = document.querySelector('audio')
    if (!a) return { missing: true }
    return {
      t: Number(a.currentTime.toFixed(2)),
      paused: a.paused,
      ended: a.ended,
      readyState: a.readyState,
      duration: Number((isFinite(a.duration) ? a.duration : 0).toFixed(1)),
      volume: a.volume,
      muted: a.muted,
      error: a.error ? a.error.code : null,
      routed: Boolean(a.__titanSource),
      ctxState: a.__titanCtx ? a.__titanCtx.state : null,
    }
  })()`)

console.log("--- before ---")
console.log(JSON.stringify(await snap()))

console.log("\nplay() ->", await ev(`(async () => {
  const a = document.querySelector('audio')
  if (!a) return 'no element'
  a.volume = 0; a.muted = true
  try { await a.play(); return 'resolved, paused=' + a.paused }
  catch (err) { return 'REJECTED: ' + err.name + ' ' + err.message }
})()`, true))

for (let i = 1; i <= 6; i += 1) {
  await new Promise((r) => setTimeout(r, 1200))
  console.log(`t+${(i * 1.2).toFixed(1)}s`, JSON.stringify(await snap()))
}

console.log("\n--- lyric state ---")
console.log(
  JSON.stringify(
    await ev(`(() => ({
      lyricsRendered: document.querySelectorAll('.lyric-now').length,
      current: document.querySelector('.lyric-now.is-now')?.innerText?.trim().slice(0,30) ?? null,
      waiting: Boolean(document.querySelector('.lyrics-waiting')),
      nowPlayingOpen: Boolean(document.querySelector('.nowplaying')),
      panePresent: Boolean(document.querySelector('.lyrics-wrap')),
    }))()`),
  ),
)

process.exit(0)
