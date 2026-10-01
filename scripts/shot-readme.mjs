/**
 * Capture the surfaces for the README.
 *
 * Every shot is taken with playback muted and the volume pinned to zero. Some of
 * them need the clock running — the now-playing shot has to catch a karaoke sweep
 * part-way through a line, which is the whole point of that screen — so this is
 * not a "never touch the audio" script, it is a "never make a sound" script.
 *
 * Written as one run rather than several because the app has to be in specific
 * states for specific shots, and re-launching per shot is where the flaky
 * "could not start playback" failures come from.
 *
 * Usage: node scripts\shot-readme.mjs [cdpPort] [outDir]
 */
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"

const port = process.argv[2] ?? "9222"
const outDir = process.argv[3] ?? "docs"

let failures = 0
const fail = (name, detail) => {
  failures++
  console.log(`  FAIL  ${name}\n        ${detail}`)
}
const pass = (name, detail) => console.log(`  ok    ${name}${detail ? `  (${detail})` : ""}`)

mkdirSync(outDir, { recursive: true })

/** Minimal CDP client, one connection per target. */
function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  const pending = new Map()
  let nextId = 1
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
  })
  const ready = new Promise((r) => ws.addEventListener("open", r, { once: true }))
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = nextId++
      pending.set(id, resolve)
      ws.send(JSON.stringify({ id, method, params }))
    })
  const evaluate = async (expression) => {
    const res = await withTimeout(
      send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }),
      "Runtime.evaluate",
    )
    if (res.result?.exceptionDetails) {
      return { threw: res.result.exceptionDetails.exception?.description ?? res.result.exceptionDetails.text }
    }
    return res.result?.result?.value
  }
  return { ready, send, evaluate }
}

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const main = list.find((t) => t.type === "page" && !t.url.includes("mini.html"))
if (!main) {
  console.error("no main page target")
  process.exit(1)
}

const app = connect(main)
await app.ready
await app.send("Page.enable")
await app.send("Runtime.enable")
await app.send("Page.bringToFront")

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Fail loudly rather than hang.
 *
 * A CDP call against a window that is not answering never resolves, so a script
 * with no timeout does not fail — it sits there until something else kills it,
 * which looks like the app being broken rather than the script being stuck. Every
 * call goes through here.
 */
const CDP_TIMEOUT_MS = 20_000
const withTimeout = (promise, what) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${what} did not answer within ${CDP_TIMEOUT_MS / 1000}s`)), CDP_TIMEOUT_MS),
    ),
  ])

const silence = () =>
  app.evaluate(`(() => { const a = document.querySelector('audio'); if (a) { a.volume = 0; a.muted = true } return true })()`)

const shoot = async (name, target = app) => {
  /*
   * Back to the top first. Nothing in this app should scroll the document, but a
   * stray `scrollIntoView` from an interaction a moment earlier is enough to cost
   * the header and the top of the artwork, and the shot has no way to tell that
   * from a layout that is simply tall.
   */
  if (target === app) {
    await app.evaluate(`(() => { window.scrollTo(0, 0); document.documentElement.scrollTop = 0; document.body.scrollTop = 0; return true })()`)
    await sleep(200)
  }
  const shot = await withTimeout(target.send("Page.captureScreenshot", { format: "png" }), "Page.captureScreenshot")
  if (!shot.result?.data) {
    fail(`shot ${name}`, "no image data came back")
    return null
  }
  const file = path.join(outDir, `${name}.png`)
  writeFileSync(file, `${shot.result.data}`, "base64")

  /*
   * A shot that is cropped looks exactly like a shot of a tall layout, so the
   * script checks rather than trusting. The editor's header must be inside the
   * image, and something must be near the top edge — a screenshot scrolled by
   * eighty pixels satisfies both of neither.
   */
  if (target === app) {
    const framing = await app.evaluate(`(() => {
      const check = (sel) => {
        const el = document.querySelector(sel)
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { top: Math.round(r.top), bottom: Math.round(r.bottom), visible: r.top > -1 && r.bottom < innerHeight + 1 }
      }
      return {
        scrollY: Math.round(window.scrollY),
        header: check('.nowplaying-dock') ?? check('.app-head') ?? check('h1'),
        editorHead: check('.editor-head'),
      }
    })()`)
    if (framing?.scrollY) {
      fail(`shot ${name}`, `the window was scrolled by ${framing.scrollY}px`)
    } else if (framing?.header && !framing.header.visible) {
      fail(`shot ${name}`, `the header is outside the frame (top ${framing.header.top})`)
    } else if (name === "lyrics-editor" && framing?.editorHead && !framing.editorHead.visible) {
      fail(`shot ${name}`, `the editor's own header is cut off (top ${framing.editorHead.top})`)
    } else {
      pass(`shot ${name}`, file)
    }
  } else {
    pass(`shot ${name}`, file)
  }
  return file
}

