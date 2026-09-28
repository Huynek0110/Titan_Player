/**
 * Open the floating mini player and check that it is a real, working second
 * window rather than a panel inside the first one.
 *
 * The things worth proving, and none of which a screenshot of the main window
 * can show:
 *
 *   1. A second `BrowserWindow` exists and it is the mini document, not the
 *      library — a wrong URL here means the bar silently renders the whole app
 *      inside a 400px strip.
 *   2. It received state. The bar is a remote control, so an empty panel means
 *      the publish loop is not running or the packet is not arriving.
 *   3. Its buttons reach the audio element. Every transport verb is sent to the
 *      main window, so this clicks the bar's own play button and reads the main
 *      window's `<audio>` — the only way to prove the two windows are actually
 *      connected rather than merely both running.
 *   4. The Liquid Glass on the pill is a real displacement, not just a blur.
 *
 * Usage: node scripts\probe-mini-player.mjs <mainPort> <out.png>
 */
import { writeFileSync } from "node:fs"

const port = process.argv[2] ?? "9222"
const out = process.argv[3] ?? "mini.png"

const connect = async (p, match) => {
  const list = await (await fetch(`http://127.0.0.1:${p}/json/list`)).json()
  const pages = list.filter((t) => t.type === "page")
  /*
   * The target has to be chosen by URL, not by taking the first page. Once the
   * bar is open there are two documents on the same debugging port, and which one
   * comes first is not something to rely on — a probe that silently attached to
   * the main window would report the bar's contents from the wrong renderer and
   * every assertion would be about the wrong window.
   */
  const page = match ? pages.find(match) : pages[0]
  if (!page) throw new Error(`no page target matching on ${p}`)
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
      userGesture: true,
    })
    if (res.result?.exceptionDetails) return { threw: res.result.exceptionDetails.text }
    return res.result?.result?.value
  }
  return { send, evaluate }
}

const main = await connect(port, (t) => !/mini\.html/.test(t.url))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// --- 1. open it, from the main window's own button ------------------------
const opened = await main.evaluate(`(() => {
  const btn = [...document.querySelectorAll('button')]
    .find(b => /mini player/i.test(b.getAttribute('aria-label') || ''))
  if (!btn) return { error: 'no mini player button' }
  btn.click()
  return { clicked: true, pressed: btn.getAttribute('aria-pressed') }
})()`)
console.log("open:", JSON.stringify(opened))
await sleep(2500)

// --- 2. find the second window -------------------------------------------
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const pages = targets.filter((t) => t.type === "page")
console.log(`\npage targets: ${pages.length}`)
for (const p of pages) console.log(`  ${p.url.split(/[\\/]/).pop()}`)

const miniTarget = pages.find((p) => /mini\.html/.test(p.url))
if (!miniTarget) {
  console.log("\nRESULT: FAIL — no window is showing mini.html.")
  process.exit(1)
}

const mini = await connect(port, (t) => /mini\.html/.test(t.url))

// --- 3. did it receive state? ---------------------------------------------
/*
 * Read the bar's state only *after* something is playing.
 *
 * Checked in the wrong order first, and the probe reported "Nothing playing" —
 * which was true and told us nothing. A bar with no track playing is supposed to
 * say "Nothing playing"; the interesting question is whether it learns the title
 * of a track once one exists, which is the whole publish loop.
 */
await main.evaluate(`(() => {
  const a = document.querySelector('audio')
  if (a) { a.volume = 0; a.muted = true }
  /*
   * The app's own play button, found by its accessible name.
   *
   * Guessing a row class name was the first attempt and it broke twice, because
   * the list renders different row markup depending on the view. "Play <title>"
   * is a contract the component actually promises, so it is what this asks for.
   */
  const btn = [...document.querySelectorAll('button')]
    .find(b => /^Play /.test(b.getAttribute('aria-label') || ''))
  if (!btn) return false
  btn.click()
  return true
})()`)
await sleep(3000)

const state = await mini.evaluate(`(() => {
  const panel = document.querySelector('.mini-panel')
  const title = document.querySelector('.mini-title')
  const art = document.querySelector('.mini-art')
  const pill = document.querySelector('.mini-transport')
  return {
    hasPanel: Boolean(panel),
    title: title ? title.textContent : null,
    artist: document.querySelector('.mini-artist')?.textContent ?? null,
    artSrc: art instanceof HTMLImageElement ? art.src.slice(0, 24) : null,
    artLoaded: art instanceof HTMLImageElement ? art.complete && art.naturalWidth > 0 : null,
    buttons: document.querySelectorAll('.mini-btn').length,
    progressVar: document.querySelector('.mini-progress')?.style.getPropertyValue('--p') ?? null,
    pillBackdrop: pill ? getComputedStyle(pill).backdropFilter : null,
    panelRect: (r => ({ w: Math.round(r.width), h: Math.round(r.height) }))(
      panel.getBoundingClientRect(),
    ),
    hasTitanApi: typeof window.titan,
    hasMiniApi: typeof window.titanMini,
  }
})()`)
console.log("\nmini state:", JSON.stringify(state, null, 2))

if (!state.hasPanel) {
  console.log("\nRESULT: FAIL — the window loaded but rendered no panel.")
  process.exit(1)
}
if (state.hasTitanApi !== "undefined") {
  console.log("\nRESULT: FAIL — the bar can see the main window's `window.titan`.")
  console.log("It is supposed to have `titanMini` only, so its document is not isolated.")
  process.exit(1)
}
if (state.title === "Nothing playing") {
  console.log("\nRESULT: FAIL — a track is playing in the main window but the bar says nothing is.")
  process.exit(1)
}
console.log(`\nOK — the bar learned "${state.title}" and the cover ${state.artLoaded ? "loaded" : "did NOT load"}.`)

const before = await main.evaluate(`(() => {
  const a = document.querySelector('audio')
  return { paused: a ? a.paused : null, t: a ? a.currentTime : null, volume: a ? a.volume : null }
})()`)

const clicked = await mini.evaluate(`(() => {
  const btn = document.querySelector('.mini-btn-play')
  if (!btn) return { error: 'no play button' }
  btn.click()
  return { clicked: true, label: btn.getAttribute('aria-label') }
})()`)
await sleep(1200)

const after = await main.evaluate(`(() => {
  const a = document.querySelector('audio')
  return { paused: a ? a.paused : null, t: a ? Number(a.currentTime.toFixed(2)) : null }
})()`)
console.log("\nbar's play button:", JSON.stringify(clicked))
console.log("main audio before:", JSON.stringify(before))
console.log("main audio after: ", JSON.stringify(after))

if (before.paused === after.paused) {
  console.log("\nRESULT: FAIL — clicking the bar's play button did not change the main")
  console.log("window's audio element. The two windows are not connected.")
  process.exit(1)
}
console.log("\nOK — a button in the second window drove the first window's audio.")

// --- 5. the glass, on the pill -------------------------------------------
const glass = await mini.evaluate(`(() => {
  const defs = document.getElementById('titan-glass-defs')
  const f = defs ? defs.querySelector('filter') : null
  return {
    filters: defs ? [...defs.querySelectorAll('filter')].map(x => x.id) : [],
    primitives: f ? [...f.children].map(n => n.nodeName) : [],
  }
})()`)
console.log("glass on the pill:", JSON.stringify(glass))

// --- capture --------------------------------------------------------------
const res = await mini.send("Page.captureScreenshot", { format: "png" })
writeFileSync(out, Buffer.from(res.result.data, "base64"))
console.log(`\nsaved ${out}`)
process.exit(0)
