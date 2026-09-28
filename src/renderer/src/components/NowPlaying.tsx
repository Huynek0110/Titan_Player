import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react"
import type { usePlayer } from "../lib/usePlayer"
import { formatDuration, formatBitrate, formatSampleRate, formatFileSize } from "../lib/format"
import Artwork from "./Artwork"
import { ChevronDown, Heart } from "./Icons"
import "./NowPlaying.css"

interface NowPlayingProps {
  track: {
    id: string
    title: string
    artist: string
    album: string
    year: number | null
    genre: string[]
    duration: number
    bitrate: number | null
    sampleRate: number | null
    channels: number | null
    lossless: boolean
    hasArtwork: boolean
    fileSize: number
    lyrics: { source: string }
  } | null
  player: ReturnType<typeof usePlayer>
  isFavourite: boolean
  onToggleFavourite: () => void
  onClose: () => void
  onOpenLyricsFile: () => void
  onReveal: () => void
  /** The lyrics pane, mounted into the info column. */
  children?: ReactNode
}

/** Width of the art column, fixed so the resize maths has one known term. */
const ART_W = 420
/** Widest and narrowest the lyrics column is allowed to be. */
const INFO_MIN = 340
const INFO_MAX = 860
const INFO_DEFAULT = 620
/** How far one arrow press on the splitter moves the column. */
const SPLIT_STEP = 24

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ")

/**
 * The full-screen view. Artwork and lyrics sit side by side rather than
 * switching, which is the layout Spotify removed from its desktop app in early
 * 2026 and drew heavy backlash for.
 */
