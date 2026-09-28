import { useCallback, useMemo, useState } from "react"
import type { Track } from "@shared/types"
import { useStore } from "../state/store"
import { formatDuration, formatTotalDuration, compareStrings } from "../lib/format"
import Artwork from "./Artwork"
import TrackList from "./TrackList"
import { Artist, ChevronUp, Close, Disc, Play, Shuffle } from "./Icons"
import "./CollectionViews.css"

/**
 * Albums and Artists share a shape, so they share an implementation: a grid of
 * cards, each one collapsing a group of tracks.
 *
 * A card opens its group into a track list underneath rather than only starting
 * playback. Albums and Artists are the views a library user actually navigates
 * by, and a grid of play-only launchers leaves no way to see what is on the
 * record, what the running time is, or how to reach a track's own menu once you
 * know which album it is on. The selection is local component state on purpose:
 * a drill-down is a navigation detail of this view, not part of the app's route,
 * so it needs no store change and does not survive a view switch.
 */

export interface Group {
  key: string
  title: string
  subtitle: string
  /** One representative track, used for the artwork. */
  seed: Track
  tracks: Track[]
}

// A written escape rather than a literal NUL byte: the separator is just as
// collision-resistant, and a real NUL makes git treat the file as binary.
const SEP = "\u0000"

function groupAlbums(tracks: Track[]): Group[] {
  const map = new Map<string, Track[]>()
  for (const track of tracks) {
    /*
     * The year is part of the key, not decoration. Keying on artist + album
     * alone collapsed a 1998 original and a 2011 remaster that both call
     * themselves "Greatest Hits" into one card carrying twice the tracks and
     * twice the running time, and showing the cover of whichever file happened
     * to sort first.
     */
    const key = `${track.albumArtist}${SEP}${track.album}${SEP}${track.year ?? ""}`
    const bucket = map.get(key)
    if (bucket) bucket.push(track)
    else map.set(key, [track])
  }

  const groups: Group[] = []
  for (const [key, list] of map) {
    const sorted = [...list].sort(
      (a, b) => (a.discNo ?? 0) - (b.discNo ?? 0) || (a.trackNo ?? 0) - (b.trackNo ?? 0),
    )
    const first = sorted[0]
    // Prefer a track that actually carries art, exactly as the artist grouping
    // does. Seeding from sorted[0] means a bonus track with no embedded picture
    // wins the race — it commonly sorts to position 0 — and the album card shows
    // a monogram for an album whose cover sits right there in the same list.
    const withArt = sorted.find((t) => t.hasArtwork) ?? first
    const year = first.year ? String(first.year) : ""
    groups.push({
      key,
      title: first.album,
      subtitle: year ? `${first.albumArtist} · ${year}` : first.albumArtist,
      seed: withArt,
      tracks: sorted,
    })
  }
  // Natural collation, the same one the track list uses. `localeCompare` put
  // "Artist 10" before "Artist 2", so the two disagreed about order in the same
  // window and the user saw a different list each time they switched views.
  return groups.sort((a, b) => compareStrings(a.title, b.title) || compareStrings(a.subtitle, b.subtitle))
}

function groupArtists(tracks: Track[]): Group[] {
  const map = new Map<string, Track[]>()
  for (const track of tracks) {
    const bucket = map.get(track.artist)
    if (bucket) bucket.push(track)
    else map.set(track.artist, [track])
  }

  const groups: Group[] = []
  for (const [name, list] of map) {
    const withArt = list.find((t) => t.hasArtwork) ?? list[0]
    groups.push({
      key: name,
      title: name,
      subtitle: `${list.length} track${list.length === 1 ? "" : "s"}`,
      seed: withArt,
      tracks: list,
    })
  }
  return groups.sort((a, b) => compareStrings(a.title, b.title))
}

interface CollectionViewsProps {
  kind: "albums" | "artists"
}

