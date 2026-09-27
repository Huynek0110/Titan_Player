import { useMemo } from "react"
import { useStore } from "../state/store"
import { formatTotalDuration, formatDuration } from "../lib/format"
import TrackList from "./TrackList"
import { Music, Play, Shuffle } from "./Icons"
import "./PlaylistView.css"

interface PlaylistViewProps {
  playlistId: string
}

/**
 * A playlist or a system collection. The track order here is the user's own, so
 * the list is not sorted and rows can be dragged into a new order.
 */
export default function PlaylistView({ playlistId }: PlaylistViewProps) {
  const store = useStore()
  const { playlists, activePlaylistId, setPlaylistTracks, playTracks, enqueue, updateSettings } = store

  const playlist = useMemo(
    () => playlists.find((p) => p.id === playlistId),
    [playlists, playlistId],
  )

  // The store already resolves playlist membership for the current view, but
  // this component needs the list for a specific playlist regardless of which
  // one happens to be active.
  const tracks = useMemo(() => {
    if (!playlist) return []
    return playlist.trackIds
      .map((id) => store.byId.get(id))
      .filter((t): t is NonNullable<typeof t> => Boolean(t))
  }, [playlist, store.byId])

  if (!playlist) {
    return (
      <div className="playlist-head">
        <h1>Playlist not found</h1>
      </div>
    )
  }

  const isFavourites = playlistId === "sys:favourites"
  // Favourites are derived from the track list, so their order is not editable.
  const reorderable = !playlist.system && !isFavourites

  const totalSeconds = tracks.reduce((sum, t) => sum + t.duration, 0)

  function reorder(from: number, to: number) {
    const ids = tracks.map((t) => t.id)
    const [moved] = ids.splice(from, 1)
    ids.splice(to, 0, moved)
    void setPlaylistTracks(playlistId, ids)
  }

  function removeAt(index: number) {
    const ids = tracks.map((t) => t.id)
    ids.splice(index, 1)
    void setPlaylistTracks(playlistId, ids)
  }

  return (
    <>
      <header className="playlist-head">
        <div className="playlist-head-art">
          <div className={`playlist-swatch ${isFavourites ? "fav" : ""}`}>
            <Music size={38} />
          </div>
        </div>

        <div className="playlist-head-body">
          <span className="playlist-kind">
            {playlist.system ? "Collection" : "Playlist"}
          </span>
          <h1 className="playlist-title">{playlist.name}</h1>
          <p className="playlist-stats">
            {tracks.length.toLocaleString()} track{tracks.length === 1 ? "" : "s"}
            {totalSeconds > 0 && (
              <>
                {" · "}
                {formatDuration(totalSeconds) === "0:00"
                  ? formatTotalDuration(totalSeconds)
                  : formatTotalDuration(totalSeconds)}
              </>
            )}
          </p>
        </div>

        <div className="playlist-head-actions">
          <button
            className="play-big"
            disabled={tracks.length === 0}
            onClick={() => playTracks(tracks, 0)}
            aria-label={`Play ${playlist.name}`}
          >
            <Play size={22} />
          </button>
          <button
            className="pill"
            disabled={tracks.length === 0}
            onClick={() => {
              const wasShuffled = store.settings?.shuffle ?? false
              if (!wasShuffled) void updateSettings({ shuffle: true })
              playTracks(tracks, 0, true)
            }}
          >
            <Shuffle size={15} /> Shuffle
          </button>
          <button
            className="pill"
            disabled={tracks.length === 0}
            onClick={() => enqueue(tracks.map((t) => t.id), "end")}
          >
            Queue
          </button>
        </div>
      </header>

      <TrackList
        key={activePlaylistId === playlistId ? "active" : "idle"}
        tracks={tracks}
        reorderable={reorderable}
        onReorder={reorder}
        onRemove={removeAt}
        emptyMessage={
          isFavourites
            ? "No favourites yet — tap the heart on any track"
            : "This playlist is empty"
        }
      />
    </>
  )
}
