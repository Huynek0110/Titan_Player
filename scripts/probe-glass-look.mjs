/**
 * Why the app does not look like glass, and why the window is growing.
 *
 * Three questions that all look like "the effect is off" from a screenshot and
 * have completely different causes:
 *
 *  1. Is the blurred cover painting at all? `--art` can be set and the layer can
 *     still show nothing — the custom scheme has to resolve from a *stylesheet*,
 *     which is a different request path from an `<img>`, and the main process has
 *     to still be holding the cover in its map.
 *  2. How opaque is everything between the eye and the picture? Four stacked
 *     translucent fills plus two scrims is enough to add up to an opaque black,
 *     and then the glass has nothing behind it and no amount of displacement
 *     strength will help.
 *  3. Is the window being asked to grow? The perf probe resizes it, but so does
 *     the user, and the reason has to be in the layout: a flex child with a large
 *     min-content width and no `min-width: 0` will push the window's minimum past
 *     its current size and the window manager will grow it to match.
 */
const port = process.argv[2] ?? "9222"

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = list.find((t) => t.type === "page" && !/mini\.html/.test(t.url))
if (!page) {
  console.error("no main page target")
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

const report = await evaluate(`(() => {
  const root = getComputedStyle(document.documentElement)
  const art = document.querySelector('.ambient-art')
  const before = art ? getComputedStyle(art, '::before') : null
  const after = art ? getComputedStyle(art, '::after') : null

  // Alpha of everything painted between the eye and the picture, top to bottom.
  const layers = []
  for (const sel of ['.ambient-art::after', '.ambient', '.grain', '.app-main', '.sidebar', '.playerbar']) {
    const isPseudo = sel.includes('::')
    const el = isPseudo
      ? (sel.startsWith('.ambient-art') ? art : document.querySelector(sel.slice(0, -2)))
      : document.querySelector(sel)
    if (!el) { layers.push({ sel, missing: true }); continue }
    const s = getComputedStyle(el, isPseudo ? '::after' : null)
    layers.push({ sel, background: s.backgroundColor, image: s.backgroundImage.slice(0, 40) })
  }

  return {
    artVar: root.getPropertyValue('--art').slice(0, 60) || '(empty)',
    artLayerPresent: Boolean(art),
    artBox: art ? (r => ({ w: Math.round(r.width), h: Math.round(r.height) }))(art.getBoundingClientRect()) : null,
    artBefore: before ? { image: before.backgroundImage.slice(0, 60), w: before.width, transform: before.transform } : null,
    artAfter: after ? { background: after.backgroundColor } : null,
    windowInner: [innerWidth, innerHeight],
    docScroll: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
    // Anything wider than the window is a candidate for pushing a min-width up.
    overflowing: [...document.querySelectorAll('.app-shell *')]
      .filter(el => el.getBoundingClientRect().right > innerWidth + 1)
      .slice(0, 6)
      .map(el => ({ cls: el.className, right: Math.round(el.getBoundingClientRect().right) })),
    layers,
  }
})()`)

console.log(JSON.stringify(report, null, 2))

/* Does the cover actually load from a stylesheet? */
if (report.artVar && report.artVar !== "(empty)") {
  const loaded = await evaluate(`new Promise(resolve => {
    const url = getComputedStyle(document.documentElement).getPropertyValue('--art')
      .replace(/^url\\(["']?/, '').replace(/["']?\\)$/, '')
    if (!url) return resolve({ skipped: 'no url' })
    const img = new Image()
    img.onload = () => resolve({ ok: true, w: img.naturalWidth, h: img.naturalHeight })
    img.onerror = (e) => resolve({ ok: false, error: 'load failed' })
    img.src = url
    setTimeout(() => resolve({ ok: false, error: 'timed out' }), 4000)
  })`)
  console.log("\ncover fetch from a stylesheet URL:", JSON.stringify(loaded))
}
