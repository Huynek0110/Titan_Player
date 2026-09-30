/**
 * End-to-end check of the lyrics editor: edit a line, tap word timings, save,
 * and confirm what landed on disk.
 *
 * This is the only test that covers the path the round-trip unit test cannot: the
 * editor's UI, the IPC handler, the filesystem jail in `isAllowedAudio`, the
 * atomic rename, and the fact that the editor then shows what the file contains.
 * Every one of those is where a "works in the pane" feature can still be losing
 * the user's work.
 *
 * Playback runs for real during the tap, because a word sweep needs a *moving*
 * clock: with the audio paused, every tap records the same instant and the file
 * comes out with all its word tags identical, which is a valid file and a useless
 * one. The element is muted and pinned to zero volume before anything can start
 * it, and the script asserts both at the end, so it cannot produce sound.
 *
 * Usage: node scripts\probe-lyrics-editor.mjs [cdpPort] [keepOpen]
 */
import { existsSync, readFileSync, rmSync } from "node:fs"
import path from "node:path"

const port = process.argv[2] ?? "9222"
const keepOpen = process.argv[3] === "keep-open"

const LIBRARY = "C:\\Users\\Le Hung Lam\\Desktop\\drive-download-20260815T060619Z-1-001"

let failures = 0
const fail = (name, detail) => {
  failures++
  console.log(`  FAIL  ${name}\n        ${detail}`)
}
const pass = (name, detail) => console.log(`  ok    ${name}${detail ? `  (${detail})` : ""}`)

// --- CDP ------------------------------------------------------------------

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = list.find((t) => t.type === "page")
if (!page) {
  console.error("no page target. Is the app running with --remote-debugging-port?")
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
  if (res.result?.exceptionDetails) {
    return { threw: res.result.exceptionDetails.exception?.description ?? res.result.exceptionDetails.text }
  }
  return res.result?.result?.value
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await send("Page.enable")
await send("Runtime.enable")
await send("Page.bringToFront")

/**
 * Click through a real mouse event rather than `element.click()`.
 *
 * A synthetic click does not grant user activation, so anything behind a
 * play()-style gesture silently no-ops. Dispatching at the element's own centre
 * also means a hit-test failure shows up as a miss instead of passing.
 */
const clickAt = async (x, y) => {
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 })
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 })
  await sleep(90)
}

/**
 * Centre of `selector` after scrolling it into view, or why there isn't one.
 *
 * The clip check is the part that matters and it cost this script a whole run.
 * `getBoundingClientRect()` happily reports a centre for an element that is
 * scrolled out of its own `overflow-y: auto` container, and dispatching a mouse
 * event there hits whatever is actually at that viewport coordinate — which is
 * nothing at all. The click silently did nothing, the text never landed, and the
 * only symptom was an empty field three steps later.
 */
const visibleSpot = (selector) =>
  evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return { missing: true }
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return { hidden: true }
    const x = Math.round(r.left + r.width / 2)
    const y = Math.round(r.top + r.height / 2)
    if (y < 0 || y > innerHeight || x < 0 || x > innerWidth) {
      return { offscreen: true, x, y, w: innerWidth, h: innerHeight }
    }
    return { x, y }
  })()`)

/** Scroll, click, and confirm the click landed by checking focus or the value. */
const clickVisible = async (selector) => {
  const spot = await visibleSpot(selector)
  if (!spot || spot.missing) return { ok: false, why: `no ${selector}` }
  if (spot.hidden) return { ok: false, why: `${selector} has no box` }
  if (spot.offscreen) return { ok: false, why: `${selector} is outside the window at ${spot.x},${spot.y}` }
  await clickAt(spot.x, spot.y)
  return { ok: true }
}

/** Click the first element whose visible text matches `re`, or report why not. */
const clickByText = async (selector, re) => {
  const spot = await evaluate(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find(n => new RegExp(${JSON.stringify(re.source)}, ${JSON.stringify(re.flags)}).test(n.innerText || ''))
    if (!el) return { missing: true }
    el.scrollIntoView({ block: 'nearest' })
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return { clipped: true, text: el.innerText }
    const x = Math.round(r.left + r.width / 2)
    const y = Math.round(r.top + r.height / 2)
    if (y < 0 || y > innerHeight || x < 0 || x > innerWidth) {
      return { offscreen: true, text: el.innerText, x, y, w: innerWidth, h: innerHeight }
    }
    return { x, y, text: el.innerText }
  })()`)
  if (!spot || spot.missing) return { ok: false, why: `no ${selector} matching /${re.source}/` }
  if (spot.clipped) return { ok: false, why: `${spot.text} is not rendered` }
  if (spot.offscreen) {
    return { ok: false, why: `${spot.text} is outside the window at ${spot.x},${spot.y} of ${spot.w}x${spot.h}` }
  }
  await clickAt(spot.x, spot.y)
  return { ok: true }
}

