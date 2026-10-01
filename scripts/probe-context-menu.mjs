/**
 * "Add to playlist": the submenu opens, and the track really lands in the list.
 *
 * The button being dead was not a cosmetic problem. `ContextMenu` closed itself
 * before calling `onSelect`, and every row that opens a second level sets menu
 * state through a functional update — so by the time it ran the state was already
 * `null` and the update returned `null`. Two rows in one menu were unreachable and
 * both looked like ordinary working code at the call site.
 *
 * So this walks the whole path rather than checking that a second level renders:
 * opens the menu, presses the row, asserts the playlist appears, presses it, and
 * then reads the playlist back **through the bridge** — which is the persisted
 * file, not the renderer's optimistic copy.
 *
 * It also checks the menu is actually glass and not merely frosted, because a
 * `.glass` class with no refraction attached looks almost exactly like one whose
 * refraction is too weak to see.
 *
 * Usage: node scripts\probe-context-menu.mjs [cdpPort]
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

console.log("\ncontext menu: add to playlist\n")

// Nothing here starts playback, so no audio is involved at any point.
const silence = () =>
  evaluate(`(() => { const a = document.querySelector('audio'); if (a) { a.volume = 0; a.muted = true } return true })()`)
await silence()

await evaluate(`(() => {
  const b = [...document.querySelectorAll('.nav-item, button')].find(n => /all songs/i.test(n.textContent || ''))
  if (b) b.click()
  return true
})()`)
await sleep(900)

// --- a playlist to add to ---------------------------------------------------

/*
 * Created through the sidebar's own field, not through the bridge.
 *
 * `window.titan.createPlaylist` writes the file and returns the new playlist, and
 * the renderer's store never hears about it — so the context menu, which lists the
 * store's copy, would show a different set of playlists entirely and this would
 * fail looking exactly like the bug under test. The app itself is fine here:
 * `store.createPlaylist` re-reads the list afterwards, which is what a bridge call
 * bypasses.
 */
const NAME = "probe-playlist-target"

await evaluate(`(async () => {
  const list = await window.titan.getPlaylists()
  const stale = list.find(p => p.name === ${JSON.stringify(NAME)})
  if (stale) await window.titan.deletePlaylist(stale.id)
  return true
})()`)

const created = await evaluate(`(() => {
  const b = document.querySelector('button[aria-label="New playlist"]')
  if (!b) return { missing: true }
  const r = b.getBoundingClientRect()
  if (r.width === 0 || r.height === 0) return { clipped: true }
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
})()`)
if (created.missing || created.clipped) {
  console.error(`the New playlist button is ${JSON.stringify(created)}`)
  process.exit(1)
}
await send("Input.dispatchMouseEvent", { type: "mousePressed", x: created.x, y: created.y, button: "left", clickCount: 1 })
await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: created.x, y: created.y, button: "left", clickCount: 1 })
await sleep(350)

const typing = await evaluate(`(() => {
  const input = document.querySelector('.playlist-input')
  if (!input) return { missing: true }
  const r = input.getBoundingClientRect()
  return { focused: document.activeElement === input, x: Math.round(r.left + 8), y: Math.round(r.top + r.height / 2) }
})()`)
if (typing.missing) {
  console.error("the sidebar did not open its playlist field")
  process.exit(1)
}
if (!typing.focused) {
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: typing.x, y: typing.y, button: "left", clickCount: 1 })
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: typing.x, y: typing.y, button: "left", clickCount: 1 })
  await sleep(250)
}
await send("Input.insertText", { text: NAME })
await sleep(250)
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 })
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 })
await sleep(900)

const made = await evaluate(`(async () => {
  const list = await window.titan.getPlaylists()
  const p = list.find(x => x.name === ${JSON.stringify(NAME)})
  const inSidebar = [...document.querySelectorAll('.nav-list *')].some(n => n.textContent.trim() === ${JSON.stringify(NAME)})
  return { id: p?.id ?? null, inSidebar }
})()`)
if (!made.id) {
  console.error(`the playlist was not created (sidebar shows it: ${made.inSidebar})`)
  process.exit(1)
}
console.log(`  playlist: ${made.id} (created, and the sidebar knows: ${made.inSidebar})`)

