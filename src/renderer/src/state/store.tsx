import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react"
import type {
  LibrarySettings,
  Playlist,
  ScanFailure,
  ScanProgress,
  Track,
} from "@shared/types"
import { compareStrings, foldSearch } from "../lib/format"

export type ViewId = "library" | "albums" | "artists" | "favourites" | "playlist" | "settings"

export interface State {
  ready: boolean
  tracks: Track[]
  byId: Map<string, Track>
  settings: LibrarySettings | null
  playlists: Playlist[]
  favourites: Set<string>
  /** Track ids the user hid from the browse views. */
  hidden: Set<string>
  progress: ScanProgress
  failedCount: number
  /** Per-file detail behind `failedCount`, so the cause is actionable. */
  failed: ScanFailure[]
  /**
   * Set when the main process could not reach a configured folder. Stays until a
   * fully clean scan, because that is the case where playlists and favourites
   * were deliberately left stale and the user needs to know.
   */
  scanError: string | null
  lastScanMs: number

  view: ViewId
  activePlaylistId: string | null
  /** Ids queued for playback, in play order. */
  queue: string[]
  /** Index into `queue` of the playing track. */
  queueIndex: number
  /** True when `queue` was built by shuffling, so "next" is not "next in list". */
  shuffled: boolean
  /** The queue as it was before shuffling, so the toggle can be undone. */
  queueOrder: string[] | null
  sortBy: LibrarySettings["sortBy"]
  sortDir: "asc" | "desc"
  search: string
  nowPlayingOpen: boolean
  showQueue: boolean
  error: string | null
}

type Action =
  | {
      type: "ready"
      settings: LibrarySettings
      playlists: Playlist[]
      favourites: string[]
      hidden: string[]
    }
  | { type: "scan:progress"; progress: ScanProgress }
  | { type: "scan:done"; tracks: Track[]; failed: ScanFailure[]; ms: number }
  | { type: "view"; view: ViewId; playlistId?: string | null }
  | { type: "sort"; sortBy?: State["sortBy"]; sortDir?: State["sortDir"] }
  | { type: "search"; search: string }
  | { type: "play"; queue: string[]; index: number; shuffled?: boolean }
  | { type: "queue:step"; delta: number }
  | { type: "queue:move"; from: number; to: number }
  | { type: "queue:shuffle"; on: boolean; ordered?: string[] | null }
  | { type: "queue:jump"; index: number }
  | { type: "queue:add"; ids: string[]; position?: "next" | "end" }
  | { type: "queue:removeAt"; index: number }
  | { type: "queue:clear" }
  | { type: "playlists:set"; playlists: Playlist[] }
  | { type: "favourites:set"; favourites: string[] }
  | { type: "hidden:set"; hidden: string[] }
  | { type: "scan:error-cleared" }
  | { type: "settings:set"; settings: LibrarySettings }
  | { type: "nowPlaying"; open: boolean }
  | { type: "showQueue"; open: boolean }
  | { type: "error"; message: string | null }

const initial: State = {
  ready: false,
  tracks: [],
  byId: new Map(),
  settings: null,
  playlists: [],
  favourites: new Set(),
  hidden: new Set(),
  progress: { phase: "idle", found: 0, parsed: 0, total: 0 },
  failedCount: 0,
  failed: [],
  scanError: null,
  lastScanMs: 0,
  view: "library",
  activePlaylistId: null,
  queue: [],
  queueIndex: -1,
  shuffled: false,
  queueOrder: null,
  sortBy: "title",
  sortDir: "asc",
  search: "",
  nowPlayingOpen: false,
  showQueue: false,
  error: null,
}

