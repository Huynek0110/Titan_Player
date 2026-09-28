/**
 * Attaches to a running Titan Player over the DevTools protocol and reports the
 * real state of its <audio> element.
 *
 * Guessing at a playback bug wastes more time than reading the values the
 * browser already knows: readyState, networkState, error code, whether an
 * AudioContext is suspended, and whether the element is being reloaded
 * underneath us.
 *
 * Usage: node scripts/inspect-audio.mjs [port]
 */
const port = process.argv[2] ?? "9222"

async function findTarget() {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`)
  const targets = await res.json()
  return targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl)
}

const target = await findTarget()
if (!target) {
  console.error("no debuggable page found on port", port)
  process.exit(1)
}

console.log("target:", target.title, target.url.slice(0, 70))

const ws = new WebSocket(target.webSocketDebuggerUrl)
let nextId = 1
const pending = new Map()

ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  }
})

await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }))

function send(method, params) {
  const id = nextId++
  return new Promise((resolve) => {
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate(expression) {
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

const probe = `(() => {
  const a = document.querySelector('audio');
  if (!a) return { missing: 'no audio element in the DOM' };

  // Any AudioContext we created is reachable only through the analyser, so look
  // for the element property our hook uses to make the source exactly once.
  const src = a.__titanSource;
  const ctx = a.__titanCtx;

  return {
    src: a.currentSrc ? a.currentSrc.slice(0, 96) : '(empty)',
    currentTime: Number(a.currentTime.toFixed(3)),
    duration: Number.isFinite(a.duration) ? Number(a.duration.toFixed(3)) : String(a.duration),
    paused: a.paused,
    ended: a.ended,
    muted: a.muted,
    volume: a.volume,
    loop: a.loop,
    playbackRate: a.playbackRate,
    readyState: a.readyState,
    networkState: a.networkState,
    seeking: a.seeking,
    errorCode: a.error ? a.error.code : null,
    errorMsg: a.error ? a.error.message : null,
    hasMediaSource: Boolean(src),
    audioContextState: ctx ? ctx.state : '(no ctx handle on element)',
    buffered: a.buffered.length ? Number(a.buffered.end(0).toFixed(2)) : 0,
  };
})()`

for (let i = 1; i <= 4; i += 1) {
  const state = await evaluate(probe)
  console.log(`\n--- sample ${i} ---`)
  console.log(JSON.stringify(state, null, 2))
  if (i < 4) await new Promise((r) => setTimeout(r, 1500))
}

ws.close()
process.exit(0)
