/**
 * The rules that decide whether a track was played or skipped.
 *
 * This is the only part of listening history that can be wrong *quietly*. A file
 * that fails to write shows an error; a threshold that is 20% too low produces a
 * library full of confident, wrong play counts, and nothing anywhere complains.
 *
 * Usage: node scripts\test-listening-rules.mjs
 */
import { build } from "esbuild"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

async function loadShared() {
  const dir = await mkdtemp(path.join(tmpdir(), "titan-listen-"))
  const out = path.join(dir, "listening.mjs")
  await build({
    entryPoints: [path.join(root, "src", "shared", "listening.ts")],
    outfile: out,
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "node20",
    logLevel: "silent",
  })
  const mod = await import(pathToFileURL(out).href)
  await rm(dir, { recursive: true, force: true })
  return mod
}

const { playThresholdSeconds, classifyListen, applyListen, playsOf, lastPlayedAt } =
  await loadShared()

let failures = 0
let checks = 0

const fail = (name, detail) => {
  failures++
  console.log(`  FAIL  ${name}\n        ${detail}`)
}
const ok = (name, detail) => console.log(`  ok    ${name}${detail ? `  (${detail})` : ""}`)

const sec = (s) => ({ durationSec: 180, positionSec: s, listenedMs: s * 1000 })

console.log("\nthe play threshold\n")

for (const [duration, expected, why] of [
  [180, 90, "half of a three-minute track, under four minutes"],
  [166, 83, "half of an 2:46 track"],
  [600, 240, "four minutes, not ten, for a long track"],
  [30, 15, "half of a thirty-second track"],
  [12, 10, "the floor: a twelve-second track needs ten seconds"],
  [4, 10, "the floor applies even when half is under it"],
  [0, 10, "an unknown duration falls back to the floor"],
  [-5, 10, "a nonsense duration does not produce a negative threshold"],
  [NaN, 10, "NaN does not produce NaN"],
]) {
  const got = playThresholdSeconds(duration)
  if (got !== expected) fail(`threshold for ${duration}s`, `got ${got}, expected ${expected}`)
  else {
    checks++
    ok(`threshold for ${duration}s`, `${got}s — ${why}`)
  }
}

console.log("\nwhat counts as a play\n")

for (const [name, input, expected] of [
  ["listened to the whole first half", sec(90), "play"],
  ["one second past the threshold", sec(91), "play"],
  ["a second under the threshold", sec(89), "skip"],
  ["a long track past four minutes", { durationSec: 900, positionSec: 240, listenedMs: 240_000 }, "play"],
  ["a long track under four minutes", { durationSec: 900, positionSec: 200, listenedMs: 200_000 }, "skip"],
  ["half a second of listening", sec(0.5), "ignore"],
  ["nothing at all", sec(0), "ignore"],
]) {
  const got = classifyListen(input)
  if (got !== expected) fail(name, `classified ${got}, expected ${expected}`)
  else {
    checks++
    ok(name, expected)
  }
}

console.log("\na seek is not listening\n")

{
  /*
   * The case that separates a position-based rule from a listening-based one.
   *
   * Someone scrubs to the middle of a track, listens twenty seconds and moves on.
   * They have not listened to it. A rule that reads the playback position counts
   * a full play every single time, and a listener who uses the seek bar would end
   * up with a play count that is really a count of how often they skipped.
   */
  const scrubbed = { durationSec: 180, positionSec: 100, listenedMs: 20_000 }
  const got = classifyListen(scrubbed)
  if (got !== "skip") {
    fail("scrubbing forward does not count as a play", `classified ${got} from position 100s and 20s heard`)
  } else {
    checks++
    ok("scrubbing forward does not count as a play", "position 100s, 20s actually heard")
  }

  // And the reverse: genuinely heard, position irrelevant.
  const heard = { durationSec: 180, positionSec: 0, listenedMs: 100_000 }
  if (classifyListen(heard) !== "play") {
    fail("listening counts regardless of position", `classified ${classifyListen(heard)}`)
  } else {
    checks++
    ok("listening counts regardless of position", "100s heard from 0:00")
  }
}

