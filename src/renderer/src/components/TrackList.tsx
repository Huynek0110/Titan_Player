import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import type { Track } from "@shared/types"
import { useStore } from "../state/store"
import { formatDuration, compareStrings } from "../lib/format"
import Artwork from "./Artwork"
import ContextMenu, { type MenuAnchor, type MenuItem } from "./ContextMenu"
import {
  Disc,
  External,
  Grip,
  Heart,
  Lyrics,
  More,
  Music,
  Next,
  Play,
  Plus,
  Queue,
  Search,
  Trash,
} from "./Icons"
import "./TrackList.css"

/** Row height plus the flex gap, which together set the scroll pitch. */
const ROW_H = 60
/** Rows rendered beyond the viewport on each side, to hide scroll latency. */
const OVERSCAN = 6
/**
 * Width of the trailing action column. Two 28px buttons and a 1px gap, plus
 * slack for the equaliser, which is positioned rather than laid out so that
 * appearing and disappearing with the current track cannot shift the buttons.
 */
const ACTIONS_W = 92
/**
 * Under this many rows a header naming four sortable columns is ceremony: two of
 * the four cells are empty strings on almost every row, and the header costs
 * more vertical space than the list does.
 */
const SIMPLE_MAX = 4
/** Distance from the scroll container's edge at which a drag starts scrolling. */
const DRAG_EDGE = 48
/** Auto-scroll speed while dragging, in pixels per frame. */
const DRAG_SPEED = 18

export type SortKey = "title" | "artist" | "album" | "duration" | "added"

/**
 * Which empty case a list is in. "Your library is empty" and "nothing matched
 * that search" need different words and different actions, and collapsing them
 * into one grey disc and one sentence is what makes an app look unfinished.
 */
export type EmptyReason = "library" | "search" | "favourites" | "playlist"

interface TrackListProps {
  tracks: Track[]
  /** Enables drag-to-reorder and the remove affordance. */
  reorderable?: boolean
  onReorder?: (from: number, to: number) => void
  onRemove?: (index: number) => void
  /** Which empty case to render. Derived from the store's current view when omitted. */
  reason?: EmptyReason
  /** Overrides the empty case's body copy. */
  emptyMessage?: string
  /**
   * Whether audio is actually playing.
   *
   * The row equaliser is a running compositor animation, and it used to run for
   * the current track whether or not anything was playing. Not derivable from
   * the store — `usePlayer` owns the media element and only App holds a ref to
   * it — so App passes it down. Defaults to false, which is the cheap and
   * truthful default: a paused track shows a static glyph.
   */
  isPlaying?: boolean
}

/**
 * Open-menu state. The track is held by id, never by index: a scan landing, a
 * folder being added or a keystroke in the search box all rewrite `tracks`
 * underneath an open menu, and a positional index silently retargeted every
 * action at a different track — or rendered the menu empty.
 */
interface MenuState {
  anchor: MenuAnchor
  id: string
  /** Second level: the playlist picker, shown in place of the first. */
  level: "track" | "playlists"
  /** True while the inline "new playlist" field is showing. */
  draft: boolean
}

