import { useEffect, useRef, useState, type ReactNode } from "react"
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
  const [showDetails, setShowDetails] = useState(false)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  // A slow parallax drift on the artwork, tied to the playhead.
  useEffect(() => {
    const node = artWrapRef.current
    if (!node || !state.isPlaying) return
    let raf = 0
    const tick = () => {
      const span = state.duration || 1
      const t = Math.min(1, state.time / span)
      // A gentle sine sweep rather than a linear map, so it never feels robotic.
      node.style.setProperty("--drift", `${Math.sin(t * Math.PI * 2) * 8}px`)
      node.style.setProperty("--drift-y", `${Math.cos(t * Math.PI * 2) * 6}px`)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [state.isPlaying, state.time, state.duration])

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

  return (
    <section className="nowplaying">
      <div className="nowplaying-top">
        <button className="icon-btn" onClick={onClose} aria-label="Close now playing">
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

      <div className="nowplaying-body">
        <div className="nowplaying-art-col">
          <div className="nowplaying-art" ref={artWrapRef}>
            <Artwork
              trackId={track.id}
              hasArtwork={track.hasArtwork}
              alt={track.title}
              size={420}
              seed={track.title}
            />
            <div className="nowplaying-art-shadow" aria-hidden="true" />
          </div>

          <div className="nowplaying-actions">
            <button className="pill" onClick={onOpenLyricsFile} title="Open an .lrc file">
              Load .lrc
            </button>
            <button className="pill" onClick={onReveal} title="Show the file in Explorer">
              Show file
            </button>
            <button className="pill" onClick={() => setShowDetails((v) => !v)}>
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
