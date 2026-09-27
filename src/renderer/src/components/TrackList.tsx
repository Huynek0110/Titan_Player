import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { Track } from "@shared/types"
import { useStore } from "../state/store"
import { formatDuration, compareStrings } from "../lib/format"
import Artwork from "./Artwork"
import ContextMenu, { type MenuAnchor, type MenuItem } from "./ContextMenu"
import {
  Disc,
  Grip,
  Heart,
  Info,
  Lyrics,
  More,
  Next,
  Play,
  Plus,
  Queue,
  Trash,
} from "./Icons"
import "./TrackList.css"

const ROW_H = 52
/** Rows rendered beyond the viewport on each side, to hide scroll latency. */
const OVERSCAN = 6

export type SortKey = "title" | "artist" | "album" | "duration" | "added"

interface TrackListProps {
  tracks: Track[]
  /** Enables drag-to-reorder and the remove affordance. */
  reorderable?: boolean
  onReorder?: (from: number, to: number) => void
  onRemove?: (index: number) => void
  /** Shown when there is nothing to play. */
  emptyMessage?: string
}

export default function TrackList({
  tracks,
  reorderable = false,
  onReorder,
  onRemove,
  emptyMessage = "No tracks here yet",
}: TrackListProps) {
  const store = useStore()
  const {
    currentTrack,
    queue,
    favourites,
    sortBy,
    sortDir,
    setSort,
    playTracks,
    enqueue,
    setPlaylistTracks,
    toggleFavourite,
  } = store

  const scrollRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportH, setViewportH] = useState(600)
  const [menu, setMenu] = useState<{ anchor: MenuAnchor; index: number } | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)

  // --- windowing ---------------------------------------------------------
  // A fixed row height lets the visible window be computed arithmetically, so
  // a five-figure library costs the same as a short one.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const observer = new ResizeObserver(() => setViewportH(el.clientHeight))
    observer.observe(el)
    setViewportH(el.clientHeight)
    return () => observer.disconnect()
  }, [])

  const total = tracks.length
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN)
  const end = Math.min(total, Math.ceil((scrollTop + viewportH) / ROW_H) + OVERSCAN)
  const slice = tracks.slice(start, end)
  const padTop = start * ROW_H
  const padBottom = Math.max(0, (total - end) * ROW_H)

  const isCurrent = useCallback(
    (track: Track) => currentTrack?.id === track.id,
    [currentTrack],
  )

  const isQueued = useCallback(
    (track: Track) => queue.includes(track.id),
    [queue],
  )

  // --- sorting -----------------------------------------------------------
  const toggleSort = (key: SortKey) => {
    if (sortBy === key) {
      void store.updateSettings({ sortDir: sortDir === "asc" ? "desc" : "asc" })
    } else {
      void store.updateSettings({ sortBy: key, sortDir: "asc" })
    }
    setSort(key, sortBy === key ? (sortDir === "asc" ? "desc" : "asc") : "asc")
  }

  const sortIndicator = (key: SortKey) =>
    sortBy !== key ? null : sortDir === "asc" ? "↑" : "↓"

  // --- selection ---------------------------------------------------------
  const toggleSelect = (id: string, additive: boolean) => {
    setSelected((prev) => {
      const next = additive ? new Set(prev) : new Set<string>()
      if (prev.has(id) && additive) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectedTracks = useMemo(
    () => (selected.size ? tracks.filter((t) => selected.has(t.id)) : []),
    [selected, tracks],
  )

  // --- context menu ------------------------------------------------------
  const openMenu = (index: number, event: React.MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    setMenu({ anchor: { x: event.clientX, y: event.clientY }, index })
  }

  const menuItems = useMemo((): MenuItem[] => {
    if (!menu) return []
    const track = tracks[menu.index]
    if (!track) return []
    const isFav = favourites.has(track.id)

    const custom = store.playlists.filter((p) => !p.system)

    return [
      {
        label: "Play",
        icon: <Play size={14} />,
        onSelect: () => playTracks(tracks, menu.index),
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
        label: isFav ? "Remove from favourites" : "Add to favourites",
        icon: <Heart size={14} filled={isFav} />,
        onSelect: () => void toggleFavourite(track.id),
      },
      {
        label: "Show lyrics",
        icon: <Lyrics size={14} />,
        disabled: track.lyrics.source === "none",
        onSelect: () => {
          playTracks(tracks, menu.index)
          store.setNowPlaying(true)
        },
      },
      { separator: true },
      ...(custom.length
        ? [
            {
              label: "Add to playlist",
              icon: <Plus size={14} />,
              onSelect: async () => {
                const name = window.prompt("Add to which playlist? Enter a new name:", "")
                if (!name?.trim()) return
                const existing = custom.find(
                  (p) => compareStrings(p.name, name.trim()) === 0,
                )
                if (existing) {
                  await setPlaylistTracks(existing.id, [...existing.trackIds, track.id])
                } else {
                  const created = await store.createPlaylist(name.trim())
                  await setPlaylistTracks(created.id, [track.id])
                }
                store.setView("playlist", existing?.id ?? null)
              },
            },
          ]
        : []),
      {
        label: "Show in Explorer",
        icon: <Info size={14} />,
        onSelect: () => void window.titan.revealInExplorer(track.path),
      },
      ...(reorderable && onRemove
        ? [
            { separator: true },
            {
              label: "Remove from this playlist",
              icon: <Trash size={14} />,
              danger: true,
              onSelect: () => onRemove(menu.index),
            },
          ]
        : []),
    ]
  }, [menu, tracks, favourites, reorderable, onRemove, store, playTracks, enqueue, toggleFavourite, setPlaylistTracks])

  // --- drag to reorder ---------------------------------------------------
  const onDragStart = (index: number) => {
    setDragIndex(index)
  }

  const onDragOverRow = (index: number) => {
    if (dragIndex === null) return
    setDropIndex(index)
  }

  const commitDrop = () => {
    if (dragIndex !== null && dropIndex !== null && dragIndex !== dropIndex) {
      onReorder?.(dragIndex, dropIndex)
    }
    setDragIndex(null)
    setDropIndex(null)
  }

  // Clear a stale drag when the pointer is released outside any row.
  useEffect(() => {
    if (dragIndex === null) return
    const onUp = () => commitDrop()
    window.addEventListener("pointerup", onUp)
    return () => window.removeEventListener("pointerup", onUp)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragIndex, dropIndex])

  if (total === 0) {
    return (
      <div className="tracklist-empty">
        <Disc size={30} />
        <p>{emptyMessage}</p>
      </div>
    )
  }

  return (
    <div className="tracklist">
      <div className="tracklist-head" style={{ gridTemplateColumns: columnsCss(reorderable) }}>
        {reorderable && <span />}
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
        ref={scrollRef}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        onClick={() => setSelected(new Set())}
      >
        <div style={{ height: padTop }} />
        {slice.map((track, i) => {
          const index = start + i
          const current = isCurrent(track)
          const queued = isQueued(track)
          return (
            <div
              key={track.id}
              className={[
                "row",
                current ? "current" : "",
                selected.has(track.id) ? "selected" : "",
                dragIndex === index ? "dragging" : "",
                dropIndex === index && dragIndex !== index ? "drop-target" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              style={{ gridTemplateColumns: columnsCss(reorderable) }}
              onClick={(e) => toggleSelect(track.id, e.metaKey || e.ctrlKey || e.shiftKey)}
              onDoubleClick={() => playTracks(tracks, index)}
              onContextMenu={(e) => openMenu(index, e)}
              draggable={reorderable}
              onDragStart={() => onDragStart(index)}
              onDragOver={() => onDragOverRow(index)}
            >
              {reorderable && (
                <span className="row-grip" aria-hidden="true">
                  <Grip size={15} />
                </span>
              )}

              <div className="row-main">
                <div className="row-art">
                  <Artwork
                    trackId={track.id}
                    hasArtwork={track.hasArtwork}
                    alt={track.title}
                    size={38}
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
                  <span className="row-title truncate">{track.title}</span>
                  {track.lyrics.source !== "none" && <Lyrics size={11} className="row-lyric-flag" />}
                </div>
              </div>

              <span className="row-cell truncate">{track.artist}</span>
              <span className="row-cell truncate">{track.album}</span>

              <span className="row-cell right tabular">
                {formatDuration(track.duration)}
              </span>

              <span className="row-actions">
                {queued && current ? (
                  <span className="row-eq" aria-label="Now playing">
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
                  onClick={(e) => openMenu(index, e)}
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

      {selectedTracks.length > 0 && (
        <div className="tracklist-selection glass">
          <span className="tabular">{selectedTracks.length} selected</span>
          <button
            className="pill"
            onClick={() => {
              enqueue(selectedTracks.map((t) => t.id), "end")
              setSelected(new Set())
            }}
          >
            <Queue size={14} /> Queue
          </button>
          <button
            className="pill"
            onClick={() => {
              playTracks(selectedTracks, 0)
              setSelected(new Set())
            }}
          >
            <Play size={13} /> Play
          </button>
        </div>
      )}

      <ContextMenu anchor={menu?.anchor ?? null} items={menuItems} onClose={() => setMenu(null)} />
    </div>
  )
}

function columnsCss(reorderable: boolean): string {
  return reorderable
    ? "34px minmax(190px, 2.4fr) minmax(120px, 1.3fr) minmax(120px, 1.3fr) 62px 84px"
    : "minmax(190px, 2.4fr) minmax(120px, 1.3fr) minmax(120px, 1.3fr) 62px 84px"
}