/** Keep the current track playing as the queue mutates around it. */
function reindex(queue: string[], index: number, currentId: string | null): number {
  if (!currentId) return Math.min(index, queue.length - 1)
  const found = queue.indexOf(currentId)
  if (found !== -1) return found
  return Math.min(Math.max(index, 0), queue.length - 1)
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "ready":
      return {
        ...state,
        ready: true,
        settings: action.settings,
        playlists: action.playlists,
        favourites: new Set(action.favourites),
        hidden: new Set(action.hidden),
        sortBy: action.settings.sortBy,
        sortDir: action.settings.sortDir,
        view: (action.settings.lastView as ViewId) ?? "library",
        // Only Favourites carries a built-in playlist id. A custom playlist has
        // to be restored explicitly, or a relaunch landed on the "playlist" view
        // with no id: an empty list under the heading "Playlist", with nothing
        // highlighted in the sidebar.
        activePlaylistId:
          action.settings.lastView === "favourites"
            ? "sys:favourites"
            : action.settings.lastView === "playlist"
              ? action.settings.lastPlaylistId
              : null,
      }

    case "scan:progress":
      return {
        ...state,
        progress: action.progress,
        // A progress event that reports a problem is the only place the main
        // process can tell the renderer that a configured folder was
        // unreachable, and it is the only warning that playlists and favourites
        // were deliberately left alone. Hold it in state so it survives the
        // `scan:done` that lands a task later, and so it is visible from any
        // view rather than only while a component happens to be mounted.
        scanError: action.progress.phase === "error" ? action.progress.error ?? null : state.scanError,
      }

    case "scan:done": {
      const byId = new Map(action.tracks.map((t) => [t.id, t]))
      // Drop queued tracks that no longer exist on disk.
      const queue = state.queue.filter((id) => byId.has(id))
      const currentId = state.queueIndex >= 0 ? state.queue[state.queueIndex] : null
      return {
        ...state,
        tracks: action.tracks,
        byId,
        queue,
        queueIndex: reindex(queue, state.queueIndex, currentId),
        failedCount: action.failed.length,
        // Keep the detail, not just the count. "12 could not be read" tells the
        // user nothing they can act on; the per-file reason is what makes it
        // fixable, and Settings can now list it.
        failed: action.failed,
        lastScanMs: action.ms,
        // Only a fully clean scan clears the warning. A partial one that reached
        // fewer folders than configured is exactly the case that must stay
        // visible, so it is not treated as success.
        scanError: action.failed.length > 0 ? state.scanError : null,
        // A successful scan clears any earlier failure, so the error panel
        // cannot sit on top of a working library.
        error: null,
        progress: { phase: "done", found: action.tracks.length, parsed: action.tracks.length, total: action.tracks.length },
      }
    }

    case "view":
      return {
        ...state,
        view: action.view,
        activePlaylistId: action.playlistId === undefined ? state.activePlaylistId : action.playlistId,
      }

    case "sort":
      return {
        ...state,
        sortBy: action.sortBy ?? state.sortBy,
        sortDir: action.sortDir ?? state.sortDir,
      }

    case "search":
      return { ...state, search: action.search }

    case "play":
      // Deliberately does not open the now-playing overlay. It covers the
      // transport, so opening it on every row click meant double-clicking a
      // track to listen removed play/pause/next/volume from the screen.
      return {
        ...state,
        queue: action.queue,
        queueIndex: action.index,
        shuffled: action.shuffled ?? false,
        queueOrder: action.shuffled ? action.queue : null,
      }

    case "queue:step": {
      const next = state.queueIndex + action.delta
      if (next < 0 || next >= state.queue.length) return state
      return { ...state, queueIndex: next }
    }

    case "queue:move": {
      const { from, to } = action
      if (from === to) return state
      if (from < 0 || from >= state.queue.length) return state
      // Clamp rather than reject: dragging past either end should drop at the
      // end, which is what every list reorder does. Rejecting it instead makes
      // the last row of a queue undroppable.
      const target = Math.max(0, Math.min(state.queue.length - 1, to))
      const currentId = state.queueIndex >= 0 ? state.queue[state.queueIndex] : null
      const queue = [...state.queue]
      const [moved] = queue.splice(from, 1)
      queue.splice(target, 0, moved)
      // Re-resolve the index by id: the playing track must keep playing even
      // though its position moved.
      return { ...state, queue, queueIndex: reindex(queue, state.queueIndex, currentId) }
    }

    /*
     * Shuffle re-orders the queue that is already loaded rather than just
     * flipping a flag. Two rules keep it honest:
     *
     *  - The playing track has to stay playing.
     *  - The rows before the current index are history and the rows after it are
     *    still ahead, so neither is shuffled.
     *
     * Turning shuffle *off* restores the order the queue was built in. It cannot
     * be reconstructed from the current view: the queue may hold tracks from
     * several views, and rebuilding it from whatever list happens to be on
     * screen silently dropped everything that was not in that list. The
     * original order is therefore kept alongside the queue.
     */
    case "queue:shuffle": {
      if (state.queueIndex < 0 || state.queue.length < 2) return { ...state, shuffled: action.on }

      const currentId = state.queue[state.queueIndex]
      const before = state.queue.slice(0, state.queueIndex)
      const after = state.queue.slice(state.queueIndex + 1)

      const upcoming = action.on
        ? shuffleArray(after)
        : // `ordered` is the queue as it was before shuffling, not a view list.
          (action.ordered ?? state.queue).filter(
            (id) => id !== currentId && !before.includes(id) && state.byId.has(id),
          )

      return {
        ...state,
        shuffled: action.on,
        queue: [...before, currentId, ...upcoming],
        // Remember the unshuffled order so the toggle is reversible.
        queueOrder: action.on ? state.queueOrder ?? state.queue : state.queue,
      }
    }

    case "queue:jump":
      if (action.index < 0 || action.index >= state.queue.length) return state
      return { ...state, queueIndex: action.index }

    case "queue:add": {
      if (action.ids.length === 0) return state
      const currentId = state.queueIndex >= 0 ? state.queue[state.queueIndex] : null
      const additions = action.ids.filter((id) => state.byId.has(id))
      if (additions.length === 0) return state

      // Re-adding an already-queued track is a no-op rather than a duplicate.
      const fresh = additions.filter((id) => !state.queue.includes(id))
      if (fresh.length === 0) return state
      const without = state.queue.filter((id) => !fresh.includes(id))

      // The insertion index must be computed against `without`, not the original
      // queue: the latter is longer by however many additions were already
      // present, which pushed the slice past the end and appended instead.
      let at: number
      if (action.position === "next" && state.queueIndex >= 0) {
        const currentPos = without.indexOf(currentId ?? "")
        at = (currentPos === -1 ? Math.min(state.queueIndex, without.length) : currentPos) + 1
      } else {
        at = without.length
      }

      const queue = [...without.slice(0, at), ...fresh, ...without.slice(at)]
      return { ...state, queue, queueIndex: reindex(queue, state.queueIndex, currentId) }
    }

    case "queue:removeAt": {
      if (action.index < 0 || action.index >= state.queue.length) return state
      const currentId = state.queueIndex === action.index ? null : state.queue[state.queueIndex]
      const queue = state.queue.filter((_, i) => i !== action.index)
      let queueIndex = state.queueIndex
      if (action.index < state.queueIndex) queueIndex -= 1
      else if (action.index === state.queueIndex) queueIndex = Math.min(queueIndex, queue.length - 1)
      return { ...state, queue, queueIndex: reindex(queue, queueIndex, currentId) }
    }

    case "queue:clear":
      return { ...state, queue: [], queueIndex: -1 }

    case "playlists:set":
      return { ...state, playlists: action.playlists }

    case "favourites:set":
      return { ...state, favourites: new Set(action.favourites) }

    case "hidden:set":
      return { ...state, hidden: new Set(action.hidden) }

    case "scan:error-cleared":
      return state.scanError === null ? state : { ...state, scanError: null }

    case "settings:set":
      return { ...state, settings: action.settings }

    case "nowPlaying":
      return { ...state, nowPlayingOpen: action.open }

    case "showQueue":
      return { ...state, showQueue: action.open }

    case "error":
      return { ...state, error: action.message }

    default:
      return state
  }
}

