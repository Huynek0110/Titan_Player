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
import { useGlassSurface } from "../lib/glass"
import Artwork from "./Artwork"
import {
  ChevronDown,
  Heart,
  Library,
  Next,
  Pause,
  Play,
  Prev,
  Queue,
  Repeat,
  RepeatOne,
  Shuffle,
  Volume,
  VolumeLow,
  VolumeMute,
} from "./Icons"
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
  /** The lyrics pane, mounted into the right-hand column. */
  children?: ReactNode

  /*
   * Transport state the player hook does not carry itself. All optional, so
   * App.tsx can adopt them incrementally and the view still renders without
   * them — a control with no state is worse than no control, so each one is
   * omitted rather than shown in a state it cannot truthfully display.
   */
  shuffled?: boolean
  repeat?: "off" | "all" | "one"
  queueOpen?: boolean
  onToggleQueue?: () => void
  /** Seeked by the inline bar, in seconds from the start of the track. */
  onSeek?: (seconds: number) => void
  /**
   * Swap the right-hand column between the lyrics pane and the editor.
   *
   * `aria-pressed` rather than `aria-expanded`: the label changes with the state
   * ("Edit lyrics" / "Done editing"), which is the pressed-button pattern, and
   * there is no single container here for `aria-expanded` to describe.
   */
  onToggleLyricsEditor?: () => void
  lyricsEditing?: boolean
  /** What kind of collection is playing, for the "Playing from" eyebrow. */
  source?: "library" | "playlist" | "album" | "artist" | "favourites"
}

/** Width of the art column, fixed so the resize maths has one known term. */
const ART_W = 420
/**
 * Widest and narrowest the lyrics column is allowed to be.
 *
 * The floor is what a single unreadable line needs; the ceiling is generous
 * because the column sits against the right edge of the window and anything wider
 * would start pushing the two halves together.
 */
const INFO_MIN = 360
const INFO_MAX = 1100
/**
 * The default. Sized for the lyric font rather than for the artwork: a 40px line
 * wraps after about six words in a 620px column, which turned one readable
 * sentence into a two-line block.
 */