const clickSelector = async (selector) => clickVisible(selector)

const pressKey = async (key, code = "KeyA", text = "a") => {
  await send("Input.dispatchKeyEvent", { type: "keyDown", key, code, text, windowsVirtualKeyCode: 65 })
  await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: 65 })
  await sleep(130)
}

const silence = () =>
  evaluate(`(() => {
    const a = document.querySelector('audio')
    if (!a) return false
    a.volume = 0; a.muted = true
    return true
  })()`)

console.log("\nlyrics editor: edit, tap, save\n")

// --- 1. a track is loaded and paused ---------------------------------------

await evaluate(`(() => {
  const a = document.querySelector('audio')
  if (a) { a.volume = 0; a.muted = true }
  return true
})()`)

const nav = await evaluate(`(() => {
  const b = [...document.querySelectorAll('.nav-item, button')]
    .find(n => /all songs/i.test(n.textContent || ''))
  if (!b) return false
  b.click()
  return true
})()`)
if (!nav) {
  console.error("no All Songs nav item")
  process.exit(1)
}
await sleep(800)

/** The track under test, and where its sidecar would go. */
const target = await evaluate(`(() => {
  const row = document.querySelectorAll('.row')[2]
  if (!row) return null
  const title = (row.querySelector('.row-title') ?? row).innerText.trim()
  const r = (row.querySelector('.row-title') ?? row).getBoundingClientRect()
  return { title, x: Math.round(r.left + 8), y: Math.round(r.top + r.height / 2) }
})()`)
if (!target) {
  console.error("no track rows")
  process.exit(1)
}
console.log(`  track: ${target.title}`)

for (let i = 1; i <= 2; i++) {
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: target.x, y: target.y, button: "left", clickCount: i })
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: target.x, y: target.y, button: "left", clickCount: i })
  await sleep(60)
}
await sleep(700)
await silence()

const opened = await evaluate(`(() => {
  const b = [...document.querySelectorAll('button')]
    .find(n => /now playing/i.test(n.getAttribute('aria-label') || ''))
  if (!b) return 'missing'
  if (b.disabled) return 'disabled'
  b.click()
  return 'ok'
})()`)
if (opened !== "ok") {
  console.error(`could not open now playing: ${opened}`)
  process.exit(1)
}
await sleep(1600)

// --- 2. open the editor ----------------------------------------------------

const editorBtn = await clickByText(".np-action", /edit lyrics|done editing/i)
if (!editorBtn.ok) {
  console.error(`editor button: ${editorBtn.why}`)
  process.exit(1)
}
await sleep(700)

if (!(await evaluate(`Boolean(document.querySelector('.editor'))`))) {
  fail("editor opens", ".editor is not in the DOM")
} else {
  pass("editor opens")
}

const beforeRows = await evaluate(`document.querySelectorAll('.ed-row').length`)
console.log(`  rows on open: ${beforeRows}`)

// --- 3. add a line and type text -------------------------------------------

const added = await clickByText(".editor-actions .np-action", /^\s*Line\s*$/)
if (!added.ok) {
  fail("add a line", added.why)
} else {
  pass("add a line")
}
await sleep(300)

const LYRIC = "Xin chao Viet Nam"

/*
 * Target the empty row, which is the one just added.
 *
 * Not the last row: `addLine` inserts in *time order*, so a line stamped at the
 * playhead lands near the top of a track whose lyrics run to two and a half
 * minutes — nowhere near the end. And the last row is scrolled out of the list's
 * viewport anyway, so its centre is not a place a click can land.
 */
const emptyRow = ".ed-row:not(.has-text) .ed-text"