export default function TrackList({
  tracks,
  reorderable = false,
  onReorder,
  onRemove,
  reason,
  emptyMessage,
  isPlaying = false,
}: TrackListProps) {
  const store = useStore()
  const {
    currentTrack,
    queue,
    favourites,
    hidden,
    history,
    playlists,
    search,
    view,
    sortBy,
    sortDir,
    playTracks,
    enqueue,
    setPlaylistTracks,
    toggleFavourite,
    setHidden,
  } = store

  const scrollRef = useRef<HTMLDivElement>(null)
  const scrollObserverRef = useRef<ResizeObserver | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  /** Where a shift-click range starts. Kept across the range so dragging the
   *  selection further extends it from where it began, as it does everywhere else. */
  const [anchorIndex, setAnchorIndex] = useState<number | null>(null)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  /** A gap in the list, 0..total, measured in the list's own coordinates.
   *  `null` when there is no gap, or when the gap falls in a region the window
   *  has not mounted — in which case no row shows the indicator, which is
   *  correct: showing one on a row that is not adjacent to the pointer would be
   *  a lie about where the track will land. */
  const [dropBoundary, setDropBoundary] = useState<number | null>(null)
  const [draftName, setDraftName] = useState("")

  // --- windowing ---------------------------------------------------------
  // A fixed row height lets the visible window be computed arithmetically, so
  // a five-figure library costs the same as a short one.
  //
  // The observer is attached by a callback ref rather than a layout effect:
  // the scroll container only exists once `tracks` is non-empty, and the first
  // render is always empty, so an effect with `[]` deps bailed on a null ref and
  // `viewportH` stayed frozen at its initial guess for the life of the component.
  const [viewportH, setViewportH] = useState(600)

  const attachScroll = useCallback((node: HTMLDivElement | null) => {
    scrollRef.current = node
    if (!node) return
    setViewportH(node.clientHeight)
    const observer = new ResizeObserver(() => setViewportH(node.clientHeight))
    observer.observe(node)
    scrollObserverRef.current?.disconnect()
    scrollObserverRef.current = observer
  }, [])

  useEffect(() => () => scrollObserverRef.current?.disconnect(), [])

  const total = tracks.length
  /*
   * Clamp both ends, and order them.
   *
   * A stale `scrollTop` surviving a view switch would otherwise compute
   * `start > end` and render nothing. It was already clamped here for that
   * reason, but clamped to `total` — and `total` is one past the last index, so a
   * view with fewer tracks than the scroll position allowed put `start` exactly on
   * it and `slice(total, total)` came back empty. Switching from a scrolled
   * All Songs to a one-track view rendered a blank list under a correct heading,
   * which is the shape of a data bug and was not one.
   *
   * So the clamp is to `total - 1`, and `end` is floored at `start + 1`: whenever
   * there is at least one track there is always a row to draw.
   */
  const start =
    total === 0 ? 0 : Math.min(Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN), total - 1)
  const end = Math.min(
    total,
    Math.max(start + 1, Math.ceil((scrollTop + viewportH) / ROW_H) + OVERSCAN),
  )
  const slice = tracks.slice(start, end)
  const padTop = start * ROW_H
  const padBottom = Math.max(0, (total - end) * ROW_H)

  const scrollRaf = useRef(0)

  /**
   * Throttled to one update per frame. The scroll event fires far faster than
   * that, and each one used to re-render every visible row — each of which
   * builds a cover-art URL and writes several inline styles — which is where
   * the list's scroll jank came from.
   *
   * The spacer heights are written from state on the way through, never read
   * back off the element, so the scroll path never forces a synchronous layout.
   */
  const onScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget
    if (scrollRaf.current) return
    scrollRaf.current = requestAnimationFrame(() => {
      scrollRaf.current = 0
      setScrollTop(el.scrollTop)
    })
  }, [])

  useEffect(() => () => cancelAnimationFrame(scrollRaf.current), [])

  const isCurrent = useCallback(
    (track: Track) => currentTrack?.id === track.id,
    [currentTrack],
  )

  const isQueued = useCallback(
    (track: Track) => queue.includes(track.id),
    [queue],
  )

  /*
   * The play count and its skip count for one row.
   *
   * Read out of a prop rather than out of the store inside the row, because a row
   * that called `useStore()` itself would subscribe to every store change — and
   * the store re-derives the whole visible list on each `timeupdate`, so that is
   * a few hundred rows re-rendering four times a second to render a number that
   * changes once per track.
   */
  const listenRecord = useCallback(
    (trackId: string) => history[trackId],
    [history],
  )

  /*
   * The play count only means something in a browse view.
   *
   * On a playlist it is actively misleading: the list is a thing the user made,
   * and stamping "3×" on its rows puts a fact about their listening history into
   * the middle of it. And a number that increments while you are looking at the
   * list is a number you cannot trust to be there when you come back to it.
   */
  const showHistory = view !== "playlist"

  // --- sorting -----------------------------------------------------------
  const toggleSort = (key: SortKey) => {
    const dir = sortBy === key ? (sortDir === "asc" ? "desc" : "asc") : "asc"
    // One call. It persists the pair and dispatches both the settings and the
    // sort update, so also calling `setSort` was a second dispatch racing the
    // first with a direction computed from the pre-toggle value.
    void store.updateSettings({ sortBy: key, sortDir: dir })
  }

  const sortIndicator = (key: SortKey) =>
    sortBy !== key ? null : sortDir === "asc" ? "↑" : "↓"

  // --- selection ---------------------------------------------------------
  /*
   * `tracks` is a new array on almost every store change — the store re-derives
   * the visible list whenever the queue advances — so its identity says nothing
   * about whether the list on screen changed. Comparing the elements is nearly
   * free: an unchanged list hands back the very same Track objects, so this is a
   * pointer scan that exits on the first genuine difference. Without this, a
   * selection made in All Songs survived a trip to a playlist, and "Play" on the
   * selected rows queued a mixture of both views.
   */
  const prevTracks = useRef(tracks)
  useEffect(() => {
    const prev = prevTracks.current
    prevTracks.current = tracks
    if (prev === tracks) return
    if (prev.length === tracks.length && prev.every((t, i) => t === tracks[i])) return
    setSelected(new Set())
    setAnchorIndex(null)
    setMenu(null)
    setDragIndex(null)
    setDropBoundary(null)
    // Reset the ref too, not just the state: an abandoned drag would otherwise
    // commit against a list that is no longer the one it started on.
    dragRef.current.from = null
    dragRef.current.boundary = null
    // The new list is a different list, so the old offset means nothing. Keeping
    // it is how you get a blank pane — scrolled past the end of a three-track
    // playlist that used to be nine hundred.
    if (scrollRef.current) scrollRef.current.scrollTop = 0
    setScrollTop(0)
  }, [tracks])

  const selectRow = (index: number, event: React.MouseEvent) => {
    const track = tracks[index]
    if (!track) return
    if (event.shiftKey && anchorIndex !== null) {
      const [lo, hi] = anchorIndex <= index ? [anchorIndex, index] : [index, anchorIndex]
      setSelected(new Set(tracks.slice(lo, hi + 1).map((t) => t.id)))
      return
    }
    setAnchorIndex(index)
    if (event.metaKey || event.ctrlKey) {
      setSelected((prev) => {
        const next = new Set(prev)
        if (next.has(track.id)) next.delete(track.id)
        else next.add(track.id)
        return next
      })
    } else {
      setSelected(new Set([track.id]))
    }
  }

  const selectedTracks = useMemo(
    () => (selected.size ? tracks.filter((t) => selected.has(t.id)) : []),
    [selected, tracks],
  )

  // Ctrl/Cmd+A. Bail on any text field — the shell's search box is a real input
  // and must keep its own select-all — and while a menu is open, which is a
  // modal surface with its own key handling.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "a" && event.key !== "A") return
      if (!event.ctrlKey && !event.metaKey) return
      if (event.altKey) return
      const target = event.target as HTMLElement | null
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return
      }
      if (menu || total === 0) return
      event.preventDefault()
      setSelected(new Set(tracks.map((t) => t.id)))
      setAnchorIndex(0)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [tracks, total, menu])

  // --- context menu ------------------------------------------------------
  const closeMenu = useCallback(() => setMenu(null), [])

  const openMenu = (track: Track, event: React.MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    setDraftName("")
    setMenu({
      anchor: { x: event.clientX, y: event.clientY },
      id: track.id,
      level: "track",
      draft: false,
    })
  }

  // Memoised on identity, not recomputed per render: `findIndex` over a
  // ten-thousand track list on every scroll frame is 600k comparisons a second
  // for no reason.
  const menuIndex = useMemo(
    () => (menu ? tracks.findIndex((t) => t.id === menu.id) : -1),
    [menu, tracks],
  )

  // The list moved under the menu and took the track with it — a rescan that
  // dropped a deleted file, or a filter that no longer matches it. Close rather
  // than leave an empty menu floating.
  useEffect(() => {
    if (menu && menuIndex === -1) closeMenu()
  }, [menu, menuIndex, closeMenu])

  const menuItems = useMemo((): MenuItem[] => {
    const track = menuIndex >= 0 ? tracks[menuIndex] : null
    if (!menu || !track) return []

    const custom = playlists.filter((p) => !p.system)

    const addTo = async (playlistId: string) => {
      const target = playlists.find((p) => p.id === playlistId)
      if (!target) return
      await setPlaylistTracks(target.id, [...target.trackIds, track.id])
    }

    const createAndAdd = async () => {
      const name = draftName.trim()
      if (!name) return
      // Typing a name that already exists adds to that playlist rather than
      // producing "Road trip" and "road trip".
      const existing = custom.find((p) => compareStrings(p.name, name) === 0)
      if (existing) await addTo(existing.id)
      else {
        const created = await store.createPlaylist(name)
        await setPlaylistTracks(created.id, [track.id])
      }
      closeMenu()
    }

    /*
     * The second level replaces the first in place rather than opening beside
     * it. The menu keeps its measured position, the window listeners it already
     * installed stay valid, and its arrow-key navigation works on the new list
     * with no extra code.
     */
    if (menu.level === "playlists") {
      if (menu.draft) {
        return [
          {
            node: (
              <input
                className="context-input"
                autoFocus
                placeholder="Playlist name"
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault()
                    void createAndAdd()
                  } else if (e.key === "Escape") {
                    // Back to the list rather than all the way out.
                    e.preventDefault()
                    setMenu((m) => (m ? { ...m, draft: false } : m))
                  }
                }}
              />
            ),
          },
          {
            label: "Create and add",
            icon: <Plus size={14} />,
            disabled: draftName.trim().length === 0,
            onSelect: () => void createAndAdd(),
          },
          { separator: true },
          { label: "Cancel", onSelect: closeMenu },
        ]
      }
      return [
        {
          label: "Back",
          onSelect: () => setMenu((m) => (m ? { ...m, level: "track" } : m)),
        },
        ...(custom.length
          ? [
              { separator: true },
              ...custom.map((p) => ({
                label: p.name,
                icon: <Music size={14} />,
                onSelect: () => void addTo(p.id),
              })),
            ]
          : []),
        { separator: true },
        {
          label: "New playlist…",
          icon: <Plus size={14} />,
          onSelect: () => setMenu((m) => (m ? { ...m, draft: true } : m)),
        },
      ]
    }

    const isHidden = hidden.has(track.id)

    return [
      {
        label: "Play",
        icon: <Play size={14} />,
        onSelect: () => playTracks(tracks, menuIndex),
      },
      {
        label: "Play next",
        icon: <Next size={14} />,
        onSelect: () => enqueue([track.id], "next"),
      },
      {
        label: "Add to queue",
        icon: <Queue size={14} />,
        onSelect: () => enqueue([track.id], "end"),
      },
      { separator: true },
      {
        label: favourites.has(track.id) ? "Remove from favourites" : "Add to favourites",
        icon: <Heart size={14} filled={favourites.has(track.id)} />,
        onSelect: () => void toggleFavourite(track.id),
      },
      {
        label: "Show lyrics",
        icon: <Lyrics size={14} />,
        disabled: track.lyrics.source === "none",
        onSelect: () => {
          playTracks(tracks, menuIndex)
          store.setNowPlaying(true)
        },
      },
      { separator: true },
      {
        // Always present. It used to be hidden whenever the user had no
        // playlists, which is precisely the new user who needs it — and it fell
        // back to window.prompt, a Win32 dialog with none of this app's styling.
        label: "Add to playlist",
        icon: <Plus size={14} />,
        onSelect: () => setMenu((m) => (m ? { ...m, level: "playlists" } : m)),
      },
      {
        label: isHidden ? "Show in library" : "Hide from library",
        // No "unhide" glyph exists in the shared icon set, and borrowing a
        // delete icon for a restore action would be a lie. The label carries it.
        icon: isHidden ? undefined : <Trash size={14} />,
        danger: !isHidden,
        onSelect: () => void setHidden(track.id, !isHidden),
      },
      {
        label: "Show in Explorer",
        icon: <External size={14} />,
        onSelect: () => void window.titan.revealInExplorer(track.path),
      },
      ...(reorderable && onRemove
        ? [
            { separator: true },
            {
              label: "Remove from this playlist",
              icon: <Trash size={14} />,
              danger: true,
              onSelect: () => onRemove(menuIndex),
            },
          ]
        : []),
    ]
  }, [
    menu,
    menuIndex,
    tracks,
    playlists,
    favourites,
    hidden,
    draftName,
    reorderable,
    onRemove,
    store,
    playTracks,
    enqueue,
    toggleFavourite,
    setPlaylistTracks,
    setHidden,
    closeMenu,
  ])

  // --- drag to reorder ---------------------------------------------------
  /**
   * The live drag, mirrored in a ref.
   *
   * Not just an optimisation. The pointer position is sampled in a
   * `requestAnimationFrame` loop and `drop` can arrive before the state update
   * that carried the last sample has committed, so a commit reading `state` is a
   * commit reading a value that is one frame stale — which on a fast drag past
   * the end of a list means dropping on the wrong row.
   */
  const dragRef = useRef<{ from: number | null; boundary: number | null; total: number }>({
    from: null,
    boundary: null,
    total,
  })

  const startDrag = (index: number) => {
    dragRef.current.from = index
    dragRef.current.boundary = index
    setDragIndex(index)
    setDropBoundary(index)
  }

  const commitDrop = useCallback(() => {
    const { from, boundary, total: count } = dragRef.current
    if (from !== null && boundary !== null) {
      /*
       * `boundary` is a gap in the list as it stands. Taking the dragged row out
       * shifts every gap below it up by one, so a boundary that sat under the
       * source has to come back up by one to stay in the same place.
       *
       * Without that correction the indicator — drawn on the row's *top* edge,
       * i.e. "insert here" — and the result disagreed: dropping on row 3 put the
       * row after row 3.
       */
      const target = boundary - (from < boundary ? 1 : 0)
      if (target !== from && target >= 0 && target < count) onReorder?.(from, target)
    }
    dragRef.current.from = null
    dragRef.current.boundary = null
    setDragIndex(null)
    setDropBoundary(null)
  }, [onReorder])

  // The list can change length mid-drag; the drop maths has to see the new count.
  useEffect(() => {
    dragRef.current.total = total
  }, [total])

  useEffect(() => {
    if (dragIndex === null) return
    const el = scrollRef.current
    if (!el) return

    // The body's own top padding, read once per drag. The pitch arithmetic
    // below assumes the content box starts this far below the container.
    const padTop = parseFloat(getComputedStyle(el).paddingTop) || 0

    let pointerY: number | null = null
    let raf = 0

    const frame = () => {
      raf = requestAnimationFrame(frame)
      if (pointerY === null) return

      const rect = el.getBoundingClientRect()

      /*
       * Auto-scroll, and the drop index, both come from the pointer's own Y
       * measured against the scroll container — never from `dragover` firing on
       * a row. Only mounted rows exist, and there is no row above or below the
       * visible window to fire on, so a drag simply stopped at the edge: in a
       * nine-hundred track playlist you could not reach past the last row you
       * could see. Reading the container instead makes every index in the list a
       * target, mounted or not, and it doubles as the auto-scroll trigger.
       */
      const before = el.scrollTop
      if (pointerY < rect.top + DRAG_EDGE) el.scrollTop = before - DRAG_SPEED
      else if (pointerY > rect.bottom - DRAG_EDGE) el.scrollTop = before + DRAG_SPEED
      if (el.scrollTop !== before) setScrollTop(el.scrollTop)

      const y = pointerY - rect.top - padTop + el.scrollTop
      // Nearest gap, so the top half of a row means "before it" and the bottom
      // half means "after it", which is what the indicator line then shows.
      const boundary = Math.max(0, Math.min(dragRef.current.total, Math.round(y / ROW_H)))
      dragRef.current.boundary = boundary
      setDropBoundary((prev) => (prev === boundary ? prev : boundary))
    }

    const onDragOver = (event: DragEvent) => {
      pointerY = event.clientY
      // Without this the browser treats every element under the pointer as an
      // invalid target: the cursor shows "no drop" and `drop` never fires.
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move"
    }

    // `drop` bubbles to the window, so this catches the drop even when the row
    // that started the drag has scrolled out of the window and unmounted. A
    // native HTML5 drag also never delivers `pointerup` to the source row —
    // Chromium fires `pointercancel` and suppresses the compatibility mouse
    // events for the rest of the drag — so committing from `pointerup` silently
    // never ran and the row stayed stuck at 40% opacity.
    const finish = () => commitDrop()

    window.addEventListener("dragover", onDragOver)
    window.addEventListener("drop", finish)
    window.addEventListener("dragend", finish)
    raf = requestAnimationFrame(frame)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener("dragover", onDragOver)
      window.removeEventListener("drop", finish)
      window.removeEventListener("dragend", finish)
    }
  }, [dragIndex, commitDrop])

  // --- empty and short lists --------------------------------------------
  // Derived rather than passed, so a plain `<TrackList tracks={visibleTracks} />`
  // in App gets the right case for whatever view it is standing in.
  const emptyReason: EmptyReason =
    reason ??
    (search.trim()
      ? "search"
      : view === "favourites"
        ? "favourites"
        : view === "playlist"
          ? "playlist"
          : "library")

  if (total === 0) {
    return (
      <EmptyState
        reason={emptyReason}
        body={emptyMessage}
        query={search.trim()}
        scanning={store.progress.phase === "walking" || store.progress.phase === "parsing"}
        found={store.progress.found}
        onAddFolder={() => void store.addFolder()}
        onRescan={() => void store.rescan()}
        onClearSearch={() => store.setSearch("")}
      />
    )
  }

  // A one- or two-row list renders as a centred list of artwork, title, artist
  // and a play button, with no sortable header to describe cells that are almost
  // all empty strings.
  if (total < SIMPLE_MAX) {
    return (
      <div className="tracklist tracklist-compact">
        <div className="tracklist-simple">
          {tracks.map((track, index) => {
            const record = listenRecord(track.id)
            const plays = record?.plays ?? 0
            const skips = record?.skips ?? 0
            return (
            <div
              key={track.id}
              data-id={track.id}
              className={[
                "simple-row",
                isCurrent(track) ? "current" : "",
                selected.has(track.id) ? "selected" : "",
                hidden.has(track.id) ? "is-hidden" : "",
                dragIndex === index ? "dragging" : "",
                dropBoundary === index && dragIndex !== index ? "drop-top" : "",
                dropBoundary === total && index === total - 1 && dragIndex !== index
                  ? "drop-bottom"
                  : "",
              ]
                .filter(Boolean)
                .join(" ")}
              onClick={(e) => selectRow(index, e)}
              onDoubleClick={() => playTracks(tracks, index)}
              onContextMenu={(e) => openMenu(track, e)}
              draggable={reorderable}
              onDragStart={() => startDrag(index)}
            >
              <div className="row-art">
                <Artwork
                  trackId={track.id}
                  hasArtwork={track.hasArtwork}
                  alt={track.title}
                  size={44}
                  seed={track.title}
                />
                <button
                  className="row-play"
                  onClick={(e) => {
                    e.stopPropagation()
                    playTracks(tracks, index)
                  }}
                  aria-label={`Play ${track.title}`}
                >
                  <Play size={15} />
                </button>
              </div>

              <div className="row-text simple-text">
                {/*
                  The same play count as the full list, for the same reason: a
                  count that appears on every track in a long library and then
                  vanishes as soon as the list shortens is a feature that looks
                  broken rather than one that is merely laid out differently.
                */}
                {showHistory && plays > 0 && (
                  <span
                    className="row-plays tabular"
                    title={`Played ${plays} time${plays === 1 ? "" : "s"} · ${
                      plays === 1 ? "skipped 0 times" : `skipped ${skips} times`
                    }`}
                  >
                    {plays}×
                  </span>
                )}
                <span className="row-title truncate">{track.title}</span>
                <span className="row-sub truncate">{track.artist}</span>
              </div>

              <span className="row-actions">
                <button
                  className={`icon-btn ${favourites.has(track.id) ? "on" : ""}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    void toggleFavourite(track.id)
                  }}
                  aria-label="Toggle favourite"
                >
                  <Heart size={15} filled={favourites.has(track.id)} />
                </button>
                <button
                  className="icon-btn"
                  onClick={(e) => openMenu(track, e)}
                  aria-label="More actions"
                >
                  <More size={15} />
                </button>
              </span>
            </div>
            )
          })}
        </div>

        <SelectionBar
          selectedTracks={selectedTracks}
          onQueue={() => {
            enqueue(selectedTracks.map((t) => t.id), "end")
            setSelected(new Set())
          }}
          onPlay={() => {
            playTracks(selectedTracks, 0)
            setSelected(new Set())
          }}
        />

        <ContextMenu anchor={menu?.anchor ?? null} items={menuItems} onClose={closeMenu} />
      </div>
    )
  }

  // --- the table ---------------------------------------------------------
  return (
    <div className="tracklist">
      {/*
        The same grid as the rows, with an empty cell where the artwork column
        is. A spacer matched to the row's left padding is not enough: the row's
        first text column starts 44px of artwork plus an 11px gap further in, so
        the label sat over the cover art.
      */}
      <div className="tracklist-head" style={{ gridTemplateColumns: columnsCss(reorderable) }}>
        {reorderable && <span className="th" aria-hidden="true" />}
        <span className="th" aria-hidden="true" />
        <button className="th sortable" onClick={() => toggleSort("title")}>
          Title {sortIndicator("title")}
        </button>
        <button className="th sortable" onClick={() => toggleSort("artist")}>
          Artist {sortIndicator("artist")}
        </button>
        <button className="th sortable" onClick={() => toggleSort("album")}>
          Album {sortIndicator("album")}
        </button>
        <button className="th sortable right" onClick={() => toggleSort("duration")}>
          {sortIndicator("duration") ? <span>{sortIndicator("duration")} Time</span> : <span>Time</span>}
        </button>
        <span className="th" />
      </div>

      <div
        className="tracklist-body"
        ref={attachScroll}
        onScroll={onScroll}
        // Only clears the selection for a genuine background click. Row clicks
        // bubble through here too, and React batches both updates, so an
        // unconditional clear made multi-select impossible.
        onClick={(e) => {
          if (e.target === e.currentTarget) {
            setSelected(new Set())
            setAnchorIndex(null)
          }
        }}
      >
        <div style={{ height: padTop }} />
        {slice.map((track, i) => {
          const index = start + i
          const current = isCurrent(track)
          const queued = isQueued(track)
          const record = listenRecord(track.id)
          const plays = record?.plays ?? 0
          const skips = record?.skips ?? 0
          return (
            <div
              key={track.id}
              /*
               * The track id in the DOM.
               *
               * Probes identify a row by its visible text, which is ambiguous the
               * moment a library has two tracks with the same title — and the
               * listening history is keyed by id, so "the row called Intenpol" is
               * not enough to say which record was written.
               */
              data-id={track.id}
              className={[
                "row",
                current ? "current" : "",
                selected.has(track.id) ? "selected" : "",
                hidden.has(track.id) ? "is-hidden" : "",
                dragIndex === index ? "dragging" : "",
                dropBoundary === index && dragIndex !== index ? "drop-top" : "",
                dropBoundary === total && index === total - 1 && dragIndex !== index
                  ? "drop-bottom"
                  : "",
              ]
                .filter(Boolean)
                .join(" ")}
              style={{ gridTemplateColumns: columnsCss(reorderable) }}
              onClick={(e) => selectRow(index, e)}
              onDoubleClick={() => playTracks(tracks, index)}
              onContextMenu={(e) => openMenu(track, e)}
              draggable={reorderable}
              onDragStart={() => startDrag(index)}
            >
              {reorderable && (
                <span className="row-grip" aria-hidden="true">
                  <Grip size={15} />
                </span>
              )}

              <div className="row-art">
                <Artwork
                  trackId={track.id}
                  hasArtwork={track.hasArtwork}
                  alt={track.title}
                  size={44}
                  seed={track.title}
                />
                <button
                  className="row-play"
                  onClick={(e) => {
                    e.stopPropagation()
                    playTracks(tracks, index)
                  }}
                  aria-label={`Play ${track.title}`}
                >
                  <Play size={15} />
                </button>
              </div>

              <div className="row-text">
                <div className="row-titleline">
                  {track.trackNo !== null && (
                    <span className="row-no tabular">{track.trackNo}</span>
                  )}
                  <span className="row-title truncate">{track.title}</span>
                  {hidden.has(track.id) && (
                    <span className="row-hidden-chip">hidden</span>
                  )}
                  {/*
                    How often this has been played.

                    Only once it has been played, and only in the library view —
                    the count is a fact about the listener, not about a playlist,
                    and a number that changes as you listen would be wrong on a
                    list the user is editing by hand. It is dimmed until hover so
                    it does not compete with the title for the eye.
                  */}
                  {showHistory && plays > 0 && (
                    <span
                      className="row-plays tabular"
                      title={`Played ${plays} time${plays === 1 ? "" : "s"} · ${
                        plays === 1 ? "skipped 0 times" : `skipped ${skips} times`
                      }`}
                    >
                      {plays}×
                    </span>
                  )}
                </div>
                {track.lyrics.source !== "none" && (
                  <Lyrics size={11} className="row-lyric-flag" />
                )}
              </div>

              <span className="row-cell truncate">{track.artist}</span>
              <span className="row-cell truncate">{track.album}</span>

              <span className="row-cell right tabular">
                {formatDuration(track.duration)}
              </span>

              <span className="row-actions">
                {queued && current ? (
                  <span
                    className={`row-eq ${isPlaying ? "live" : ""}`}
                    aria-label={isPlaying ? "Now playing" : "Paused"}
                  >
                    <i />
                    <i />
                    <i />
                  </span>
                ) : null}
                <button
                  className={`icon-btn ${favourites.has(track.id) ? "on" : ""}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    void toggleFavourite(track.id)
                  }}
                  aria-label="Toggle favourite"
                >
                  <Heart size={15} filled={favourites.has(track.id)} />
                </button>
                <button
                  className="icon-btn"
                  onClick={(e) => openMenu(track, e)}
                  aria-label="More actions"
                >
                  <More size={15} />
                </button>
              </span>
            </div>
          )
        })}
        <div style={{ height: padBottom }} />
      </div>

      <SelectionBar
        selectedTracks={selectedTracks}
        onQueue={() => {
          enqueue(selectedTracks.map((t) => t.id), "end")
          setSelected(new Set())
        }}
        onPlay={() => {
          playTracks(selectedTracks, 0)
          setSelected(new Set())
        }}
      />

      <ContextMenu anchor={menu?.anchor ?? null} items={menuItems} onClose={closeMenu} />
    </div>
  )
}

