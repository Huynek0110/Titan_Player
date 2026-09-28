/**
 * Does the line-change animation actually run, and does it run the way it is
 * supposed to?
 *
 * This replaced a probe that looked for a fading outgoing line. There is no
 * outgoing line any more — the line that *was* current is the same DOM node, now
 * carrying `is-next-1`, because every line is keyed on its timestamp and stays
 * mounted. The whole transition is a class change on a node that already exists.
 *
 * So the questions this answers are different ones:
 *
 *   1. Do all three lines really share one font size? If they do not, something
 *      has reintroduced the reflow that broke the rhythm, and it is the defect
 *      this whole design exists to avoid.
 *   2. Is the hierarchy carried by `transform` rather than by size?
 *   3. When the active line changes, does anything actually *interpolate* — or
 *      does it snap? A snap means no transition is running, which is the failure
 *      a static screenshot cannot see.
 *
 * Plays with the volume pinned to zero. Playback has to be arranged by
 * `shot-nowplaying-quiet.mjs <port> <out> <row> <seek> keep-playing`, which
 * double-clicks a row with real input events and so goes through the app's own
 * code. A probe that calls `audio.play()` itself advances the clock but leaves the
 * app's `isPlaying` false, so the lyrics pane stays on its paused backoff poll and
 * the current line never moves — which looks exactly like a broken animation when
 * the feature is fine.
 *
 * Usage: node scripts\probe-lyric-animation.mjs <cdpPort> [sampleMs] [reduce]
 *
 * `reduce` leaves the media emulation off, so the app's own
 * `prefers-reduced-motion` branch is what runs. That branch is checked for two
 * different things and the first version of this file checked neither: the scale
 * hierarchy must *survive* it, and the transition must *not*.
 */
const port = process.argv[2] ?? "9222"
const sampleMs = Number(process.argv[3] ?? 60)
const asReduced = process.argv[4] === "reduce"

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
    // Chromium's autoplay policy treats a script-initiated `play()` with no user
    // activation as a blocked play, so without this the element silently stays
    // paused and every sample reads the same frame.
    userGesture: true,
  })
  if (res.result?.exceptionDetails) return { threw: res.result.exceptionDetails.text }
  return res.result?.result?.value
}

await send("Runtime.enable")

/*
 * Emulate the preference explicitly in BOTH directions.
 *
 * The first version only *set* it for the animation run and *left it alone* for
 * the reduced run, on the assumption that dropping the override would restore the
 * host's real setting. It does not: `Emulation.setEmulatedMedia` is sticky on the
 * target, so the reduced run inherited `no-preference` from the previous run and
 * cheerfully reported the animated behaviour as the reduced one. Anything that
 * can be pinned must be pinned in both states, or the comparison is meaningless.
 */
await send("Emulation.setEmulatedMedia", {
  features: [
    { name: "prefers-reduced-motion", value: asReduced ? "reduce" : "no-preference" },
  ],
})

const state = await evaluate(`(() => {
  const a = document.querySelector('audio')
  if (!a) return { error: 'no audio element' }
  a.volume = 0
  a.muted = true
  return {
    paused: a.paused,
    t: Number(a.currentTime.toFixed(2)),
    lines: document.querySelectorAll('.lyric-now').length,
    nowPlayingOpen: Boolean(document.querySelector('.nowplaying')),
  }
})()`)
console.log("state:", JSON.stringify(state))

if (state.error) process.exit(1)

/*
 * Get playback going, if it is not already.
 *
 * The rule everywhere in this repo is that a probe must not *start* playback by
 * calling `audio.play()`: it advances the media clock but leaves the app's
 * `isPlaying` false, so the lyrics pane stays on its paused backoff poll and the
 * current line never moves — which is indistinguishable from a broken animation.
 *
 * Clicking the app's own transport button through a real input event is the one
 * exception that is honest, because it goes through the app's own code and the
 * app's own state. So that is what this does rather than making every invocation
 * a two-command dance with `shot-nowplaying-quiet.mjs`.
 */
