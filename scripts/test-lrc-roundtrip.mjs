/**
 * Round-trip test for the LRC serialiser.
 *
 * `formatLrc` and `parseLrc` are a matched pair: the editor writes with one and
 * the scanner reads with the other, and the only evidence either is correct is
 * that a file which goes in and comes back out still puts the same words in the
 * same places at the same times. Nothing about that is visible in a typecheck,
 * and a round trip that is *close* rather than exact is exactly the kind of bug
 * that only shows up as lyrics drifting a fraction of a second per line.
 *
 * The shared module is TypeScript, so it is bundled to a temporary ESM file
 * with the esbuild already in the project's dependencies rather than adding a
 * test runner. Run it with `node scripts/test-lrc-roundtrip.mjs`.
 */
import { build } from "esbuild"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

/** `src/shared/lyrics.ts` only imports a type, so the bundle is self-contained. */
async function loadShared() {
  const dir = await mkdtemp(path.join(tmpdir(), "titan-lrc-"))
  const out = path.join(dir, "lyrics.mjs")
  await build({
    entryPoints: [path.join(root, "src", "shared", "lyrics.ts")],
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

const { parseLrc, formatLrc, splitWords, wordBodyProblem } = await loadShared()

let failures = 0
let checks = 0

function fail(name, detail) {
  failures++
  console.log(`  FAIL  ${name}\n        ${detail}`)
}

function ok(name, detail) {
  console.log(`  ok    ${name}${detail ? `  (${detail})` : ""}`)
}

/** Two lines count as equal when their times round to the same centisecond. */
function sameLine(a, b) {
  if (a.text !== b.text) return `text differs:\n          a=${JSON.stringify(a.text)}\n          b=${JSON.stringify(b.text)}`
  if (Math.abs(a.time - b.time) >= 0.01) return `time differs: ${a.time} vs ${b.time}`
  const aw = a.words ?? []
  const bw = b.words ?? []
  if (aw.length !== bw.length) return `word count differs: ${aw.length} vs ${bw.length}`
  for (let i = 0; i < aw.length; i++) {
    if (aw[i].start !== bw[i].start || aw[i].end !== bw[i].end) {
      return `word ${i} offsets differ: ${aw[i].start}-${aw[i].end} vs ${bw[i].start}-${bw[i].end}`
    }
    if (Math.abs(aw[i].time - bw[i].time) >= 0.01) {
      return `word ${i} time differs: ${aw[i].time} vs ${bw[i].time}`
    }
  }
  return null
}

/**
 * Time the first N words of `text`.
 *
 * The offsets come from `splitWords` rather than being written out by hand,
 * because a hand-written offset that forgets the space after a word describes a
 * *different* line than the one in the string — and every one of those cases
 * fails as a "gap", which looks like a bug in the serialiser rather than a
 * mistake in the test. Fewer times than words is deliberate and meaningful: a
 * prefix of the line's words is the "stops short of the end" case.
 */
function timedWords(text, times) {
  const segments = splitWords(text)
  if (times.length > segments.length) {
    throw new Error(`"${text}" splits into ${segments.length} words, got ${times.length} times`)
  }
  return times.map((time, i) => ({
    time,
    start: segments[i].start,
    end: segments[i].end,
  }))
}

/**
 * Parse -> format -> parse, and require the two parses to agree.
 *
 * The centisecond tolerance is the format's own resolution, not a fudge: two
 * centiseconds is a difference no one can hear and no file can express, and
 * anything above that is a real loss.
 */
function roundTrip(name, lrc) {
  const first = parseLrc(lrc)
  const written = formatLrc(first.lines, { title: "Round Trip", artist: "Test" })
  const second = parseLrc(written)

  if (first.synced !== second.synced) {
    fail(name, `synced flipped: ${first.synced} -> ${second.synced}`)
    return
  }
  if (first.lines.length !== second.lines.length) {
    fail(name, `line count differs: ${first.lines.length} -> ${second.lines.length}\n${written}`)
    return
  }
  for (let i = 0; i < first.lines.length; i++) {
    const diff = sameLine(first.lines[i], second.lines[i])
    if (diff) {
      fail(name, `line ${i}: ${diff}\n${written}`)
      return
    }
  }
  checks++
  ok(name, `${second.lines.length} lines${second.lines.some((l) => l.words) ? ", word timing kept" : ""}`)
}

console.log("\nround trip through formatLrc -> parseLrc\n")

roundTrip(
  "line-level",
  "[00:12.34]first line\n[00:15.00]second line\n[00:19.88]third",
)

roundTrip(
  "word-level (Enhanced LRC)",
  "[00:12.00]<00:12.00>Hello <00:12.40>there <00:12.90>friend",
)

roundTrip(
  "vi diacritics",
  "[00:08.00]Dưa Chua\n[00:14.20]Một người đi xa",
)

roundTrip(
  "whitespace is collapsed identically",
  "[00:05.00]a  double   space  \n[00:09.00]   leading and trailing   ",
)

roundTrip(
  "three-digit fraction in, two out",
  "[00:07.250]hundredths stay the same\n[00:11.999]rounds down, never up",
)

roundTrip("at the one minute mark", "[01:00.00]one minute\n[01:30.50]ninety seconds")
roundTrip("past an hour", "[61:05.00]over an hour")

roundTrip(
  "multiple timestamps on one line",
  "[00:10.00][00:40.00]a repeated chorus",
)

roundTrip(
  "a line the parser skips as an ID tag",
  "[ti:Not A Line]\n[00:03.00]real line",
)

roundTrip("single line", "[00:00.50]the very first")

roundTrip(
  "offset tag is already applied when read",
  "[offset:500]\n[00:10.00]half a second early",
)

console.log("\ndegradation: a line whose word timing is unusable saves as a line\n")

/** Each of these must survive as a line and report why the words were dropped. */
const degrade = [
  {
    name: "single word",
    line: { time: 1, text: "Alone", words: [{ time: 1, start: 0, end: 5 }] },
    reason: "single-word",
  },
  {
    name: "word times running backwards",
    line: {
      time: 1,
      text: "two words",
      words: [
        { time: 1, start: 0, end: 3 },
        { time: 0.5, start: 4, end: 9 },
      ],
    },
    reason: "backwards",
  },
  {
    name: "a gap between words",
    line: {
      time: 1,
      text: "two words",
      words: [
        { time: 1, start: 0, end: 3 },
        { time: 1.4, start: 6, end: 9 },
      ],
    },
    reason: "gap",
  },
  {
    name: "words overlapping",
    line: {
      time: 1,
      text: "two words",
      words: [
        { time: 1, start: 0, end: 5 },
        { time: 1.4, start: 3, end: 9 },
      ],
    },
    reason: "overlap",
  },
  {
    // Contiguous, but stopping four characters short of the end. The whole point
    // is that the words agree with each other and only the tail is missing, so
    // the check cannot be satisfied by an earlier rule firing first.
    name: "words stopping short of the end",
    line: { time: 1, text: "two words here", words: timedWords("two words here", [1, 1.4]) },
    reason: "short-cover",
  },
]

for (const test of degrade) {
  const reported = wordBodyProblem(test.line)
  const written = formatLrc([test.line])
  const parsed = parseLrc(written)
  const line = parsed.lines[0]

  if (reported !== test.reason) {
    fail(test.name, `reported "${reported}", expected "${test.reason}"`)
    continue
  }
  if (!line) {
    fail(test.name, `line did not survive: ${JSON.stringify(written)}`)
    continue
  }
  if (line.words) {
    fail(test.name, `word timing survived anyway, so the sweep would be wrong`)
    continue
  }
  if (line.text !== test.line.text) {
    fail(test.name, `text changed: ${JSON.stringify(line.text)}`)
    continue
  }
  checks++
  ok(test.name, `saved as "[${written.trim()}]", reported "${reported}"`)
}

console.log("\nvalid word timing is kept\n")

{
  // Contiguous, ordered, covering: the one shape that must survive intact.
  const text = "Hello there friend"
  const line = { time: 1, text, words: timedWords(text, [1, 1.4, 1.8]) }
  const written = formatLrc([line])
  const parsed = parseLrc(written)
  const back = parsed.lines[0]

  if (wordBodyProblem(line) !== null) {
    fail("valid timing is rejected", `reported "${wordBodyProblem(line)}"`)
  } else if (!back?.words || back.words.length !== 3) {
    fail("valid timing is lost", `came back with ${back?.words?.length ?? 0} words: ${written.trim()}`)
  } else {
    checks++
    ok("valid timing is kept", written.trim())
  }
}

console.log("\nthe flooring guarantee\n")

{
  /*
   * Rounding is monotonic, so it can never reverse two stamps — but it can
   * collapse two genuinely distinct ones onto the same centisecond, and a
   * zero-length segment is not a sweep. `wordFillFraction` has to treat a step
   * under a millisecond as "finish this word immediately", so words 4ms apart
   * would light up together and the line would read as one movement.
   *
   * 12.998 and 13.002 are the pair that exposes it: rounding sends both to
   * 13.00, flooring keeps 12.99 and 13.00.
   */
  const text = "aa bb"
  const original = [12.998, 13.002]
  const words = timedWords(text, original)
  const written = formatLrc([{ time: original[0], text, words }])
  const stamps = [...written.matchAll(/<(\d{2}:\d{2}\.\d{2})>/g)].map((m) => m[1])
  const toSeconds = (s) => {
    const [m, rest] = s.split(":")
    return Number(m) * 60 + Number(rest)
  }
  const times = stamps.map(toSeconds)

  /*
   * Applied to the *original* times, not to what was written. Rounding the
   * output would compare 12.99 with 13.00, which are already distinct and would
   * pass whether or not the serialiser floors at all — a test that cannot fail is
   * not a test. This is the check that proves the case is worth making.
   */
  const ifRounded = original.map((t) => Math.round(t * 100) / 100)

  if (ifRounded[0] !== ifRounded[1]) {
    fail("the case is worth testing", `rounding does not collapse ${original.join(" and ")}`)
  } else if (stamps.length !== 2) {
    fail("distinct stamps stay distinct", `expected 2 stamps, got ${stamps.length}: ${written.trim()}`)
  } else if (times[0] === times[1]) {
    fail("distinct stamps stay distinct", `flooring collapsed them to ${stamps[0]}`)
  } else if (times[1] <= times[0]) {
    fail("distinct stamps stay distinct", `not increasing: ${stamps.join(", ")}`)
  } else {
    checks++
    ok(
      "distinct stamps stay distinct",
      `${stamps[0]} then ${stamps[1]}; rounding would have collapsed both to ${ifRounded[0].toFixed(2)}`,
    )
  }
}

{
  // The same collapse on line tags: two lines 4ms apart would come back from
  // parseLrc with identical times, and the second would have no interval to
  // interpolate across.
  const lines = [
    { time: 12.998, text: "first" },
    { time: 13.002, text: "second" },
  ]
  const back = parseLrc(formatLrc(lines))
  if (back.lines.length !== 2) {
    fail("adjacent lines stay distinct", `came back with ${back.lines.length} lines`)
  } else if (back.lines[0].time === back.lines[1].time) {
    fail("adjacent lines stay distinct", `both landed on ${back.lines[0].time}s`)
  } else {
    checks++
    ok("adjacent lines stay distinct", `${back.lines[0].time}s then ${back.lines[1].time}s`)
  }
}

{
  // Flooring must never write a time *later* than the truth, which is the error
  // that is actually audible rather than merely imprecise.
  const written = formatLrc([{ time: 12.999, text: "late" }])
  const stamp = written.match(/\[(\d{2}:\d{2}\.\d{2})\]/)?.[1]
  const toSeconds = (s) => {
    const [m, rest] = s.split(":")
    return Number(m) * 60 + Number(rest)
  }
  if (!stamp || toSeconds(stamp) > 12.999) {
    fail("a stamp is never written late", `wrote ${stamp} for 12.999s`)
  } else {
    checks++
    ok("a stamp is never written late", `12.999s -> ${stamp} (${toSeconds(stamp)}s)`)
  }
}

{
  // A backwards pair is refused and reported, so the editor can say why rather
  // than writing a file whose sweep would run the wrong way.
  const line = {
    time: 12.349,
    text: "aa bb",
    words: timedWords("aa bb", [12.349, 12.341]),
  }
  if (wordBodyProblem(line) !== "backwards") {
    fail("a backwards pair is refused", `reported "${wordBodyProblem(line)}"`)
  } else {
    const written = formatLrc([line])
    const parsed = parseLrc(written)
    if (parsed.lines[0]?.words) {
      fail("a backwards pair is refused", "word timing survived into the file")
    } else if (parsed.lines[0]?.text !== "aa bb") {
      fail("a backwards pair is refused", `text changed to ${JSON.stringify(parsed.lines[0]?.text)}`)
    } else {
      checks++
      ok("a backwards pair is refused", `saved as "${written.trim()}"`)
    }
  }
}

console.log("\nsplitWords reassembles the line exactly\n")

for (const text of [
  "Hello there friend",
  "  leading and trailing  ",
  "single",
  "Dưa Chua Một người đi xa",
  "tabs\tand\nnewlines inside",
  "   ",
  "",
]) {
  const segments = splitWords(text)
  const rebuilt = segments.map((s) => s.text).join("")
  if (rebuilt !== text) {
    fail(`splitWords ${JSON.stringify(text)}`, `rebuilt as ${JSON.stringify(rebuilt)}`)
  } else if (text.length > 0 && text.trim().length > 0 && segments.some((s) => s.end <= s.start)) {
    fail(`splitWords ${JSON.stringify(text)}`, "produced an empty segment")
  } else if (text.trim().length > 0 && segments.some((s) => s.text.trim().length === 0)) {
    fail(`splitWords ${JSON.stringify(text)}`, "produced a whitespace-only segment")
  } else {
    checks++
    ok(`splitWords ${JSON.stringify(text)}`, `${segments.length} segments`)
  }
}

console.log(`\n${checks} passed, ${failures} failed\n`)
process.exit(failures === 0 ? 0 : 1)