export default function CollectionViews({ kind }: CollectionViewsProps) {
  const { visibleTracks, playTracks, search } = useStore()
  const [openKey, setOpenKey] = useState<string | null>(null)

  const groups = useMemo(
    () => (kind === "albums" ? groupAlbums(visibleTracks) : groupArtists(visibleTracks)),
    [kind, visibleTracks],
  )

  // A group that no longer exists — the library rescanned, or the search box
  // narrowed — must not leave a drill-down pointing at nothing.
  const open = openKey ? (groups.find((g) => g.key === openKey) ?? null) : null
  const close = useCallback(() => setOpenKey(null), [])

  if (groups.length === 0) {
    return (
      <div className="collection-empty">
        {kind === "albums" ? <Disc size={30} /> : <Artist size={30} />}
        <p>{search.trim() ? `Nothing matches “${search.trim()}”` : `No ${kind} yet`}</p>
        {search.trim() && <p className="collection-empty-hint">Try a shorter search, or clear it.</p>}
      </div>
    )
  }

  return (
    <div className={`collection ${open ? "with-detail" : ""}`}>
      <div className="collection-grid-wrap">
        <div className={`collection-grid ${kind === "artists" ? "artists" : ""}`}>
          {groups.map((group) => {
            const total = group.tracks.reduce((sum, t) => sum + t.duration, 0)
            const expanded = open?.key === group.key
            return (
              <article
                key={group.key}
                className={`card ${expanded ? "expanded" : ""}`}
                // Remounting a card that scrolls back into view is what makes
                // `content-visibility` re-rasterise its artwork, so the art is
                // kept mounted once revealed.
              >
                <button
                  className="card-hit"
                  onClick={() => (expanded ? close() : setOpenKey(group.key))}
                  title={expanded ? `Close ${group.title}` : `Open ${group.title}`}
                  aria-expanded={expanded}
                >
                  <div className="card-art">
                    <Artwork
                      trackId={group.seed.id}
                      hasArtwork={group.seed.hasArtwork}
                      alt={group.title}
                      size={168}
                      seed={group.title}
                    />
                    <span className="card-play">
                      {expanded ? <ChevronUp size={18} /> : <Play size={18} />}
                    </span>
                  </div>
                  <div className="card-text">
                    <span className="card-title truncate">{group.title}</span>
                    <span className="card-sub truncate">{group.subtitle}</span>
                  </div>
                </button>
                <div className="card-meta">
                  {kind === "albums"
                    ? `${group.tracks.length} track${group.tracks.length === 1 ? "" : "s"} · ${formatTotalDuration(total)}`
                    : formatDuration(total)}
                </div>
              </article>
            )
          })}
        </div>
      </div>

      {open && (
        <section className="collection-detail" aria-label={open.title}>
          <header className="collection-detail-head">
            <button
              className="detail-close"
              onClick={close}
              aria-label="Close track list"
              title="Back to the grid"
            >
              <Close size={15} />
            </button>

            <div className="detail-art">
              <Artwork
                trackId={open.seed.id}
                hasArtwork={open.seed.hasArtwork}
                alt={open.title}
                size={56}
                seed={open.title}
                className={kind === "artists" ? "round" : ""}
              />
            </div>

            <div className="detail-body">
              <span className="detail-kind">{kind === "albums" ? "Album" : "Artist"}</span>
              <h2 className="detail-title truncate">{open.title}</h2>
              <p className="detail-stats tabular">
                {open.tracks.length.toLocaleString()} track
                {open.tracks.length === 1 ? "" : "s"}
                {open.tracks.length > 0 && ` · ${formatTotalDuration(totalDuration(open))}`}
                {open.subtitle !== open.title && ` · ${open.subtitle}`}
              </p>
            </div>

            <div className="detail-actions">
              <button
                className="detail-play"
                disabled={open.tracks.length === 0}
                onClick={() => playTracks(open.tracks, 0)}
                aria-label={`Play ${open.title}`}
              >
                <Play size={17} />
              </button>
              <button
                className="pill"
                disabled={open.tracks.length < 2}
                onClick={() => playTracks(open.tracks, 0, true)}
                title="Play in a random order"
              >
                <Shuffle size={14} /> Shuffle
              </button>
            </div>
          </header>

          {/*
            Keyed on the group so switching albums resets scroll and selection.
            Without it the new list opens at the previous one's offset, which in
            an eleven-track disc could be past the end and show an empty pane.
          */}
          <TrackList key={open.key} tracks={open.tracks} />
        </section>
      )}
    </div>
  )
}

function totalDuration(group: Group): number {
  return group.tracks.reduce((sum, t) => sum + t.duration, 0)
}