if (state.paused) {
  /*
   * A real double-click at real coordinates, through CDP.
   *
   * Both alternatives were tried and both fail in ways that look like success:
   * `audio.play()` from a script advances the clock but leaves the app's
   * `isPlaying` false, and `element.click()` from `Runtime.evaluate` does not
   * grant user activation, so Chromium's autoplay policy blocks the play and the
   * element stays paused — while the script has already printed that it clicked.
   * Only a dispatched input event gets the element playing, and it goes through
   * the app's own row handler, so the app's own state is correct too.
   */
  await evaluate(`(() => {
    // Leave Now Playing first. That view marks the shell \`inert\` and traps
    // focus, so a row in the library exists, is not disabled, and silently does
    // nothing when clicked.
    if (document.querySelector('.nowplaying')) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    }
    const a = document.querySelector('audio')
    if (a) { a.volume = 0; a.muted = true }
    return true
  })()`)
  await new Promise((r) => setTimeout(r, 700))

  const spot = await evaluate(`(() => {
    const row = document.querySelectorAll('.row')[1] || document.querySelectorAll('.row')[0]
    if (!row) return null
    const t = row.querySelector('.row-title') ?? row
    const r = t.getBoundingClientRect()
    return { x: Math.round(r.left + 8), y: Math.round(r.top + r.height / 2) }
  })()`)

  if (!spot) {
    console.error("\nNo track row to click. Is the library view open?")
    process.exit(1)
  }
  for (let i = 1; i <= 2; i += 1) {
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed", x: spot.x, y: spot.y, button: "left", clickCount: i,
    })
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased", x: spot.x, y: spot.y, button: "left", clickCount: i,
    })
    await new Promise((r) => setTimeout(r, 50))
  }
  console.log("was paused; double-clicked a row at", JSON.stringify(spot))
  await new Promise((r) => setTimeout(r, 2000))
  await new Promise((r) => setTimeout(r, 2500))
  const after = await evaluate(`(() => {
    const a = document.querySelector('audio')
    return { paused: a ? a.paused : null, t: a ? Number(a.currentTime.toFixed(2)) : null }
  })()`)
  console.log("now:", JSON.stringify(after))
  if (after.paused) {
    console.error("\nStill paused, so the current line will not move and this probe cannot")
    console.error("tell a stopped clock from a broken animation. Start playback in the app")
    console.error("and re-run.")
    process.exit(1)
  }
}

const motion = await evaluate(
  `matchMedia('(prefers-reduced-motion: reduce)').matches ? 'reduce' : 'no-preference'`,
)
console.log("prefers-reduced-motion:", motion)

/*
 * Reads the scale out of the computed transform matrix.
 *
 * A matrix rather than `transform`, because a transition on `transform` resolves
 * to `matrix(...)` and there is no readable `scale()` to compare. m11 is the
 * horizontal scale; the stack is right-aligned so only that axis is in play.
 */
const READ = `(() => {
  const a = document.querySelector('audio')
  const nodes = [...document.querySelectorAll('.lyric-now')]
  const now = nodes.find(n => n.classList.contains('is-now'))
  const scaleOf = n => {
    const m = new DOMMatrixReadOnly(getComputedStyle(n).transform)
    return Number(m.a.toFixed(4))
  }
  return {
    t: Number((a?.currentTime ?? 0).toFixed(2)),
    text: now ? now.innerText.trim().slice(0, 26) : null,
    sizes: nodes.map(n => Math.round(parseFloat(getComputedStyle(n).fontSize))),
    nowScale: now ? scaleOf(now) : null,
    nowFilter: now ? getComputedStyle(now).filter : null,
    nowShadow: now ? getComputedStyle(now).textShadow : null,
    scales: nodes.map(scaleOf),
    paused: a?.paused,
  }
})()`

const samples = []
const started = Date.now()
while (Date.now() - started < 22000) {
  const s = await evaluate(READ)
  if (s && !s.threw) samples.push(s)
  await new Promise((r) => setTimeout(r, sampleMs))
}

// Stop again so nothing keeps playing after the probe.
await evaluate(`(() => { const a = document.querySelector('audio'); if (a) a.pause(); return true })()`)

const times = samples.map((s) => s.t)
const span = times.length ? Math.max(...times) - Math.min(...times) : 0
const changes = samples.filter((s, i) => i > 0 && s.text !== samples[i - 1].text).length
console.log(
  `\nsamples: ${samples.length}, playback span: ${span.toFixed(1)}s, line changes: ${changes}`,
)

if (changes === 0) {
  console.log("\nRESULT: the current line never changed. Nothing to check.")
  process.exit(1)
}

// --- 1. one font size for every line ------------------------------------
const sizeSets = new Set(samples.flatMap((s) => s.sizes).map(String))
console.log(`\n=== font sizes seen across every line, every sample ===`)
console.log(`  ${[...sizeSets].sort((a, b) => a - b).join(", ")}`)
if (sizeSets.size > 1) {
  console.log("\nRESULT: FAIL — lines have different font sizes. That reintroduces the")
  console.log("reflow the scale-based hierarchy exists to avoid.")
  process.exit(1)
}
console.log("  OK — one size everywhere, so promotion cannot reflow anything.")

