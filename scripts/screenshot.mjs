/**
 * Screenshot the running app over CDP.
 *
 * CDP rather than a Win32 `PrintWindow` helper: the window is a Chromium
 * compositor surface with `titleBarStyle: "hidden"`, and PowerShell on this
 * machine blocks `.ps1` files outright, so the usual approach needs a script
 * file it cannot execute. This needs nothing but Node's global WebSocket.
 *
 * Usage: node scripts\screenshot.mjs <cdpPort> <outPath> [maximise]
 */
const port = process.argv[2] ?? "9222"
const out = process.argv[3] ?? "titan.png"
const maximise = process.argv[4] === "maximise"

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

await send("Page.enable")

if (maximise) {
  // Drive the app's own maximise button rather than the OS, so the screenshot
  // exercises the same path a user does and the resize jank shows up here.
  const { result } = await send("Runtime.evaluate", {
    expression: `(() => {
      const b = [...document.querySelectorAll('.titlebar-btn')]
        .find(el => /maximi|restore/i.test(el.getAttribute('aria-label') || ''))
      if (b) { b.click(); return b.getAttribute('aria-label') }
      return null
    })()`,
    returnByValue: true,
  })
  console.log("maximise button:", result?.result?.value)
  // Resizing triggers the backdrop-filter re-blur, so give it time to settle.
  await new Promise((r) => setTimeout(r, 2500))
}

const { result } = await send("Page.captureScreenshot", { format: "png" })
if (!result?.data) {
  console.error("captureScreenshot returned nothing")
  process.exit(1)
}

const { writeFileSync } = await import("node:fs")
writeFileSync(out, Buffer.from(result.data, "base64"))
console.log(`saved ${out} (${(result.data.length * 0.75 / 1024).toFixed(0)} kB)`)

ws.close()
process.exit(0)
