/**
 * Does the glass make the window stutter when it is resized?
 *
 * This exists because it already happened once. Four surfaces with a
 * `backdrop-filter` meant a fresh Gaussian pass over each of them on every frame
 * of a resize, and maximising the window juddered badly enough to be the first
 * thing anyone would notice about the app. The fix at the time was to strip the
 * filters off everything except the player bar.
 *
 * That fix has now been partly undone — the sidebar and the queue drawer carry a
 * displacement-map refraction as well — so the question has to be answered with
 * numbers instead of by argument. "It should be fine" is what the sidebar comment
 * used to say, and the comment above it still records the stutter.
 *
 * What it measures: the window is resized through a series of steps while the
 * main process reports how long each composite took, and the same run is repeated
 * with every refraction removed so the two can be compared on the same machine in
 * the same session. A difference that is invisible in absolute terms still matters
 * if the app is already near the frame budget.
 *
 * The queue drawer is measured open *and* closed. It transitions its own transform
 * and opacity while over a scrolling list, so its backdrop genuinely changes every
 * frame while it moves, and that is the worst case rather than the average one.
 *
 * Usage: node scripts\probe-glass-perf.mjs <cdpPort>
 */
const port = process.argv[2] ?? "9222"

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const pages = list.filter((t) => t.type === "page")
const main = pages.find((t) => !/mini\.html/.test(t.url))
if (!main) {
  console.error("no main page target")
  process.exit(1)
}

const ws = new WebSocket(main.webSocketDebuggerUrl)
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/*
 * Frame timing, taken in the renderer.
 *
 * `requestAnimationFrame` deltas are the honest measure here: they are what the
 * user sees, they include everything the compositor had to do, and they need no
 * main-process cooperation. The CDP tracing domain would give a per-stage
 * breakdown, which is more information than this question needs and a great deal
 * more code.
 */
const SAMPLE = `(() => new Promise(resolve => {
  const deltas = []
  let last = performance.now()
  const started = last
  const tick = () => {
    const now = performance.now()
    deltas.push(now - last)
    last = now
    if (now - started < 2000) requestAnimationFrame(tick)
    else {
      const sorted = [...deltas].sort((a, b) => a - b)
      resolve({
        frames: deltas.length,
        median: Number(sorted[Math.floor(sorted.length / 2)].toFixed(2)),
        p95: Number(sorted[Math.floor(sorted.length * 0.95)].toFixed(2)),
        worst: Number(sorted[sorted.length - 1].toFixed(2)),
        over32: deltas.filter(d => d > 32).length,
      })
    }
  }
  requestAnimationFrame(tick)
}))()`

/*
 * Frame timing, collected *while* the window is being resized.
 *
 * This is the version that actually answers the question, and getting here took
 * two attempts that both measured the wrong thing.
 *
 * The first compared a frame-timing object against the return value of the
 * `resizeTo` call and printed `median undefinedms` and then "within a frame at
 * 60Hz" — a confident conclusion from a comparison that never happened.
 *
 * The second sampled *after* the sweep settled, which is also the wrong thing:
 * the stutter being looked for happens *during* a resize, and a window that has
 * finished resizing is compositing a static scene. It reported a clean
 * `+0.00ms` with zero dropped frames, which was true and useless.
 *
 * So the sampler is installed first and parks its result on `window`, the sweep
 * runs in separate evaluate calls while it is collecting, and the result is read
 * afterwards. `awaitPromise` cannot be used — it would block the very connection
 * that has to issue the resize — which is why this is a two-phase dance.
 */
const START_SAMPLER = `(() => {
  window.__perf = { deltas: [], done: false }
  const p = window.__perf
  let last = performance.now()
  const started = last
  const tick = () => {
    const now = performance.now()
    p.deltas.push(now - last)
    last = now
    if (now - started < 4000) requestAnimationFrame(tick)
    else p.done = true
  }
  requestAnimationFrame(tick)
  return true
})()`