console.log("\nnonsense input degrades to nothing\n")

for (const [name, input, expected] of [
  ["a NaN listened time", { durationSec: 180, positionSec: 90, listenedMs: NaN }, "ignore"],
  ["a negative listened time", { durationSec: 180, positionSec: 90, listenedMs: -5000 }, "ignore"],
  /*
   * Infinity is the interesting one, and the answer is "ignore" rather than
   * "play".
   *
   * It reads as a broken accumulator rather than as a track somebody genuinely
   * listened to for ever, and the two ways to fail are not symmetric. Counting it
   * as a play would inflate a count that nothing could later contradict; ignoring
   * it loses exactly one session. When a number cannot be trusted, the cheap
   * mistake is the right one.
   */
  ["an infinite listened time", { durationSec: 180, positionSec: 90, listenedMs: Infinity }, "ignore"],
]) {
  const got = classifyListen(input)
  if (got !== expected) fail(name, `classified ${got}, expected ${expected}`)
  else {
    checks++
    ok(name, got)
  }
}

console.log("\nfolding a session in\n")

{
  let history = {}
  const at = "2026-09-30T12:00:00.000Z"

  history = applyListen(history, "a", "play", 120_000, at)
  history = applyListen(history, "a", "play", 90_000, at)
  history = applyListen(history, "a", "skip", 30_000, at)
  history = applyListen(history, "b", "skip", 30_000, at)

  checks++
  ok("three sessions on one track", `plays=${playsOf(history, "a")}, skips=${history.a.skips}`)

  if (history.a.plays !== 2) fail("plays accumulate", `got ${history.a.plays}, expected 2`)
  else if (history.a.skips !== 1) fail("skips accumulate", `got ${history.a.skips}, expected 1`)
  else if (history.a.listenedMs !== 240_000) {
    fail("listened time accumulates", `got ${history.a.listenedMs}, expected 240000`)
  } else {
    checks++
    ok("plays, skips and listened time all accumulate", "2 plays, 1 skip, 240000ms")
  }

  if (history.b.plays !== 0) fail("a skipped track has no plays", `got ${history.b.plays}`)
  else {
    checks++
    ok("a skipped track has no plays", "the ratio stays meaningful")
  }

  /*
   * "ignore" must return the *same object*, because the caller compares identity
   * to decide whether anything changed. A fresh equal-but-new object would make
   * every row re-render on a tap that was not recorded.
   */
  const before = history
  const after = applyListen(before, "c", "ignore", 1000, at)
  if (after !== before) fail("an ignored session returns the same object", "identity changed")
  else if ("c" in after) fail("an ignored session creates no entry", "c was added")
  else {
    checks++
    ok("an ignored session changes nothing at all", "same object, no new key")
  }
}

console.log("\nreading a track that was never played\n")

{
  if (playsOf({}, "nope") !== 0) fail("an unknown track has zero plays", "nonzero")
  else if (playsOf(undefined, "nope") !== 0) fail("no history at all reads as zero plays", "nonzero")
  else if (lastPlayedAt({}, "nope") !== 0) fail("an unknown track has no last-played time", "nonzero")
  else if (lastPlayedAt({ x: { lastPlayed: "not a date" } }, "x") !== 0) {
    fail("an unparseable date sorts as never played", "nonzero")
  } else {
    checks++
    ok("an unknown or unplayed track reads as zero", "no NaN, no exception")
  }

  // A real date has to survive, or "Recently Played" would be permanently empty.
  const when = lastPlayedAt({ x: { lastPlayed: "2026-09-30T12:00:00.000Z" } }, "x")
  if (when !== Date.parse("2026-09-30T12:00:00.000Z")) {
    fail("a real last-played date parses", `got ${when}`)
  } else {
    checks++
    ok("a real last-played date parses", String(when))
  }
}

console.log(`\n${checks} passed, ${failures} failed\n`)
process.exit(failures === 0 ? 0 : 1)
