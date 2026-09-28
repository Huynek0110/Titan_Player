import { useState } from "react"
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
 * to a monogram derived from the title, which is far more recognisable than a
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
  /*
   * The state is tracked against a key that includes `hasArtwork`, not just the
   * id. Keying on the id alone meant a track whose cover failed to decode stayed
   * broken forever, even after a rescan turned up working art for it — the flag
   * still matched, so the image was never retried. The component instance is
   * also reused at a stable position without a React key, so the key has to
   * change whenever the thing being displayed does.
   */
  const source = `${trackId}|${hasArtwork ? 1 : 0}`
  const [failedFor, setFailedFor] = useState<string | null>(null)
  const [loadedFor, setLoadedFor] = useState<string | null>(null)
  const failed = failedFor === source

  const url = window.titan.coverUrl(trackId, hasArtwork)
  const showImage = hasArtwork && !failed && Boolean(url)
  /*
   * A freshly mounted track starts unresolved, so the image fades in rather than
   * popping. On a first paint of a long library this is the single most
   * conspicuous piece of missing motion.
   */
  const resolved = loadedFor === source

  const monogram = (seed ?? alt).trim().charAt(0).toUpperCase() || "♪"

  return (
    <div
      className={`artwork ${className}`}
      style={{
        width: size,
        height: size,
        // Keeps the placeholder box from collapsing before art resolves.
        minWidth: size,
        // Published so the drop shadow can scale with the art. See Artwork.css.
        ["--art-size" as string]: `${size}px`,
      }}
    >
      {/*
       * The monogram is mounted whenever the image has not resolved yet — while
       * it is decoding *and* when there is nothing to decode — and cross-fades
       * out underneath the image. Rendering it only in the no-image branch meant
       * that a cover arriving over the network faded up from a blank plate, and
       * that a 404 popped a letter onto the plate instead of revealing one.
       */}
      <span
        className={`artwork-fallback ${resolved ? "hidden" : ""}`}
        aria-hidden="true"
      >
        <span className="artwork-monogram">{monogram}</span>
      </span>

      {showImage ? (
        <img
          src={url as string}
          alt={alt}
          draggable={false}
          decoding="async"
          loading={size > 100 ? "lazy" : undefined}
          className={resolved ? "resolved" : ""}
          onLoad={() => setLoadedFor(source)}
          onError={() => setFailedFor(source)}
        />
      ) : null}
    </div>
  )
}
