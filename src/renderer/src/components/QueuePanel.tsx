import { useEffect, useRef, useState } from "react"
import { useStore } from "../state/store"
import { formatDuration } from "../lib/format"
import Artwork from "./Artwork"
import { Close, Play, Queue, Trash } from "./Icons"
import { useGlassSurface } from "../lib/glass"
import "./QueuePanel.css"

/**
 * How long the panel stays mounted after it is dismissed. Matches the exit
 * transition in QueuePanel.css; if the two disagree, either the cut reappears or
 * an invisible panel sits over the library swallowing clicks.
 */
const EXIT_MS = 170

/** The play queue, as a right-hand drawer over the library. */
export default function QueuePanel() {
  const { queueTracks, queueIndex, showQueue, setShowQueue, jumpTo, removeFromQueue, clearQueue } =
    useStore()

  /*
   * Frosted, but deliberately *not* refracting.
   *
   * This is the one surface in the app that is both filtered and moving over
   * content that is itself moving: the drawer slides in over the library list,
   * so its backdrop genuinely changes on every frame of the slide, and a backdrop
   * filter is re-evaluated against whatever is behind the element each time. A
   * blur is one pass and it was already here; a displacement is a second pass
   * that samples a map, and with the chromatic aberration on top of it that is
   * three.
   *
   * Measured during a window-resize sweep with the drawer open, that was worth
   * roughly three dropped frames in a hundred-and-thirty, on top of the noise the
   * sweep produces on its own — and the same surfaces with the glass switched off
   * entirely still dropped four. Small, real, and on the one surface where the
   * effect is least visible at rest: frosted glass over a scrolling list already
   * reads as glass, because the list is what makes the blur worth having.
   *
   * The rim and the fill are unchanged, so it still looks like a card.
   */
  const panelRef = useGlassSurface<HTMLDivElement>({
    displacement: 0,
    extra: "blur(28px) saturate(1.6)",
    flat: 0.08,
    chromatic: false,
  })

  /*
   * Mounted and open are separate. Unmounting on the same render that cleared
   * `showQueue` meant the panel animated in over 240ms and disappeared in 0ms,
   * so every close was a hard cut — the eye has already committed to the
   * transition by the time it starts, and a missing second half reads as a
   * glitch rather than as speed.
   */
  const [mounted, setMounted] = useState(showQueue)
  const [open, setOpen] = useState(false)
  const exitTimer = useRef<number | null>(null)

  useEffect(() => {
    if (showQueue) {
      if (exitTimer.current) {
        window.clearTimeout(exitTimer.current)
        exitTimer.current = null
      }
      setMounted(true)
      // A frame later, so the panel is committed to the DOM in its closed state
      // before the class flips. Both in the same frame and the transition has no
      // starting value to animate from, so it snaps open.
      const raf = requestAnimationFrame(() => setOpen(true))
      return () => {
        cancelAnimationFrame(raf)
      }
    }
    if (!mounted) return
    setOpen(false)
    exitTimer.current = window.setTimeout(() => {
      exitTimer.current = null
      setMounted(false)
    }, EXIT_MS)
    return () => {
      if (exitTimer.current) {
        window.clearTimeout(exitTimer.current)
        exitTimer.current = null
      }
    }
  }, [showQueue, mounted])

  /*
   * Two ways out. A drawer that can only be closed by hitting one small icon is
   * a drawer people get stuck in, and the queue sits directly over the search
   * box and the header controls.
   *
   * Gated on `showQueue`, not `mounted` or `open`, so both listeners are gone the
   * instant the close is requested. Keying them to the mounted state would let
   * the outside pointerdown of the closing click land a second time during the
   * 170ms exit.
   *
   * The `q` shortcut deliberately does not appear here: App owns the toggle, and
   * a second handler inverting the same flag would fight it.
   */
  useEffect(() => {
    if (!showQueue) return

    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.tagName === "INPUT" || target?.isContentEditable) return
      if (event.key === "Escape") {
        event.preventDefault()
        setShowQueue(false)
      }
    }
    const onPointerDown = (event: PointerEvent) => {
      // Anything outside the panel dismisses it. A data attribute keeps the check
      // independent of class names. The click that follows is allowed through to
      // whatever is underneath, which is deliberate: the common reason to reach
      // past a drawer is to pick a different track, and swallowing that would
      // mean the second click. It is also why there is no scrim — see the note in
      // QueuePanel.css.
      const target = event.target as HTMLElement | null
      if (target?.closest("[data-queue-panel]")) return
      setShowQueue(false)
    }

    window.addEventListener("keydown", onKey)
    // Capture, so this runs before the row handlers underneath.
    window.addEventListener("pointerdown", onPointerDown, true)
    return () => {
      window.removeEventListener("keydown", onKey)
      window.removeEventListener("pointerdown", onPointerDown, true)
    }
  }, [showQueue, setShowQueue])

  if (!mounted) return null

  const upcoming = queueTracks.slice(queueIndex + 1)
  const playing = queueIndex >= 0 ? queueTracks[queueIndex] : undefined

  return (
    <aside
      id="queue-panel"
      ref={panelRef}
      className={`queue ${open ? "open" : ""}`}
      data-queue-panel="true"
      aria-label="Play queue"
      aria-hidden={!open}
    >
      <header className="queue-head">
        <Queue size={17} />
        <h2 className="queue-title">Queue</h2>
        <span className="queue-count tabular">
          {queueTracks.length}
          {/* Spelled out rather than put in an `aria-label`. A bare span has no
              role, and naming a role-less element is not reliably surfaced —
              some readers drop the visible text and read only the label. */}
          <span className="queue-sr"> tracks queued</span>
        </span>
        {queueTracks.length > 0 && (
          <button className="icon-btn" onClick={clearQueue} aria-label="Clear queue" title="Clear queue">
            <Trash size={15} />
          </button>
        )}
        <button
          className="queue-close"
          onClick={() => setShowQueue(false)}
          aria-label="Close queue"
          title="Close queue  (Esc)"
        >
          <Close size={17} />
        </button>
      </header>

      <div className="queue-body">
        {queueTracks.length === 0 ? (
          <div className="queue-empty">
            <Queue size={26} />
            <p className="queue-empty-title">Your queue is empty</p>
            <p className="queue-empty-hint">
              Play a track from the library, or press <kbd>Play all</kbd> above it, and it will be waiting
              here.
            </p>
          </div>
        ) : (
          <>
            {playing && (
              <>
                <p className="queue-label">Now playing</p>
                <QueueRow
                  track={playing}
                  index={queueIndex}
                  current
                  onPlay={() => jumpTo(queueIndex)}
                  onRemove={() => removeFromQueue(queueIndex)}
                />
              </>
            )}

            {upcoming.length > 0 && <p className="queue-label">Next up</p>}
            {upcoming.map((track, i) => {
              const index = queueIndex + 1 + i
              return (
                <QueueRow
                  key={track.id}
                  track={track}
                  index={index}
                  onPlay={() => jumpTo(index)}
                  onRemove={() => removeFromQueue(index)}
                />
              )
            })}
          </>
        )}
      </div>
    </aside>
  )
}

