import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { activeLineIndex, lineFillFraction } from "@shared/lyrics"
import type { LyricLine } from "@shared/types"
import { formatDuration } from "../lib/format"
import { useReducedMotion } from "../lib/useReducedMotion"
import { Lyrics } from "./Icons"
import "./LyricsPane.css"

interface LyricsPaneProps {
  lines: LyricLine[]
  plain?: string
  /** The audio clock, read through a callback so it can stay stable. */
  getTime: () => number
  isPlaying: boolean
  onSeek: (seconds: number) => void
  hasAny: boolean

  /**
   * Progress of the online lookup, so the pane can say something while it waits
   * instead of showing an empty box that looks like a track with no lyrics at
   * all. Absent means the feature is off, and the pane says nothing about it.
   */
  onlineStatus?: "searching" | "not-found" | "offline"
  onlineDetail?: string
  onRetryOnline?: () => void

  /**
   * Whether online lookup is switched on, and a way to switch it on from here.
   *
   * Both optional, and both matter for discoverability rather than function. The
   * setting is off by default because a lookup reports what you play to a third
   * party, which is a decision that should be made deliberately — but a pane
   * that says only "no lyrics in this file" while silently having a feature that
   * would fix it is worse than either extreme. The user reads that as the app
   * being unable, not as a choice they have not made yet.
   */
  onlineEnabled?: boolean
  onEnableOnline?: () => void
}

const NUDGE_STEP_MS = 200
const NUDGE_LIMIT_MS = 5000

/** How often to re-read the clock while paused, in milliseconds. */
const PAUSED_POLL_MS = 250
/** Backing-off multiplier once repeated polls find nothing new. */
const PAUSED_IDLE_STEPS = 4

/**
 * How many lines to show after the current one.
 *
 * Two. The second line gives the listener somewhere to start, and it recedes far
 * enough that the eye is pulled to the current line and the rest reads as
 * context. A third line stops it being "the line and what is coming", which is
 * the whole idea.
 */
const UPCOMING = 2

/** How far past the final lyric the dots take over, in seconds. */
const TAIL_SECONDS = 2.5

/**
 * The lyrics pane: the current line, what comes next, and a marker for the parts
 * of a track nobody sings over.
 *
 * This replaced a scrolling list of every line with a per-word karaoke sweep, and
 * the change removed complexity rather than adding it — no scroll container, no
 * per-line DOM for a fifty-line file, and no custom property being written from a
 * `requestAnimationFrame` loop. What is left is a binary search over the
 * timestamps and four nodes. The sweep was the expensive part and nobody wanted
 * it.
 */