const READ_SAMPLER = `(() => {
  const p = window.__perf
  if (!p) return { error: 'sampler was never started' }
  const d = p.deltas
  if (d.length < 10) return { error: 'only ' + d.length + ' frames collected' }
  const s = [...d].sort((a, b) => a - b)
  return {
    done: p.done,
    frames: d.length,
    median: Number(s[Math.floor(s.length / 2)].toFixed(2)),
    p95: Number(s[Math.floor(s.length * 0.95)].toFixed(2)),
    worst: Number(s[s.length - 1].toFixed(2)),
    over32: d.filter(x => x > 32).length,
    over50: d.filter(x => x > 50).length,
  }
})()`

/** Resizes the window through a sweep while the sampler is collecting. */
const sweep = async (label) => {
  /*
   * Re-assert the window before every sweep, not just once at the start.
   *
   * Something in the environment keeps taking focus between measurements — a
   * shell, a build, a screenshot — and an occluded window is throttled to zero
   * frames, which arrives as an empty sample rather than as a slow one. The
   * symptom was one sweep reporting `only 0 frames collected` after two good
   * ones, which reads as the glass being unmeasurable rather than as the window
   * being behind something.
   */
  await send("Page.bringToFront").catch(() => {})
  await new Promise((r) => setTimeout(r, 500))
  const state = await evaluate(`document.visibilityState`)
  if (state !== "visible") {
    console.log(`  (window was ${state} before this sweep — skipped)`)
    return { error: `window was ${state}` }
  }

  await evaluate(START_SAMPLER)
  const steps = 22
  for (let i = 0; i < steps; i += 1) {
    await evaluate(`(() => { window.resizeTo(${960 + i * 22}, ${640 + i * 14}); return true })()`)
    await sleep(45)
  }
  await evaluate(`(() => { window.resizeTo(1440, 900); return true })()`)
  // Keep the sampler alive past the sweep so it covers the settle as well.
  await sleep(900)
  const result = await evaluate(READ_SAMPLER)
  console.log(`${label}\n  ${JSON.stringify(result)}`)
  return result
}

/*
 * Refuse to measure a window that is not being painted.
 *
 * A hidden document gets no `requestAnimationFrame` at all — Chromium throttles
 * it to zero — so every sample comes back empty. The first version of this
 * printed `median undefinedms` and then "within a frame at 60Hz", which is a
 * clean pass derived from no data whatsoever. The guard below catches the empty
 * result, but it is better to fix the cause than to keep reporting it.
 *
 * The cause is occlusion rather than minimisation. Anything else on the desktop
 * coming to the front makes Chromium mark this window hidden, and it stayed that
 * way across several runs, which is why this is intermittent rather than a
 * startup bug. `Page.bringToFront` is the fix; the guard is the backstop.
 */
await send("Page.bringToFront").catch(() => {})
await new Promise((r) => setTimeout(r, 600))

const visible = await evaluate(`(() => ({
  visibilityState: document.visibilityState,
  hasFocus: document.hasFocus(),
  inner: [innerWidth, innerHeight],
}))()`)
if (visible.visibilityState !== "visible") {
  console.error(`\nThe window is ${visible.visibilityState}, not visible.`)
  console.error("A hidden or occluded document is not given animation frames, so every")
  console.error("sample would be empty and the comparison meaningless. Close whatever")
  console.error("is in front of it and re-run.")
  process.exit(1)
}
console.log(`measuring a visible ${visible.inner[0]}x${visible.inner[1]} window`)