const clickAt = async (x, y, button = "left") => {
  await app.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount: 1 })
  await app.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount: 1 })
  await sleep(110)
}

/**
 * Click the first element matching a selector.
 *
 * Scrolls only when the element is genuinely outside the viewport. `scrollIntoView`
 * called unconditionally is the reason the first lyrics-editor screenshot came out
 * with its header and half the artwork cut off: `block: "center"` scrolls every
 * scrollable ancestor, including ones the element does not belong to, so clicking
 * a button that was already visible quietly moved the whole window down eighty
 * pixels and the screenshot photographed the result.
 */
const click = async (selector, re) => {
  const spot = await app.evaluate(`(() => {
    const els = [...document.querySelectorAll(${JSON.stringify(selector)})]
    const el = ${re ? `els.find(n => new RegExp(${JSON.stringify(re.source)}, ${JSON.stringify(re.flags)}).test(n.innerText || ''))` : "els[0]"}
    if (!el) return { missing: true }
    const measure = () => {
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) return { clipped: true }
      const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2)
      const offscreen = y < 4 || y > innerHeight - 4 || x < 4 || x > innerWidth - 4
      return offscreen ? { offscreen: true, x, y } : { x, y }
    }
    let box = measure()
    if (box.offscreen) {
      el.scrollIntoView({ block: 'nearest' })
      box = measure()
    }
    return box
  })()`)
  if (!spot || spot.missing) return { ok: false, why: `no ${selector}${re ? ` matching /${re.source}/` : ""}` }
  if (spot.clipped) return { ok: false, why: `${selector} has no box` }
  if (spot.offscreen) return { ok: false, why: `${selector} is outside the window at ${spot.x},${spot.y}` }
  await clickAt(spot.x, spot.y)
  return { ok: true }
}

/*
 * The track these shots use.
 *
 * Chosen deliberately, not "the first row". The library is not uniform: some files
 * carry synced lyrics and some carry none at all, and the now-playing shot that
 * lands on one of the latter photographs the "no lyrics found online" empty state
 * instead of the thing the screenshot exists to show. This one has a sidecar with
 * word timings, so the sweep is real.
 */
const TRACK = "Wtf Bby"

console.log("\nREADME screenshots\n")

await silence()

// --- 1. the library ---------------------------------------------------------

const allSongs = await click(".nav-item", /all songs/i)
if (!allSongs.ok) {
  console.error(`could not reach All Songs: ${allSongs.why}`)
  process.exit(1)
}
await sleep(900)

// Start a track so the transport and palette are alive in the library shot.
const started = await app.evaluate(`(() => {
  const row = [...document.querySelectorAll('.row')]
    .find(r => new RegExp(${JSON.stringify(TRACK)}, 'i').test(r.innerText || ''))
    ?? [...document.querySelectorAll('.row')].find(r => (r.innerText || '').trim())
  if (!row) return { missing: true }
  const el = row.querySelector('.row-title') ?? row
  const r = el.getBoundingClientRect()
  return { x: Math.round(r.left + 8), y: Math.round(r.top + r.height / 2), title: (row.innerText || '').replace(/\\n/g, ' ').slice(0, 40) }
})()`)
if (started.missing) {
  fail("find a track row", "the library is empty")
} else {
  pass("track row found", started.title)
}
if (!started.missing) {
  for (let i = 1; i <= 2; i++) {
    await app.send("Input.dispatchMouseEvent", { type: "mousePressed", x: started.x, y: started.y, button: "left", clickCount: i })
    await app.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: started.x, y: started.y, button: "left", clickCount: i })
    await sleep(70)
  }
  await sleep(1100)
}
await silence()
await sleep(400)

await shoot("library")

// --- 2. now playing, with a karaoke sweep part-way through a line ------------

/*
 * The clock has to be running for this one. A still frame of a sweep looks
 * exactly like a line with no fill on it, which is the one thing this screenshot
 * exists to disprove — so it is seeked into the middle of a word-timed line and
 * then sampled until the fill is visibly partial.
 */