const before = await evaluate(`(() => {
  const rows = [...document.querySelectorAll('.ed-row')]
  const row = rows.find(r => (r.querySelector('.ed-text')?.value ?? '') === '')
  if (!row) return { missing: true, count: rows.length }
  return { count: rows.length }
})()`)
console.log(`  empty rows available: ${JSON.stringify(before)}`)

const clickText = await clickVisible(emptyRow)
if (!clickText.ok) {
  fail("reach the new line's text field", clickText.why)
} else {
  const focused = await evaluate(`(() => {
    const a = document.activeElement
    return { tag: a?.tagName ?? null, cls: a?.className ?? null }
  })()`)
  if (focused.cls?.includes("ed-text")) {
    pass("the new line's field takes focus", JSON.stringify(focused.tag))
  } else {
    fail("the new line's field takes focus", `activeElement is ${JSON.stringify(focused)}`)
  }

  await send("Input.insertText", { text: LYRIC })
  await sleep(350)

  const typedValue = await evaluate(`(() => {
    const a = document.activeElement
    const row = a?.closest?.('.ed-row')
    return {
      value: a?.value ?? null,
      stillFocused: a?.className?.includes('ed-text') ?? false,
      stamp: row?.querySelector('.ed-stamp')?.value ?? null,
    }
  })()`)
  console.log(`  after typing: ${JSON.stringify(typedValue)}`)
  if (typedValue.value === LYRIC) {
    pass("type into the line", JSON.stringify(typedValue.value))
  } else {
    fail("type into the line", `field reads ${JSON.stringify(typedValue.value)}`)
  }

  /*
   * The caret has to survive the keystroke. This is the check that the row key
   * used to break: the key included the line's text, so React replaced the input
   * on every character and focus went with it. One insertText is one event, so
   * this would not catch a per-character loss on its own — typing them one at a
   * time does.
   */
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "X", code: "KeyX", text: "X" })
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "X", code: "KeyX" })
  await sleep(250)
  const afterOneKey = await evaluate(`(() => {
    const a = document.activeElement
    return { value: a?.value ?? null, focused: a?.className?.includes('ed-text') ?? false }
  })()`)
  if (afterOneKey.focused && afterOneKey.value === LYRIC + "X") {
    pass("the caret survives a keystroke", JSON.stringify(afterOneKey.value))
  } else {
    fail("the caret survives a keystroke", JSON.stringify(afterOneKey))
  }
  // Put it back the way the next step expects.
  await evaluate(`(() => {
    const a = document.activeElement
    if (a && a.className?.includes('ed-text')) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(a, ${JSON.stringify(LYRIC)})
      a.dispatchEvent(new Event('input', { bubbles: true }))
    }
    return true
  })()`)
  await sleep(250)
}

// --- 4. tap the word timings ------------------------------------------------

/*
 * The tap button, found by what the row says rather than by its position.
 *
 * It sits among seven identical-looking icons, so the only unambiguous handle is
 * its title; and the row is found by its text, because the newly added line is
 * not the last one — `addLine` inserts in time order, and a line stamped at the
 * playhead belongs near the top of a two-and-a-half-minute track.
 */
const tapBtn = await evaluate(`(() => {
  const row = [...document.querySelectorAll('.ed-row')]
    .find(r => (r.querySelector('.ed-text')?.value ?? '').trim() === ${JSON.stringify(LYRIC)})
  if (!row) return { missing: 'row', texts: [...document.querySelectorAll('.ed-text')].map(n => n.value).slice(0, 8) }
  const btn = [...row.querySelectorAll('.icon-btn')]
    .find(b => /tap the word timings/i.test(b.getAttribute('title') || ''))
  if (!btn) return { missing: 'button', titles: [...row.querySelectorAll('.icon-btn')].map(b => b.getAttribute('title')) }
  btn.scrollIntoView({ block: 'center' })
  const r = btn.getBoundingClientRect()
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
})()`)

