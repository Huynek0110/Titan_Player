import { useState } from "react"
import { Music } from "./Icons"
import "./Artwork.css"

interface ArtworkProps {
  trackId: string
  hasArtwork: boolean
  alt: string
  /** Any CSS size value. The component stays square. */
  size?: number
  className?: string
  /** Renders the seed monogram instead of the note glyph. */
  seed?: string
}

/**
 * Cover art with a graceful fallback. A missing or unreadable image falls back
 * to a tinted monogram derived from the title, which is far more recognisable
 * than a generic grey square.
 */
export default function Artwork({
  trackId,
  hasArtwork,
  alt,
  size = 48,
  className = "",
  seed,
}: ArtworkProps) {
  // The failure flag is tracked against the id that produced it. Storing just a
  // boolean meant one undecodable cover poisoned every later track, because the
  // component instance is reused at a stable position without a React key.
  const [failedFor, setFailedFor] = useState<string | null>(null)
  const failed = failedFor === trackId
  const url = window.titan.coverUrl(trackId, hasArtwork)
  const showImage = hasArtwork && !failed

  const monogram = (seed ?? alt).trim().charAt(0).toUpperCase() || "♪"
  // Deterministic hue per track keeps the fallback varied but stable.
  const hue = [...trackId].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) % 360, 7)

  return (
    <div
      className={`artwork ${className}`}
      style={{
        width: size,
        height: size,
        // Keeps the placeholder box from collapsing before art resolves.
        minWidth: size,
        ["--hue" as string]: String(hue),
      }}
    >
      {showImage && url ? (
        <img src={url} alt={alt} draggable={false} onError={() => setFailedFor(trackId)} />
      ) : (
        <span className="artwork-fallback" aria-hidden="true">
          <Music size={Math.max(14, Math.round(size * 0.34))} />
          <span className="artwork-monogram">{monogram}</span>
        </span>
      )}
    </div>
  )
}
