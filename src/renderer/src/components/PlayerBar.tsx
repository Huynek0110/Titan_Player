import { useCallback, useEffect, useRef, useState } from "react"
import { useStore } from "../state/store"
import type { usePlayer } from "../lib/usePlayer"
import { formatDuration } from "../lib/format"
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
  const { currentTrack, queue, queueIndex, favourites, settings, toggleFavourite } = store
  const { state, toggle, previous, next, seek, setVolume, toggleMute, cycleRepeat, toggleShuffle } = player

  const repeat = settings?.repeat ?? "off"
  const shuffle = settings?.shuffle ?? false

  const volumeIcon = state.muted || state.volume === 0 ? VolumeMute : state.volume < 0.5 ? VolumeLow : Volume
  const VolumeGlyph = volumeIcon

  return (
    <footer className="playerbar glass">
      <div className="playerbar-left">
        {currentTrack ? (
          <>
            <Artwork
              trackId={currentTrack.id}
              hasArtwork={currentTrack.hasArtwork}
              alt={currentTrack.title}
              size={54}
              seed={currentTrack.title}
            />
            <div className="playerbar-meta">
              <span className="playerbar-title truncate">{currentTrack.title}</span>
              <span className="playerbar-artist truncate">{currentTrack.artist}</span>
            </div>
            <button
              className={`icon-btn ${favourites.has(currentTrack.id) ? "on" : ""}`}
              onClick={() => void toggleFavourite(currentTrack.id)}
              aria-label="Toggle favourite"
            >
              <Heart size={16} filled={favourites.has(currentTrack.id)} />
            </button>
          </>
        ) : (
          <span className="playerbar-idle">Nothing playing</span>
        )}
      </div>

      <div className="playerbar-centre">
        <div className="transport">
          <button
            className={`icon-btn ${shuffle ? "on" : ""}`}
            onClick={toggleShuffle}
            aria-label="Shuffle"
            title="Shuffle"
          >
            <Shuffle size={16} />
          </button>
          <button className="icon-btn" onClick={previous} disabled={queue.length === 0} aria-label="Previous">
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
            disabled={queue.length === 0 || queueIndex >= queue.length - 1}
            aria-label="Next"
          >
            <Next size={18} />
          </button>
          <button
            className={`icon-btn ${repeat !== "off" ? "on" : ""}`}
            onClick={cycleRepeat}
            aria-label="Repeat mode"
            title={repeat === "one" ? "Repeat one" : repeat === "all" ? "Repeat all" : "Repeat off"}
          >
            {repeat === "one" ? <RepeatOne size={16} /> : <Repeat size={16} />}
          </button>
        </div>

        <SeekBar
          time={state.time}
          duration={state.duration}
          buffered={state.buffered}
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
          className={`icon-btn ${store.showQueue ? "on" : ""}`}
          onClick={() => store.setShowQueue(!store.showQueue)}
          aria-label="Queue"
          title="Queue"
        >
          <Queue size={17} />
        </button>

        <div className="volume">
          <button className="icon-btn" onClick={toggleMute} aria-label="Mute">
            <VolumeGlyph size={17} />
          </button>
          <input
            className="slider"
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={state.muted ? 0 : state.volume}
            onChange={(e) => setVolume(Number(e.target.value))}
            aria-label="Volume"
            style={{ ["--pct" as string]: `${(state.muted ? 0 : state.volume) * 100}%` }}
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
  onSeek: (seconds: number) => void
}

function SeekBar({ time, duration, buffered, onSeek }: SeekBarProps) {
  const trackRef = useRef<HTMLDivElement>(null)
  const fillRef = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)
  // Where the fill currently is, and where it is heading. The gap between them
  // is the spring.
  const chaseRef = useRef({ shown: 0, target: 0 })
  const seekRatioRef = useRef<number | null>(null)

  const ratio = duration > 0 ? Math.max(0, Math.min(1, time / duration)) : 0

  // Spring loop: ease `shown` toward `target` every frame. Cancels out once
  // they are within a pixel's worth of each other, so it idles at no cost.
  useEffect(() => {
    let raf = 0
    const tick = () => {
      const node = fillRef.current
      const { shown, target } = chaseRef.current
      if (node) {
        const next = shown + (target - shown) * 0.22
        chaseRef.current = { shown: Math.abs(next - target) < 0.0004 ? target : next, target }
        node.style.transform = `scaleX(${chaseRef.current.shown})`
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  useEffect(() => {
    chaseRef.current.target = seekRatioRef.current ?? ratio
  }, [ratio])

  const ratioFromEvent = useCallback((clientX: number) => {
    const node = trackRef.current
    if (!node || duration <= 0) return 0
    const rect = node.getBoundingClientRect()
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
  }, [duration])

  const onPointerDown = (event: React.PointerEvent) => {
    if (duration <= 0) return
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
    setHover(r)
    if (!dragging) return
    seekRatioRef.current = r
    chaseRef.current.target = r
    onSeek(r * duration)
  }

  const onPointerUp = (event: React.PointerEvent) => {
    if (!dragging) return
    event.currentTarget.releasePointerCapture(event.pointerId)
    setDragging(false)
    onSeek(ratioFromEvent(event.clientX) * duration)
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    const step = event.shiftKey ? 30 : 5
    if (event.key === "ArrowRight") {
      event.preventDefault()
      onSeek(Math.min(duration, time + step))
    } else if (event.key === "ArrowLeft") {
      event.preventDefault()
      onSeek(Math.max(0, time - step))
    } else if (event.key === "Home") {
      event.preventDefault()
      onSeek(0)
    }
  }

  const showRatio = dragging ? (seekRatioRef.current ?? ratio) : (hover ?? ratio)

  return (
    <div className="seek">
      <span className="seek-time tabular">{formatDuration(time)}</span>

      <div
        className={`seek-track ${dragging ? "dragging" : ""}`}
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(time)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setHover(null)}
        onKeyDown={onKeyDown}
      >
        <div className="seek-rail" />
        <div
          className="seek-buffer"
          style={{ transform: `scaleX(${duration > 0 ? Math.min(1, buffered / duration) : 0})` }}
        />
        <div className="seek-fill" ref={fillRef}>
          <span className="seek-knob" style={{ left: `${showRatio * 100}%` }} />
        </div>
      </div>

      <span className="seek-time tabular">{formatDuration(duration)}</span>
    </div>
  )
}
