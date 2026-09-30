import { useCallback, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react"
import { useStore, type ViewId } from "../state/store"
import { formatCount } from "../lib/format"
import type { Playlist } from "@shared/types"
import {
  Artist,
  Close,
  Disc,
  Heart,
  Library,
  More,
  Music,
  Plus,
  Refresh,
  Settings,
  Trash,
  Waveform,
} from "./Icons"
import ContextMenu, { type MenuAnchor, type MenuItem } from "./ContextMenu"
import { useGlassSurface } from "../lib/glass"
import "./Sidebar.css"

const SYSTEM_NAV: Array<{
  id: ViewId
  label: string
  icon: typeof Library
  playlistId?: string
}> = [
  { id: "library", label: "All Songs", icon: Library },
  { id: "recent", label: "Recently Played", icon: Waveform },
  { id: "albums", label: "Albums", icon: Disc },
  { id: "artists", label: "Artists", icon: Artist },
  { id: "favourites", label: "Favourites", icon: Heart, playlistId: "sys:favourites" },
]

export default function Sidebar() {
  const store = useStore()
  /*
   * Liquid Glass on the app's main chrome.
   *
   * This rail had no backdrop filter at all, and deliberately: a full-height
   * blur behind the navigation caused a second large Gaussian pass on every frame
   * of a window resize, which is what made maximising stutter.
   *
   * The reason for removing it does not apply to what replaced it. That was a
   * `backdrop-filter` that was *declared once and never transitioned* on a
   * surface whose backdrop is the ambient wash -- a soft, static gradient that
   * changes only when the track changes. This is a displacement map, and it is
   * regenerated only when the element's own size changes, so the filter itself
   * is stable. The claim is measured, not assumed: `probe-glass-perf.mjs` resizes
   * the window with this rail live and reads the frame times, and
   * `scripts/README.md` records the numbers.
   *
   * A weak displacement on purpose. This is a tall, mostly-empty surface: a
   * strong rim bend on a rectangle that shape stops reading as glass and starts
   * reading as a funhouse mirror along its two long edges.
   */
  const railRef = useGlassSurface<HTMLElement>({
    displacement: 30,
    chromatic: false,
    extra: "blur(14px) saturate(1.5)",
    flat: 0.16,
  })
  const {
    view,
    activePlaylistId,
    playlists,
    tracks,
    favourites,
    progress,
    setView,
    createPlaylist,
    renamePlaylist,
    setPlaylistTracks,
    deletePlaylist,
    rescan,
  } = store

  const [creating, setCreating] = useState(false)
  const [draftName, setDraftName] = useState("")
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState("")
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ anchor: MenuAnchor; id: string } | null>(null)

  /*
   * The name as last committed, for each of the two inline fields.
   *
   * A blur has to decide between "the user is done with this" and "the user
   * clicked something unrelated". Comparing against the last committed value
   * answers that without any timing assumptions, and — because the value is
   * written *before* the IPC round trip — it also absorbs the blur that fires
   * while that round trip is still in flight, which is what used to create a
   * second playlist from one Enter.
   */
  const committedDraft = useRef<string | null>(null)
  const committedRename = useRef<string | null>(null)
  const submittingCreate = useRef(false)

  const customPlaylists = useMemo(() => playlists.filter((p) => !p.system), [playlists])

  const scanning = progress.phase === "walking" || progress.phase === "parsing"

  const isActive = (id: ViewId, playlistId?: string) =>
    view === id && (playlistId ? activePlaylistId === playlistId : true)

  function resetCreate() {
    setCreating(false)
    setDraftName("")
    committedDraft.current = null
  }

  async function submitNewPlaylist() {
    /*
     * Re-entrancy guard, and not just for the blur. A double Enter, or an Enter
     * followed by the blur that the input's own unmount provokes, both reach this
     * function inside a single task — and `resetCreate` only *schedules* the
     * render that clears `draftName`, so both calls would read the same name out
     * of the same closure and create it twice.
     */
    if (submittingCreate.current) return
    submittingCreate.current = true
    const name = draftName.trim()
    // Recorded before awaiting, not after, so a blur that lands while the IPC
    // round trip is still in flight compares equal and bails out.
    committedDraft.current = name
    resetCreate()
    try {
      if (!name) return
      const playlist = await createPlaylist(name)
      setView("playlist", playlist.id)
    } finally {
      submittingCreate.current = false
    }
  }

  /** A blur commits only a draft the user actually changed. */
  function onCreateBlur() {
    if (draftName.trim() === (committedDraft.current ?? "")) return
    void submitNewPlaylist()
  }

  const startRename = useCallback((playlist: Playlist) => {
    setRenamingId(playlist.id)
    setRenameDraft(playlist.name)
    committedRename.current = playlist.name
    setConfirmingId(null)
    setMenu(null)
  }, [])

  function cancelRename() {
    committedRename.current = renameDraft.trim()
    setRenamingId(null)
  }

  const commitRename = useCallback(
    async (id: string) => {
      const previous = committedRename.current
      const name = renameDraft.trim()
      committedRename.current = name
      setRenamingId(null)
      // An empty or unchanged name is a cancel, not a request to blank a
      // playlist out of the store.
      if (!name || name === previous) return
      await renamePlaylist(id, name)
    },
    [renameDraft, renamePlaylist],
  )

  function onRenameBlur(id: string) {
    if (renameDraft.trim() === (committedRename.current ?? "")) {
      setRenamingId(null)
      return
    }
    void commitRename(id)
  }

  const duplicatePlaylist = useCallback(
    async (playlist: Playlist) => {
      /*
       * Two store calls, because that is what the store offers. The second has
       * to run *after* the first has landed in state: `createPlaylist` appends
       * and `setPlaylistTracks` maps over the list it reads, so firing them back
       * to back meant the mapping ran against a list that did not contain the
       * copy yet, and the copy vanished from the sidebar until a relaunch.
       *
       * No view change on the way out — the request was for a copy, not a
       * navigation, and the new row appearing in the sidebar is the feedback.
       */
      const copy = await createPlaylist(`${playlist.name} copy`)
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      await setPlaylistTracks(copy.id, [...playlist.trackIds])
    },
    [createPlaylist, setPlaylistTracks],
  )

  const menuItems = useMemo<MenuItem[]>(() => {
    if (!menu) return []
    const target = playlists.find((p) => p.id === menu.id)
    if (!target) return []
    return [
      { label: "Rename", onSelect: () => startRename(target) },
      { label: "Duplicate", onSelect: () => void duplicatePlaylist(target) },
      { separator: true },
      {
        label: "Delete",
        danger: true,
        onSelect: () => {
          /*
           * Two inline steps instead of `window.confirm`. Deleting is
           * irreversible and is the one action here a field cannot undo, so it
           * gets a deliberate second click — and it gets one drawn by this app,
           * not a Win32 dialog that looks like a different program opened behind
           * the player.
           */
          setConfirmingId(target.id)
          setMenu(null)
        },
      },
    ]
  }, [menu, playlists, startRename, duplicatePlaylist])

  const closeMenu = useCallback(() => setMenu(null), [])

  /**
   * Keep the row's buttons from stealing focus.
   *
   * The "new playlist" field sits directly above the list, and clicking any of a
   * row's buttons moved focus out of it — which committed the draft, so pressing
   * Delete on a playlist three rows down quietly created a playlist. Cancelling
   * the default mousedown behaviour holds focus where it was, so the draft
   * survives and nothing is created.
   */
  const holdFocus = (event: ReactMouseEvent) => event.preventDefault()

  const albumCount = useMemo(() => {
    const set = new Set<string>()
    for (const t of tracks) set.add(`${t.albumArtist}|${t.album}`)
    return set.size
  }, [tracks])

  const artistCount = useMemo(() => new Set(tracks.map((t) => t.artist)).size, [tracks])

  return (
    <nav className="sidebar" ref={railRef}>
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
              onClick={() => {
                resetCreate()
                setCreating(true)
              }}
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
              onBlur={onCreateBlur}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  void submitNewPlaylist()
                }
                if (e.key === "Escape") {
                  e.preventDefault()
                  resetCreate()
                }
              }}
            />
          )}

          {customPlaylists.length === 0 && !creating ? (
            <p className="sidebar-empty">No playlists yet</p>
          ) : (
            <ul className="nav-list">
              {customPlaylists.map((playlist) => {
                const isRenaming = renamingId === playlist.id
                const isConfirming = confirmingId === playlist.id
                return (
                  <li
                    key={playlist.id}
                    className={`nav-row ${isConfirming ? "confirming" : ""}`}
                  >
                    {isRenaming ? (
                      <input
                        className="playlist-input"
                        autoFocus
                        value={renameDraft}
                        onChange={(e) => setRenameDraft(e.target.value)}
                        onBlur={() => onRenameBlur(playlist.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault()
                            void commitRename(playlist.id)
                          }
                          if (e.key === "Escape") {
                            e.preventDefault()
                            cancelRename()
                          }
                        }}
                      />
                    ) : (
                      <>
                        <button
                          className={`nav-item ${isActive("playlist", playlist.id) ? "active" : ""}`}
                          onClick={() => setView("playlist", playlist.id)}
                          onDoubleClick={() => startRename(playlist)}
                          title={`${playlist.name} — double-click to rename`}
                        >
                          <Music size={16} />
                          <span className="truncate">{playlist.name}</span>
                          <span className="nav-count">{playlist.trackIds.length}</span>
                        </button>

                        {isConfirming ? (
                          <span className="nav-confirm" onMouseDown={holdFocus}>
                            <button
                              className="nav-confirm-yes"
                              onClick={() => {
                                setConfirmingId(null)
                                void deletePlaylist(playlist.id)
                              }}
                              title={`Delete ${playlist.name} for good`}
                            >
                              Sure?
                            </button>
                            <button
                              className="icon-btn nav-confirm-no"
                              onClick={() => setConfirmingId(null)}
                              aria-label={`Cancel deleting ${playlist.name}`}
                              title="Cancel"
                            >
                              <Close size={13} />
                            </button>
                          </span>
                        ) : (
                          <span className="nav-affordances" onMouseDown={holdFocus}>
                            <button
                              className="icon-btn nav-more"
                              onClick={(e) => {
                                const box = e.currentTarget.getBoundingClientRect()
                                setConfirmingId(null)
                                setMenu({ id: playlist.id, anchor: { x: box.left, y: box.bottom + 4 } })
                              }}
                              aria-label={`More options for ${playlist.name}`}
                              title="More"
                            >
                              <More size={15} />
                            </button>
                            <button
                              className="icon-btn nav-delete"
                              onClick={() => setConfirmingId(playlist.id)}
                              aria-label={`Delete ${playlist.name}`}
                              title="Delete playlist"
                            >
                              <Trash size={14} />
                            </button>
                          </span>
                        )}
                      </>
                    )}
                  </li>
                )
              })}
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

      <ContextMenu anchor={menu?.anchor ?? null} items={menuItems} onClose={closeMenu} />
    </nav>
  )
}
