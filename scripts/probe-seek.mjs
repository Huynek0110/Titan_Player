/**
 * Why does a seek not stick?
 *
 * Sets currentTime, reads it straight back, and reports readyState and duration
 * so it is obvious whether the element is refusing the seek (no metadata yet) or
 * something in the app is resetting it afterwards.
 *
 * Usage: node scripts\probe-seek.mjs <cdpPort> <seconds>
 */
const port = process.argv[2] ?? "9222"
const seconds = Number(process.argv[3] ?? 60)

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

const snap = () =>
  evaluate(`(() => {
    const a = document.querySelector('audio')
    if (!a) return { missing: true }
    return {
      hasSrc: Boolean(a.currentSrc || a.src),
      readyState: a.readyState,
      // 0 HAVE_NOTHING, 1 HAVE_METADATA, 2 HAVE_CURRENT_DATA, 4 HAVE_ENOUGH_DATA
      networkState: a.networkState,
      duration: Number((isFinite(a.duration) ? a.duration : 0).toFixed(2)),
      time: Number(a.currentTime.toFixed(2)),
      paused: a.paused,
      volume: a.volume,
      muted: a.muted,
      error: a.error ? a.error.code : null,
      seekableLen: a.seekable.length,
      seekableEnd: a.seekable.length ? Number(a.seekable.end(0).toFixed(2)) : null,
    }
  })()`)

console.log("before:", JSON.stringify(await snap()))

console.log(
  "set:",
  JSON.stringify(
    await evaluate(`(() => {
      const a = document.querySelector('audio')
      if (!a) return 'no element'
      try {
        a.currentTime = ${seconds}
        return { set: a.currentTime }
      } catch (err) {
        return { threw: String(err) }
      }
    })()`),
  ),
)

console.log("immediately after:", JSON.stringify(await snap()))
await new Promise((r) => setTimeout(r, 1500))
console.log("1.5s later:", JSON.stringify(await snap()))

const lyric = await evaluate(`(() => {
  const el = document.querySelector('.lyric-line.active')
  const scroll = document.querySelector('.lyrics-scroll')
  return {
    activeFound: Boolean(el),
    activeText: el ? el.innerText.trim().slice(0, 50) : null,
    fill: el ? el.querySelector('.lyric-text')?.style.getPropertyValue('--fill') ?? null : null,
    scrollTop: scroll ? Math.round(scroll.scrollTop) : null,
    totalLines: document.querySelectorAll('.lyric-line').length,
  }
})()`)
console.log("lyrics:", JSON.stringify(lyric, null, 2))

ws.close()
process.exit(0)