/**
 * Identical track and header grids. The artwork is its own column so the
 * "TITLE" label lands on the titles rather than 53px to their left.
 */
function columnsCss(reorderable: boolean): string {
  return reorderable
    ? `32px 44px minmax(180px, 2.6fr) minmax(130px, 1.3fr) minmax(130px, 1.3fr) 66px ${ACTIONS_W}px`
    : `44px minmax(220px, 2.6fr) minmax(130px, 1.3fr) minmax(130px, 1.3fr) 66px ${ACTIONS_W}px`
}

function SelectionBar({
  selectedTracks,
  onQueue,
  onPlay,
}: {
  selectedTracks: Track[]
  onQueue: () => void
  onPlay: () => void
}) {
  if (selectedTracks.length === 0) return null
  return (
    <div className="tracklist-selection glass">
      <span className="tabular">{selectedTracks.length} selected</span>
      <button className="pill" onClick={onQueue}>
        <Queue size={14} /> Queue
      </button>
      <button className="pill" onClick={onPlay}>
        <Play size={13} /> Play
      </button>
    </div>
  )
}

interface EmptyStateProps {
  reason: EmptyReason
  body?: string
  query: string
  scanning: boolean
  found: number
  onAddFolder: () => void
  onRescan: () => void
  onClearSearch: () => void
}

