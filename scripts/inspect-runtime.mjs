/**
 * Runtime check over CDP against a running Titan Player.
 *
 * Reports the things that review cannot: whether a track actually plays, whether
 * the accent palette follows the artwork, and whether anything threw.
 *
 * Usage: node scripts\inspect-runtime.mjs <cdpPort>
 */
// Node 22+ ships a global WebSocket client, so this needs no dependency.
const port = process.argv[2] ?? "9224"

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = list.find((t) => t.type === "page")
if (!page) {
  console.error("no page target found")
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
let nextId = 1
const pending = new Map()

ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  }
})

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
    return { error: res.result.exceptionDetails.text }
  }
  return res.result?.result?.value
}

await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }))
await send("Runtime.enable")

const snapshot = async () =>
  evaluate(`(() => {
    const audio = document.querySelector('audio')
    const root = getComputedStyle(document.documentElement)
    const rows = [...document.querySelectorAll('.row')]
    return {
      rows: rows.length,
      // Read the numbers off the first rows to confirm the sort is really album
      // order rather than whatever the header claims.
      firstNos: rows.slice(0, 8).map(r => (r.querySelector('.row-no')?.textContent ?? '').trim()),
      firstTitles: rows.slice(0, 3).map(r => (r.querySelector('.row-title')?.textContent ?? '').trim().slice(0, 26)),
      sortHeader: [...document.querySelectorAll('.th')]
        .map(h => h.textContent.trim() + (h.getAttribute('aria-sort') ? ':' + h.getAttribute('aria-sort') : ''))
        .join(' | '),
      accent: root.getPropertyValue('--accent').trim(),
      ambient: root.getPropertyValue('--amb-1').trim(),
      audio: audio ? {
        src: (audio.src || '').slice(0, 48),
        paused: audio.paused,
        time: Number(audio.currentTime.toFixed(2)),
        duration: Number((audio.duration || 0).toFixed(1)),
        error: audio.error ? audio.error.code : null,
        // Whether the element is routed into a Web Audio graph. If true and it
        // is still silent, the context is suspended and that is the bug.
        routed: Boolean(audio.__titanSource),
      } : null,
      images: {
        total: document.querySelectorAll('.artwork img').length,
        resolved: document.querySelectorAll('.artwork img.resolved').length,
      },
      windowButtons: document.querySelectorAll('.titlebar-btn').length,
      nowPlaying: Boolean(document.querySelector('.nowplaying')),
    }
  })()`)

console.log("=== initial ===")
console.log(JSON.stringify(await snapshot(), null, 2))

// Double-click the third row via real input events. Synthetic clicks from
// PowerShell never reached the window, so this has to go through CDP.
const box = await evaluate(`(() => {
  const row = document.querySelectorAll('.row')[2]
  if (!row) return null
  const r = row.getBoundingClientRect()
  return { x: Math.round(r.left + 120), y: Math.round(r.top + r.height / 2) }
})()`)

if (box) {
  for (let i = 0; i < 2; i += 1) {
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: i + 1,
    })
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: i + 1,
    })
  }
  await new Promise((r) => setTimeout(r, 4000))
  console.log("=== after double-click ===")
  console.log(JSON.stringify(await snapshot(), null, 2))
}

// Open Now Playing to check the overlay renders at all.
await evaluate(`document.querySelector('.playerbar-art')?.click?.() ?? document.querySelector('.playerbar')?.dispatchEvent(new MouseEvent('click', {bubbles:true}))`)
await new Promise((r) => setTimeout(r, 1200))
console.log("=== after opening now playing ===")
console.log(JSON.stringify(await snapshot(), null, 2))

ws.close()
process.exit(0)
