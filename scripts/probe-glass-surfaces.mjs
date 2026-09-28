/**
 * Which surfaces actually carry a Liquid Glass refraction right now?
 *
 * A screenshot answers "does it look like glass" and not "is the filter running",
 * which matters because a refraction that has silently stopped being applied
 * looks almost exactly like a refraction that is applied at a strength too low to
 * see. So this reads the computed value off every surface the app puts it on, and
 * checks that each one resolves to a real `feDisplacementMap` chain rather than
 * having been quietly replaced.
 *
 * It also catches the failure this hook has actually had: it sets
 * `backdrop-filter` on the element, which *replaces* the stylesheet's value rather
 * than adding to it, so a surface can lose its `saturate()` and still look
 * plausible. The filter string is compared against what the stylesheet asked for.
 *
 * Usage: node scripts\probe-glass-surfaces.mjs <cdpPort>
 */
const port = process.argv[2] ?? "9222"

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = list.find((t) => t.type === "page" && !/mini\.html/.test(t.url))
if (!page) {
  console.error("no main page target")
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
  if (res.result?.exceptionDetails) return { threw: res.result.exceptionDetails.text }
  return res.result?.result?.value
}

/** The surfaces the app intends to be glass, and what each is missing if absent. */
const WANTED = [
  { sel: ".sidebar", label: "navigation rail" },
  { sel: ".playerbar", label: "player bar" },
  { sel: ".queue", label: "queue drawer" },
  { sel: ".context-menu", label: "context menu", needsOpen: true },
  { sel: ".nowplaying-dock", label: "now playing dock", needsOpen: true },
]

/*
 * Open the surfaces that are only on screen on demand, and *confirm* each one
 * opened.
 *
 * The state is read from the button's own `aria-expanded`, not from whether the
 * panel appeared. The button is a toggle, and the panel mounts a render or two
 * after the click, so driving this off the panel's presence means clicking a
 * number of times without knowing the current state: three "open it" clicks
 * against a toggle are two too many, and the probe closed the drawer it was
 * supposed to be inspecting. `aria-expanded` is the component's own statement of
 * what it is doing, and it is correct on the render before the panel exists.
 */
const openAndConfirm = async (buttonLabel, tries = 3) => {
  const isOpen = () =>
    evaluate(`(() => {
      const b = [...document.querySelectorAll('button')]
        .find(x => x.getAttribute('aria-label') === ${JSON.stringify(buttonLabel)})
      return b ? b.getAttribute('aria-expanded') === 'true' : null
    })()`)

  for (let i = 0; i < tries; i += 1) {
    if ((await isOpen()) === true) {
      // Let the panel mount and the hook attach.
      await new Promise((r) => setTimeout(r, 600))
      return true
    }
    await evaluate(`(() => {
      const b = [...document.querySelectorAll('button')]
        .find(x => x.getAttribute('aria-label') === ${JSON.stringify(buttonLabel)})
      if (b) b.click()
      return true
    })()`)
    await new Promise((r) => setTimeout(r, 700))
  }
  if ((await isOpen()) === true) return true
  console.log(`  (could not open ${buttonLabel} — that surface will be skipped)`)
  return false
}

await openAndConfirm("Queue")

const rows = await evaluate(`(() => {
  const wanted = ${JSON.stringify(WANTED)}
  const out = []
  for (const w of wanted) {
    const el = document.querySelector(w.sel)
    if (!el) { out.push({ ...w, present: false }); continue }
    const s = getComputedStyle(el)
    const inline = el.style.getPropertyValue('backdrop-filter')
    const ref = (inline.match(/url\\("#?([^")]+)"?\\)/) || [])[1] || null
    const node = ref ? document.getElementById(ref) : null
    out.push({
      ...w,
      present: true,
      // Checked against the *element's own* box, not just the visibility keyword:
      // an element can be marked visible and still be off-screen, and a refraction
      // on a zero-area element is a filter that reads nothing.
      visible:
        s.visibility !== 'hidden' &&
        s.display !== 'none' &&
        el.getBoundingClientRect().width > 2,
      rect: (r => ({ w: Math.round(r.width), h: Math.round(r.height) }))(
        el.getBoundingClientRect(),
      ),
      visibility: s.visibility,
      display: s.display,
      cls: typeof el.className === 'string' ? el.className : '',
      inline: inline || null,
      computed: s.backdropFilter || s.getPropertyValue('backdrop-filter'),
      background: s.backgroundColor,
      filterExists: Boolean(node),
      primitives: node ? [...node.children].map(c => c.nodeName) : [],
      // The map has to be an feImage with a real data URL, or the displacement
      // has nothing to read and the rim renders as nothing at all.
      mapBytes:
        node && node.firstElementChild
          ? (node.firstElementChild.getAttribute('href') ||
             node.firstElementChild.getAttributeNS('http://www.w3.org/1999/xlink', 'href') ||
             '').length
          : 0,
    })
  }
  return out
})()`)

