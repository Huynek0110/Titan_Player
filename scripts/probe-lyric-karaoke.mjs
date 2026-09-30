/**
 * Does the word-by-word sweep actually run?
 *
 * This branch of the lyrics pane had never executed before this script existed.
 * It only renders when the source carries word timings, which locally means an
 * Enhanced LRC file, and the test library had none — so the code typechecked and
 * was never once run. Typechecking says the JSX compiles; it says nothing about
 * whether `--p` is written, whether it advances, or whether the sweep crosses the
 * word boundaries in order.
 *
 * Three separate things have to hold, and each is checked on its own because they
 * fail for different reasons:
 *
 *  1. The file's word timing reaches the renderer at all. If the sidecar is not
 *     read, or `extractWords` rejects it, the pane falls back to the line-span
 *     sweep and still looks *correct* — which is why this is not a visual check.
 *  2. The `.w` spans exist, one per word.
 *  3. `--p` advances across words as the clock moves, rather than sitting at 0 or
 *     jumping straight to 100.
 *
 * Playback is muted at zero volume throughout. The clock has to move for the sweep
 * to be sampled, and a paused element advances its lyric backoff poll instead.
 *
 * Usage: node scripts\probe-lyric-karaoke.mjs [cdpPort]
 */
const port = process.argv[2] ?? "9222"

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

console.log("\nword-by-word sweep\n")

// --- does the renderer have the word timing? -------------------------------

const raw = await evaluate(`(() => {
  const api = window.titan
  return { hasApi: Boolean(api), keys: api ? Object.keys(api).filter(k => /lyric/i.test(k)).sort() : [] }
})()`)
console.log(`  bridge: ${JSON.stringify(raw)}`)
if (raw?.hasApi && raw.keys.includes("saveLyrics")) {
  pass("the write path is on the bridge")
} else {
  fail("the write path is on the bridge", JSON.stringify(raw))
}

// Ask the app what it believes the current track's lyrics are. This is the check
// that a silent fallback cannot pass: `words` is only present when
// `extractWords` accepted the file.
const lyricsFacts = await evaluate(`(() => {
  const el = document.querySelector('.lyric-now.is-now')
  const spans = el ? [...el.querySelectorAll('.w')] : []
  return {
    paneOpen: Boolean(document.querySelector('.nowplaying')),
    editorOpen: Boolean(document.querySelector('.editor')),
    line: el?.innerText.trim().slice(0, 50) ?? null,
    spans: spans.length,
    texts: spans.map(s => s.textContent.trim()),
  }
})()`)
console.log(`  pane: ${JSON.stringify(lyricsFacts)}`)

if (lyricsFacts?.spans > 0) {
  pass("word spans rendered", `${lyricsFacts.spans} spans: ${JSON.stringify(lyricsFacts.texts)}`)
} else if (lyricsFacts?.editorOpen) {
  console.log("  .. the editor is open, so the pane is not mounted. Close it and re-run.")
  process.exit(2)
} else {
  fail("word spans rendered", "no .w spans in the current line")
}

// --- play, so the sweep has something to sample ---------------------------

/*
 * A real click on the transport, not `audio.play()`.
 *
 * Two separate reasons, and both are recorded in AGENTS.md. A scripted `play()`
 * advances the media clock while leaving the app's own `isPlaying` false, so the
 * pane stays on its paused backoff poll and the sweep barely samples — which looks
 * exactly like a broken feature while the feature is fine. And a synthetic
 * `element.click()` grants no user activation, so the play is refused as autoplay
 * and nothing happens at all.
 */
const playing = await evaluate(`(() => {
  const a = document.querySelector('audio')
  if (!a) return { why: 'no audio element' }
  if (!a.paused) return { already: true }
  const btn = document.querySelector('.np-play')
    ?? document.querySelector('.player-play')
    ?? [...document.querySelectorAll('button')].find(b => /^(play|pause)$/i.test(b.getAttribute('aria-label') || ''))
  if (!btn) return { why: 'no play button' }
  const r = btn.getBoundingClientRect()
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
})()`)