export default function NowPlaying({
  track,
  player,
  isFavourite,
  onToggleFavourite,
  onClose,
  onOpenLyricsFile,
  onReveal,
  children,
}: NowPlayingProps) {
  const { state } = player
  const artWrapRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const restoreRef = useRef<HTMLElement | null>(null)
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const [showDetails, setShowDetails] = useState(false)
  /** Requested width of the lyrics column, or null for the default. */
  const [requested, setRequested] = useState<number | null>(null)
  /** Room the lyrics column actually has, measured rather than assumed. */
  const [avail, setAvail] = useState(Number.POSITIVE_INFINITY)

  // --- dialog behaviour -------------------------------------------------
  // This is a full-screen overlay over an application that is still mounted
  // behind it, so without the next three things a keyboard user can tab straight
  // out of the dialog and into the library, and a screen reader's cursor can
  // walk the whole app while the modal claims to be modal.
  useLayoutEffect(() => {
    const shell = document.querySelector<HTMLElement>(".app-shell")
    const alreadyInert = shell?.inert ?? false
    // `inert` removes the subtree from the tab order, the accessibility tree and
    // hit testing in one property. Restoring the previous value rather than
    // forcing false keeps this composable with anything else that inerted it.
    if (shell) shell.inert = true

    const previous = document.activeElement
    // Never record something inside the dialog as the thing to come back to.
    // Besides being pointless, it defeats the double-invoked effects React runs
    // in development: the second mount would otherwise "restore" focus to the
    // close button that the first mount had just focused.
    restoreRef.current =
      previous instanceof HTMLElement && !closeRef.current?.contains(previous)
        ? previous
        : null
    // Focus the close control, not the dialog: it is the first thing a sighted
    // user wants and the only child guaranteed to be focusable.
    closeRef.current?.focus()

    return () => {
      if (shell) shell.inert = alreadyInert
      restoreRef.current?.focus()
    }
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose()
        return
      }
      if (event.key !== "Tab") return
      const root = rootRef.current
      if (!root) return
      // Queried per press rather than cached: the tab order inside the dialog
      // changes as panels open and close, and a stale list would trap focus on
      // an element that is no longer there.
      const focusable = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (node) => node.offsetWidth > 0 || node.offsetHeight > 0,
      )
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const current = document.activeElement
      const outside = !root.contains(current)
      if (event.shiftKey) {
        if (current === first || outside) {
          event.preventDefault()
          last.focus()
        }
      } else if (current === last || outside) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  // --- parallax drift ---------------------------------------------------
  // The clock arrives through a ref rather than as a dependency. Depending on
  // `state.time` tore this loop down and rebuilt it about four times a second,
  // and each new closure captured a clock value up to 250ms stale, so the sweep
  // was a 4Hz staircase; the `transition: transform` on the artwork then chased
  // that staircase a further frame behind. Persistently reading a ref, with no
  // transition, gives one smooth sweep — and the residual 4Hz sampling of the
  // clock is sub-pixel here, because the whole drift is 8px over a whole track.
  const clockRef = useRef({ time: 0, duration: 0 })
  useEffect(() => {
    clockRef.current.time = state.time
    clockRef.current.duration = state.duration
  }, [state.time, state.duration])

  useEffect(() => {
    const node = artWrapRef.current
    if (!node || !state.isPlaying) return
    let raf = 0
    const tick = () => {
      const { time, duration } = clockRef.current
      const span = duration || 1
      const t = Math.min(1, time / span)
      // A gentle sine sweep rather than a linear map, so it never feels robotic.
      node.style.setProperty("--drift", `${Math.sin(t * Math.PI * 2) * 8}px`)
      node.style.setProperty("--drift-y", `${Math.cos(t * Math.PI * 2) * 6}px`)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [state.isPlaying])

  // --- lyrics column width ----------------------------------------------
  // Measured on layout and on resize instead of assumed, so the clamp is
  // honest and `aria-valuenow` reports the width the column really has rather
  // than the width it was asked for. A layout effect, not a passive one: at the
  // 960px minimum window the default width is wider than the space available, so
  // a post-paint measurement would show one frame of overflow.
  useLayoutEffect(() => {
    const measure = () => {
      const body = bodyRef.current
      if (!body) return
      const style = getComputedStyle(body)
      const inner =
        body.clientWidth -
        parseFloat(style.paddingLeft) -
        parseFloat(style.paddingRight)
      const gap = parseFloat(style.columnGap) || 0
      setAvail(Math.max(0, inner - ART_W - gap * 2))
    }
    measure()
    window.addEventListener("resize", measure)
    return () => window.removeEventListener("resize", measure)
  }, [])

  const minInfo = Math.min(INFO_MIN, avail)
  const maxInfo = Math.max(minInfo, Math.min(INFO_MAX, avail))
  const infoWidth = Math.round(
    requested === null ? INFO_DEFAULT : Math.max(minInfo, Math.min(maxInfo, requested)),
  )

  const onSplitPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      // From the clamped width, not the raw request, so grabbing the handle
      // after a window resize continues from where the column actually is.
      dragRef.current = { startX: event.clientX, startWidth: infoWidth }
      event.currentTarget.setPointerCapture(event.pointerId)
      // A drag that selects text, or that flips the cursor back to a text caret
      // the moment the pointer leaves the 26px handle, feels broken.
      document.body.classList.add("np-resizing")
    },
    [infoWidth],
  )

  const onSplitPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag) return
    setRequested(drag.startWidth + (event.clientX - drag.startX))
  }, [])

  const endSplitDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return
    dragRef.current = null
    // Guarded: releasing a capture the browser has already dropped throws
    // NotFoundError, which is exactly what happens if the pointer leaves the
    // window mid-drag.
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    document.body.classList.remove("np-resizing")
  }, [])

  // Escape closes this view mid-drag, and the matching pointerup never arrives,
  // so the drag class is cleared on unmount too. Left behind it would keep text
  // selection dead in the rest of the app.
  useEffect(() => {
    return () => document.body.classList.remove("np-resizing")
  }, [])

  const onSplitKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const step = SPLIT_STEP
      let next: number | null = null
      if (event.key === "ArrowRight") next = infoWidth + step
      else if (event.key === "ArrowLeft") next = infoWidth - step
      else if (event.key === "PageDown") next = infoWidth + step * 4
      else if (event.key === "PageUp") next = infoWidth - step * 4
      else if (event.key === "Home") next = minInfo
      else if (event.key === "End") next = maxInfo
      if (next === null) return
      // Stopped here rather than allowed to bubble: the app's global shortcuts
      // ignore anything already default-prevented, and Shift+Arrow is seek.
      event.preventDefault()
      setRequested(next)
    },
    [infoWidth, minInfo, maxInfo],
  )

  if (!track) return null

  const facts: Array<[string, string]> = [
    ["Album", track.album],
    ...(track.year ? ([["Year", String(track.year)]] as Array<[string, string]>) : []),
    ...(track.genre.length ? ([["Genre", track.genre.join(", ")]] as Array<[string, string]>) : []),
    ["Duration", formatDuration(track.duration)],
    ["Quality", `${track.lossless ? "Lossless" : "Lossy"}${formatBitrate(track.bitrate) ? ` · ${formatBitrate(track.bitrate)}` : ""}`],
    ...(track.sampleRate ? ([["Sample rate", formatSampleRate(track.sampleRate)!]] as Array<[string, string]>) : []),
    ...(track.channels ? ([["Channels", track.channels === 1 ? "Mono" : track.channels === 2 ? "Stereo" : `${track.channels} channels`]] as Array<[string, string]>) : []),
    ["Size", formatFileSize(track.fileSize)],
    ["Lyrics", track.lyrics.source === "none" ? "Not tagged" : "Embedded"],
  ]

  const gridStyle = {
    "--np-info": `${infoWidth}px`,
  } as CSSProperties

  return (
    <section
      className="nowplaying"
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Now playing: ${track.title}`}
    >
      <div className="nowplaying-top">
        <button
          className="icon-btn"
          onClick={onClose}
          ref={closeRef}
          aria-label="Close now playing"
        >
          <ChevronDown size={22} />
        </button>
        <span className="nowplaying-source truncate">Playing from library</span>
        <button
          className={`icon-btn ${isFavourite ? "on" : ""}`}
          onClick={onToggleFavourite}
          aria-label="Toggle favourite"
        >
          <Heart size={18} filled={isFavourite} />
        </button>
      </div>

      <div className="nowplaying-body" ref={bodyRef} style={gridStyle}>
        <div className="nowplaying-art-col">
          <div className="nowplaying-art" ref={artWrapRef}>
            <Artwork
              trackId={track.id}
              hasArtwork={track.hasArtwork}
              alt={track.title}
              size={ART_W}
              seed={track.title}
            />
            <div className="nowplaying-art-shadow" aria-hidden="true" />
          </div>

          {/*
            Not three identical pills. "Load .lrc" is the one that rescues a
            track whose lyrics are missing or wrong, so it is the only one that
            gets a surface; the other two are file-management verbs and stay
            quiet until hovered. The divider says the first is a different kind
            of action from the pair after it.
          */}
          <div className="nowplaying-actions">
            <button
              className="np-action lead"
              onClick={onOpenLyricsFile}
              title="Open an .lrc file to replace these lyrics"
            >
              Load .lrc
            </button>
            <span className="np-action-divider" aria-hidden="true" />
            <button
              className="np-action"
              onClick={onReveal}
              title="Show the file in Explorer"
            >
              Show file
            </button>
            <button
              className="np-action"
              onClick={() => setShowDetails((v) => !v)}
              // `aria-pressed` rather than `aria-expanded`: this is a toggle that
              // changes its own label, which is the pressed-button pattern, and
              // `aria-expanded` on a button that controls no single container
              // would misrepresent it.
              aria-pressed={showDetails}
            >
              {showDetails ? "Hide details" : "Details"}
            </button>
          </div>

          {showDetails && (
            <dl className="nowplaying-facts">
              {facts.map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd className="selectable">{value}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>

        <div
          className="nowplaying-split"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the lyrics pane"
          aria-valuemin={Math.round(minInfo)}
          aria-valuemax={Math.round(maxInfo)}
          aria-valuenow={infoWidth}
          tabIndex={0}
          title="Drag, or use the arrow keys, to change how much room the lyrics get"
          onPointerDown={onSplitPointerDown}
          onPointerMove={onSplitPointerMove}
          onPointerUp={endSplitDrag}
          onPointerCancel={endSplitDrag}
          onKeyDown={onSplitKeyDown}
        >
          <span className="nowplaying-split-grip" />
        </div>

        <div className="nowplaying-info">
          <h1 className="nowplaying-title">{track.title}</h1>
          <p className="nowplaying-artist">{track.artist}</p>
          {track.album && <p className="nowplaying-album">{track.album}</p>}
          {children}
        </div>
      </div>
    </section>
  )
}
