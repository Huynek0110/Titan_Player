import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useStore } from "./state/store"
import { usePlayer } from "./lib/usePlayer"
import { extractPalette, applyPalette } from "./lib/palette"
import { formatDuration } from "./lib/format"
import { parseLrc } from "@shared/lyrics"

import TitleBar from "./components/TitleBar"
import Sidebar from "./components/Sidebar"
import TrackList from "./components/TrackList"
import PlayerBar from "./components/PlayerBar"
import NowPlaying from "./components/NowPlaying"
import LyricsPane from "./components/LyricsPane"
import CollectionViews from "./components/CollectionViews"
import PlaylistView from "./components/PlaylistView"
import QueuePanel from "./components/QueuePanel"
import Settings from "./components/Settings"
import Visualiser from "./components/Visualiser"
import { Close, Search, Shuffle, Play, Music } from "./components/Icons"
import "./App.css"

export default function App() {
  const store = useStore()
  const { view, activePlaylistId, currentTrack, nowPlayingOpen, search, setSearch } = store

  const audioRef = useRef<HTMLAudioElement>(null)
  const player = usePlayer(audioRef)
  const [searchFocused, setSearchFocused] = useState(false)

  // The lyrics sweep must sample the audio clock every animation frame, so it
  // reads the element directly rather than the `timeupdate`-driven state, which
  // only updates about four times a second.
  const getTime = useCallback(() => audioRef.current?.currentTime ?? 0, [])

  // --- ambient palette follows the playing track -------------------------
  useEffect(() => {
    if (!currentTrack) return
    let cancelled = false
    void extractPalette(
      currentTrack.hasArtwork ? window.titan.coverUrl(currentTrack.id, true) : null,
    ).then((palette) => {
      if (!cancelled) applyPalette(palette)
    })
    return () => {
      cancelled = true
    }
  }, [currentTrack])

  // --- shell search ------------------------------------------------------
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const typing = target?.tagName === "INPUT" || target?.isContentEditable

      if (event.key === "/" && !typing) {
        event.preventDefault()
        document.getElementById("library-search")?.focus()
        return
      }
      if (event.key === "Escape" && typing) {
        ;(target as HTMLInputElement).blur()
        return
      }
      if (typing) return
      // Never shadow a browser or OS chord.
      if (event.ctrlKey || event.metaKey || event.altKey) return

      if (event.key === "q" || event.key === "Q") {
        store.setShowQueue(!store.showQueue)
      } else if (event.key === "s" || event.key === "S") {
        store.setView("settings", null)
      } else if (event.key === "l" || event.key === "L") {
        store.setView("library", null)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [store])

  // --- external .lrc loading --------------------------------------------
  const loadLyricsFile = useCallback(async () => {
    if (!currentTrack) return
    const picked = await window.titan.pickLyricsFile()
    if (!picked) return
    const parsed = parseLrc(picked.content)
    // Hand the parsed lines to the pane by stashing them on the track object
    // the renderer already holds; the main process never needs to know.
    if (currentTrack.lyrics.source === "none" || !currentTrack.lyrics.synced) {
      currentTrack.lyrics = {
        synced: parsed.synced,
        lines: parsed.lines,
        plain: parsed.plain ?? picked.content,
        source: "lrc-sidecar",
      }
      // Nudge React to notice the mutation.
      store.setNowPlaying(true)
      store.setSearch(store.search)
    }
  }, [currentTrack, store])

  // --- content routing ---------------------------------------------------
  const body = useMemo(() => {
    switch (view) {
      case "albums":
        return <CollectionViews kind="albums" />
      case "artists":
        return <CollectionViews kind="artists" />
      case "playlist":
        return activePlaylistId ? (
          <PlaylistView playlistId={activePlaylistId} />
        ) : (
          <TrackList tracks={store.visibleTracks} />
        )
      case "settings":
        return <Settings />
      default:
        return <TrackList tracks={store.visibleTracks} />
    }
  }, [view, activePlaylistId, store.visibleTracks, store.search])

  const heading = useMemo(() => {
    switch (view) {
      case "albums":
        return "Albums"
      case "artists":
        return "Artists"
      case "favourites":
        return "Favourites"
      case "playlist":
        return store.playlists.find((p) => p.id === activePlaylistId)?.name ?? "Playlist"
      case "settings":
        return "Settings"
      default:
        return "All Songs"
    }
  }, [view, activePlaylistId, store.playlists])

  // Memoised. Without this, every `timeupdate` re-summed the whole library:
  // a few hundred thousand property reads a second for one subtitle string.
  const totalSeconds = useMemo(
    () => store.visibleTracks.reduce((sum, t) => sum + t.duration, 0),
    [store.visibleTracks],
  )

  return (
    <div className={`app ${nowPlayingOpen ? "np-open" : ""}`}>
      <div className="ambient" aria-hidden="true" />
      <div className="grain" aria-hidden="true" />

      {/* The real media element. Kept in the DOM so Chromium treats it as
          attached, which is required for reliable playback. */}
      <audio ref={audioRef} preload="metadata" />

      <div className="app-shell">
        <TitleBar title={heading} />

        <div className="app-body">
          <Sidebar />

          <main className="app-main">
            {view !== "playlist" && view !== "settings" && (
              <header className="library-head">
                <div className="library-head-top">
                  <div className="library-title">
                    <h1>{heading}</h1>
                    <p className="library-sub">
                      {store.visibleTracks.length.toLocaleString()} track
                      {store.visibleTracks.length === 1 ? "" : "s"}
                      {totalSeconds > 0 && ` · ${formatDuration(totalSeconds)}`}
                    </p>
                  </div>

                  <div className="library-tools">
                    <label className={`search ${searchFocused ? "focus" : ""}`}>
                      <Search size={15} />
                      <input
                        id="library-search"
                        value={search}
                        placeholder="Search  /"
                        onChange={(e) => setSearch(e.target.value)}
                        onFocus={() => setSearchFocused(true)}
                        onBlur={() => setSearchFocused(false)}
                      />
                      {search && (
                        <button onClick={() => setSearch("")} aria-label="Clear search">
                          <Close size={13} />
                        </button>
                      )}
                    </label>

                    <button
                      className="pill"
                      disabled={store.visibleTracks.length === 0}
                      onClick={() => store.playTracks(store.visibleTracks, 0, true)}
                    >
                      <Shuffle size={15} /> Shuffle all
                    </button>
                    <button
                      className="play-big sm"
                      disabled={store.visibleTracks.length === 0}
                      onClick={() => store.playTracks(store.visibleTracks, 0)}
                      aria-label="Play all"
                    >
                      <Play size={17} />
                    </button>
                  </div>
                </div>

                {currentTrack && player.state.isPlaying && (
                  <div className="library-eq">
                    <Visualiser getAnalyser={player.ensureAnalyser} active height={34} />
                  </div>
                )}
              </header>
            )}

            <div className="app-content">{body}</div>
          </main>
        </div>

        <PlayerBar player={player} />
      </div>

      <QueuePanel />

      {nowPlayingOpen && currentTrack && (
        <NowPlaying
          track={currentTrack}
          player={player}
          isFavourite={store.favourites.has(currentTrack.id)}
          onToggleFavourite={() => void store.toggleFavourite(currentTrack.id)}
          onClose={() => store.setNowPlaying(false)}
          onOpenLyricsFile={() => void loadLyricsFile()}
          onReveal={() => void window.titan.revealInExplorer(currentTrack.path)}
        >
          <LyricsPane
            lines={currentTrack.lyrics.lines}
            plain={currentTrack.lyrics.plain}
            getTime={getTime}
            isPlaying={player.state.isPlaying}
            onSeek={player.seek}
            hasAny={currentTrack.lyrics.source !== "none"}
          />
        </NowPlaying>
      )}

      {!nowPlayingOpen && !store.ready && (
        <div className="boot">
          <Music size={26} />
          <span>Reading your library…</span>
        </div>
      )}

      {store.error && (
        <div className="fatal glass" role="alert">
          <strong>Something went wrong</strong>
          <p className="selectable">{store.error}</p>
          <div className="fatal-actions">
            <button className="pill" onClick={() => void store.rescan()}>
              Try again
            </button>
            <button className="pill ghost" onClick={() => store.dismissError()}>
              Dismiss
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
