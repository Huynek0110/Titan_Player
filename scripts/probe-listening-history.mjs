/**
 * Listening history, end to end.
 *
 * The unit tests cover the threshold. This covers the parts they cannot: that a
 * real play session is measured at all, that the main process writes it, and that
 * the count comes back into the row.
 *
 * It deliberately exercises both outcomes, because "nothing was recorded" and "the
 * wrong thing was recorded" fail in opposite directions and only running both
 * distinguishes a threshold that is far too low from one that never fires. A test
 * that only checks a play would also pass if every skip were counted as a play.
 *
 * Two sessions, on the shortest track in the library so the threshold is 27
 * seconds rather than ninety:
 *
 *   1. play for 8s, skip  -> `skips: 1`, `plays: 0`
 *   2. play for 30s, skip -> `plays: 1`
 *
 * Playback is muted at zero volume throughout and the script asserts it at the
 * end. It does have to actually play: the counter measures real listening, so
 * seeking to 0:40 and skipping is *supposed* to be ignored, and that is a
 * property worth being unable to fake.
 *
 * Usage: node scripts\probe-listening-history.mjs [cdpPort] [--keep]
 */
import { existsSync, readFileSync, rmSync } from "node:fs"
import path from "node:path"

const port = process.argv[2] ?? "9222"
const keep = process.argv.includes("--keep")

/** The 54-second track, so its threshold is 27s rather than ninety. */
const TRACK = "Intenpol"

let failures = 0
const fail = (name, detail) => {
  failures++
  console.log(`  FAIL  ${name}\n        ${detail}`)
}
const pass = (name, detail) => console.log(`  ok    ${name}${detail ? `  (${detail})` : ""}`)

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
  const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })
  if (res.result?.exceptionDetails) {
    return { threw: res.result.exceptionDetails.exception?.description ?? res.result.exceptionDetails.text }
  }
  return res.result?.result?.value
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await send("Page.enable")
await send("Runtime.enable")
await send("Page.bringToFront")

console.log("\nlistening history, end to end\n")

/*
 * The history is cumulative by design, so this measures a *delta*.
 *
 * Requiring a reset before each run would make the script correct exactly once.
 * A listening history is meant to accumulate, and a test that stops meaning
 * anything on its second invocation is the kind that reports success forever
 * while checking nothing.
 */
/*
 * Rows are `.row` in the table and `.simple-row` in the compact layout TrackList
 * falls back to for a list of under four tracks — which is exactly what a first
 * run of this script produces, so a probe that only knows `.row` finds nothing
 * and reports an empty list where the feature is working.
 */
const ROW_SEL = ".row, .simple-row"

const readHistory = () => evaluate(`(async () => (await window.titan.getListeningHistory()))()`)

const findRowId = async () =>
  evaluate(`(() => {
    const row = [...document.querySelectorAll('.row, .simple-row')]
      .find(r => new RegExp(${JSON.stringify(TRACK)}, 'i').test(r.innerText || ''))
    return row?.dataset?.id ?? null
  })()`)

await evaluate(`(() => {
  const b = [...document.querySelectorAll('.nav-item, button')].find(n => /all songs/i.test(n.textContent || ''))
  if (b) b.click()
  return true
})()`)
await sleep(900)

const before = await readHistory()
const baseline = (await findRowId()) ? before[await findRowId()] : undefined
console.log(`  before: ${JSON.stringify(baseline ?? { plays: 0, skips: 0, listenedMs: 0 })}`)

const silence = () =>
  evaluate(`(() => { const a = document.querySelector('audio'); if (a) { a.volume = 0; a.muted = true } return true })()`)

await silence()
await evaluate(`(() => {
  const b = [...document.querySelectorAll('.nav-item, button')].find(n => /all songs/i.test(n.textContent || ''))
  if (b) b.click()
  return true
})()`)
await sleep(900)

/**
 * Double-click the row matching `re`, the way a user starts a track.
 *
 * And then make sure it actually started. A double-click loads the track either
 * way — `currentTime` stays 0 and only `duration` proves the right file loaded —
 * so a probe that stops there reports a session of zero listened time and a
 * threshold that was never crossed, which looks like a broken counter rather than
 * an unstarted track.
 *
 * The fallback is the transport's own play button, which is a different control
 * with a different activation path. If neither works, the element's own error is
 * reported rather than guessed at.
 */