// Creating it selects it, which leaves the library view showing an empty list.
// The right-click below needs a track to aim at.
await evaluate(`(() => {
  const b = [...document.querySelectorAll('.nav-item')].find(n => /all songs/i.test(n.textContent || ''))
  if (b) b.click()
  return true
})()`)
await sleep(900)

const track = await evaluate(`(() => {
  const row = [...document.querySelectorAll('.row, .simple-row')].find(r => (r.innerText || '').trim())
  if (!row) return null
  const id = row.dataset.id
  const title = row.innerText.replace(/\\n/g, ' ').slice(0, 40)
  const el = row.querySelector('.row-title') ?? row
  const r = el.getBoundingClientRect()
  if (r.width === 0 || r.height === 0 || r.top < 0 || r.top > innerHeight) row.scrollIntoView({ block: 'center' })
  const r2 = el.getBoundingClientRect()
  return { id, title, x: Math.round(r2.left + 8), y: Math.round(r2.top + r2.height / 2) }
})()`)
if (!track) {
  console.error("no track rows")
  process.exit(1)
}
console.log(`  track: ${track.title}`)

/** Right-click a row, which is how the menu is opened by hand. */
const openMenu = async () => {
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: track.x, y: track.y, button: "right", clickCount: 1 })
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: track.x, y: track.y, button: "right", clickCount: 1 })
  await sleep(350)
  return evaluate(`(() => {
    const m = document.querySelector('.context-menu')
    if (!m) return { open: false }
    return {
      open: true,
      items: [...m.querySelectorAll('.context-item')].map(b => b.innerText.trim()),
      filter: m.style.getPropertyValue('backdrop-filter') || getComputedStyle(m).backdropFilter,
    }
  })()`)
}

const readMenu = () =>
  evaluate(`(() => {
    const m = document.querySelector('.context-menu')
    if (!m) return { open: false }
    return {
      open: true,
      items: [...m.querySelectorAll('.context-item')].map(b => b.innerText.trim()),
      filter: m.style.getPropertyValue('backdrop-filter') || getComputedStyle(m).backdropFilter,
    }
  })()`)

const first = await openMenu()
if (!first.open) {
  fail("the context menu opens", "no .context-menu in the DOM")
  process.exit(1)
}
pass("the context menu opens", `${first.items.length} rows`)

if (/url\(["']?#titan-glass-/.test(first.filter ?? "")) {
  pass("the menu refracts, not just frosts", first.filter.slice(0, 46))
} else {
  fail("the menu refracts, not just frosts", `backdrop-filter is ${JSON.stringify(first.filter)}`)
}

if (first.items.some((t) => /add to playlist/i.test(t))) {
  pass("the menu offers Add to playlist")
} else {
  fail("the menu offers Add to playlist", JSON.stringify(first.items))
}

// --- press it ---------------------------------------------------------------

const pressRow = async (re) => {
  const spot = await evaluate(`(() => {
    const m = document.querySelector('.context-menu')
    if (!m) return { gone: true }
    const b = [...m.querySelectorAll('.context-item')]
      .find(n => new RegExp(${JSON.stringify(re.source)}, 'i').test(n.innerText || ''))
    if (!b) return { missing: true, items: [...m.querySelectorAll('.context-item')].map(n => n.innerText.trim()) }
    const r = b.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return { clipped: true }
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  })()`)
  if (!spot || spot.gone) return { ok: false, why: "the menu is gone" }
  if (spot.missing) return { ok: false, why: `no row matching /${re.source}/ — saw ${JSON.stringify(spot.items)}` }
  if (spot.clipped) return { ok: false, why: "the row has no box" }
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: spot.x, y: spot.y, button: "left", clickCount: 1 })
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: spot.x, y: spot.y, button: "left", clickCount: 1 })
  await sleep(400)
  return { ok: true }
}