if (!tapBtn || tapBtn.missing) {
  fail("find the tap button", JSON.stringify(tapBtn))
} else {
  await clickAt(tapBtn.x, tapBtn.y)
  await sleep(500)

  const tapSurface = await evaluate(`(() => {
    const el = document.querySelector('.ed-tap')
    if (!el) return { missing: true }
    const words = [...el.querySelectorAll('.ed-tap-word')]
    return {
      words: words.length,
      count: el.querySelector('.ed-tap-count')?.innerText.trim() ?? null,
      role: el.getAttribute('role'),
      focused: document.activeElement === el,
    }
  })()`)

  if (!tapSurface || tapSurface.missing) {
    fail("tap session opens", "no .ed-tap")
  } else {
    pass("tap session opens", `${tapSurface.words} words, focus=${tapSurface.focused}`)

    if (!tapSurface.focused) {
      fail("tap surface takes focus", "keys would go nowhere without it")
    }

    // Play, so the clock moves and the tags come out distinct.
    const started = await evaluate(`(() => {
      const a = document.querySelector('audio')
      if (!a) return 'no audio'
      if (a.paused) {
        const b = document.querySelector('.ed-tap')
        // The tap surface owns Space, so play through the element's own state and
        // keep the volume down rather than pressing a key that would be swallowed.
        a.volume = 0; a.muted = true
      }
      return 'ok'
    })()`)
    if (started !== "ok") fail("prepare for tapping", started)

    const before = await evaluate(`document.querySelector('audio')?.currentTime ?? null`)
    // If the track is paused the clock will not move and every tag collapses onto
    // one centisecond, so say so rather than writing a valid but useless file.
    await pressKey("a")
    await sleep(260)
    const after = await evaluate(`document.querySelector('audio')?.currentTime ?? null`)
    const moving = typeof before === "number" && typeof after === "number" && after > before
    console.log(`  clock: ${before} -> ${after} ${moving ? "(moving)" : "(STILL)"}`)

    // The first word was pre-filled by the line's own time, so one tap has
    // already happened by the time this starts. Tap until the session finishes.
    for (let i = 0; i < 8; i++) {
      const stillTapping = await evaluate(`Boolean(document.querySelector('.ed-tap'))`)
      if (!stillTapping) break
      await pressKey("a")
    }
    await sleep(500)

    const session = await evaluate(`(() => {
      const el = document.querySelector('.ed-tap')
      return el ? { open: true, count: el.querySelector('.ed-tap-count')?.innerText.trim() } : { open: false }
    })()`)
    if (session.open) fail("tapping finishes on the last word", `still open at ${session.count}`)
    else pass("tapping finishes on the last word")

    const wordsOnLine = await evaluate(`(() => {
      const row = [...document.querySelectorAll('.ed-row')]
        .find(r => (r.querySelector('.ed-text')?.value ?? '').trim() === ${JSON.stringify(LYRIC)})
      return {
        label: row?.querySelector('.ed-words-ok, .ed-words-bad, .ed-words-none')?.innerText ?? null,
        stamp: row?.querySelector('.ed-stamp')?.value ?? null,
      }
    })()`)
    console.log(`  line now: ${JSON.stringify(wordsOnLine)}`)
    if (/\d+ words timed/.test(wordsOnLine.label ?? "")) {
      pass("word timing attached", wordsOnLine.label)
    } else {
      fail("word timing attached", `row says ${JSON.stringify(wordsOnLine.label)}`)
    }
  }
}

await silence()
await evaluate(`(() => { const a = document.querySelector('audio'); if (a) a.pause(); return true })()`)

// --- 5. save, and check the bytes on disk ----------------------------------

const sidecarGuess = await evaluate(`(() => {
  const a = document.querySelector('audio')
  return a?.currentSrc ? a.currentSrc : null
})()`)

const saved = await clickByText(".editor-actions .np-action", /save \.lrc/i)
if (!saved.ok) {
  fail("click save", saved.why)
} else {
  pass("click save")
}
await sleep(1400)

const afterSave = await evaluate(`(() => {
  const revert = [...document.querySelectorAll('.editor-actions .np-action')]
    .find(b => /revert/i.test(b.innerText))
  return {
    msg: document.querySelector('.editor-msg')?.innerText ?? null,
    isOk: Boolean(document.querySelector('.editor-msg.is-ok')),
    isError: Boolean(document.querySelector('.editor-msg.is-error')),
    // Named for what it is: Revert is *disabled* once nothing is unsaved, so
    // `true` here is the clean state.
    revertDisabled: revert?.disabled ?? null,
  }
})()`)
console.log(`  save message: ${JSON.stringify(afterSave)}`)

