import { useMemo, useState } from "react"
import { useStore, type ViewId } from "../state/store"
import { formatCount } from "../lib/format"
import {
  Artist,
  Disc,
  Heart,
  Library,
  Music,
  Plus,
  Refresh,
  Settings,
  Trash,
} from "./Icons"
import "./Sidebar.css"

const SYSTEM_NAV: Array<{
  id: ViewId
  label: string
  icon: typeof Library
  playlistId?: string
}> = [
  { id: "library", label: "All Songs", icon: Library },
  { id: "albums", label: "Albums", icon: Disc },
  { id: "artists", label: "Artists", icon: Artist },
  { id: "favourites", label: "Favourites", icon: Heart, playlistId: "sys:favourites" },
]

export default function Sidebar() {
  const store = useStore()
  const {
    view,
    activePlaylistId,
    playlists,
    tracks,
    favourites,
    progress,
    setView,
    createPlaylist,
    deletePlaylist,
    rescan,
  } = store

  const [creating, setCreating] = useState(false)
  const [draftName, setDraftName] = useState("")

  const customPlaylists = useMemo(
    () => playlists.filter((p) => !p.system),
    [playlists],
  )

  const scanning = progress.phase === "walking" || progress.phase === "parsing"

  const isActive = (id: ViewId, playlistId?: string) =>
    view === id && (playlistId ? activePlaylistId === playlistId : true)

  async function submitNewPlaylist() {
    const name = draftName.trim()
    setCreating(false)
    setDraftName("")
    if (!name) return
    const playlist = await createPlaylist(name)
    setView("playlist", playlist.id)
  }

  const albumCount = useMemo(() => {
    const set = new Set<string>()
    for (const t of tracks) set.add(`${t.albumArtist}|${t.album}`)
    return set.size
  }, [tracks])

  const artistCount = useMemo(
    () => new Set(tracks.map((t) => t.artist)).size,
    [tracks],
  )

  return (
    <nav className="sidebar">
      <div className="sidebar-scroll">
        <ul className="nav-list">
          {SYSTEM_NAV.map((item) => {
            const IconComponent = item.icon
            const count =
              item.id === "library"
                ? tracks.length
                : item.id === "albums"
                  ? albumCount
                  : item.id === "artists"
                    ? artistCount
                    : favourites.size
            return (
              <li key={item.id}>
                <button
                  className={`nav-item ${isActive(item.id, item.playlistId) ? "active" : ""}`}
                  onClick={() => setView(item.id, item.playlistId ?? null)}
                >
                  <IconComponent size={17} />
                  <span className="truncate">{item.label}</span>
                  {count > 0 && <span className="nav-count">{count.toLocaleString()}</span>}
                </button>
              </li>
            )
          })}
        </ul>

        <div className="sidebar-section">
          <div className="sidebar-section-head">
            <span>Playlists</span>
            <button
              className="icon-btn sidebar-add"
              onClick={() => setCreating(true)}
              aria-label="New playlist"
              title="New playlist"
            >
              <Plus size={16} />
            </button>
          </div>

          {creating && (
            <input
              className="playlist-input"
              autoFocus
              value={draftName}
              placeholder="Playlist name"
              onChange={(e) => setDraftName(e.target.value)}
              onBlur={submitNewPlaylist}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submitNewPlaylist()
                if (e.key === "Escape") {
                  setCreating(false)
                  setDraftName("")
                }
              }}
            />
          )}

          {customPlaylists.length === 0 && !creating ? (
            <p className="sidebar-empty">No playlists yet</p>
          ) : (
            <ul className="nav-list">
              {customPlaylists.map((playlist) => (
                <li key={playlist.id} className="nav-row">
                  <button
                    className={`nav-item ${isActive("playlist", playlist.id) ? "active" : ""}`}
                    onClick={() => setView("playlist", playlist.id)}
                    onDoubleClick={() => {
                      const name = window.prompt("Rename playlist", playlist.name)
                      if (name?.trim()) void store.renamePlaylist(playlist.id, name.trim())
                    }}
                  >
                    <Music size={16} />
                    <span className="truncate">{playlist.name}</span>
                    <span className="nav-count">{playlist.trackIds.length}</span>
                  </button>
                  <button
                    className="icon-btn nav-delete"
                    onClick={() => {
                      if (window.confirm(`Delete "${playlist.name}"?`)) {
                        void deletePlaylist(playlist.id)
                      }
                    }}
                    aria-label={`Delete ${playlist.name}`}
                    title="Delete playlist"
                  >
                    <Trash size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="sidebar-foot">
        <button
          className="icon-btn sidebar-rescan"
          onClick={() => void rescan()}
          disabled={scanning}
          aria-label="Rescan library"
          title={scanning ? "Scanning…" : "Rescan library"}
        >
          <Refresh size={15} className={scanning ? "spin" : ""} />
        </button>
        <span className="sidebar-stat truncate">
          {scanning
            ? progress.phase === "walking"
              ? `Finding files… ${progress.found.toLocaleString()}`
              : `Reading tags… ${progress.parsed.toLocaleString()}/${progress.total.toLocaleString()}`
            : formatCount(tracks.length, "track")}
        </span>
        <button
          className={`icon-btn ${view === "settings" ? "on" : ""}`}
          onClick={() => setView("settings", null)}
          aria-label="Settings"
          title="Settings"
        >
          <Settings size={16} />
        </button>
      </div>
    </nav>
  )
}
