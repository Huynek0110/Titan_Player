import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { LyricLine } from "@shared/types"
import { activeLineIndex, lineFillFraction } from "@shared/lyrics"
import { Lyrics } from "./Icons"
import "./LyricsPane.css"

interface LyricsPaneProps {
  lines: LyricLine[]
  plain?: string
  /**
   * Reads the live playhead. A function, not a value, on purpose: the fill runs
   * in a rAF loop and must sample the audio clock every frame. Reading a prop
   * fed by `timeupdate` would only fire about four times a second, turning the
   * sweep into a visible staircase.
   *
   * It is called from that loop and from nowhere else. Calling it during render
   * would make render depend on a clock that moves on its own, so the same props
   * would paint different output depending on when React got round to them.
   */
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

const AUTO_RESUME_MS = 2600
/** Seconds of stillness after which auto-scroll takes over again. */
const IDLE_BEFORE_RESUME = 4000

/**
 * Clock polling while nothing is playing.
 *
 * With the audio stopped the playhead cannot move, so the 60Hz loop is torn down
 * rather than left idling. It cannot be torn down *forever*, though: a seek can
 * arrive from outside this pane — the player bar's scrubber — and nothing
 * announces it, so the only way to follow one is to keep looking. The poll
 * therefore starts here and backs off on every frame that changes nothing, so a
 * paused pane with a synced track settles at about 1Hz rather than running two
 * 60Hz loops forever, and a pane that has just been seeked snaps straight back
 * to full rate.
 */
const PAUSED_POLL_MS = 200
/** Ceiling on the backoff: three doublings of the poll, so a paused pane with a
 *  synced track settles at about 1Hz and no further. */
const PAUSED_IDLE_STEPS = 3

/** One press of the timing nudge. LRC offsets are quoted in milliseconds and
 *  real-world drift is tens of milliseconds, so 200ms is a visible correction
 *  without overshooting past the words being corrected. */
const NUDGE_STEP_MS = 200
const NUDGE_LIMIT_MS = 5000

/**
 * A karaoke lyrics view.
 *
 * The fill is one CSS custom property written from an animation frame, consumed
 * by a `background-clip: text` gradient on an `inline` element. Because the
 * element is inline, the gradient wraps across line boxes, so a multi-line lyric
 * gets one continuous sweep with no per-word DOM and no reflow. React state and
 * CSS transitions are both deliberately avoided on that path: state would
 * re-render sixty times a second, and a transition would lag the audio clock.
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
  const scrollRef = useRef<HTMLDivElement>(null)
  const lineRefs = useRef<Map<number, HTMLButtonElement>>(new Map())
  const [active, setActive] = useState(-1)
  const [autoScroll, setAutoScroll] = useState(true)
  const idleTimer = useRef<number | null>(null)
  const pausedUntil = useRef(0)

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

  // --- active line and the sweep -----------------------------------------
  // One loop, not two. Polling the active index and writing the fill from
  // separate loops meant they could disagree by a frame at a line change, and
  // doubled the per-frame work for no benefit.
  //
  // The loop is keyed to `isPlaying`, not merely to `synced` and `active >= 0`.
  // Gating only on those left two 60Hz loops running indefinitely behind a paused
  // synced track, one of them writing the same `--fill` value sixty times a
  // second.
  useEffect(() => {
    if (!synced) return
    const list = lines
    let raf = 0
    let timer = 0
    let index = -2
    let written = -1
    let idle = 0

    /** True when this frame actually moved the display, which is what resets the
     *  paused poll back to full rate. */
    const frame = () => {
      // The nudge shifts everything, so it belongs where the clock is read
      // rather than inside the parser: the file's own `[offset:]` tag has already
      // been applied at scan time, and this is a second, user-driven correction
      // on top of it. Positive means the lyrics should appear earlier, matching
      // LRC's sign convention.
      const time = getTime() + nudgeSeconds
      const next = activeLineIndex(list, time)
      if (next !== index) {
        index = next
        // Reset the guard: the newly active element may be a recycled node
        // carrying a previous line's percentage.
        written = -1
        setActive(next)
        return true
      }
      if (next < 0) return false
      const element = lineRefs.current.get(next)
      if (!element) return false
      const percent = lineFillFraction(list[next], list[next + 1]?.time, time) * 100
      // Writing an unchanged value still costs a style recalculation on an
      // element whose background is clipped to text, so it is skipped.
      if (Math.abs(percent - written) < 0.05) return false
      written = percent
      element.style.setProperty("--fill", `${percent.toFixed(2)}%`)
      return true
    }

    // One immediate pass, so a seek made while paused shows straight away rather
    // than after the first poll.
    frame()