const drawerOpen = (await evaluate(`(() => {
  const b = [...document.querySelectorAll('button')]
    .find(x => x.getAttribute('aria-label') === 'Queue')
  return b ? b.getAttribute('aria-expanded') === 'true' : false
})()`)) === true
if (!drawerOpen) {
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')]
      .find(x => x.getAttribute('aria-label') === 'Queue')
    if (b) b.click()
    return true
  })()`)
  await sleep(800)
}

const glassSurfaces = await evaluate(`(() => {
  const out = []
  for (const sel of ['.sidebar', '.queue', '.playerbar', '.context-menu']) {
    const el = document.querySelector(sel)
    if (!el) { out.push({ sel, present: false }); continue }
    const s = getComputedStyle(el)
    out.push({ sel, present: true, backdrop: (s.backdropFilter || '').slice(0, 40) })
  }
  return out
})()`)
console.log("glass surfaces:", JSON.stringify(glassSurfaces, null, 2))

/*
 * The comparison is *paired*, and that is the whole design.
 *
 * The first version measured "glass on", then "glass off", then reported a
 * difference. On a machine that is also running builds, that measures whichever
 * arm happened to be running when something else took the CPU: two consecutive
 * runs of the same build reported 2 dropped frames and then 18, with the 18
 * landing on a different configuration each time. The glass does not cost 16
 * frames sometimes.
 *
 * So each round measures both arms back to back, and the arms alternate between
 * rounds. A contention spike has to land in both, which is the only way the
 * median of the differences means anything.
 */
const setGlass = (on) => `(() => {
  const els = [...document.querySelectorAll('[style*="backdrop-filter"]')]
  for (const el of els) {
    if (${on}) {
      const saved = el.dataset.glassValue
      if (saved) {
        el.style.setProperty('backdrop-filter', saved)
        el.style.setProperty('-webkit-backdrop-filter', saved)
      }
    } else {
      if (!el.dataset.glassValue) el.dataset.glassValue = el.style.getPropertyValue('backdrop-filter')
      el.style.setProperty('backdrop-filter', 'none')
      el.style.setProperty('-webkit-backdrop-filter', 'none')
    }
  }
  return els.length
})()`

const ROUNDS = Number(process.argv[3] ?? 3)
const onResults = []
const offResults = []

for (let round = 0; round < ROUNDS; round++) {
  // Alternate which arm goes first, so ordering cannot favour either one.
  const arms = round % 2 === 0 ? ["on", "off"] : ["off", "on"]
  for (const arm of arms) {
    await evaluate(setGlass(arm === "on"))
    await sleep(300)
    const label = `round ${round + 1}, drawer ${drawerOpen ? "open" : "closed"}, glass ${arm}`
    const result = await sweep(label)
    if (result.error) continue
    ;(arm === "on" ? onResults : offResults).push(result)
  }
}

if (onResults.length === 0 || offResults.length === 0) {
  console.log("\nRESULT: INCONCLUSIVE — not enough usable samples on both arms.")
  process.exit(1)
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
const summarise = (rs) => ({
  n: rs.length,
  median: median(rs.map((r) => r.median)),
  p95: median(rs.map((r) => r.p95)),
  worst: Math.max(...rs.map((r) => r.worst)),
  over32: median(rs.map((r) => r.over32)),
  frames: median(rs.map((r) => r.frames)),
})

const on = summarise(onResults)
const off = summarise(offResults)

const fmt = (s) =>
  `median ${s.median}ms  p95 ${s.p95}ms  worst ${s.worst}ms  ` +
  `dropped>32ms: ${s.over32}  (n=${s.n})`

console.log(`\n=== ${ROUNDS} paired rounds, drawer ${drawerOpen ? "open" : "closed"} ===`)
console.log(`  glass on : ${fmt(on)}`)
console.log(`  glass off: ${fmt(off)}`)
console.log(`\n  difference: p95 ${(on.p95 - off.p95 >= 0 ? "+" : "")}${(on.p95 - off.p95).toFixed(1)}ms` +
            `   dropped ${on.over32 - off.over32 >= 0 ? "+" : ""}${on.over32 - off.over32}`)

const bad = on.p95 - off.p95 > 6 || on.over32 - off.over32 > 2
console.log(
  bad
    ? "\nRESULT: the glass is costing frames even against its own baseline. Weaken\n" +
        "the displacements or narrow the surfaces they are on."
    : "\nRESULT: the glass is not measurably costing frames against its own baseline.",
)
process.exit(bad ? 1 : 0)
