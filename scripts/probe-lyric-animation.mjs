/**
 * Does the line-change animation actually run?
 *
 * Plays with the volume pinned to zero, then samples the DOM across a lyric
 * boundary and records every frame where the outgoing line is on screen, together
 * with its computed opacity and transform. That answers three separate questions
 * that a screenshot cannot: does the element ever appear, does the animation
 * apply to it, and how long does it last.
 *
 * Usage: node scripts\probe-lyric-animation.mjs <cdpPort> [sampleMs]
 */
const port = process.argv[2] ?? "9222"
const sampleMs = Number(process.argv[3] ?? 90)

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
    // paused and every sample reads the same frame. A real click goes through
    // `Input.dispatchMouseEvent` instead, which grants activation the honest way.
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
 * reduced-motion path is verified separately by reading what the component
 * renders.
 */
await send("Emulation.setEmulatedMedia", {
  features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
})

// No sound: muted, and the volume genuinely zero.
//
// Playback has to be started by clicking the app's own button, through a real
// input event. Calling `audio.play()` from a script advances the clock but leaves
// the app's `isPlaying` false, so the lyrics pane stays on its paused backoff poll
// and the current line never moves — which looks exactly like the animation being
// broken when it is only the test driving the player behind its back.
/*
 * This probe only observes. Playback is arranged by whoever runs it, with
 * `shot-nowplaying-quiet.mjs <port> <out> <row> <seek> keep-playing`, which
 * double-clicks a row with real input events and therefore goes through the app's
 * own code.
 *
 * Every attempt to *start* playback from inside this file failed, and each failure
 * looked like the feature being broken:
 *
 *  - `audio.play()` from a script advances the clock but leaves the app's
 *    `isPlaying` false, so the lyrics pane stays on its paused backoff poll and
 *    the current line never moves.
 *  - `Runtime.evaluate` with `userGesture: true` unblocks `play()` but still
 *    bypasses the app's own state, so the pane never sees a change either.
 *  - Clicking `.np-play` is a toggle and only lands when the view is open and the
 *    button is where `getBoundingClientRect` claims, so a second run pauses what
 *    the first started.
 *
 * Observing beats starting. The probe reports the clock span and the number of
 * distinct lines, so a stopped clock is distinguishable from a broken animation
 * rather than being reported as the animation.
 */
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

// Whether the user has asked for reduced motion, which changes the answer.
const motion = await evaluate(
  `matchMedia('(prefers-reduced-motion: reduce)').matches ? 'reduce' : 'no-preference'`,
)
console.log("prefers-reduced-motion:", motion)

// Sample fast enough to catch a 380ms animation.
const samples = []
const started = Date.now()
while (Date.now() - started < 22000) {
  const s = await evaluate(`(() => {
    const exit = document.querySelector('.lyric-now.is-exit')
    const now = document.querySelector('.lyric-now.is-now')
    const a = document.querySelector('audio')
    return {
      t: Number((a?.currentTime ?? 0).toFixed(2)),
      now: now ? now.innerText.trim().slice(0, 24) : null,
      hasExit: Boolean(exit),
      exitText: exit ? exit.innerText.trim().slice(0, 24) : null,
      exitOpacity: exit ? getComputedStyle(exit).opacity : null,
      // The filter is what the exit actually animates now. The line dissolves in
      // place rather than travelling, so the transform stays "none" throughout,
      // and sampling only that would report a line that appeared and vanished
      // without any visible change. The box is sampled too, to prove it holds
      // still.
      exitFilter: exit ? getComputedStyle(exit).filter : null,
      exitTransform: exit ? getComputedStyle(exit).transform : null,
      exitTop: exit ? Math.round(exit.getBoundingClientRect().top) : null,
      exitAnim: exit ? getComputedStyle(exit).animationName : null,
      paused: a?.paused,
      volume: a?.volume,
      muted: a?.muted,
    }
  })()`)
  if (s && !s.threw) samples.push(s)
  await new Promise((r) => setTimeout(r, sampleMs))
}

// Stop again so nothing keeps playing after the probe.
await evaluate(`(() => { const a = document.querySelector('audio'); if (a) a.pause(); return true })()`)

const withExit = samples.filter((s) => s.hasExit)
const times = samples.map((s) => s.t)
const span = times.length ? Math.max(...times) - Math.min(...times) : 0
const distinct = new Set(samples.map((s) => s.now).filter(Boolean)).size
console.log(`\nsamples: ${samples.length}, playback span: ${span.toFixed(1)}s, distinct current lines: ${distinct}`)
console.log(`with an outgoing line: ${withExit.length}`)

if (withExit.length === 0) {
  console.log("\nRESULT: the outgoing line never appeared. The exit state is not being set.")
  const lines = samples.map((s) => s.now).filter(Boolean)
  const changes = lines.filter((v, i) => i > 0 && v !== lines[i - 1]).length
  console.log(`current line changed ${changes} time(s) during playback, so the display is live.`)
  process.exit(1)
}

console.log("\n=== every sample where the outgoing line was present ===")
for (const s of withExit) {
  console.log(
    `t=${String(s.t).padStart(6)}  "${s.exitText}"  opacity=${s.exitOpacity}  ` +
      `filter=${s.exitFilter}  top=${s.exitTop}  animation=${s.exitAnim}`,
  )
}

const first = withExit[0]
const last = withExit[withExit.length - 1]
console.log(
  `\nvisible for ~${Math.round((withExit.length * sampleMs))}ms  ` +
    `opacity ${first.exitOpacity} -> ${last.exitOpacity}  ` +
    `filter ${first.exitFilter} -> ${last.exitFilter}`,
)

/*
 * The whole point of the effect is that nothing travels, so this has to be checked
 * per exit rather than across the whole run.
 *
 * The outgoing line is anchored above the *current* line, and the current line is
 * one or two rows tall depending on the lyric, so different exits legitimately sit
 * at different y. Comparing across the run would report that as movement when it
 * is just the anchor being a different height. Within one exit the box must not
 * move at all.
 */
const byExit = new Map()
for (const s of withExit) {
  const key = s.exitText
  if (!byExit.has(key)) byExit.set(key, [])
  byExit.get(key).push(s)
}
console.log("\n=== stationary check, per outgoing line ===")
let anyMoved = false
for (const [text, group] of byExit) {
  const tops = new Set(group.map((s) => s.exitTop))
  const moved = tops.size > 1
  if (moved) anyMoved = true
  console.log(
    `  ${moved ? "MOVED " : "still "} "${text.slice(0, 28)}"  y: ${[...tops].join(", ")}` +
      `  (${group.length} samples)`,
  )
}
console.log(
  anyMoved
    ? "\nRESULT: a line moved while it was dissolving. That is a scroll, not a fade."
    : "\nRESULT: every outgoing line dissolved without moving.",
)
const transforms = new Set(withExit.map((s) => s.exitTransform))
console.log(`transform: ${[...transforms].join(", ")}`)
console.log(`animation applied: ${first.exitAnim}`)

process.exit(0)