const startTrack = async (re) => {
  const spot = await evaluate(`(() => {
    const row = [...document.querySelectorAll('.row, .simple-row')].find(r => new RegExp(${JSON.stringify(re.source)}, 'i').test(r.innerText || ''))
    if (!row) return { missing: true }
    const el = row.querySelector('.row-title') ?? row
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0 || r.top < 0 || r.top > innerHeight) {
      row.scrollIntoView({ block: 'center' })
    }
    const r2 = el.getBoundingClientRect()
    return { x: Math.round(r2.left + 8), y: Math.round(r2.top + r2.height / 2), text: row.innerText.replace(/\\n/g, ' ').slice(0, 40) }
  })()`)
  if (!spot || spot.missing) return { ok: false, why: `no row matching /${re.source}/` }

  await send("Page.bringToFront")
  for (let i = 1; i <= 2; i++) {
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: spot.x, y: spot.y, button: "left", clickCount: i })
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: spot.x, y: spot.y, button: "left", clickCount: i })
    await sleep(70)
  }
  await sleep(1100)
  await silence()

  let state = await evaluate(`(() => {
    const a = document.querySelector('audio')
    return a ? { paused: a.paused, t: Number(a.currentTime.toFixed(2)), dur: Math.round(a.duration || 0), ready: a.readyState, err: a.error?.code ?? null } : null
  })()`)

  if (state?.paused) {
    const play = await evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find(n => /^play$/i.test(n.getAttribute('aria-label') || ''))
      if (!b || b.disabled) return { missing: true }
      const r = b.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    })()`)
    if (play && !play.missing) {
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x: play.x, y: play.y, button: "left", clickCount: 1 })
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: play.x, y: play.y, button: "left", clickCount: 1 })
      await sleep(700)
      await silence()
    }
    state = await evaluate(`(() => {
      const a = document.querySelector('audio')
      return a ? { paused: a.paused, t: Number(a.currentTime.toFixed(2)), dur: Math.round(a.duration || 0), ready: a.readyState, err: a.error?.code ?? null, triedPlayButton: true } : null
    })()`)
  }

  if (state?.paused) {
    return { ok: false, why: `the track loaded but would not play: ${JSON.stringify(state)}` }
  }
  return { ok: true, text: spot.text, state }
}

/** Let the clock actually run, then confirm it did. */
const playFor = async (seconds) => {
  const started = await evaluate(`(() => {
    const a = document.querySelector('audio')
    if (!a) return 'no audio'
    a.volume = 0; a.muted = true
    return 'ok'
  })()`)
  if (started !== "ok") return started
  const t0 = await evaluate(`Number((document.querySelector('audio')?.currentTime ?? 0).toFixed(2))`)
  await sleep(seconds * 1000)
  await silence()
  const t1 = await evaluate(`Number((document.querySelector('audio')?.currentTime ?? 0).toFixed(2))`)
  return { from: t0, to: t1, advanced: t1 - t0 }
}

const next = async () => {
  const spot = await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(n => /^(next|skip)$/i.test(n.getAttribute('aria-label') || ''))
    if (!b || b.disabled) return { missing: true }
    const r = b.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  })()`)
  if (!spot || spot.missing) return false
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: spot.x, y: spot.y, button: "left", clickCount: 1 })
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: spot.x, y: spot.y, button: "left", clickCount: 1 })
  await sleep(400)
  await silence()
  return true
}

// --- 1. a session abandoned early -----------------------------------------

const first = await startTrack(new RegExp(TRACK))
if (!first.ok) {
  console.error(`could not start the track: ${first.why}`)
  process.exit(1)
}
console.log(`  track: ${first.text}`)

// Read after playback has begun: `duration` is NaN until metadata arrives, and
// printing "threshold: NaN" reads like a defect rather than a timing of the read.
const duration = await evaluate(`(() => {
  const d = document.querySelector('audio')?.duration
  return Number.isFinite(d) ? d : 0
})()`)
if (duration > 0) {
  console.log(`  duration: ${Math.round(duration)}s, threshold: ${Math.max(10, Math.min(duration * 0.5, 240)).toFixed(1)}s`)
} else {
  console.log("  duration: not reported yet")
}

const short = await playFor(8)
console.log(`  session 1 clock: ${JSON.stringify(short)}`)
if (typeof short === "object" && short.advanced < 5) {
  fail("the clock runs during a session", `advanced only ${short.advanced}s in 8s`)
} else {
  pass("the clock runs during a session", `${short.from}s -> ${short.to}s`)
}

if (!(await next())) {
  console.error("could not press Next")
  process.exit(1)
}
await sleep(900)

