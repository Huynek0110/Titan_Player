/**
 * Put a word-timed `.lrc` beside a track, so the karaoke sweep has something to
 * run on.
 *
 * Written as literal LRC text rather than through `formatLrc`, on purpose. The
 * serialiser already has `test-lrc-roundtrip.mjs`; feeding its own output into
 * the renderer would mean a bug in it and a bug in the sweep could cancel out and
 * both tests would pass. This file is what a third-party tagger or a hand-typed
 * Enhanced LRC actually looks like, which is what the renderer has to survive.
 *
 * Usage: node scripts\make-word-lrc.mjs <trackPath> [--keep]
 */
import { writeFileSync, existsSync } from "node:fs"
import path from "node:path"

const trackPath = process.argv[2]
const keep = process.argv.includes("--keep")

if (!trackPath || !existsSync(trackPath)) {
  console.error("usage: node scripts\\make-word-lrc.mjs <trackPath> [--keep]")
  process.exit(1)
}

const sidecar = path.join(
  path.dirname(trackPath),
  `${path.basename(trackPath, path.extname(trackPath))}.lrc`,
)

if (existsSync(sidecar) && !keep) {
  console.log(`${path.basename(sidecar)} already exists; pass --keep to overwrite it`)
  process.exit(1)
}

/*
 * Enhanced LRC: one `[mm:ss.xx]` per line, then one `<mm:ss.xx>` in front of each
 * word. The line tag and the first word tag are the same instant, as the format
 * requires. Times are spread across the first half of the track so a seek to
 * anywhere in that range lands on a sweepable line.
 */
const text = `[ti:Word timing fixture]
[ar:RPT MCK]
[al:HVL]
[by:probe]
[00:01.00]<00:01.00>Xin <00:01.30>chao <00:01.70>Viet <00:02.10>Nam
[00:03.00]<00:03.00>Mot <00:03.40>nguoi <00:03.90>di <00:04.30>xa
[00:05.00]<00:05.00>Tim <00:05.35>anh <00:05.80>nhu <00:06.20>dang <00:06.70>no tung
[00:07.00]<00:07.00>Nhe <00:07.40>nhang <00:07.90>day <00:08.40>len
`

writeFileSync(sidecar, text, "utf8")
console.log(`wrote ${sidecar}`)
console.log(`  ${text.split("\n").filter(Boolean).length - 5} lyric lines, 4 with word timing`)