function QueueRow({
  track,
  index,
  current = false,
  onPlay,
  onRemove,
}: {
  track: { id: string; title: string; artist: string; duration: number; hasArtwork: boolean }
  index: number
  current?: boolean
  onPlay: () => void
  onRemove: () => void
}) {
  return (
    <div className={`queue-row ${current ? "current" : ""}`}>
      {/*
       * One cell, two occupants, swapped by CSS rather than by a conditional.
       * Conditionally rendering the play glyph would change the cell's width,
       * and the row's number column is the only thing keeping these rows aligned
       * with each other.
       */}
      <span className="queue-slot">
        <span className="queue-index tabular">{index + 1}</span>
        <Play size={12} className="queue-nowplay" />
      </span>

      <Artwork
        trackId={track.id}
        hasArtwork={track.hasArtwork}
        alt={track.title}
        size={34}
        seed={track.title}
      />

      {/* Click only. It also had `onDoubleClick` bound to the same handler, so a
          double-click played the track twice and the second play clobbered the
          first — two queue writes and two `play()` calls for one gesture. */}
      <button
        className="queue-text"
        onClick={onPlay}
        aria-current={current ? "true" : undefined}
        title="Play now"
      >
        <span className="truncate">{track.title}</span>
        <span className="truncate queue-sub">{track.artist}</span>
      </button>

      <span className="queue-dur tabular">{formatDuration(track.duration)}</span>

      <button
        className="icon-btn queue-x"
        onClick={onRemove}
        aria-label={`Remove ${track.title} from the queue`}
        title="Remove from queue"
      >
        <Close size={13} />
      </button>
    </div>
  )
}