// --- 2. the hierarchy is in the transform -------------------------------
const settled = samples.filter((s) => s.nowScale !== null)
const maxScale = Math.max(...settled.map((s) => s.nowScale))
const minScale = Math.min(...settled.map((s) => s.nowScale))
console.log(`\n=== scale on the current line ===`)
console.log(`  range ${minScale.toFixed(3)} .. ${maxScale.toFixed(3)}`)
if (maxScale - minScale < 0.001) {
  console.log("  steady at one value — the *other* lines' scales carry the hierarchy:")
  const other = new Set(settled.flatMap((s) => s.scales).map((n) => n.toFixed(2)))
  console.log(`  every line's scale, across every sample: ${[...other].sort().join(", ")}`)
} else {
  console.log("  varies — that is the transition running, sampled mid-flight")
}

// --- 3. does anything interpolate, or snap? ----------------------------
/*
 * For each line that was current, look at the samples that follow it. If a
 * transition is running, at least one of them must show a scale strictly between
 * the shrunken value and 1. A jump straight to 1 means the class changed and
 * nothing animated.
 */
const BY_TEXT = new Map()
for (const s of samples) {
  if (!s.text) continue
  if (!BY_TEXT.has(s.text)) BY_TEXT.set(s.text, [])
  BY_TEXT.get(s.text).push(s)
}

const SHARP = 0.995
const SHRUNK = 0.65
console.log(`\n=== interpolation, per line that was current ===`)
let sawTransition = false
for (const [text, group] of BY_TEXT) {
  const scales = group.map((s) => s.nowScale)
  // The frames while this line was settling in, i.e. after it stopped being 1.
  const moving = scales.filter((v) => v < SHARP && v > SHRUNK)
  const distinct = new Set(scales.map((v) => v.toFixed(3)))
  const interpolated = moving.length >= 1
  if (interpolated) sawTransition = true
  console.log(
    `  ${interpolated ? "eased  " : "SNAPPED "} "${text.slice(0, 26)}"  ` +
      `scales: ${[...distinct].join(" -> ")}`,
  )
}
console.log(`\nRESULT: ${sawTransition ? "a transition is running" : "everything SNAPPED — no transition"}`)
console.log("filters seen on the current line:")
console.log(`  ${[...new Set(samples.map((s) => s.nowFilter))].join("\n  ")}`)

// --- 4. the reduced-motion branch, if that is what is running -------------
if (!asReduced) {
  console.log(
    "\nRun again with `reduce` to check the reduced-motion branch: the scale\n" +
      "hierarchy has to survive it, and the transition must not.",
  )
  process.exit(sawTransition ? 0 : 1)
}

/*
 * Under reduced motion the two requirements are opposites of each other, and the
 * mistake is satisfying one at the other's expense.
 *
 * The hierarchy must SURVIVE: the current line is still bigger and still lit.
 * Scale and glow are static styles, not motion, and a current line that is
 * neither is not identified at all.
 *
 * The transition must NOT survive: no overshoot, no travel, nothing that
 * interpolates the transform.
 */
const allScales = [...new Set(settled.flatMap((s) => s.scales).map((n) => n.toFixed(3)))]
const hierarchyIntact = allScales.length >= 2
const settledNow = settled.map((s) => s.nowScale)
const nowSnapped = settledNow.every((v) => v === 1)
const anyMid = settledNow.some((v) => v < 0.999 && v > 0.7)

console.log(`\n=== reduced motion ===`)
console.log(`  every line's scale: ${allScales.sort().join(", ")}`)
console.log(`  ${hierarchyIntact ? "OK   the size hierarchy survives" : "FAIL the hierarchy is gone — all lines are the same size"}`)
console.log(`  ${nowSnapped ? "OK   the current line sits at exactly 1" : `WARN current line scale varies: ${[...new Set(settledNow)].join(", ")}`}`)
console.log(`  ${!anyMid ? "OK   nothing is interpolating the transform" : "FAIL the transform is still animating"}`)

const exit = hierarchyIntact && !anyMid
console.log(`\nRESULT: ${exit ? "reduced motion keeps the hierarchy and drops the motion" : "reduced motion is wrong"}`)
process.exit(exit ? 0 : 1)
