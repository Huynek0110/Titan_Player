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
 * Cover art with a graceful fallback. A missing or broken image falls back to a
 * tinted monogram derived from the title, which is far more recognisable than a
 * generic grey square.
 */
export default function Artwork({
  trackId,
  hasArtwork,
  alt,
  size = 48,
  className = "",
  seed,
}: ArtworkProps) {
  const url = window.titan.coverUrl(trackId, hasArtwork)
  const [failed, setFailed] = useState(false)
  const showImage = Boolean(url) && hasArtwork && !failed

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
        <img src={url} alt={alt} draggable={false} onError={() => setFailed(true)} />
      ) : (
        <span className="artwork-fallback" aria-hidden="true">
          <Music size={Math.max(14, Math.round(size * 0.34))} />
          <span className="artwork-monogram">{monogram}</span>
        </span>
      )}
    </div>
  )
}