// --- 2. a session played past the threshold --------------------------------

const second = await startTrack(new RegExp(TRACK))
if (!second.ok) {
  console.error(`could not restart the track: ${second.why}`)
  process.exit(1)
}
const long = await playFor(32)
console.log(`  session 2 clock: ${JSON.stringify(long)}`)
if (typeof long === "object" && long.advanced < 28) {
  fail("the long session actually played", `advanced only ${long.advanced}s in 32s`)
} else {
  pass("the long session actually played", `${long.from}s -> ${long.to}s`)
}

if (!(await next())) {
  console.error("could not press Next")
  process.exit(1)
}
await sleep(1200)

// --- 3. what the renderer now believes -------------------------------------

const rows = await evaluate(`(() => {
  const row = [...document.querySelectorAll('.row, .simple-row')]
    .find(r => new RegExp(${JSON.stringify(TRACK)}, 'i').test(r.innerText || ''))
  return {
    plays: row?.querySelector('.row-plays')?.innerText ?? null,
    title: row?.innerText.replace(/\\n/g, ' | ').slice(0, 60) ?? null,
  }
})()`)
console.log(`  row: ${JSON.stringify(rows)}`)

if (/\d/.test(rows?.plays ?? "")) {
  pass("the row shows its play count", rows.plays)
} else {
  fail("the row shows its play count", `badge reads ${JSON.stringify(rows.plays)}`)
}

await evaluate(`(() => {
  const nav = [...document.querySelectorAll('.nav-item, button')]
    .find(n => /recently played/i.test(n.textContent || ''))
  if (nav) nav.click()
  return true
})()`)
await sleep(700)

const recentRows = await evaluate(`(() => {
  const list = document.querySelectorAll('.row, .simple-row')
  return {
    count: list.length,
    first: list[0]?.innerText.replace(/\\n/g, ' | ').slice(0, 50) ?? null,
    containsTrack: [...list].some(r => new RegExp(${JSON.stringify(TRACK)}, 'i').test(r.innerText || '')),
  }
})()`)
console.log(`  recently played: ${JSON.stringify(recentRows)}`)

if (recentRows.containsTrack) pass("Recently Played includes the track", recentRows.first)
else fail("Recently Played includes the track", `${recentRows.count} rows, none of them ours`)

// --- 4. what was actually written -----------------------------------------

/*
 * Read back through the bridge, so this is the file's contents and not the
 * renderer's optimistic copy. And compared against the baseline, so the numbers
 * asserted are the two sessions this run created rather than a total that grows
 * every time the script runs.
 */
const after = await readHistory()
const id = await findRowId()
const record = id ? after?.[id] : undefined
const base = baseline ?? { plays: 0, skips: 0, listenedMs: 0 }

if (!record) {
  fail("a record exists for the track", `no entry for id ${id}; wrote ${JSON.stringify(after)}`)
} else {
  const dPlays = record.plays - base.plays
  const dSkips = record.skips - base.skips
  const dMs = record.listenedMs - base.listenedMs

  if (dPlays !== 1) fail("one session counted as a play", `+${dPlays}, expected +1`)
  else pass("one session counted as a play", `+${dPlays} (total ${record.plays})`)

  if (dSkips !== 1) fail("one session counted as a skip", `+${dSkips}, expected +1`)
  else pass("one session counted as a skip", `+${dSkips} (total ${record.skips})`)

  /*
   * The listened total is the real evidence that both sessions were measured
   * rather than one having been counted twice or neither at all: 8s plus 32s is
   * about 40s. The counter caps each tick at three seconds, so it can exceed wall
   * time only if something is wrong, which makes a generous upper bound enough.
   */
  const total = dMs / 1000
  if (total < 30 || total > 55) {
    fail("the listened total matches the two sessions", `+${total.toFixed(1)}s, expected roughly 40`)
  } else {
    pass("the listened total matches the two sessions", `+${total.toFixed(1)}s of about 40`)
  }
}

// --- 5. silence ------------------------------------------------------------

const audio = await evaluate(`(() => {
  const a = document.querySelector('audio')
  return a ? { paused: a.paused, volume: a.volume, muted: a.muted } : null
})()`)
if (audio && audio.volume === 0 && audio.muted) pass("silence held throughout", JSON.stringify(audio))
else fail("silence held throughout", JSON.stringify(audio))

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} failed`}\n`)

ws.close()
process.exit(failures === 0 ? 0 : 1)
