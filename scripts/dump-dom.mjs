/**
 * Quick DOM dump over CDP. For answering "what is the app actually showing"
 * without a screenshot, and for checking whether a list rendered at all.
 *
 * Usage: node scripts\dump-dom.mjs <cdpPort> [selector] [maxChars]
 */
const port = process.argv[2] ?? "9222"
const selector = process.argv[3] ?? "body"
const maxChars = Number(process.argv[4] ?? 600)

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

const counts = await evaluate(`(() => {
  const q = (s) => document.querySelectorAll(s).length
  return {
    rows: q('.row'),
    nowPlaying: q('.nowplaying'),
    lyricsLines: q('.lyric-line'),
    lyricActive: q('.lyric-line.active'),
    artworks: q('.artwork img'),
    boot: q('.boot'),
    fatal: q('.fatal'),
  }
})()`)
console.log("counts:", JSON.stringify(counts))

const text = await evaluate(
  `document.querySelector(${JSON.stringify(selector)})?.innerText?.slice(0, ${maxChars}) ?? '(no match)'`,
)
console.log(`text of ${selector}:`)
console.log(text)

const box = await evaluate(`(() => {
  const el = document.querySelector('.nowplaying-body')
  const scroll = document.querySelector('.lyrics-scroll')
  const info = document.querySelector('.nowplaying-info')
  const art = document.querySelector('.nowplaying-art-col')
  const r = (n) => n ? { top: Math.round(n.getBoundingClientRect().top), h: Math.round(n.getBoundingClientRect().height) } : null
  return {
    viewport: { w: innerWidth, h: innerHeight },
    body: r(el),
    artCol: r(art),
    info: r(info),
    scroll: r(scroll),
    scrollTop: scroll ? Math.round(scroll.scrollTop) : null,
    scrollHeight: scroll ? Math.round(scroll.scrollHeight) : null,
  }
})()`)
console.log("layout:", JSON.stringify(box, null, 2))

ws.close()
process.exit(0)