export default function LyricsPane({
  lines,
  plain,
  getTime,
  isPlaying,
  onSeek,
  hasAny,
  onlineStatus,
  onlineDetail,
  onRetryOnline,
  onlineEnabled,
  onEnableOnline,
}: LyricsPaneProps) {
  const [active, setActive] = useState(-1)
  const reduced = useReducedMotion()

  /**
   * The user's timing nudge, stored against the array it was set for.
   *
   * Deriving the value this way means a track change resets it with no effect and
   * no extra render: `lines` is a new array, the stored one no longer matches, and
   * the offset reads as zero. A plain `useState` would have needed a reset effect
   * and flashed the previous track's correction onto the new track for a frame.
   */
  const [nudge, setNudge] = useState<{ forLines: LyricLine[]; ms: number }>({
    forLines: lines,
    ms: 0,
  })
  const nudgeMs = nudge.forLines === lines ? nudge.ms : 0
  const nudgeSeconds = nudgeMs / 1000

  const synced = lines.length > 0

  // --- the active line ---------------------------------------------------
  /*
   * A binary search and a `setState` when the answer changes. Nothing else.
   *
   * The rate is a `requestAnimationFrame` while playing and a backing-off poll
   * while paused, because a paused media element cannot move the clock by itself
   * but a seek can still arrive from the player bar or a click in here, and
   * nothing announces one. Once several polls in a row find the same line, the
   * interval doubles up to a cap: a paused track should not cost a wake-up every
   * quarter second for as long as the window is open.
   */
  useEffect(() => {
    if (!synced) return
    const list = lines
    let raf = 0
    let timer = 0
    let index = -2
    let idle = 0

    const poll = () => {
      // The nudge shifts everything, so it belongs where the clock is read rather
      // than inside the parser: the file's own `[offset:]` tag has already been
      // applied at scan time, and this is a second, user-driven correction on top
      // of it. Positive means the lyrics should appear earlier, matching LRC's sign
      // convention.
      const time = getTime() + nudgeSeconds
      const next = activeLineIndex(list, time)
      if (next === index) return false
      index = next
      setActive(next)
      return true
    }

    // One immediate pass, so a seek made while paused shows straight away rather
    // than after the first poll.
    poll()

    if (isPlaying) {
      const tick = () => {
        poll()
        raf = requestAnimationFrame(tick)
      }
      raf = requestAnimationFrame(tick)
    } else {
      const tick = () => {
        idle = poll() ? 0 : Math.min(idle + 1, PAUSED_IDLE_STEPS)
        timer = window.setTimeout(tick, PAUSED_POLL_MS * 2 ** idle)
      }
      timer = window.setTimeout(tick, PAUSED_POLL_MS)
    }

    return () => {
      cancelAnimationFrame(raf)
      window.clearTimeout(timer)
    }
  }, [lines, synced, isPlaying, getTime, nudgeSeconds])

  /**
   * Where the display is in the track: before the first line, at a line, or past
   * the last one.
   *
   * The two ends are the same thing to a listener — the song is running and
   * nobody is singing — so both get the same marker. Treating them differently
   * was how a track that opens with an instrumental used to show its first line
   * immediately and highlight it while the music had not reached it yet.
   */
  const phase = useMemo(() => {
    if (!synced) return "none"
    if (active < 0) return "waiting"
    const last = lines[lines.length - 1]
    const next = lines[active + 1]
    if (!next && getTime() + nudgeSeconds > last.time + TAIL_SECONDS) return "waiting"
    return "singing"
  }, [synced, active, lines, getTime, nudgeSeconds])

  /**
   * The lines to draw: the current one, then what comes next.
   *
   * Nothing at all during an instrumental, which is what the phase above decides.
   */
  const visible = useMemo(() => {
    if (phase !== "singing") return []
    return lines.slice(active, active + 1 + UPCOMING).map((line, offset) => ({ line, offset }))
  }, [lines, active, phase])

  const plainLines = useMemo(
    () => (plain ? plain.split(/\r?\n/).map((t) => t.trim()).filter(Boolean) : []),
    [plain],
  )

  // --- interaction ------------------------------------------------------
  const groupRef = useRef<HTMLDivElement>(null)

  const seekTo = useCallback(
    (line: LyricLine) => {
      // Undo the nudge on the way in: the stored time is where the *file* says
      // the line starts, but the pane is currently reading it as time + nudge, so
      // seeking to the raw value would land outside the window the pane thinks is
      // active and the line would not light up.
      onSeek(Math.max(0, line.time - nudgeSeconds))
    },
    [onSeek, nudgeSeconds],
  )

  /**
   * Arrow keys step through the lines that are on screen.
   *
   * Only three nodes exist, so this is a roving focus over a handful of buttons
   * rather than the forty tab stops a full list would have produced. The current
   * line takes the tab stop, which is what makes "the line being sung" reachable
   * at all.
   */
  const onLineKeys = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const key = event.key
      if (key !== "ArrowDown" && key !== "ArrowUp") return
      const from = (event.target as HTMLElement).closest<HTMLElement>(".lyric-now")
      if (!from) return
      const here = Number(from.dataset.offset)
      if (!Number.isFinite(here)) return
      const to = key === "ArrowDown" ? here + 1 : here - 1
      if (to < 0 || to > visible.length - 1) return
      event.preventDefault()
      const target = groupRef.current?.querySelector<HTMLButtonElement>(`[data-offset="${to}"]`)
      target?.focus()
    },
    [visible.length],
  )

  // --- the word sweep ---------------------------------------------------

  const stackRef = useRef<HTMLDivElement>(null)

  /**
   * Whether any visible line carries word-level timing.
   *
   * Enhanced LRC is the only local format that has it, and almost nothing writes
   * it, so for most tracks this loop never runs at all. That is the honest
   * outcome: a sweep invented from line timings alone looks like the words are
   * being shouted rather than sung, and the line-level display is better than a
   * wrong animation.
   */
  const karaoke = visible.some((v) => v.line.words)

  /**
   * Slice a line into one span per timed word.
   *
   * The whitespace *between* words is appended to the preceding span rather than
   * left between them, because a gap between two inline boxes would be a place
   * the sweep cannot cross — the gradient would restart and the space would stay
   * empty while its neighbours filled. Carrying the space inside the span (with
   * `white-space: pre-wrap` to keep it) makes each word a complete unit.
   *
   * The spans are given no fill value of their own. `--p` is written by the loop
   * below, and until it runs the CSS default of 0% leaves the line uniformly
   * unfilled, which is a correct frame rather than a flash of white.
   */
  const renderWords = useCallback((line: LyricLine) => {
    const words = line.words
    if (!words) return line.text
    const out: React.ReactNode[] = []
    for (let i = 0; i < words.length; i++) {
      const w = words[i]
      const next = words[i + 1]
      const end = next ? next.start : line.text.length
      out.push(
        <span className="w" key={`${w.start}-${i}`}>
          {line.text.slice(w.start, end)}
        </span>,
      )
    }
    return out
  }, [])

  /**
   * Write the sweep position onto the current line's words, once per frame.
   *
   * The gradient's stop is a custom property rather than React state, because a
   * re-render per frame would be the single most expensive thing in the app and
   * the whole point is that it must not be. The word spans are collected once per
   * line change, not per frame, so the loop never queries the DOM — a
   * `querySelectorAll` at 60Hz is a forced style recalc every frame.
   *
   * `lineFillFraction` already knows whether the line has word timing and, if it
   * is unusable, falls back to interpolating across the line's own span. This
   * maps that single 0..1 fraction onto per-word percentages using the character
   * offsets the parser recorded, which is why the sweep advances smoothly through
   * a word instead of snapping between them.
   *
   * The spans are re-collected by keying the effect on `active`, so the loop is
   * torn down and rebuilt once per lyric — a few times a minute — rather than
   * sixty times a second.
   */
  useEffect(() => {
    if (!karaoke || reduced) return
    const line = lines[active]
    if (!line?.words) return

    const host = stackRef.current?.querySelector<HTMLElement>(".lyric-now.is-now")
    const els = host ? Array.from(host.querySelectorAll<HTMLElement>(".w")) : []
    if (els.length === 0) return

    const words = line.words
    const total = line.text.length || 1
    const next = lines[active + 1]
    let raf = 0

    const tick = () => {
      const f = lineFillFraction(line, next?.time, getTime() + nudgeSeconds)
      for (let i = 0; i < els.length && i < words.length; i++) {
        const w = words[i]
        const s = w.start / total
        const e = Math.max(w.end, w.start + 1) / total
        // Below the word's start it is empty, past its end it is finished, and
        // between the two the sweep crosses it in proportion to its own length.
        const p = f <= s ? 0 : f >= e ? 100 : ((f - s) / (e - s)) * 100
        const el = els[i]
        const nextP = `${p.toFixed(1)}%`
        if (el.dataset.p !== nextP) {
          el.style.setProperty("--p", nextP)
          el.dataset.p = nextP
        }
        const done = f >= e
        if (el.classList.contains("is-done") !== done) el.classList.toggle("is-done", done)
      }
      raf = requestAnimationFrame(tick)
    }

    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [karaoke, reduced, active, lines, getTime, nudgeSeconds])

  // --- timing nudge -----------------------------------------------------
  const stepNudge = useCallback(
    (delta: number) => {
      setNudge((prev) => {
        const current = prev.forLines === lines ? prev.ms : 0
        const next = current + delta
        return {
          forLines: lines,
          ms: next > NUDGE_LIMIT_MS ? NUDGE_LIMIT_MS : next < -NUDGE_LIMIT_MS ? -NUDGE_LIMIT_MS : next,
        }
      })
    },
    [lines],
  )

  const nudgeLabel =
    nudgeMs === 0
      ? "0.00s"
      : `${nudgeMs > 0 ? "+" : "-"}${Math.abs(nudgeMs / 1000).toFixed(2)}s`

  // --- empty states -----------------------------------------------------
  if (!hasAny) {
    /*
     * A track with no lyrics shows one of three different things, because they
     * call for different actions. Collapsing them into a single "no lyrics"
     * message made a lookup still in flight look identical to a confirmed miss,
     * which is the one case where showing nothing actively misleads.
     */
    if (onlineStatus === "searching") {
      return (
        <div className="lyrics-empty" role="status">
          <span className="lyrics-lookup-dot" aria-hidden="true" />
          <p>Looking for lyrics</p>
          <span>Searching LRCLib by artist and title.</span>
        </div>
      )
    }

    if (onlineStatus === "not-found" || onlineStatus === "offline") {
      return (
        <div className="lyrics-empty">
          <Lyrics size={26} />
          <p>{onlineStatus === "offline" ? "Could not reach LRCLib" : "No lyrics found online"}</p>
          <span>
            {onlineStatus === "offline"
              ? (onlineDetail ?? "The lookup failed. Local lyrics still work with no connection.")
              : (onlineDetail ??
                "Nothing matched this artist and title closely enough to trust.")}
          </span>
          {onRetryOnline && onlineStatus === "not-found" && (
            <button className="lyrics-retry" onClick={onRetryOnline}>
              Search again
            </button>
          )}
        </div>
      )
    }

    return (
      <div className="lyrics-empty">
        <Lyrics size={26} />
        <p>No lyrics in this file</p>
        <span>Embed a LYRICS or SYNCEDLYRICS tag, or drop a matching .lrc beside it.</span>
        {/*
          Offered only when the setting is actually off and there is a way to turn
          it on from here. This is the difference between a user who never finds
          the feature and one who turns it on knowingly — and the cost of that
          privacy tradeoff has to be stated here, not only in Settings, because
          this is where someone actually wants it.
        */}
        {onEnableOnline && onlineEnabled === false && (
          <>
            <button className="lyrics-retry" onClick={onEnableOnline}>
              Look up lyrics online
            </button>
            <span className="lyrics-privacy">
              Sends this track&apos;s artist, title and album to lrclib.net. Turn it off any
              time in Settings.
            </span>
          </>
        )}
      </div>
    )
  }

  if (!synced) {
    /*
     * Unsynced lyrics have no "current" line to show, so there is nothing to
     * single out. A centred block of the text is the honest presentation: it is
     * readable, and it does not pretend to be following the song.
     */
    return (
      <div className="lyrics-plain-wrap">
        <div className="lyrics-plain selectable">
          {plainLines.map((line, i) => (
            <p key={i}>{line}</p>
          ))}
        </div>
      </div>
    )
  }

  // --- the synced view ---------------------------------------------------
  return (
    <div className="lyrics-wrap">
      <div className="lyrics-focus" ref={groupRef} onKeyDown={onLineKeys}>
        <div className="lyrics-stack" ref={stackRef}>
          {visible.map(({ line, offset }) => (
            <button
              /*
               * Keyed on the timestamp, so React carries the same DOM node from
               * "second line up" to "current" rather than destroying and rebuilding
               * it. The state change is then a CSS transition on a node that
               * already exists, which is where the motion comes from.
               *
               * This is also why there is no exit animation any more. There is no
               * outgoing line to fade: the line that *was* current is still the
               * same node, now carrying `is-next-1`. The whole transition is the
               * class changing, which removed a timer, a ref, an effect and a
               * duplicated DOM node.
               */
              key={`${line.time}-${line.text}`}
              data-offset={offset}
              data-time={line.time}
              className={`lyric-now is-${offset === 0 ? "now" : `next-${offset}`}${
                line.words ? " is-karaoke" : ""
              }`}
              tabIndex={offset === 0 ? 0 : -1}
              aria-current={offset === 0 || undefined}
              onClick={() => seekTo(line)}
              title={`Jump to ${formatDuration(line.time)}`}
            >
              {line.words ? (
                renderWords(line)
              ) : (
                line.text || "♪"
              )}
            </button>
          ))}

          {/*
            The instrumental marker. Three dots rather than a spinner, and the last
            one faint rather than absent, so the state reads as "waiting for the
            next line" and not as an empty box. It sits in the same slot the lines
            do, so nothing jumps when the song comes back in.
          */}
          {phase === "waiting" && (
            <div
              className="lyrics-waiting"
              role="status"
              aria-label="No lyrics here right now"
            >
              <i />
              <i />
              <i />
            </div>
          )}
        </div>
      </div>

      <div className="lyrics-foot">
        <span className={isPlaying ? "on" : ""}>{isPlaying ? "Following" : "Paused"}</span>

        {/*
          Always on screen rather than behind a menu. The user who needs this is
          looking at words running ahead of or behind the music, and a timing
          offset is the only explanation most of them will have — so it has to be
          one click away, in the pane, with its value visible.
        */}
        <div className="lyric-nudge" role="group" aria-label="Lyrics timing">
          <span className="lyric-nudge-label">Timing</span>
          <button
            className="nudge-btn"
            onClick={() => stepNudge(-NUDGE_STEP_MS)}
            aria-label="Show the lyrics 0.2 seconds later"
            title="Show the lyrics later. The file's own [offset:] tag is already applied; this is a further correction."
          >
            &minus;
          </button>
          <button
            className={`nudge-value ${nudgeSeconds === 0 ? "" : "shifted"}`}
            onClick={() => setNudge({ forLines: lines, ms: 0 })}
            aria-label={`Timing correction ${nudgeLabel}. Activate to reset.`}
            title="Resets to zero"
          >
            {nudgeLabel}
          </button>
          <button
            className="nudge-btn"
            onClick={() => stepNudge(NUDGE_STEP_MS)}
            aria-label="Show the lyrics 0.2 seconds earlier"
            title="Show the lyrics earlier"
          >
            +
          </button>
        </div>
      </div>
    </div>
  )
}
