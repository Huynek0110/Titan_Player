/**
 * Generates small WAV files carrying real LIST/INFO tags, plus a sidecar .lrc,
 * so the scan -> tag -> playback -> lyrics path can be verified end to end
 * without hunting for media files.
 *
 * Usage: node scripts/make-test-audio.mjs [targetDir]
 */
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

const RATE = 44100

function pcm(seconds, freq) {
  const n = Math.floor(RATE * seconds)
  const data = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i += 1) {
    // Fade in and out so playback does not click at the boundaries.
    const fade = Math.min(1, i / 2000, (n - i) / 2000)
    const t = i / RATE
    // A couple of harmonics so it sounds like a note rather than a beep.
    const v =
      Math.sin(2 * Math.PI * freq * t) * 0.5 +
      Math.sin(2 * Math.PI * freq * 2 * t) * 0.18 +
      Math.sin(2 * Math.PI * freq * 3 * t) * 0.08
    data.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(v * fade * 26000))), i * 2)
  }
  return data
}

function infoChunk(tags) {
  const parts = [Buffer.from("INFO", "ascii")]
  for (const [id, value] of Object.entries(tags)) {
    if (!value) continue
    const body = Buffer.concat([Buffer.from(`${value}\0`, "ascii")])
    const padded = body.length % 2 === 1 ? Buffer.concat([body, Buffer.alloc(1)]) : body
    parts.push(Buffer.from(id, "ascii"))
    parts.push(Buffer.alloc(4))
    parts.writeUInt32LE(body.length, parts.length - 4)
    parts.push(padded)
  }
  return Buffer.concat(parts)
}

function makeWav(seconds, freq, tags) {
  const data = pcm(seconds, freq)
  const fmt = Buffer.alloc(24)
  fmt.write("fmt ", 0, "ascii")
  fmt.writeUInt32LE(16, 4)
  fmt.writeUInt16LE(1, 8) // PCM
  fmt.writeUInt16LE(2, 10) // stereo
  fmt.writeUInt32LE(RATE, 12)
  fmt.writeUInt32LE(RATE * 4, 16)
  fmt.writeUInt16LE(4, 20)
  fmt.writeUInt16LE(16, 22)

  const list = infoChunk(tags)
  const listHead = Buffer.alloc(8)
  listHead.write("LIST", 0, "ascii")
  listHead.writeUInt32LE(list.length, 4)

  const body = Buffer.concat([Buffer.from("WAVE", "ascii"), fmt, listHead, list])
  const riff = Buffer.alloc(8)
  riff.write("RIFF", 0, "ascii")
  riff.writeUInt32LE(body.length, 4)

  const dataHead = Buffer.alloc(8)
  dataHead.write("data", 0, "ascii")
  dataHead.writeUInt32LE(data.length, 4)

  return Buffer.concat([riff, body, dataHead, data])
}

const TRACKS = [
  {
    file: "01 Aurora Drift.wav",
    freq: 261.63,
    tags: {
      INAM: "Aurora Drift",
      IART: "Kite Harbour",
      IPRD: "Northern Signal",
      ICRD: "2024",
      IGNR: "Ambient",
      ITRK: "1",
    },
  },
  {
    file: "02 Glass Meridian.wav",
    freq: 329.63,
    tags: {
      INAM: "Glass Meridian",
      IART: "Kite Harbour",
      IPRD: "Northern Signal",
      ICRD: "2024",
      IGNR: "Ambient",
      ITRK: "2",
    },
  },
  {
    file: "03 Low Tide Signals.wav",
    freq: 196.0,
    tags: {
      INAM: "Low Tide Signals",
      IART: "Vela Nine",
      IPRD: "Salt Circuit",
      ICRD: "2026",
      IGNR: "Electronic",
      ITRK: "1",
    },
  },
]

const LRC = `[ar:Kite Harbour]
[ti:Aurora Drift]
[offset:+0]
[00:00.50]The first line of the test lyric
[00:03.00]A second line with a longer sentence
[00:06.00]A line that is long enough to wrap onto a second visual line in the pane
[00:09.00]And a final line
`

const target = path.resolve(process.argv[2] ?? path.join(process.env.USERPROFILE, "Music"))
await mkdir(path.join(target, "Kite Harbour"), { recursive: true })

for (const track of TRACKS) {
  const dest = path.join(target, "Kite Harbour", track.file)
  await writeFile(dest, makeWav(11, track.freq, track.tags))
  console.log("wrote", dest)
}

const lrcPath = path.join(target, "Kite Harbour", "01 Aurora Drift.lrc")
await writeFile(lrcPath, LRC, "utf8")
console.log("wrote", lrcPath)
