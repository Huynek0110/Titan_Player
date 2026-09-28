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
 * Usage: node scripts\probe-lyric-animation.mjs <cdpPort> [sampleMs]
 */
const port = process.argv[2] ?? "9222"
const sampleMs = Number(process.argv[3] ?? 60)

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
 * This machine reports `prefers-reduced-motion: reduce`, because Windows has
 * animation effects switched off. That is a real preference and the app honours
 * it, which means the moving part of the line change is correctly suppressed and
 * cannot be observed here as-is.
 *
 * So the probe forces the other branch through Chromium's own media emulation.
 * That verifies the animation *works* for users who have motion enabled, and the
 * reduced-motion path is verified separately by reading what the component renders.
 */
await send("Emulation.setEmulatedMedia", {
  features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
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
if (state.paused) {
  console.error("\nThe audio is paused, so the current line will not move and this probe")
  console.error("cannot tell a stopped clock from a broken animation. Re-run it with")
  console.error("`shot-nowplaying-quiet.mjs` ending in `keep-playing`.")
  process.exit(1)
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

process.exit(sawTransition ? 0 : 1)
