import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { LyricLine } from "@shared/types"
import { activeLineIndex } from "@shared/lyrics"
import { Lyrics } from "./Icons"
import "./LyricsPane.css"

interface LyricsPaneProps {
  lines: LyricLine[]
  plain?: string
  /** Current playback position in seconds. */
  time: number
  isPlaying: boolean
  onSeek: (seconds: number) => void
  hasAny: boolean
}

const AUTO_RESUME_MS = 2600
/** Seconds of stillness after which auto-scroll takes over again. */
const IDLE_BEFORE_RESUME = 4000

/**
 * A karaoke lyrics view.
 *
 * The fill is one CSS custom property written from a requestAnimationFrame
 * loop, consumed by a `background-clip: text` gradient on an `inline` element.
 * Because the element is inline, the gradient wraps across line boxes, so a
 * multi-line lyric gets one continuous sweep with no per-word DOM and no
 * reflow. React state and CSS transitions are both deliberately avoided here:
 * state would re-render 60 times a second, and a transition would lag the
 * audio clock.
 */
export default function LyricsPane({
  lines,
  plain,
  time,
  isPlaying,
  onSeek,
  hasAny,
}: LyricsPaneProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const lineRefs = useRef<Map<number, HTMLButtonElement>>(new Map())
  const [active, setActive] = useState(-1)
  const [autoScroll, setAutoScroll] = useState(true)
  const idleTimer = useRef<number | null>(null)
  const pausedUntil = useRef(0)

  const synced = lines.length > 0

  // --- which line is active ---------------------------------------------
  useEffect(() => {
    if (!synced) return
    const index = activeLineIndex(lines, time)
    if (index !== active) setActive(index)
  }, [time, lines, synced, active])

  // --- the sweep --------------------------------------------------------
  // Writes `--fill` on the active line only. Writing to a single element keeps
  // this to one style mutation per frame instead of one per line.
  useEffect(() => {
    if (!synced || active < 0) return
    const element = lineRefs.current.get(active)
    if (!element) return

    let raf = 0
    const tick = () => {
      const start = lines[active].time
      const next = lines[active + 1]?.time
      // Hold the line fully filled if there is no following timestamp to
      // interpolate towards, rather than snapping back to empty.
      const span = next !== undefined ? Math.max(0.35, next - start) : 6
      const progress = Math.max(0, Math.min(1, (time - start) / span))
      element.style.setProperty("--fill", `${(progress * 100).toFixed(2)}%`)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [active, lines, time, synced])

  // --- auto-scroll ------------------------------------------------------
  const scrollToActive = useCallback(
    (index: number) => {
      const container = scrollRef.current
      const element = lineRefs.current.get(index)
      if (!container || !element) return
      // Centre the active line in the viewport, which reads better than
      // scrolling it to the very top.
      const target = element.offsetTop - container.clientHeight * 0.38
      container.scrollTo({ top: Math.max(0, target), behavior: "smooth" })
    },
    [],
  )

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

  // --- empty states -----------------------------------------------------
  if (!hasAny) {
    return (
      <div className="lyrics-empty">
        <Lyrics size={26} />
        <p>No lyrics in this file</p>
        <span>Embed a LYRICS or SYNCEDLYRICS tag, or drop a matching .lrc beside it.</span>
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
  return (
    <div className="lyrics-wrap">
      <div
        className="lyrics-scroll"
        ref={scrollRef}
        onWheel={suspendAutoScroll}
        onPointerDown={suspendAutoScroll}
        onTouchMove={suspendAutoScroll}
      >
        <div className="lyrics-inner">
          {lines.map((line, index) => {
            const state =
              index === active ? "active" : index < active ? "past" : "future"
            // Within 4s of the next line, treat the following line as "next" so
            // the eye is led there slightly early.
            const upcoming =
              lines[index + 1] !== undefined && lines[index + 1].time - time < 4

            return (
              <button
                key={`${line.time}-${index}`}
                ref={(node) => setLineRef(index, node)}
                className={`lyric-line ${state} ${upcoming && index === active ? "soon" : ""}`}
                onClick={() => onSeek(line.time)}
                title={`Jump to ${formatStamp(line.time)}`}
              >
                <span className="lyric-text">{line.text || "♪"}</span>
                {line.translation && <span className="lyric-translation">{line.translation}</span>}
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
      </div>
    </div>
  )
}

function formatStamp(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, "0")}`
}