export interface Store extends State {
  playTracks: (tracks: Track[], startIndex: number, shuffled?: boolean) => void
  /** Re-order the current queue in place, or restore album order. */
  setShuffle: (on: boolean) => void
  playNext: () => void
  playPrev: () => void
  jumpTo: (index: number) => void
  enqueue: (ids: string[], position?: "next" | "end") => void
  removeFromQueue: (index: number) => void
  /** Drag-to-reorder within the queue. Indices are clamped, not rejected. */
  moveInQueue: (from: number, to: number) => void
  clearQueue: () => void
  rescan: () => Promise<void>
  setView: (view: ViewId, playlistId?: string | null) => void
  setSort: (sortBy?: State["sortBy"], sortDir?: State["sortDir"]) => void
  setSearch: (search: string) => void
  setNowPlaying: (open: boolean) => void
  setShowQueue: (open: boolean) => void
  dismissError: () => void
  /** Persist a settings patch. Resolves with the merged settings as stored. */
  updateSettings: (patch: Partial<LibrarySettings>) => Promise<LibrarySettings>
  createPlaylist: (name: string) => Promise<Playlist>
  renamePlaylist: (id: string, name: string) => Promise<void>
  setPlaylistTracks: (id: string, trackIds: string[]) => Promise<void>
  deletePlaylist: (id: string) => Promise<void>
  toggleFavourite: (trackId: string) => Promise<void>
  /** Hide a track from the browse views, or bring it back. */
  setHidden: (trackId: string, hidden: boolean) => Promise<void>
  addFolder: () => Promise<void>
  removeFolder: (folder: string) => Promise<void>
  /** Tracks for the current view, filtered by search and sorted. */
  visibleTracks: Track[]
  /** Per-file scan failures from the last scan. */
  failed: ScanFailure[]
  /** Why a configured folder was unreachable, if one was. */
  scanError: string | null
  clearScanError: () => void
  currentTrack: Track | null
  queueTracks: Track[]
  /** Ids hidden from the browse views. */
  hidden: Set<string>
}