const INFO_DEFAULT = 780
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
 * The full-screen view.
 *
 * Artwork and lyrics sit side by side rather than switching, which is the layout
 * Spotify removed from its desktop app in early 2026 and drew heavy backlash for.
 * The cover is also blown up and blurred behind everything, so the whole window
 * is the colour of the record rather than a dark panel with a picture on it.
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
  shuffled = false,
  repeat = "off",
  queueOpen = false,
  onToggleQueue,
  onSeek,
  onToggleLyricsEditor,
  lyricsEditing = false,
  source,
}: NowPlayingProps) {
  const { state, toggle, previous, next, seek, toggleShuffle, cycleRepeat, setVolume, toggleMute } =
    player
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
  // transition, gives one smooth sweep.
  //
  // Only the crisp artwork drifts. The blurred backdrop is a full-window layer,
  // and moving it would re-run a large Gaussian blur on every frame of the
  // animation — the same mistake that made window resizing stutter.
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
      /*
       * The middle track is flexible (`minmax(48px, 1fr)`), so what is available
       * for the lyrics is what is left after the artwork, the gaps and that
       * track's minimum. Reading the track's real width rather than assuming the
       * old fixed-48px value keeps `aria-valuemax` honest if the minimum is ever
       * changed in the stylesheet.
       */
      const tracks = style.gridTemplateColumns.split(" ").map(parseFloat)
      const middle = tracks[1] || 48
      setAvail(Math.max(0, inner - ART_W - middle - gap * 2))
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
      let nextWidth: number | null = null
      if (event.key === "ArrowRight") nextWidth = infoWidth + step
      else if (event.key === "ArrowLeft") nextWidth = infoWidth - step
      else if (event.key === "PageDown") nextWidth = infoWidth + step * 4
      else if (event.key === "PageUp") nextWidth = infoWidth - step * 4
      else if (event.key === "Home") nextWidth = minInfo
      else if (event.key === "End") nextWidth = maxInfo
      if (nextWidth === null) return
      // Stopped here rather than allowed to bubble: the app's global shortcuts
      // ignore anything already default-prevented, and Shift+Arrow is seek.
      event.preventDefault()
      setRequested(nextWidth)
    },
    [infoWidth, minInfo, maxInfo],
  )

  // --- inline seek bar ---------------------------------------------------
  /*
   * A second, self-contained slider in the left column rather than a mirror of
   * the one in the player bar. A reflected value cannot be dragged and would go
   * stale the moment the two disagreed, so this owns its own drag and reports the
   * target upward. While dragging, the displayed position is the pointer's, not
   * the track's — otherwise the thumb fights the mouse.
   */
  const seekTrackRef = useRef<HTMLDivElement>(null)
  const [seekDrag, setSeekDrag] = useState<number | null>(null)

  // Read through the optional because these hooks run before the `!track` guard:
  // a hook that is called conditionally breaks the rules of hooks, and the guard
  // has to stay below all of them.
  const liveDuration = state.duration || track?.duration || 0
  const shown = seekDrag ?? (liveDuration > 0 ? Math.min(1, state.time / liveDuration) : 0)

  const seekFromPointer = useCallback(
    (clientX: number) => {
      const el = seekTrackRef.current
      if (!el || liveDuration <= 0) return
      const rect = el.getBoundingClientRect()
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
      setSeekDrag(ratio)
    },
    [liveDuration],
  )

  const commitSeek = useCallback(
    (ratio: number) => {
      const target = ratio * liveDuration
      // Seek both the element and the store, so the queue panel and the player
      // bar agree with this bar immediately rather than on the next tick.
      seek(target)
      onSeek?.(target)
    },
    [liveDuration, seek, onSeek],
  )

  const onSeekKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (liveDuration <= 0) return
      const step = event.shiftKey ? 30 : 5
      let to: number | null = null
      if (event.key === "ArrowRight" || event.key === "ArrowUp") to = state.time + step
      else if (event.key === "ArrowLeft" || event.key === "ArrowDown") to = state.time - step
      else if (event.key === "Home") to = 0
      else if (event.key === "End") to = liveDuration
      if (to === null) return
      event.preventDefault()
      commitSeek(Math.max(0, Math.min(1, to / liveDuration)))
    },
    [state.time, liveDuration, commitSeek],
  )

  if (!track) return null

  const facts: Array<[string, string]> = [
    ["Album", track.album],
    ...(track.year ? ([["Year", String(track.year)]] as Array<[string, string]>) : []),
    ...(track.genre.length ? ([["Genre", track.genre.join(", ")]] as Array<[string, string]>) : []),
    ["Duration", formatDuration(track.duration)],
    [
      "Quality",
      `${track.lossless ? "Lossless" : "Lossy"}${formatBitrate(track.bitrate) ? ` · ${formatBitrate(track.bitrate)}` : ""}`,
    ],
    ...(track.sampleRate
      ? ([["Sample rate", formatSampleRate(track.sampleRate)!]] as Array<[string, string]>)
      : []),
    ...(track.channels
      ? ([
          [
            "Channels",
            track.channels === 1
              ? "Mono"
              : track.channels === 2
                ? "Stereo"
                : `${track.channels} channels`,
          ],
        ] as Array<[string, string]>)
      : []),
    ["Size", formatFileSize(track.fileSize)],
    [
      "Lyrics",
      track.lyrics.source === "none"
        ? "Not tagged"
        : track.lyrics.source === "online"
          ? "From LRCLib"
          : "Embedded",
    ],
  ]

  /*
   * "Playing from" names the kind of collection, and the value names it. The
   * kind comes from the caller because only the app knows whether the queue was
   * built from a playlist, an album view or the whole library — the renderer
   * cannot tell from the track alone, and guessing would be wrong whenever an
   * album happened to be playing.
   */
  const sourceKind = source ?? "library"
  const sourceLabel = track.album.trim() || "Your library"
  const VolumeGlyph = state.muted || state.volume === 0 ? VolumeMute : state.volume < 0.5 ? VolumeLow : Volume

  const coverUrl = track.hasArtwork ? window.titan.coverUrl(track.id, true) : null

  /*
   * Liquid Glass on the transport dock.
   *
   * It had the `.glass` class, which is a blur and a fill, and no refraction —
   * `scripts/probe-glass-surfaces.mjs` is what surfaced that, by failing this
   * surface while the other three passed. A frosted panel and a refracting one
   * are different materials, and only the second one is the thing being asked for.
   */
  const dockRef = useGlassSurface<HTMLDivElement>({
    displacement: -50,
    extra: "blur(28px) saturate(1.6)",
    flat: 0.07,
    chromatic: false,
  })

  /*
   * The lyric type size, derived from the column width rather than fixed.
   *
   * Every line is this size — the current one and the two below it — and the
   * hierarchy comes from scale and blur instead. That only works if the size is
   * chosen so a line is as unlikely to wrap as possible, because a line that
   * wraps takes two rows and the block's rhythm changes with the lyric.
   *
   * The column is whatever is left after a 420px cover, the volume rail and the
   * gaps, so it is far narrower in a small window than a wide one. Roughly 40
   * characters fit on one row at about 0.55em average advance for this face,
   * which is where the divisor comes from. Clamped so a very narrow window still
   * gives a readable lyric and a wide one stops growing.
   */
  const lyricSize = Math.round(Math.max(26, Math.min(38, infoWidth / 40 / 0.55)))
  const gridStyle = {
    "--np-info": `${infoWidth}px`,
    "--lyric-size": `${lyricSize}px`,
  } as CSSProperties

  const RepeatGlyph = repeat === "one" ? RepeatOne : Repeat
  const repeatTitle =
    repeat === "one" ? "Repeat one" : repeat === "all" ? "Repeat all" : "Repeat off"

  return (
    <section
      className="nowplaying"
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Now playing: ${track.title}`}
    >
      {/*
        The cover, blown up and blurred, behind everything.

        Scaled past the viewport so the blur cannot sample the window edge and
        produce a hard bright rim. Static on purpose: this is a full-window
        `filter: blur()`, and animating it would re-run that blur every frame.
      */}
      {coverUrl && (
        <div
          className="nowplaying-bg"
          aria-hidden="true"
          style={{ backgroundImage: `url("${coverUrl}")` }}
        />
      )}
      <div className="nowplaying-scrim" aria-hidden="true" />

      {/*
        The floating control island. The reference layout puts repeat and close
        together in a detached card rather than in a full-width strip, which keeps
        the top of the window free for the artwork and stops a row of chrome from
        cutting across the cover.
      */}
      <div className="nowplaying-dock glass" ref={dockRef}>
        <button
          className={`icon-btn ${repeat !== "off" ? "on" : ""}`}
          onClick={cycleRepeat}
          aria-label={repeatTitle}
          title={repeatTitle}
        >
          <RepeatGlyph size={17} />
        </button>
        <button
          className="icon-btn"
          onClick={onClose}
          ref={closeRef}
          aria-label="Close now playing"
          title="Close"
        >
          <ChevronDown size={20} />
        </button>
      </div>

      <p className="nowplaying-eyebrow">
        <Library size={17} />
        <span>
          <span className="nowplaying-eyebrow-label">Playing from {sourceKind}</span>
          <span className="nowplaying-eyebrow-value truncate">{sourceLabel}</span>
        </span>
      </p>

      {/*
        Volume, standing on the window's left edge rather than in a bar.

        A vertical range input is `writing-mode: vertical-lr` with a reversed
        `direction`, not the deprecated `appearance: slider-vertical`. The label
        is a real number rather than a tooltip, because on a control this
        deliberately unlike every other one in the app, the value has to be
        readable at a glance.
      */}
      <div className="nowplaying-volume">
        <span className="tabular" aria-hidden="true">
          {Math.round((state.muted ? 0 : state.volume) * 100)}%
        </span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={state.muted ? 0 : state.volume}
          onChange={(event) => setVolume(Number(event.target.value))}
          aria-label={state.muted ? "Volume, muted" : "Volume"}
          aria-valuetext={
            state.muted ? "Muted" : `${Math.round(state.volume * 100)} percent`
          }
        />
        <button
          className="nowplaying-volume-btn"
          onClick={toggleMute}
          aria-label={state.muted ? "Unmute" : "Mute"}
          aria-pressed={state.muted}
          title={state.muted ? "Unmute" : "Mute"}
        >
          <VolumeGlyph size={17} />
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
          </div>

          <div className="nowplaying-meta">
            <h1 className="nowplaying-title">{track.title}</h1>
            <p className="nowplaying-artist">{track.artist}</p>
            <p className="nowplaying-album truncate">
              {[track.album, track.year].filter(Boolean).join(" · ")}
            </p>
          </div>

          {/*
            The transport, repeated here rather than borrowed from the player bar.
            Two copies of a control are a maintenance cost, but the player bar is
            40px of chrome pinned to the bottom of the library, which is a
            different context from a full-screen view of one record — and a view
            that is 60% artwork and lyrics with no way to pause from it is not
            worth opening.
          */}
          <div className="nowplaying-transport">
            <button
              className={`icon-btn ${isFavourite ? "on" : ""}`}
              onClick={onToggleFavourite}
              aria-label={isFavourite ? "Remove from favourites" : "Add to favourites"}
              aria-pressed={isFavourite}
              title={isFavourite ? "Remove from favourites" : "Add to favourites"}
            >
              <Heart size={17} filled={isFavourite} />
            </button>
            <button
              className={`icon-btn ${shuffled ? "on" : ""}`}
              onClick={toggleShuffle}
              aria-label="Shuffle"
              aria-pressed={shuffled}
              title={shuffled ? "Shuffle on" : "Shuffle off"}
            >
              <Shuffle size={17} />
            </button>

            <span className="nowplaying-transport-gap" aria-hidden="true" />

            <button
              className="icon-btn"
              onClick={previous}
              disabled={!state.isPlaying && state.time < 3}
              aria-label="Previous"
              title="Previous"
            >
              <Prev size={20} />
            </button>
            <button
              className="np-play"
              onClick={toggle}
              aria-label={state.isPlaying ? "Pause" : "Play"}
            >
              {state.isPlaying ? <Pause size={22} /> : <Play size={22} />}
            </button>
            <button className="icon-btn" onClick={next} aria-label="Next" title="Next">
              <Next size={20} />
            </button>

            <span className="nowplaying-transport-gap" aria-hidden="true" />

            {onToggleQueue && (
              <button
                className={`icon-btn ${queueOpen ? "on" : ""}`}
                onClick={onToggleQueue}
                aria-label="Queue"
                aria-expanded={queueOpen}
                title="Queue"
              >
                <Queue size={17} />
              </button>
            )}
          </div>

          {/*
            The seek bar. Its own drag state, because a reflected value cannot be
            dragged and would disagree with the player bar the moment the two
            ticked differently.
          */}
          <div className="nowplaying-seek">
            <span className="tabular">{formatDuration(seekDrag !== null ? seekDrag * liveDuration : state.time)}</span>
            <div
              className="nowplaying-seek-track"
              ref={seekTrackRef}
              role="slider"
              tabIndex={liveDuration > 0 ? 0 : -1}
              aria-label="Seek"
              aria-valuemin={0}
              aria-valuemax={Math.round(liveDuration)}
              aria-valuenow={Math.round((seekDrag ?? shown) * liveDuration)}
              aria-valuetext={formatDuration((seekDrag ?? shown) * liveDuration)}
              aria-disabled={liveDuration === 0}
              onPointerDown={(event) => {
                if (liveDuration <= 0) return
                event.currentTarget.setPointerCapture(event.pointerId)
                seekFromPointer(event.clientX)
              }}
              onPointerMove={(event) => {
                if (seekDrag === null) return
                seekFromPointer(event.clientX)
              }}
              onPointerUp={(event) => {
                if (seekDrag === null) return
                if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                  event.currentTarget.releasePointerCapture(event.pointerId)
                }
                commitSeek(seekDrag)
                setSeekDrag(null)
              }}
              onPointerCancel={() => setSeekDrag(null)}
              onKeyDown={onSeekKeyDown}
            >
              <div className="nowplaying-seek-rail">
                <div className="nowplaying-seek-fill" style={{ transform: `scaleX(${shown})` }} />
              </div>
            </div>
            <span className="tabular">{formatDuration(liveDuration)}</span>
          </div>

          {/*
            Not three identical pills. "Load .lrc" is the one that rescues a track
            whose lyrics are missing or wrong, so it is the only one that gets a
            surface; the other two are file-management verbs and stay quiet until
            hovered. The divider says the first is a different kind of action from
            the pair after it.
          */}
          <div className="nowplaying-actions">
            <button
              className={`np-action lead ${lyricsEditing ? "on" : ""}`}
              onClick={onToggleLyricsEditor}
              aria-pressed={lyricsEditing}
              title="Fix the timing of these lyrics, and add word-by-word timing"
            >
              {lyricsEditing ? "Done editing" : "Edit lyrics"}
            </button>
            <button className="np-action" onClick={onOpenLyricsFile} title="Open an .lrc file to replace these lyrics">
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

        <div className="nowplaying-info">{children}</div>
      </div>
    </section>
  )
}
