/**
 * Screenshot the library view, with the track list scrolling behind the player
 * bar.
 *
 * This exists because the glass cannot be judged from the Now Playing view: its
 * background is an empty ambient wash, so there is nothing behind the bar to
 * refract and the effect is invisible whether or not it is running. A scrolling
 * list of rows is the only place in the app where content actually passes under
 * the bar.
 *
 * Usage: node scripts\shot-library.mjs <cdpPort> <out.png> [scrollY]
 */
import { writeFileSync } from "node:fs"

const port = process.argv[2] ?? "9222"
const out = process.argv[3] ?? "library.png"
const scrollY = Number(process.argv[4] ?? 260)

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

// Close Now Playing if it is open, and go to the song list.
const state = await evaluate(`(() => {
  const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
  document.dispatchEvent(esc)
  const nav = [...document.querySelectorAll('button, a')]
    .find(b => /all songs|songs|tracks/i.test((b.textContent || '').trim()))
  if (nav) nav.click()
  return { nav: nav ? nav.textContent.trim() : 'not found' }
})()`)
console.log("view:", JSON.stringify(state))

await new Promise((r) => setTimeout(r, 900))

// Scroll the list so rows pass under the bar. The scroll container is whatever
// actually overflows, which is not necessarily the one a class name suggests.
const scrolled = await evaluate(`(() => {
  const candidates = [...document.querySelectorAll('*')].filter(el => {
    const cs = getComputedStyle(el)
    return el.scrollHeight > el.clientHeight + 40 &&
      /auto|scroll/.test(cs.overflowY) &&
      el.getBoundingClientRect().height > 200
  })
  const el = candidates.sort((a, b) => b.clientHeight - a.clientHeight)[0]
  if (!el) return { error: 'no scroll container' }
  el.scrollTop = ${scrollY}
  return { scrolled: el.scrollTop, max: el.scrollHeight - el.clientHeight, cls: el.className }
})()`)
console.log("scroll:", JSON.stringify(scrolled))

await new Promise((r) => setTimeout(r, 700))

const res = await send("Page.captureScreenshot", { format: "png" })
writeFileSync(out, Buffer.from(res.result.data, "base64"))
console.log("saved", out)
process.exit(0)