    if (isPlaying) {
      const tick = () => {
        frame()
        raf = requestAnimationFrame(tick)
      }
      raf = requestAnimationFrame(tick)
    } else {
      const tick = () => {
        idle = frame() ? 0 : Math.min(idle + 1, PAUSED_IDLE_STEPS)
        timer = window.setTimeout(tick, PAUSED_POLL_MS * 2 ** idle)
      }
      timer = window.setTimeout(tick, PAUSED_POLL_MS)
    }
    return () => {
      cancelAnimationFrame(raf)
      window.clearTimeout(timer)
    }
  }, [lines, synced, isPlaying, getTime, nudgeSeconds])

  // A line that stops being active keeps whatever fill it had reached, so clear
  // it. Without this, seeking backwards leaves every skipped line rendered at
  // full brightness instead of the dimmed upcoming state. `lines` is in the
  // dependency list because a new set of lines reuses the same DOM nodes when
  // the timestamps happen to line up.
  useEffect(() => {
    for (const [index, element] of lineRefs.current) {
      if (index !== active) element.style.removeProperty("--fill")
    }
  }, [active, lines])

  // --- auto-scroll ------------------------------------------------------
  const scrollToActive = useCallback((index: number) => {
    const container = scrollRef.current
    const element = lineRefs.current.get(index)
    if (!container || !element) return
    // `offsetTop` is measured against the nearest *positioned* ancestor, which
    // is the full-screen overlay rather than this scroll container. Subtracting
    // the container's own offset is what makes the line actually land 38% down.
    const target =
      element.offsetTop -
      container.offsetTop -
      container.clientHeight * 0.38 +
      container.scrollTop
    container.scrollTo({ top: Math.max(0, target), behavior: "smooth" })
  }, [])

  useEffect(() => {
    if (!autoScroll || active < 0) return
    if (Date.now() < pausedUntil.current) return
    scrollToActive(active)
  }, [active, autoScroll, scrollToActive])

  // Any manual interaction suspends auto-scroll, then it resumes on its own.
  const suspendAutoScroll = useCallback(() => {
    setAutoScroll(false)
    pausedUntil.current = Date.now() + AUTO_RESUME_MS
    if (idleTimer.current) window.clearTimeout(idleTimer.current)
    idleTimer.current = window.setTimeout(() => setAutoScroll(true), IDLE_BEFORE_RESUME)
  }, [])

  useEffect(() => {
    return () => {
      if (idleTimer.current) window.clearTimeout(idleTimer.current)
    }
  }, [])

  const setLineRef = useCallback((index: number, node: HTMLButtonElement | null) => {
    if (node) lineRefs.current.set(index, node)
    else lineRefs.current.delete(index)
  }, [])

  const plainLines = useMemo(
    () => (plain ? plain.split(/\r?\n/).map((t) => t.trim()).filter(Boolean) : []),
    [plain],
  )

  // --- interaction ------------------------------------------------------
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
   * Roving tab index over the lines.
   *
   * Forty focusable lines would be forty tab stops before the pane's own controls,
   * and it would bury the line actually being sung under thirty-nine others. Only
   * the active line is in the tab order, so tabbing into the pane lands on it —
   * which is the only way "the active line" is discoverable to a keyboard user at
   * all — and the arrow keys move between lines without seeking, since focus is
   * not playback.
   */
  const onLineKeys = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const key = event.key
      if (key !== "ArrowDown" && key !== "ArrowUp" && key !== "Home" && key !== "End") return
      const from = (event.target as HTMLElement).closest<HTMLElement>(".lyric-line")
      if (!from) return
      const index = Number(from.dataset.index)
      if (!Number.isFinite(index)) return
      const last = lines.length - 1
      let to = index
      if (key === "ArrowDown") to = index + 1
      else if (key === "ArrowUp") to = index - 1
      else if (key === "Home") to = 0
      else to = last
      if (to === index || to < 0 || to > last) return
      event.preventDefault()
      suspendAutoScroll()
      lineRefs.current.get(to)?.focus()
    },
    [lines.length, suspendAutoScroll],
  )

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
              Sends this track&apos;s artist, title and album to lrclib.net. Turn it off
              any time in Settings.
            </span>
          </>
        )}
      </div>
    )
  }

  if (!synced) {
    return (
      <div className="lyrics-plain-wrap" ref={scrollRef}>
        <div className="lyrics-plain selectable">
          {plainLines.map((line, i) => (
            <p key={i}>{line}</p>
          ))}
        </div>
      </div>
    )
  }

  // --- synced view ------------------------------------------------------
  // Before the first line is reached there is no active line to hang the tab stop
  // on, so the first line takes it.
  const tabbable = active >= 0 ? active : 0

  return (
    <div className="lyrics-wrap">
      <div
        className="lyrics-scroll"
        ref={scrollRef}
        onWheel={suspendAutoScroll}
        onPointerDown={suspendAutoScroll}
        onTouchMove={suspendAutoScroll}
        onKeyDown={onLineKeys}
      >
        <div className="lyrics-inner">
          {lines.map((line, index) => {
            const state =
              index === active ? "active" : index < active ? "past" : "future"

            return (
              <button
                key={`${line.time}-${index}`}
                data-index={index}
                ref={(node) => setLineRef(index, node)}
                className={`lyric-line ${state}`}
                tabIndex={index === tabbable ? 0 : -1}
                aria-current={index === active || undefined}
                onClick={() => seekTo(line)}
                title={`Jump to ${formatStamp(line.time)}`}
              >
                {/*
                 * The size ramp lives on this wrapper and not on `.lyric-text`.
                 * `transform` does not apply to non-replaced inline boxes, and
                 * the text has to stay `inline` so the fill gradient is
                 * positioned across the union of its fragments — that is what
                 * makes a wrapped lyric one continuous sweep. A block parent
                 * takes the transform, so neither constraint has to give.
                 */}
                <span className="lyric-scale">
                  <span className="lyric-text">{line.text || "♪"}</span>
                </span>
              </button>
            )
          })}
        </div>
      </div>

      <div className="lyrics-foot">
        <span className={autoScroll ? "on" : ""}>{isPlaying ? "Following" : "Paused"}</span>
        {!autoScroll && (
          <button className="pill" onClick={() => setAutoScroll(true)}>
            Resume follow
          </button>
        )}

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

function formatStamp(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, "0")}`
}
