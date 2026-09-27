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
  ScanProgress,
  Track,
} from "@shared/types"
import { compareStrings } from "../lib/format"

export type ViewId = "library" | "albums" | "artists" | "favourites" | "playlist" | "settings"

export interface State {
  ready: boolean
  tracks: Track[]
  byId: Map<string, Track>
  settings: LibrarySettings | null
  playlists: Playlist[]
  favourites: Set<string>
  progress: ScanProgress
  failedCount: number
  lastScanMs: number

  view: ViewId
  activePlaylistId: string | null
  /** Ids queued for playback, in play order. */
  queue: string[]
  /** Index into `queue` of the playing track. */
  queueIndex: number
  /** True when `queue` was built by shuffling, so "next" is not "next in list". */
  shuffled: boolean
  sortBy: LibrarySettings["sortBy"]
  sortDir: "asc" | "desc"
  search: string
  nowPlayingOpen: boolean
  showQueue: boolean
  error: string | null
}

type Action =
  | { type: "ready"; settings: LibrarySettings; playlists: Playlist[]; favourites: string[] }
  | { type: "scan:progress"; progress: ScanProgress }
  | { type: "scan:done"; tracks: Track[]; failed: number; ms: number }
  | { type: "view"; view: ViewId; playlistId?: string | null }
  | { type: "sort"; sortBy?: State["sortBy"]; sortDir?: State["sortDir"] }
  | { type: "search"; search: string }
  | { type: "play"; queue: string[]; index: number; shuffled?: boolean }
  | { type: "queue:replace"; queue: string[]; index: number }
  | { type: "queue:step"; delta: number }
  | { type: "queue:jump"; index: number }
  | { type: "queue:add"; ids: string[]; position?: "next" | "end" }
  | { type: "queue:removeAt"; index: number }
  | { type: "queue:clear" }
  | { type: "playlists:set"; playlists: Playlist[] }
  | { type: "favourites:set"; favourites: string[] }
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
  progress: { phase: "idle", found: 0, parsed: 0, total: 0 },
  failedCount: 0,
  lastScanMs: 0,
  view: "library",
  activePlaylistId: null,
  queue: [],
  queueIndex: -1,
  shuffled: false,
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
        sortBy: action.settings.sortBy,
        sortDir: action.settings.sortDir,
        view: (action.settings.lastView as ViewId) ?? "library",
      }

    case "scan:progress":
      return { ...state, progress: action.progress }

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
        failedCount: action.failed,
        lastScanMs: action.ms,
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
      return {
        ...state,
        queue: action.queue,
        queueIndex: action.index,
        shuffled: action.shuffled ?? false,
        nowPlayingOpen: true,
      }

    case "queue:replace":
      return { ...state, queue: action.queue, queueIndex: action.index }

    case "queue:step": {
      const next = state.queueIndex + action.delta
      if (next < 0 || next >= state.queue.length) return state
      return { ...state, queueIndex: next }
    }

    case "queue:jump":
      if (action.index < 0 || action.index >= state.queue.length) return state
      return { ...state, queueIndex: action.index }

    case "queue:add": {
      if (action.ids.length === 0) return state
      const currentId = state.queueIndex >= 0 ? state.queue[state.queueIndex] : null
      const without = state.queue.filter((id) => !action.ids.includes(id))
      const additions = action.ids.filter((id) => state.byId.has(id))
      if (additions.length === 0) return state
      // "Next" inserts directly after the playing track, preserving its order.
      const at = action.position === "next" && state.queueIndex >= 0 ? state.queueIndex + 1 : without.length
      const queue = [...without.slice(0, at), ...additions, ...without.slice(at)]
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
  playNext: () => void
  playPrev: () => void
  jumpTo: (index: number) => void
  enqueue: (ids: string[], position?: "next" | "end") => void
  removeFromQueue: (index: number) => void
  clearQueue: () => void
  rescan: () => Promise<void>
  setView: (view: ViewId, playlistId?: string | null) => void
  setSort: (sortBy?: State["sortBy"], sortDir?: State["sortDir"]) => void
  setSearch: (search: string) => void
  setNowPlaying: (open: boolean) => void
  setShowQueue: (open: boolean) => void
  updateSettings: (patch: Partial<LibrarySettings>) => Promise<void>
  createPlaylist: (name: string) => Promise<Playlist>
  renamePlaylist: (id: string, name: string) => Promise<void>
  setPlaylistTracks: (id: string, trackIds: string[]) => Promise<void>
  deletePlaylist: (id: string) => Promise<void>
  toggleFavourite: (trackId: string) => Promise<void>
  addFolder: () => Promise<void>
  removeFolder: (folder: string) => Promise<void>
  /** Tracks for the current view, filtered by search and sorted. */
  visibleTracks: Track[]
  currentTrack: Track | null
  queueTracks: Track[]
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
        const [settings, playlists, favourites] = await Promise.all([
          window.titan.getSettings(),
          window.titan.getPlaylists(),
          window.titan.getFavourites(),
        ])
        if (cancelled) return
        dispatch({ type: "ready", settings, playlists, favourites })
        await scan()
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

  const scan = useCallback(async () => {
    const current = stateRef.current.settings
    if (!current) return
    try {
      const result = await window.titan.scan(current.musicFolders, current.extensions)
      dispatch({
        type: "scan:done",
        tracks: result.tracks,
        failed: result.failed.length,
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

    const query = state.search.trim().toLowerCase()
    const searched = query
      ? base.filter(
          (t) =>
            t.title.toLowerCase().includes(query) ||
            t.artist.toLowerCase().includes(query) ||
            t.album.toLowerCase().includes(query),
        )
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
      queueTracks: state.queue
        .map((id) => state.byId.get(id))
        .filter((t): t is Track => Boolean(t)),
      playTracks,
      enqueue,
      playNext: () => dispatch({ type: "queue:step", delta: 1 }),
      playPrev: () => dispatch({ type: "queue:step", delta: -1 }),
      jumpTo: (index: number) => dispatch({ type: "queue:jump", index }),
      removeFromQueue: (index: number) => dispatch({ type: "queue:removeAt", index }),
      clearQueue: () => dispatch({ type: "queue:clear" }),
      rescan,
      setView: (view, playlistId) => {
        dispatch({ type: "view", view, playlistId })
        const current = stateRef.current.settings
        if (current) void window.titan.updateSettings({ lastView: view })
      },
      setSort: (sortBy, sortDir) => dispatch({ type: "sort", sortBy, sortDir }),
      setSearch: (search) => dispatch({ type: "search", search }),
      setNowPlaying: (open) => dispatch({ type: "nowPlaying", open }),
      setShowQueue: (open) => dispatch({ type: "showQueue", open }),
      updateSettings: async (patch) => {
        const settings = await window.titan.updateSettings(patch)
        dispatch({ type: "settings:set", settings })
        if (patch.sortBy || patch.sortDir) {
          dispatch({ type: "sort", sortBy: patch.sortBy, sortDir: patch.sortDir })
        }
      },
      createPlaylist: async (name) => {
        const playlist = await window.titan.createPlaylist(name)
        dispatch({ type: "playlists:set", playlists: [...stateRef.current.playlists, playlist] })
        return playlist
      },
      renamePlaylist: async (id, name) => {
        const updated = await window.titan.updatePlaylist(id, { name })
        if (!updated) return
        dispatch({
          type: "playlists:set",
          playlists: stateRef.current.playlists.map((p) => (p.id === id ? updated : p)),
        })
      },
      setPlaylistTracks: async (id, trackIds) => {
        const updated = await window.titan.updatePlaylist(id, { trackIds })
        if (!updated) return
        dispatch({
          type: "playlists:set",
          playlists: stateRef.current.playlists.map((p) => (p.id === id ? updated : p)),
        })
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
      addFolder: async () => {
        const picked = await window.titan.pickFolders()
        if (picked.length === 0) return
        const current = stateRef.current.settings
        if (!current) return
        const merged = [...new Set([...current.musicFolders, ...picked])]
        await window.titan.updateSettings({ musicFolders: merged })
        dispatch({ type: "settings:set", settings: { ...current, musicFolders: merged } })
        await rescan()
      },
      removeFolder: async (folder) => {
        const current = stateRef.current.settings
        if (!current) return
        const next = current.musicFolders.filter((f) => f !== folder)
        const settings = await window.titan.updateSettings({ musicFolders: next })
        dispatch({ type: "settings:set", settings })
        await rescan()
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
