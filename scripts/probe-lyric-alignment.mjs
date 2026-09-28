/**
 * Why the lyric lines do not share a right edge.
 *
 * Symptom: a lyric that wraps to two rows comes out short of the window's right
 * edge while the one-row lines reach it, so the block looks shoved to one side.
 *
 * This dumps what is actually true rather than reasoning about it — the box of
 * each line, the box of the stack, the box of the pane, and the resolved
 * properties that could plausibly move a right-aligned child away from its
 * container's edge. The candidates are `text-wrap: balance`, the `transform`
 * origin, and any padding on the pane.
 *
 * Usage: node scripts\probe-lyric-alignment.mjs <cdpPort>
 */
const port = process.argv[2] ?? "9222"

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
  })
  if (res.result?.exceptionDetails) return { threw: res.result.exceptionDetails.text }
  return res.result?.result?.value
}

const report = await evaluate(`(() => {
  const pane = document.querySelector('.lyrics-pane') || document.querySelector('.lyrics-wrap')
  const focus = document.querySelector('.lyrics-focus')
  const stack = document.querySelector('.lyrics-stack')
  if (!pane || !focus || !stack) {
    return { error: 'missing pane/focus/stack', have: {
      pane: Boolean(pane), focus: Boolean(focus), stack: Boolean(stack) } }
  }
  const box = el => {
    const r = el.getBoundingClientRect()
    return { left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width) }
  }
  const cs = el => {
    const s = getComputedStyle(el)
    return {
      display: s.display,
      width: s.width,
      textAlign: s.textAlign,
      textWrap: s.textWrap || s.textWrapStyle,
      transform: s.transform,
      transformOrigin: s.transformOrigin,
      paddingRight: s.paddingRight,
      marginRight: s.marginRight,
      maxWidth: s.maxWidth,
    }
  }
  const lines = [...document.querySelectorAll('.lyric-now')].map(n => ({
    cls: n.className,
    ...box(n),
    text: n.innerText.trim().slice(0, 30),
    rows: n.getClientRects().length,
    computed: cs(n),
    // The width of the *text* rather than the box, which is the thing that has
    // to reach the right edge. Measured with a Range so it is the real inline
    // extent and not the block's.
    textRight: (() => {
      const r = document.createRange()
      r.selectNodeContents(n)
      const rects = [...r.getClientRects()].filter(x => x.width > 0)
      return rects.length ? Math.round(Math.max(...rects.map(x => x.right))) : null
    })(),
  }))
  return {
    windowInnerWidth: innerWidth,
    pane: { ...box(pane), computed: cs(pane) },
    focus: { ...box(focus), computed: cs(focus) },
    stack: { ...box(stack), computed: cs(stack) },
    lines,
  }
})()`)

console.log(JSON.stringify(report, null, 2))

if (report.lines?.length) {
  const edges = report.lines.map((l) => l.textRight)
  const spread = Math.max(...edges) - Math.min(...edges)
  console.log(`\ntext right edges: ${edges.join(", ")}`)
  console.log(`window right edge: ${report.windowInnerWidth}`)
  console.log(`stack right edge: ${report.stack?.right}`)
  console.log(
    spread <= 1
      ? "OK — every line's text reaches the same x."
      : `MISALIGNED — the lines' text ends at ${spread}px of different x.`,
  )
}
process.exit(0)
