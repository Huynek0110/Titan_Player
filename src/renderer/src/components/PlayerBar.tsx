import { useCallback, useEffect, useRef, useState } from "react"
import { useStore } from "../state/store"
import type { usePlayer } from "../lib/usePlayer"
import { formatDuration } from "../lib/format"
import { useGlassSurface } from "../lib/glass"
import Artwork from "./Artwork"
import {
  ChevronUp,
  Heart,
  Lyrics,
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
import "./PlayerBar.css"

interface PlayerBarProps {
  player: ReturnType<typeof usePlayer>
}

/**
 * The transport. The seek bar fills with a spring rather than snapping to the
 * playhead, so scrubbing has momentum instead of tracking the pointer rigidly
 * — the same trick Apple shipped on iOS 26 sliders.
 */
export default function PlayerBar({ player }: PlayerBarProps) {
  const store = useStore()
  /*
   * Liquid Glass on the one surface that sits over scrolling content, so there is
   * something behind it worth refracting. A weak displacement on purpose: this is
   * a 100px strip across the bottom of the window, and a strong rim bend on a
   * surface that wide stops reading as glass and starts reading as a funhouse
   * mirror at the left and right ends.
   */
  const barRef = useGlassSurface<HTMLElement>({ displacement: 26, blur: 3, flat: 0.4 })
  const { currentTrack, queue, queueIndex, queueTracks, favourites, settings, shuffled, toggleFavourite } =
    store
  const { state, toggle, previous, next, seek, setVolume, toggleMute, cycleRepeat, toggleShuffle } = player

  const repeat = settings?.repeat ?? "off"
  const repeatLabel = repeat === "one" ? "Repeat one" : repeat === "all" ? "Repeat all" : "Repeat off"
  const isFavourite = currentTrack ? favourites.has(currentTrack.id) : false

  /*
   * Mute and a zero volume are the same outcome to the ear, so the icon treats
   * them as one. The slider is pinned to 0 while muted, which means dragging it
   * away from the left is how you unmute — the mute button is not the only way
   * out, and the icon is what tells you which state you are in.
   */
  const silent = state.muted || state.volume === 0
  const VolumeGlyph = silent ? VolumeMute : state.volume < 0.5 ? VolumeLow : Volume
  const shownVolume = silent ? 0 : state.volume
  const level = Math.round(shownVolume * 100)

  return (
    <footer className="playerbar glass" ref={barRef}>
      <div className="playerbar-left">
        {currentTrack ? (
          <>
            <Artwork
              trackId={currentTrack.id}
              hasArtwork={currentTrack.hasArtwork}
              alt={currentTrack.title}
              size={68}
              seed={currentTrack.title}
            />
            <div className="playerbar-meta">
              <span className="playerbar-title truncate">{currentTrack.title}</span>
              <span className="playerbar-artist truncate">{currentTrack.artist}</span>
            </div>
            <button
              className={`icon-btn ${isFavourite ? "on" : ""}`}
              onClick={() => void toggleFavourite(currentTrack.id)}
              aria-label={isFavourite ? "Remove from favourites" : "Add to favourites"}
              aria-pressed={isFavourite}
            >
              <Heart size={16} filled={isFavourite} />
            </button>
          </>
        ) : (
          <span className="playerbar-idle">Nothing playing</span>
        )}
      </div>

      <div className="playerbar-centre">
        <div className="transport">
          {/*
           * `state-btn` rather than a bare `on`, because the on-state needs a
           * shape as well as the accent colour. See `.state-btn.on::after`.
           */}
          <button
            className={`icon-btn state-btn ${shuffled ? "on" : ""}`}
            onClick={toggleShuffle}
            disabled={queueTracks.length < 2}
            aria-label="Shuffle"
            aria-pressed={shuffled}
            title={shuffled ? "Shuffle on" : "Shuffle off"}
          >
            <Shuffle size={16} />
          </button>

          <button
            className="icon-btn"
            onClick={previous}
            disabled={queue.length === 0}
            aria-label="Previous"
          >
            <Prev size={18} />
          </button>

          <button
            className="play-toggle"
            onClick={toggle}
            disabled={!currentTrack}
            aria-label={state.isPlaying ? "Pause" : "Play"}
          >
            {state.isPlaying ? <Pause size={20} /> : <Play size={20} />}
          </button>

          <button
            className="icon-btn"
            onClick={next}
            // Repeat-all wraps, so the last track is not the end of the road.
            // Greying the button there made it contradict what auto-advance
            // would do a moment later.
            disabled={queue.length === 0 || (queueIndex >= queue.length - 1 && repeat !== "all")}
            aria-label="Next"
          >
            <Next size={18} />
          </button>

          {/* Three states, so there is no pressed state to expose: the label
              names the current mode instead, which is also the tooltip. */}
          <button
            className={`icon-btn state-btn ${repeat !== "off" ? "on" : ""}`}
            onClick={cycleRepeat}
            aria-label={repeatLabel}
            title={`${repeatLabel} — click to change`}
          >
            {repeat === "one" ? <RepeatOne size={16} /> : <Repeat size={16} />}
          </button>
        </div>

        <SeekBar
          time={state.time}
          duration={state.duration}
          buffered={state.buffered}
          loading={state.isLoading}
          onSeek={seek}
        />
      </div>

      <div className="playerbar-right">
        <button
          className="icon-btn"
          onClick={() => store.setNowPlaying(true)}
          disabled={!currentTrack}
          aria-label="Now playing and lyrics"
          title="Now playing"
        >
          <ChevronUp size={18} />
        </button>
        <button
          className="icon-btn"
          onClick={() => store.setNowPlaying(true)}
          disabled={!currentTrack || currentTrack.lyrics.source === "none"}
          aria-label="Lyrics"
          title="Lyrics"
        >
          <Lyrics size={17} />
        </button>
        <button
          className={`icon-btn state-btn ${store.showQueue ? "on" : ""}`}
          onClick={() => store.setShowQueue(!store.showQueue)}
          // A drawer toggle is a disclosure, not a toggle button: `expanded` is
          // what tells a screen reader that a region now exists off to the side.
          aria-label="Queue"
          aria-expanded={store.showQueue}
          aria-controls="queue-panel"
          title="Queue  (Q)"
        >
          <Queue size={17} />
        </button>

        <div className="volume">
          <button
            className="icon-btn"
            onClick={toggleMute}
            aria-label={silent ? "Unmute" : "Mute"}
          >
            <VolumeGlyph size={17} />
          </button>
          <input
            className="slider"
            type="range"
            min={0}
            max={1}
            /*
             * 0.01 so a drag lands on the level the pointer was aimed at. That
             * is 100 presses to cross the range with the arrow keys, so the
             * keyboard steps coarser than the pointer — see `onKeyDown`.
             */
            step={0.01}
            value={shownVolume}
            onChange={(e) => setVolume(Number(e.target.value))}
            onKeyDown={(e) => {
              const up = e.key === "ArrowUp" || e.key === "ArrowRight"
              const down = e.key === "ArrowDown" || e.key === "ArrowLeft"
              if (up || down) {
                e.preventDefault()
                setVolume(shownVolume + (up ? 1 : -1) * (e.shiftKey ? 0.1 : 0.05))
              } else if (e.key === "Home") {
                e.preventDefault()
                setVolume(0)
              } else if (e.key === "End") {
                e.preventDefault()
                setVolume(1)
              }
            }}
            aria-label="Volume"
            // The raw 0.8 of a range input is read out as "0.8". The state the
            // user cares about is the level, and whether it is silenced.
            aria-valuetext={silent ? "Muted" : `${level} percent`}
            style={{ ["--pct" as string]: `${shownVolume * 100}%` }}
          />
        </div>
      </div>

      {state.error && <div className="playerbar-error">{state.error}</div>}
    </footer>
  )
}

interface SeekBarProps {
  time: number
  duration: number
  buffered: number
  /** True while the element is waiting on data, so the playhead can stall. */
  loading: boolean
  onSeek: (seconds: number) => void
}

function SeekBar({ time, duration, buffered, loading, onSeek }: SeekBarProps) {
  const trackRef = useRef<HTMLDivElement>(null)
  const fillRef = useRef<HTMLDivElement>(null)
  const knobRef = useRef<HTMLSpanElement>(null)
  const [dragging, setDragging] = useState(false)
  // Where the fill currently is, and where it is heading. The gap between them
  // is the spring.
  const chaseRef = useRef({ shown: 0, target: 0 })
  const seekRatioRef = useRef<number | null>(null)

  const ratio = duration > 0 ? Math.max(0, Math.min(1, time / duration)) : 0
  // Nothing to seek before the element has reported a duration, so the control
  // is removed from the tab order rather than left as a focusable dead end.
  const seekable = duration > 0

  // Spring loop: ease `shown` toward `target` every frame. The knob is written
  // from the same loop; reading the ref during render gave it a new position
  // only on re-renders, about four times a second, while the fill moved
  // smoothly — so the two visibly drifted apart.
  useEffect(() => {
    let raf = 0
    const tick = () => {
      const node = fillRef.current
      const knob = knobRef.current
      const track = trackRef.current
      const { shown, target } = chaseRef.current

      // The knob is positioned in pixels because a percentage translate on a
      // 12px element would move it 12px, not the width of the track.
      const width = track ? track.clientWidth : 0

      // Snap when close, so the loop can idle instead of writing a style every
      // frame forever.
      if (Math.abs(target - shown) < 0.0004) {
        chaseRef.current = { shown: target, target }
        if (node) node.style.transform = `scaleX(${target})`
        if (knob) knob.style.transform = `translateY(-50%) translateX(${target * width}px) scale(1)`
        raf = 0
        return
      }

      const next = shown + (target - shown) * 0.22
      chaseRef.current = { shown: next, target }
      if (node) node.style.transform = `scaleX(${next})`
      if (knob) knob.style.transform = `translateY(-50%) translateX(${next * width}px) scale(1)`
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  useEffect(() => {
    chaseRef.current.target = seekRatioRef.current ?? ratio
  }, [ratio])

  const ratioFromEvent = useCallback(
    (clientX: number) => {
      const node = trackRef.current
      if (!node || duration <= 0) return 0
      const rect = node.getBoundingClientRect()
      return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    },
    [duration],
  )

  const onPointerDown = (event: React.PointerEvent) => {
    if (!seekable) return
    event.currentTarget.setPointerCapture(event.pointerId)
    setDragging(true)
    const r = ratioFromEvent(event.clientX)
    seekRatioRef.current = r
    chaseRef.current.target = r
    chaseRef.current.shown = r
    onSeek(r * duration)
  }

  const onPointerMove = (event: React.PointerEvent) => {
    const r = ratioFromEvent(event.clientX)
    if (!dragging) return
    seekRatioRef.current = r
    chaseRef.current.target = r
    onSeek(r * duration)
  }

  const onPointerUp = (event: React.PointerEvent) => {
    if (!dragging) return
    event.currentTarget.releasePointerCapture(event.pointerId)
    setDragging(false)
    // Clear the drag override. Leaving it set pinned the spring target to the
    // release position forever, so the fill stopped advancing for the rest of
    // the track while the time labels carried on moving.
    seekRatioRef.current = null
    onSeek(ratioFromEvent(event.clientX) * duration)
  }

  const onPointerCancel = () => {
    setDragging(false)
    seekRatioRef.current = null
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!seekable) return
    /*
     * The ARIA slider pattern, in full: Right/Up increase, Left/Down decrease,
     * Home/End jump to the ends, PageUp/PageDown for a coarse step. It was
     * missing End, which left a keyboard user with no way to reach the last
     * seconds of a track except 200 presses of the right arrow.
     */
    const fine = event.shiftKey ? 1 : 5
    const coarse = 30
    let to: number
    switch (event.key) {
      case "ArrowRight":
      case "ArrowUp":
        to = time + fine
        break
      case "ArrowLeft":
      case "ArrowDown":
        to = time - fine
        break
      case "PageUp":
        to = time + coarse
        break
      case "PageDown":
        to = time - coarse
        break
      case "Home":
        to = 0
        break
      case "End":
        to = duration
        break
      default:
        return
    }
    event.preventDefault()
    onSeek(Math.max(0, Math.min(duration, to)))
  }

  return (
    <div className="seek">
      <span className="seek-time tabular">{formatDuration(time)}</span>

      <div
        className={`seek-track ${dragging ? "dragging" : ""} ${loading ? "loading" : ""}`}
        ref={trackRef}
        role="slider"
        tabIndex={seekable ? 0 : -1}
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(time)}
        // "3:41" is a position a person can act on; the raw 221 is not, and
        // `valuenow` still carries it for anything that reads the number.
        aria-valuetext={formatDuration(time)}
        aria-disabled={!seekable}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onLostPointerCapture={onPointerCancel}
        onKeyDown={onKeyDown}
      >
        <div className="seek-rail" />
        <div
          className="seek-buffer"
          style={{ transform: `scaleX(${duration > 0 ? Math.min(1, buffered / duration) : 0})` }}
        />
        <div className="seek-fill" ref={fillRef} />
        {/* A sibling of the fill, not a child: the fill carries a scaleX, which
            would squash the knob into an ellipse and resolve its offset against
            the scaled width. Positioned by the rAF loop, not by React state. */}
        <span className="seek-knob" ref={knobRef} />
      </div>

      {/*
       * An em dash, not "0:00", before the element has reported a duration.
       * Both are four characters so the fixed width holds and nothing shifts;
       * "0:00" however reads as a real length of nothing, which is a claim
       * about the file rather than an admission that the app has not asked yet.
       */}
      <span className="seek-time tabular">{seekable ? formatDuration(duration) : "—"}</span>
    </div>
  )
}
