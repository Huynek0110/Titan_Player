/**
 * Probes one audio file to separate "the file is broken" from "our delivery of
 * it is broken": checks the container magic, whether a picture block exists, and
 * whether that block's declared MIME is something Chromium can accept.
 */
import { readFile } from "node:fs/promises"
import path from "node:path"
import { parseFile } from "music-metadata"

const target = process.argv[2]
if (!target) {
  console.error("usage: node scripts/probe-audio.mjs <file>")
  process.exit(1)
}

console.log("file:", path.basename(target))

const head = (await readFile(target)).subarray(0, 4)
console.log("magic:", head.toString("ascii"), head.toString("hex"))

try {
  const meta = await parseFile(target, { duration: true })
  console.log("format:      ", meta.format.container, meta.format.codec, meta.format.lossless ? "lossless" : "lossy")
  console.log("duration:    ", meta.format.duration, "s")
  console.log("sampleRate:  ", meta.format.sampleRate)
  console.log("channels:    ", meta.format.numberOfChannels)
  console.log("bitrate:     ", meta.format.bitrate)
  console.log("title:       ", meta.common.title)
  console.log("artist:      ", meta.common.artist)
  console.log("album:       ", meta.common.album)
  console.log("pictures:    ", meta.common.picture?.length ?? 0)
  for (const pic of meta.common.picture ?? []) {
    console.log(
      `  - type=${pic.type} name=${pic.name} mime=${JSON.stringify(pic.format)} bytes=${pic.data.length}`,
    )
    // Chromium rejects the whole FLAC when the picture block's MIME is empty or
    // not a real image type, so flag anything suspicious.
    const mime = String(pic.format ?? "").toLowerCase()
    const suspicious = !/^image\/(jpeg|png|webp|gif|bmp)$/.test(mime)
    console.log(`    magic: ${Buffer.from(pic.data.subarray(0, 4)).toString("hex")}${suspicious ? "   <-- SUSPICIOUS MIME" : ""}`)
  }
  const lyricTags = meta.common.lyrics ?? []
  console.log("lyric tags:  ", lyricTags.length)
  for (const tag of lyricTags) {
    console.log(`  - text=${(tag.text ?? "").length} chars, syncText=${tag.syncText?.length ?? 0} cues`)
  }
  const vorbis = meta.native?.vorbis
  if (vorbis) {
    const keys = vorbis.map((t) => t.id)
    console.log("vorbis keys: ", keys.join(", ") || "(none)")
  }
} catch (err) {
  console.error("PARSE FAILED:", err instanceof Error ? err.message : err)
}