const StoreContext = createContext<Store | null>(null)

function shuffleArray<T>(items: T[]): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initial)
  // A ref mirrors the queue so callbacks can read it without re-subscribing.
  const stateRef = useRef(state)
  stateRef.current = state

  // --- bootstrap ---------------------------------------------------------
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [settings, playlists, favourites, hidden] = await Promise.all([
          window.titan.getSettings(),
          window.titan.getPlaylists(),
          window.titan.getFavourites(),
          window.titan.getHidden(),
        ])
        if (cancelled) return
        dispatch({ type: "ready", settings, playlists, favourites, hidden })
        // Pass the freshly fetched settings through, so the first scan does not
        // depend on a re-render having happened yet.
        await scan(settings)
      } catch (err) {
        if (!cancelled) {
          dispatch({ type: "error", message: err instanceof Error ? err.message : String(err) })
        }
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    return window.titan.onScanProgress((progress: ScanProgress) =>
      dispatch({ type: "scan:progress", progress }),
    )
  }, [])

  const scan = useCallback(async (settingsOverride?: LibrarySettings) => {
    // Read through the ref, but allow the caller to pass the settings it just
    // fetched. On a cold start the reducer has not re-rendered yet, so the ref
    // still holds null and the first scan would silently do nothing — leaving
    // the audio protocol's root set empty and nothing playable.
    const current = settingsOverride ?? stateRef.current.settings
    if (!current) return
    try {
      const result = await window.titan.scan(current.musicFolders, current.extensions)
      dispatch({
        type: "scan:done",
        tracks: result.tracks,
        failed: result.failed,
        ms: result.durationMs,
      })
    } catch (err) {
      dispatch({ type: "error", message: err instanceof Error ? err.message : String(err) })
    }
  }, [])

  const rescan = useCallback(async () => {
    dispatch({ type: "scan:progress", progress: { phase: "walking", found: 0, parsed: 0, total: 0 } })
    await scan()
  }, [scan])

  /** Re-read the playlist list from the main process, the single source of truth. */
  const refreshPlaylists = useCallback(async () => {
    const playlists = await window.titan.getPlaylists()
    dispatch({ type: "playlists:set", playlists })
  }, [])

  /** Persist settings and keep the renderer's copy in step. */
  const store_updateSettings = useCallback(async (patch: Partial<LibrarySettings>) => {
    const settings = await window.titan.updateSettings(patch)
    dispatch({ type: "settings:set", settings })
    if (patch.sortBy || patch.sortDir) {
      dispatch({ type: "sort", sortBy: patch.sortBy, sortDir: patch.sortDir })
    }
    return settings
  }, [])

  // --- playback ----------------------------------------------------------
  const playTracks = useCallback((tracks: Track[], startIndex: number, shuffled = false) => {
    if (tracks.length === 0) return
    let queue = tracks.map((t) => t.id)
    let index = startIndex
    if (shuffled) {
      // Keep the chosen track first, shuffle the remainder.
      const first = queue[startIndex]
      const rest = shuffleArray(queue.filter((_, i) => i !== startIndex))
      queue = [first, ...rest]
      index = 0
    }
    dispatch({ type: "play", queue, index, shuffled })
  }, [])

  const enqueue = useCallback((ids: string[], position: "next" | "end" = "end") => {
    dispatch({ type: "queue:add", ids, position })
  }, [])

  const value = useMemo<Store>(() => {
    const currentTrack = state.queueIndex >= 0 ? (state.byId.get(state.queue[state.queueIndex]) ?? null) : null

    // Derive the visible list for the current view.
    let base: Track[]
    switch (state.view) {
      case "favourites":
        base = state.tracks.filter((t) => state.favourites.has(t.id))
        break
      case "playlist": {
        const playlist = state.playlists.find((p) => p.id === state.activePlaylistId)
        base = playlist
          ? playlist.trackIds
              .map((id) => state.byId.get(id))
              .filter((t): t is Track => Boolean(t))
          : []
        break
      }
      case "albums":
      case "artists":
        base = state.tracks
        break
      default:
        base = state.tracks
    }

    // "Hide from library" removes a track from the browse views but leaves it
    // reachable where it was explicitly asked for: a favourite, or a member of a
    // playlist. Hiding is for a bad rip or a spoken intro that pollutes the album
    // view, not for silencing a track the user deliberately curated somewhere.
    if (state.hidden.size > 0) {
      const activeIds =
        state.view === "playlist"
          ? new Set(
              state.playlists.find((p) => p.id === state.activePlaylistId)?.trackIds ?? [],
            )
          : null
      base = base.filter(
        (t) => !state.hidden.has(t.id) || state.favourites.has(t.id) || activeIds?.has(t.id),
      )
    }

    // Search folds diacritics, so "muoi" finds "Mười" and "nguyen" finds
    // "Nguyễn". Without it a Vietnamese library is effectively unsearchable by
    // anyone not typing every mark perfectly. Genre and track number are folded
    // in too, since both are natural things to look for.
    const query = foldSearch(state.search.trim())
    const searched = query
      ? base.filter((t) => {
          if (foldSearch(t.title).includes(query)) return true
          if (foldSearch(t.artist).includes(query)) return true
          if (foldSearch(t.album).includes(query)) return true
          if (t.genre.some((g) => foldSearch(g).includes(query))) return true
          if (t.trackNo !== null && String(t.trackNo) === query) return true
          if (t.year !== null && String(t.year).includes(query)) return true
          return false
        })
      : base

    // Playlists keep their own hand-made order; everything else is sorted.
    const sorted =
      state.view === "playlist" && state.activePlaylistId !== "sys:favourites"
        ? searched
        : [...searched].sort((a, b) => {
            const dir = state.sortDir === "asc" ? 1 : -1
            switch (state.sortBy) {
              case "artist":
                return compareStrings(a.artist, b.artist) * dir || compareStrings(a.title, b.title)
              case "album":
                return (
                  compareStrings(a.album, b.album) * dir ||
                  (a.discNo ?? 0) - (b.discNo ?? 0) ||
                  (a.trackNo ?? 0) - (b.trackNo ?? 0)
                )
              case "duration":
                return (a.duration - b.duration) * dir
              case "added":
                return (Date.parse(a.addedAt) - Date.parse(b.addedAt)) * dir
              default:
                return (
                  compareStrings(a.title, b.title) * dir ||
                  compareStrings(a.artist, b.artist)
                )
            }
          })

    return {
      ...state,
      visibleTracks: sorted,
      currentTrack,
      failed: state.failed,
      scanError: state.scanError,
      clearScanError: () => dispatch({ type: "scan:error-cleared" }),
      /** Hidden ids, so a row can render its own hidden state. */
      hidden: state.hidden,
      queueTracks: state.queue
        .map((id) => state.byId.get(id))
        .filter((t): t is Track => Boolean(t)),
      playTracks,
      enqueue,
      playNext: () => dispatch({ type: "queue:step", delta: 1 }),
      playPrev: () => dispatch({ type: "queue:step", delta: -1 }),
      setShuffle: (on) => {
        dispatch({ type: "queue:shuffle", on, ordered: stateRef.current.queueOrder })
        // Persist through the store so the renderer's own copy of settings is
        // updated. Calling the bridge directly left `settings.shuffle` stale,
        // which made the toggle one-way: it could only ever switch shuffle on.
        void store_updateSettings({ shuffle: on })
      },
      jumpTo: (index: number) => dispatch({ type: "queue:jump", index }),
      removeFromQueue: (index: number) => dispatch({ type: "queue:removeAt", index }),
      moveInQueue: (from, to) => dispatch({ type: "queue:move", from, to }),
      clearQueue: () => dispatch({ type: "queue:clear" }),
      rescan,
      setView: (view, playlistId) => {
        const id = playlistId === undefined ? stateRef.current.activePlaylistId : playlistId
        dispatch({ type: "view", view, playlistId: id })
        // Persist both halves. Saving only the view meant a relaunch restored
        // `view: "playlist"` with a null id and rendered an empty library.
        void store_updateSettings({
          lastView: view,
          lastPlaylistId: id ?? null,
        }).catch(() => {})
      },
      setSort: (sortBy, sortDir) => dispatch({ type: "sort", sortBy, sortDir }),
      setSearch: (search) => dispatch({ type: "search", search }),
      setNowPlaying: (open) => dispatch({ type: "nowPlaying", open }),
      setShowQueue: (open) => dispatch({ type: "showQueue", open }),
      dismissError: () => dispatch({ type: "error", message: null }),
      updateSettings: store_updateSettings,
      /*
       * Playlist mutations re-read the whole list from the main process instead
       * of patching the renderer's copy.
       *
       * `stateRef.current` is only refreshed when React commits, so a mutation
       * that dispatches and is immediately followed by another one — duplicate a
       * playlist, or create one and then fill it — read a list that predated the
       * first call and wrote it back with the new playlist missing. The playlist
       * then vanished from the sidebar. Making the main process the single source
       * of truth removes that whole class of bug, and the list is small.
       */
      createPlaylist: async (name) => {
        const playlist = await window.titan.createPlaylist(name)
        await refreshPlaylists()
        return playlist
      },
      renamePlaylist: async (id, name) => {
        const updated = await window.titan.updatePlaylist(id, { name })
        if (!updated) return
        await refreshPlaylists()
      },
      setPlaylistTracks: async (id, trackIds) => {
        const updated = await window.titan.updatePlaylist(id, { trackIds })
        if (!updated) return
        await refreshPlaylists()
      },
      deletePlaylist: async (id) => {
        const ok = await window.titan.deletePlaylist(id)
        if (!ok) return
        dispatch({
          type: "playlists:set",
          playlists: stateRef.current.playlists.filter((p) => p.id !== id),
        })
        if (stateRef.current.activePlaylistId === id) {
          dispatch({ type: "view", view: "library", playlistId: null })
        }
      },
      toggleFavourite: async (trackId) => {
        const favourites = await window.titan.toggleFavourite(trackId)
        dispatch({ type: "favourites:set", favourites })
      },
      setHidden: async (trackId, hidden) => {
        // The queue is deliberately left alone. Hiding a track is about keeping
        // it out of the browse views, not about stopping playback, so hiding the
        // currently playing track must not interrupt it.
        const next = await window.titan.setHidden(trackId, hidden)
        dispatch({ type: "hidden:set", hidden: next })
      },
      addFolder: async () => {
        const picked = await window.titan.pickFolders()
        if (picked.length === 0) return
        const current = stateRef.current.settings
        if (!current) return
        const merged = [...new Set([...current.musicFolders, ...picked])]
        const settings = await window.titan.updateSettings({ musicFolders: merged })
        dispatch({ type: "settings:set", settings })
        // Hand the scan the settings just written. Letting it read the ref
        // instead meant it re-scanned the *previous* folder list, so a newly
        // added folder stayed invisible until Rescan was pressed by hand.
        await scan(settings)
      },
      removeFolder: async (folder) => {
        const current = stateRef.current.settings
        if (!current) return
        const next = current.musicFolders.filter((f) => f !== folder)
        const settings = await window.titan.updateSettings({ musicFolders: next })
        dispatch({ type: "settings:set", settings })
        await scan(settings)
      },
    }
  }, [state, playTracks, enqueue, rescan])

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
}

export function useStore(): Store {
  const store = useContext(StoreContext)
  if (!store) throw new Error("useStore must be used inside <StoreProvider>")
  return store
}