/**
 * Four different empty situations, four different answers.
 *
 * They used to share one grey disc and one sentence, which made the very first
 * thing a new user saw — an empty library — indistinguishable from a search that
 * happened to find nothing, and gave no route out of either.
 */
function EmptyState({
  reason,
  body,
  query,
  scanning,
  found,
  onAddFolder,
  onRescan,
  onClearSearch,
}: EmptyStateProps) {
  if (scanning) {
    return (
      <Shell icon={<Disc size={30} />} title="Reading your library" body={found > 0
        ? `Found ${found.toLocaleString()} file${found === 1 ? "" : "s"} so far…`
        : "Walking your music folders…"} />
    )
  }

  if (reason === "search") {
    return (
      <Shell
        icon={<Search size={26} />}
        title={query ? `Nothing matches “${query}”` : "Nothing to search"}
        body={
          body ??
          "Search covers titles, artists, albums, genres, track numbers and years. Diacritics are optional — “muoi” finds “Mười”."
        }
        actions={[{ label: "Clear search", onSelect: onClearSearch }]}
      />
    )
  }

  if (reason === "favourites") {
    return (
      <Shell
        icon={<Heart size={26} />}
        title="No favourites yet"
        body={
          body ??
          "Tap the heart on any track to collect it here. Favourites are kept as their own list, so you can play them without touching anything else."
        }
      />
    )
  }

  if (reason === "playlist") {
    return (
      <Shell
        icon={<Music size={26} />}
        title="This playlist is empty"
        body={body ?? "Right-click any track and choose Add to playlist to put it here."}
      />
    )
  }

  return (
    <Shell
      icon={<Music size={30} />}
      title="No music here yet"
      body={
        body ??
        "Titan Player reads the folders on this machine, not a streaming service. Point it at the folder your music is in, and make sure it holds files it recognises — mp3, flac, m4a, aac, ogg, opus, wav."
      }
      actions={[
        { label: "Add a music folder", onSelect: onAddFolder, primary: true },
        { label: "Rescan", onSelect: onRescan },
      ]}
    />
  )
}

function Shell({
  icon,
  title,
  body,
  actions,
}: {
  icon: ReactNode
  title: string
  body?: string
  actions?: Array<{ label: string; onSelect: () => void; primary?: boolean }>
}) {
  return (
    <div className="tracklist-empty">
      <span className="tracklist-empty-mark">{icon}</span>
      <h2>{title}</h2>
      {body && <p>{body}</p>}
      {actions && actions.length > 0 && (
        <div className="tracklist-empty-actions">
          {actions.map((action) => (
            <button
              key={action.label}
              className={`pill ${action.primary ? "primary" : ""}`}
              onClick={action.onSelect}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