await click(".nav-item", /all songs/i)
await sleep(400)
const nowPlaying = await app.evaluate(`(() => {
  const b = [...document.querySelectorAll('button')].find(n => /now playing/i.test(n.getAttribute('aria-label') || ''))
  if (!b || b.disabled) return { missing: true }
  const r = b.getBoundingClientRect()
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
})()`)
if (nowPlaying.missing) {
  fail("open the now-playing view", "the button is missing or disabled")
} else {
  await clickAt(nowPlaying.x, nowPlaying.y)
  await sleep(1800)

  const seeked = await app.evaluate(`(async () => {
    const a = document.querySelector('audio')
    if (!a) return { noAudio: true }
    // Inside line 2 of the fixture (17.14s -> 19.46s), late enough that the first
    // two words are lit and the third is mid-sweep. That partial state is the
    // whole reason this screenshot exists: a still of a sweep is
    // indistinguishable from a line with no fill on it.
    a.currentTime = 18.9
    a.volume = 0
    a.muted = true
    await a.play().catch(() => {})
    a.pause()
    return { ok: true, duration: Math.round(a.duration || 0) }
  })()`)
  if (seeked.noAudio) fail("now playing", "no audio element")
  else {
    pass("seeked into the word-timed line", `duration ${seeked.duration}s`)
    await silence()
    await sleep(1800)
    const state = await app.evaluate(`(() => {
      const el = document.querySelector('.lyric-now.is-now')
      const spans = el ? [...el.querySelectorAll('.w')] : []
      return {
        line: el?.innerText.trim().slice(0, 44) ?? null,
        spans: spans.length,
        p: spans.map(s => s.style.getPropertyValue('--p')),
        karaoke: el?.classList.contains('is-karaoke') ?? false,
      }
    })()`)
    console.log(`  on screen: ${JSON.stringify(state)}`)
    if (state.karaoke && state.spans >= 2) pass("a karaoke line is on screen", `${state.spans} word spans`)
    else fail("a karaoke line is on screen", JSON.stringify(state))
    await shoot("now-playing")
  }
}

// --- 3. the lyrics editor ---------------------------------------------------

const editor = await click(".np-action", /edit lyrics/i)
if (!editor.ok) {
  fail("open the lyrics editor", editor.why)
} else {
  await sleep(900)
  await shoot("lyrics-editor")
  // Back out with Escape, which the dialog handles. Leaving it open would put the
  // editor in the albums shot that follows.
  await app.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 })
  await app.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 })
  await sleep(900)
}

// --- 4. the floating mini player --------------------------------------------

/*
 * The bar is a second BrowserWindow, so it is a second CDP target. Capturing the
 * main window's page would photograph a window the bar is not in.
 *
 * The button is found by its exact accessible name. A substring match on "mini"
 * across every button on the screen is one typo away from clicking the settings
 * gear, which unmounts the player bar and makes the failure look like "the mini
 * player will not open". No user gesture is needed to open a window, so a plain
 * `.click()` here is the reliable path — a synthesised mouse event at measured
 * coordinates is not.
 */
await app.send("Page.bringToFront")
const toggled = await app.evaluate(`(() => {
  const b = document.querySelector('button[aria-label="Mini player"]')
  if (!b) return { missing: true, labels: [...document.querySelectorAll('button')].map(n => n.getAttribute('aria-label')).filter(Boolean).slice(0, 24) }
  b.click()
  return { pressed: b.getAttribute('aria-pressed') }
})()`)
if (toggled.missing) {
  fail("open the mini player", JSON.stringify(toggled.labels))
} else {
  pass("pressed the mini player button", `aria-pressed=${toggled.pressed}`)

  // The window is a real BrowserWindow: give it time to exist, not just time to
  // have been asked for.
  let bar = null
  for (let i = 0; i < 12 && !bar; i++) {
    await sleep(400)
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    bar = targets.find((t) => t.type === "page" && /mini\.html/.test(t.url)) ?? null
  }
  if (!bar) {
    fail("find the mini player window", "no target with mini.html after 5s")
  } else {
    const barCdp = connect(bar)
    await barCdp.ready
    await barCdp.send("Page.enable")
    await barCdp.send("Runtime.enable")
    await sleep(1100)
    await shoot("mini-player", barCdp)

    // Put it away again so the next run starts from a clean window set.
    await app.evaluate(`(() => {
      const b = document.querySelector('button[aria-label="Mini player"]')
      if (b && b.getAttribute('aria-pressed') === 'true') b.click()
      return true
    })()`)
    await sleep(500)
  }
}

await silence()
const final = await app.evaluate(`(() => {
  const a = document.querySelector('audio')
  return a ? { paused: a.paused, volume: a.volume, muted: a.muted } : null
})()`)
if (!final || (final.volume === 0 && final.muted)) pass("silence held", JSON.stringify(final))
else fail("silence held", JSON.stringify(final))

console.log(`\n${failures === 0 ? "all shots captured" : `${failures} failed`}\n`)
process.exit(failures === 0 ? 0 : 1)