let bad = 0
let skipped = 0
for (const r of rows) {
  if (!r.present) {
    console.log(`  --  ${r.label.padEnd(18)} not in the DOM`)
    skipped += 1
    continue
  }
  if (!r.visible) {
    console.log(
      `  --  ${r.label.padEnd(18)} not on screen: ${r.rect.w}x${r.rect.h}` +
        `  visibility ${r.visibility}  display ${r.display}  class "${r.cls}"`,
    )
    skipped += 1
    continue
  }
  /*
   * The chain is checked by shape, not by length.
   *
   * It used to be three primitives — map, displace, soften — and asserting that
   * exactly was fine until the chromatic aberration landed, which makes it nine:
   * three displacements, three channel matrices, two blends, and the softening
   * blur. A length check would now fail a surface that is working perfectly, and
   * a probe that reports a working filter as broken gets ignored, which is worse
   * than not having it.
   *
   * So: the map first, at least one displacement, a softening blur last, and a
   * real data URL behind the map.
   */
  const p = r.primitives
  const ok =
    r.filterExists &&
    p.length >= 3 &&
    p[0] === "feImage" &&
    p.includes("feDisplacementMap") &&
    p[p.length - 1] === "feGaussianBlur" &&
    r.mapBytes > 200
  if (!ok) bad += 1
  console.log(
    `  ${ok ? "OK  " : "FAIL"}  ${r.label.padEnd(18)} ${r.computed}` +
      `  map ${r.mapBytes}B  ${p.length} primitives` +
      `  chromatic: ${p.filter((n) => n === "feColorMatrix").length ? "yes" : "no"}`,
  )
  if (!r.filterExists) {
    // The box is the missing datum. A hook that bails on `width < 2 ||
    // height < 2` produces exactly this: the surface is on screen and correct,
    // but the measurement it took when it mounted was zero, and it never retried
    // because a ResizeObserver only fires when the size *changes*.
    console.log(
      `        no inline backdrop-filter; box is ${r.rect.w}x${r.rect.h}, ` +
        `background ${r.background}`,
    )
  }
}

const census = await evaluate(`(() => {
  const defs = document.getElementById('titan-glass-defs')
  return {
    defsExists: Boolean(defs),
    defsAttached: defs ? defs.isConnected : false,
    filterIds: defs ? [...defs.querySelectorAll('filter')].map(f => f.id) : [],
    // Every element in the document carrying an inline backdrop-filter, however
    // it got there. A filter id that the drawer is *not* using but that exists
    // means its hook ran and something took it away again; a missing id entirely
    // means the hook never built.
    inlineUsers: [...document.querySelectorAll('[style*="backdrop-filter"]')].map(el => ({
      cls: el.className,
      value: el.style.getPropertyValue('backdrop-filter'),
    })),
  }
})()`)
console.log("\nfilter census:", JSON.stringify(census, null, 2))

console.log(`\nsurfaces checked: ${rows.length}, on screen: ${rows.length - skipped}, broken: ${bad}`)
if (skipped > 0) {
  console.log(
    "A skipped surface is not a pass. Re-run with the app idle so the drawer and\n" +
      "the menu can be opened, or read the count rather than the exit code.",
  )
}
process.exit(bad === 0 ? 0 : 1)