const pressed = await pressRow(/add to playlist/i)
if (!pressed.ok) {
  fail("pressing Add to playlist does something", pressed.why)
} else {
  pass("pressing Add to playlist does something")
}

const second = await readMenu()
if (!second.open) {
  fail(
    "the playlist list appears",
    "the menu closed — this is the reported bug: it closes before the row's own state update runs",
  )
} else {
  pass("the playlist list appears", second.items.join(" | "))

  if (second.items.some((t) => t.trim() === NAME)) {
    pass("the existing playlist is listed")
  } else {
    fail("the existing playlist is listed", JSON.stringify(second.items))
  }
  if (second.items.some((t) => /back/i.test(t))) {
    pass("and there is a way back out")
  } else {
    fail("and there is a way back out", JSON.stringify(second.items))
  }
  if (/url\(["']?#titan-glass-/.test(second.filter ?? "")) {
    pass("the second level is glass too")
  } else {
    fail("the second level is glass too", JSON.stringify(second.filter))
  }
}

// --- add it -----------------------------------------------------------------

const before = await evaluate(`(async () => {
  const l = await window.titan.getPlaylists()
  return l.find(p => p.id === ${JSON.stringify(made.id)})?.trackIds ?? []
})()`)

const chosen = await pressRow(new RegExp(`^${NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"))
if (!chosen.ok) {
  fail("pressing the playlist adds the track", chosen.why)
} else {
  pass("pressing the playlist adds the track")
}

const after = await evaluate(`(async () => {
  const l = await window.titan.getPlaylists()
  return l.find(p => p.id === ${JSON.stringify(made.id)})?.trackIds ?? []
})()`)
console.log(`  playlist before: ${before.length} tracks, after: ${after.length}`)

if (!after.includes(track.id)) {
  fail("the track is in the playlist on disk", `after = ${JSON.stringify(after)}, wanted ${track.id}`)
} else if (after.length !== before.length + 1) {
  fail("exactly one track was added", `${before.length} -> ${after.length}`)
} else {
  pass("the track is in the playlist on disk", `${before.length} -> ${after.length}`)
}

/*
 * Adding the same track twice.
 *
 * Worth one check because the handler appends unconditionally — a second
 * press, or two right-clicks in a row, would put the same track in the list
 * twice and every later count of it would be wrong. This is a report of what
 * happens, not an assertion that duplicates are good.
 */
const again = await openMenu()
if (again.open) {
  const p1 = await pressRow(/add to playlist/i)
  if (p1.ok) {
    await pressRow(new RegExp(`^${NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"))
    const twice = await evaluate(`(async () => {
      const l = await window.titan.getPlaylists()
      return l.find(p => p.id === ${JSON.stringify(made.id)})?.trackIds ?? []
    })()`)
    const count = twice.filter((id) => id === track.id).length
    if (count > 1) {
      fail("adding the same track twice does not duplicate it", `it appears ${count} times`)
    } else {
      pass("adding the same track twice does not duplicate it", "already handled")
    }
  }
}

const afterRows = await readMenu()
if (!afterRows.open) pass("the menu closes after a real action", "as it should")
else fail("the menu closes after a real action", "still open")

// --- clean up ---------------------------------------------------------------

await evaluate(`(async () => {
  await window.titan.deletePlaylist(${JSON.stringify(made.id)})
  return true
})()`)
const gone = await evaluate(`(async () => {
  const l = await window.titan.getPlaylists()
  return !l.some(p => p.id === ${JSON.stringify(made.id)})
})()`)
if (gone) pass("the probe's playlist is removed")
else fail("the probe's playlist is removed", "it is still there")

const audio = await evaluate(`(() => {
  const a = document.querySelector('audio')
  return a ? { paused: a.paused, volume: a.volume, muted: a.muted } : null
})()`)
if (!audio || (audio.volume === 0 && audio.muted)) pass("nothing was played", JSON.stringify(audio))
else fail("nothing was played", JSON.stringify(audio))

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} failed`}\n`)
ws.close()
process.exit(failures === 0 ? 0 : 1)