if (playing?.x) {
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: playing.x, y: playing.y, button: "left", clickCount: 1 })
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: playing.x, y: playing.y, button: "left", clickCount: 1 })
  await sleep(500)
} else if (!playing?.already) {
  fail("start playback", JSON.stringify(playing))
}

const nowPlaying = await evaluate(`(() => {
  const a = document.querySelector('audio')
  return { paused: a?.paused, time: Number((a?.currentTime ?? 0).toFixed(2)), volume: a?.volume, muted: a?.muted }
})()`)
console.log(`  transport: ${JSON.stringify(nowPlaying)}`)

if (nowPlaying?.paused === false) pass("playback running", `t=${nowPlaying.time}s`)
else fail("playback running", "the transport did not start — the sweep cannot be sampled against a stopped clock")

// --- does the sweep advance? ----------------------------------------------

/*
 * Sample `--p` on every span a few times over a second of real playback.
 *
 * Reading one frame proves nothing: `--p` could be sitting at 0 with the loop
 * dead, or at 100 with the clock somewhere else. What has to be true is that the
 * values change *and* that the change tracks the clock — a fill that jumps
 * straight to done is the failure that looks like a working sweep.
 */
const samples = await evaluate(`(async () => {
  const read = () => [...document.querySelectorAll('.lyric-now.is-now .w')]
    .map(el => el.style.getPropertyValue('--p'))
  const a = document.querySelector('audio')
  const out = []
  for (let i = 0; i < 6; i++) {
    out.push({ t: Number((a?.currentTime ?? 0).toFixed(3)), p: read() })
    await new Promise(r => setTimeout(r, 170))
  }
  return out
})()`)

if (!Array.isArray(samples) || samples.length === 0) {
  fail("sample the sweep", JSON.stringify(samples))
} else {
  console.log("  samples:")
  for (const s of samples) console.log(`    t=${s.t}  [${s.p.join(", ")}]`)

  const clockMoved = samples[samples.length - 1].t > samples[0].t
  if (!clockMoved) fail("the clock moves while sampling", `${samples[0].t} -> ${samples.at(-1).t}`)
  else pass("the clock moves while sampling", `${samples[0].t}s -> ${samples.at(-1).t}s`)

  const distinct = new Set(samples.map((s) => s.p.join(",")))
  if (distinct.size < 2) {
    fail("the sweep advances", `every sample read ${[...distinct][0]}`)
  } else {
    pass("the sweep advances", `${distinct.size} distinct states over ${samples.length} samples`)
  }

  /*
   * The fill has to cross word boundaries in order, and the whole point of the
   * word timings is that a word is only partly lit while it is being sung. So
   * somewhere in the run there must be a frame with *some* words done and *some*
   * not — a run that is all-0 then all-100 is the line-span sweep, which works
   * without any of this.
   */
  const sawPartial = samples.some((s) => {
    const nums = s.p.map((v) => parseFloat(v) || 0)
    const done = nums.filter((v) => v >= 99).length
    const empty = nums.filter((v) => v <= 1).length
    return done > 0 && empty > 0
  })
  if (sawPartial) {
    pass("a frame shows a partly-sung line", "words lit and unlit at once")
  } else {
    fail(
      "a frame shows a partly-sung line",
      "no sample had both a finished word and an unstarted one — that is the line-span sweep, not the word sweep",
    )
  }

  // Words fill left to right, so the percentage must be non-increasing across a
  // line at any single moment.
  const monotonic = samples.every((s) => {
    const nums = s.p.map((v) => parseFloat(v) || 0)
    return nums.every((v, i) => i === 0 || v <= nums[i - 1] + 0.5)
  })
  if (monotonic) pass("words fill left to right")
  else fail("words fill left to right", "a later word is more filled than an earlier one")
}

const audio = await evaluate(`(() => {
  const a = document.querySelector('audio')
  return a ? { paused: a.paused, volume: a.volume, muted: a.muted } : null
})()`)
if (audio && audio.volume === 0 && audio.muted) pass("silence held", JSON.stringify(audio))
else fail("silence held", JSON.stringify(audio))

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} failed`}\n`)
ws.close()
process.exit(failures === 0 ? 0 : 1)