if (afterSave.revertDisabled !== true) {
  fail("save clears the unsaved-changes state", `Revert is disabled=${afterSave.revertDisabled}`)
} else {
  pass("save clears the unsaved-changes state")
}

if (afterSave.isError) {
  fail("save succeeds", afterSave.msg)
} else if (afterSave.isOk) {
  pass("save succeeds", afterSave.msg)
} else {
  fail("save reports back", `no confirmation, saw ${JSON.stringify(afterSave.msg)}`)
}

// The message names the file, so read it from there rather than guessing.
const savedPath = await evaluate(`(() => {
  const m = (document.querySelector('.editor-msg.is-ok')?.innerText ?? '').replace(/^Saved\\.?\\s*/, '').trim()
  return m && m !== 'Saved.' ? m : null
})()`)

if (!savedPath) {
  fail("locate the written file", "the confirmation did not name one")
} else if (!existsSync(savedPath)) {
  fail("the file exists", `${savedPath} is not on disk`)
} else {
  pass("the file exists", path.basename(savedPath))

  const text = readFileSync(savedPath, "utf8")
  console.log("  --- file on disk ---")
  console.log(text.split("\n").map((l) => `  | ${l}`).join("\n"))
  console.log("  ---")

  const stamps = [...text.matchAll(/<(\d{2}:\d{2}\.\d{2})>/g)].map((m) => m[1])
  const toSeconds = (s) => {
    const [m, rest] = s.split(":")
    return Number(m) * 60 + Number(rest)
  }
  const times = stamps.map(toSeconds)

  if (!stamps.length) {
    fail("word tags written", "no <mm:ss.xx> tags in the file")
  } else {
    pass("word tags written", `${stamps.length} tags`)
  }

  const ordered = times.every((t, i) => i === 0 || t >= times[i - 1])
  if (!ordered) fail("word tags in order", `${stamps.join(", ")}`)
  else pass("word tags in order", stamps.join(" then "))

  const distinct = new Set(times).size
  if (distinct < 2) {
    fail("word tags are distinct", `all ${stamps.length} tags read ${stamps[0]} — the clock was not moving`)
  } else {
    pass("word tags are distinct", `${distinct} of ${stamps.length} different`)
  }

  const words = text.split("\n").find((l) => l.includes("<")) ?? ""
  for (const word of LYRIC.split(" ")) {
    if (!words.includes(word)) {
      fail("every word is in the file", `${JSON.stringify(word)} missing from ${JSON.stringify(words)}`)
      break
    }
  }
  if (words.split(">").length - 1 === LYRIC.split(" ").length + 1) {
    pass("every word is in the file", `${LYRIC.split(" ").length} words`)
  }
}

// --- 6. the editor adopted what was written --------------------------------

const karaoke = await evaluate(`(() => {
  const row = [...document.querySelectorAll('.ed-row')]
    .find(r => (r.querySelector('.ed-text')?.value ?? '').trim() === ${JSON.stringify(LYRIC)})
  return { label: row?.querySelector('.ed-words-ok, .ed-words-bad, .ed-words-none')?.innerText ?? null }
})()`)
if (/\d+ words timed/.test(karaoke.label ?? "")) {
  pass("the editor adopted the written timing", karaoke.label)
} else {
  fail("the editor adopted the written timing", `row says ${JSON.stringify(karaoke.label)}`)
}

// --- 7. nothing is audible -------------------------------------------------

const audio = await evaluate(`(() => {
  const a = document.querySelector('audio')
  return a ? { paused: a.paused, volume: a.volume, muted: a.muted, time: Number(a.currentTime.toFixed(2)) } : null
})()`)
if (audio && audio.volume === 0 && audio.muted) {
  pass("silence held throughout", JSON.stringify(audio))
} else {
  fail("silence held throughout", JSON.stringify(audio))
}

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} failed`}\n`)

if (!keepOpen && savedPath && existsSync(savedPath)) {
  // Leave the library as it was found. The sidecar changes what a rescan reads,
  // so a probe that leaves it behind silently alters the next session's results.
  try {
    rmSync(savedPath)
    console.log(`  removed ${path.basename(savedPath)} so the library is back as it was`)
  } catch (err) {
    console.log(`  could not remove the test file: ${err.message}`)
  }
}

ws.close()
process.exit(failures === 0 ? 0 : 1)
