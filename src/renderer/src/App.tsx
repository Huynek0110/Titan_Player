import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { Lyrics } from "@shared/types"
import { useStore } from "./state/store"
import { usePlayer } from "./lib/usePlayer"
import { useMiniBridge } from "./lib/useMiniBridge"
import { extractPalette, applyPalette } from "./lib/palette"
import { formatDuration } from "./lib/format"
import { parseLrc } from "@shared/lyrics"

import TitleBar from "./components/TitleBar"
import Sidebar from "./components/Sidebar"
import TrackList from "./components/TrackList"
import PlayerBar from "./components/PlayerBar"
import NowPlaying from "./components/NowPlaying"
import LyricsPane from "./components/LyricsPane"
import LyricsEditor from "./components/LyricsEditor"
import CollectionViews from "./components/CollectionViews"
import PlaylistView from "./components/PlaylistView"
import QueuePanel from "./components/QueuePanel"
import Settings from "./components/Settings"
import Visualiser from "./components/Visualiser"
import { Close, Search, Shuffle, Play, Music, Info } from "./components/Icons"
import "./App.css"

export default function App() {
  const store = useStore()
  const { view, activePlaylistId, currentTrack, nowPlayingOpen, search, setSearch } = store

  const audioRef = useRef<HTMLAudioElement>(null)
  const player = usePlayer(audioRef)
  const [searchFocused, setSearchFocused] = useState(false)
  // The visualiser is off until asked for, because enabling it routes audio
  // through Web Audio and a suspended context would silence playback.
  const [visOn, setVisOn] = useState(false)
  const [visFailed, setVisFailed] = useState(false)

  // The lyrics sweep must sample the audio clock every animation frame, so it
  // reads the element directly rather than the `timeupdate`-driven state, which
  // only updates about four times a second.
  const getTime = useCallback(() => audioRef.current?.currentTime ?? 0, [])

  // --- the floating mini player ------------------------------------------
  /*
   * Wired here rather than inside `usePlayer` because the bar needs three things
   * the player does not have: the store (for the current track and favourites),
   * the audio element itself (for the real clock), and the ability to change the
   * main window's view. Passing all three in is clearer than teaching the audio
   * engine about a second window.
   */
  const openNowPlaying = useCallback(() => {
    store.setNowPlaying(true)
  }, [store])
  useMiniBridge(player, store, audioRef, openNowPlaying)

  // --- ambient palette follows the playing track -------------------------
  useEffect(() => {
    if (!currentTrack) return
    let cancelled = false
    const art = currentTrack.hasArtwork ? window.titan.coverUrl(currentTrack.id, true) : null
    /*
     * The cover itself, as the blurred backdrop.
     *
     * This is what makes the glass read as glass. A `backdrop-filter` bends what
     * is behind it, and a three-stop gradient has no features to bend — the
     * displacement has nothing to act on and the refraction is invisible however
     * strong it is. A photograph has edges, a subject and blotches, so the rim
     * has something to distort. Everything else in the interface is glass *over*
     * this.
     *
     * Set as a custom property rather than an inline style so the element that
     * paints it can stay in the stylesheet, and so the mini window — which has
     * its own document and deliberately does not run this effect — is unaffected.
     * The `media://` URL is only readable because the custom scheme serves it
     * with the CORS headers a canvas and a stylesheet both need.
     */
    document.documentElement.style.setProperty("--art", art ? `url("${art}")` : "none")
    void extractPalette(art).then((palette) => {
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
  // Lyrics loaded from a file, keyed by track id.
  //
  // This is state rather than a mutation of `currentTrack`. Assigning straight
  // onto the track object left `lines` as the same array reference, so
  // LyricsPane's effects — which correctly depend on `lines` — never re-ran and
  // the karaoke sweep kept using the stale closure. The old code also nudged a
  // re-render by dispatching a same-value search update, and gated the assignment
  // so that a track which already had synced lyrics silently ignored the file
  // the user had just picked in order to correct them.
  const [lyricOverride, setLyricOverride] = useState<{ id: string; lyrics: Lyrics } | null>(null)

  /*
   * Whether the right-hand column is the editor or the pane.
   *
   * Keyed by nothing and reset on open: the editor owns a draft of every line,
   * and leaving it open across a track change would carry one track's timings
   * into another's save. The `key` on the component below is the real guard —
   * remounting on the track id means a new track gets a fresh draft before its
   * first paint rather than a frame later.
   */
  const [editingLyrics, setEditingLyrics] = useState(false)

  const loadLyricsFile = useCallback(async () => {
    if (!currentTrack) return
    const picked = await window.titan.pickLyricsFile()
    if (!picked) return

    const parsed = parseLrc(picked.content)
    if (parsed.synced) {
      setLyricOverride({
        id: currentTrack.id,
        lyrics: { synced: true, lines: parsed.lines, source: "lrc-sidecar" },
      })
    } else {
      // Still useful: a plain text file beats showing nothing.
      setLyricOverride({
        id: currentTrack.id,
        lyrics: { synced: false, lines: [], plain: parsed.plain ?? picked.content, source: "lrc-sidecar" },
      })
    }
  }, [currentTrack])

  const lyrics =
    lyricOverride && lyricOverride.id === currentTrack?.id ? lyricOverride.lyrics : currentTrack?.lyrics

  // --- online lyrics lookup ----------------------------------------------
  /*
   * Runs when a track with no local lyrics starts playing, and only then.
   *
   * A local source always wins: a tag or a sidecar `.lrc` was put there
   * deliberately by whoever tagged the file, and replacing it with a database's
   * guess would override an intentional choice with an automatic one. Looking
   * up unconditionally would also mean a request per track change whether or not
   * it was needed, which is both wasteful and a larger privacy footprint than the
   * feature requires.
   *
   * The result is held in the same `lyricOverride` slot as a hand-picked file, so
   * a user who loads their own `.lrc` afterwards simply overwrites the fetched
   * answer, and there is one place that decides which lyrics are on screen.
   */
  const [onlineState, setOnlineState] = useState<{
    id: string
    status: "idle" | "searching" | "not-found" | "offline" | "disabled"
    detail?: string
  }>({ id: "", status: "idle" })

  const lookupTarget = useMemo(
    () =>
      currentTrack
        ? {
            id: currentTrack.id,
            title: currentTrack.title,
            artist: currentTrack.artist,
            album: currentTrack.album,
            duration: currentTrack.duration,
          }
        : null,
    [currentTrack],
  )

  useEffect(() => {
    if (!lookupTarget || !store.settings?.fetchOnlineLyrics) {
      setOnlineState({ id: "", status: "idle" })
      return
    }
    // Nothing to gain: the file already carries lyrics, or the user has supplied
    // their own for this exact track.
    if (currentTrack?.lyrics.source !== "none") return
    if (lyricOverride?.id === lookupTarget.id) return

    let live = true
    setOnlineState({ id: lookupTarget.id, status: "searching" })

    void window.titan
      .lookupLyrics(lookupTarget)
      .then((result) => {
        // A superseded request must not write. Skipping a track is fast and the
        // replies can arrive out of order.
        if (!live) return
        if (result.outcome === "found" && result.lyrics) {
          setLyricOverride({ id: lookupTarget.id, lyrics: result.lyrics })
          setOnlineState({ id: lookupTarget.id, status: "idle", detail: result.detail })
        } else if (result.outcome === "not-found") {
          setOnlineState({ id: lookupTarget.id, status: "not-found", detail: result.detail })
        } else if (result.outcome === "disabled") {
          setOnlineState({ id: lookupTarget.id, status: "disabled" })
        } else {
          setOnlineState({ id: lookupTarget.id, status: "offline", detail: result.detail })
        }
      })
      .catch(() => {
        // Never a fatal error. This is a local player with an optional extra, and
        // a network problem must not become an error dialog over a working app.
        if (live) setOnlineState({ id: lookupTarget.id, status: "offline" })
      })

    return () => {
      live = false
    }
  }, [lookupTarget, currentTrack?.lyrics.source, lyricOverride?.id, store.settings?.fetchOnlineLyrics])

  /** Forget the cached answer and try again, for a lookup that matched wrongly. */
  const retryOnlineLyrics = useCallback(async () => {
    if (!lookupTarget) return
    setOnlineState({ id: lookupTarget.id, status: "searching" })
    // Drop the override first, or the effect above would treat the track as
    // already supplied and never fire the new lookup.
    setLyricOverride(null)
    await window.titan.forgetLyrics(lookupTarget)
    const result = await window.titan.lookupLyrics(lookupTarget)
    if (result.outcome === "found" && result.lyrics) {
      setLyricOverride({ id: lookupTarget.id, lyrics: result.lyrics })
      setOnlineState({ id: lookupTarget.id, status: "idle", detail: result.detail })
    } else if (result.outcome === "not-found") {
      setOnlineState({ id: lookupTarget.id, status: "not-found", detail: result.detail })
    } else {
      setOnlineState({ id: lookupTarget.id, status: "offline", detail: result.detail })
    }
  }, [lookupTarget])

  // --- content routing ---------------------------------------------------
  const body = useMemo(() => {
    switch (view) {
      case "albums":
        // Keyed deliberately. Both views render the same component, and React
        // reconciles same-type siblings as one instance, so without a key the
        // card entrance animation played on the way into Albums and then never
        // replayed on the way into Artists. The key is on the child, not on
        // `.app-content` — keying the shell would remount the sidebar's search
        // field and lose its text and scroll position on every view change.
        return <CollectionViews key="albums" kind="albums" />
      case "artists":
        return <CollectionViews key="artists" kind="artists" />
      case "playlist":
        return activePlaylistId ? (
          <PlaylistView playlistId={activePlaylistId} />
        ) : (
          <TrackList tracks={store.visibleTracks} isPlaying={player.state.isPlaying} />
        )
      case "settings":
        return <Settings failedFiles={store.failed} />
      default:
        return <TrackList tracks={store.visibleTracks} isPlaying={player.state.isPlaying} />
    }
  }, [view, activePlaylistId, store.visibleTracks, store.search, player.state.isPlaying])

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
      {/* The blurred cover, then the tint over it. See `.ambient-art`. */}
      <div className="ambient-art" aria-hidden="true" />
      <div className="ambient" aria-hidden="true" />
      <div className="grain" aria-hidden="true" />

      {/* The real media element. Kept in the DOM so Chromium treats it as
          attached, which is required for reliable playback. */}
      <audio ref={audioRef} preload="metadata" />

      <div className="app-shell">
        {/* No `title` prop: the wordmark is the app's identity, not a copy of the
            page heading. Passing the heading put the same string in the chrome at
            10px and 40px below it at 33px, and because the heading changes with
            every view, the text you read while dragging the window was
            constantly in motion. */}
        <TitleBar />

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

                    {currentTrack && (
                      <button
                        className={`vis-toggle ${visOn ? "on" : ""}`}
                        // The click is the user gesture the AudioContext needs,
                        // which is the only way resume() is guaranteed to work.
                        onClick={async () => {
                          const ok = await player.enableVisualiser()
                          setVisOn(ok)
                          setVisFailed(!ok)
                        }}
                        title={
                          visFailed
                            ? "Audio could not be routed to the visualiser"
                            : visOn
                              ? "Hide the visualiser"
                              : "Show the visualiser"
                        }
                        aria-pressed={visOn}
                      >
                        {visOn ? (
                          <Visualiser
                            getAnalyser={player.getAnalyser}
                            active
                            height={22}
                            onUnavailable={() => setVisFailed(true)}
                          />
                        ) : (
                          "Bars"
                        )}
                      </button>
                    )}
                  </div>
                </div>
              </header>
            )}

            {/*
              * A folder the user configured could not be reached, so the scan
              * deliberately did not prune playlists or favourites. That is the
              * one condition where the library on screen is knowingly out of date
              * with the disk, so it is stated here rather than only in Settings —
              * otherwise the user reconnects a drive, finds half their playlists
              * apparently emptied, and has no idea why.
              */}
            {store.scanError && (
              <div className="scan-warning" role="status">
                <Info size={15} />
                <span>{store.scanError}</span>
                <button
                  className="scan-warning-dismiss"
                  onClick={store.clearScanError}
                  aria-label="Dismiss"
                  title="Dismiss"
                >
                  <Close size={13} />
                </button>
              </div>
            )}

            <div className="app-content">{body}</div>
          </main>
        </div>

        <PlayerBar player={player} />
      </div>

      <QueuePanel />

      {nowPlayingOpen && currentTrack && (
        <NowPlaying
          track={{ ...currentTrack, lyrics: lyrics ?? currentTrack.lyrics }}
          player={player}
          isFavourite={store.favourites.has(currentTrack.id)}
          onToggleFavourite={() => void store.toggleFavourite(currentTrack.id)}
          onClose={() => {
            setEditingLyrics(false)
            store.setNowPlaying(false)
          }}
          onOpenLyricsFile={() => void loadLyricsFile()}
          onReveal={() => void window.titan.revealInExplorer(currentTrack.path)}
          shuffled={store.shuffled}
          repeat={store.settings?.repeat ?? "off"}
          queueOpen={store.showQueue}
          onToggleQueue={() => store.setShowQueue(!store.showQueue)}
          onSeek={player.seek}
          onToggleLyricsEditor={() => setEditingLyrics((v) => !v)}
          lyricsEditing={editingLyrics}
          source={
            view === "playlist"
              ? "playlist"
              : view === "favourites"
                ? "favourites"
                : view === "albums"
                  ? "album"
                  : view === "artists"
                    ? "artist"
                    : "library"
          }
        >
          {editingLyrics ? (
            <LyricsEditor
              key={currentTrack.id}
              audioPath={currentTrack.path}
              meta={{
                title: currentTrack.title,
                artist: currentTrack.artist,
                album: currentTrack.album,
                duration: currentTrack.duration,
              }}
              lines={lyrics?.lines ?? currentTrack.lyrics.lines}
              plain={lyrics?.plain ?? currentTrack.lyrics.plain}
              getTime={getTime}
              isPlaying={player.state.isPlaying}
              onTogglePlay={player.toggle}
              onSeek={player.seek}
              onAdopt={(saved) => setLyricOverride({ id: currentTrack.id, lyrics: saved })}
              onClose={() => setEditingLyrics(false)}
            />
          ) : (
            <LyricsPane
              lines={lyrics?.lines ?? currentTrack.lyrics.lines}
              plain={lyrics?.plain ?? currentTrack.lyrics.plain}
              getTime={getTime}
              isPlaying={player.state.isPlaying}
              onSeek={player.seek}
              hasAny={(lyrics ?? currentTrack.lyrics).source !== "none"}
              onlineStatus={
                onlineState.id === currentTrack.id &&
                onlineState.status !== "idle" &&
                onlineState.status !== "disabled"
                  ? onlineState.status
                  : undefined
              }
              onlineDetail={onlineState.detail}
              onRetryOnline={() => void retryOnlineLyrics()}
              onlineEnabled={store.settings?.fetchOnlineLyrics}
              onEnableOnline={() => void store.updateSettings({ fetchOnlineLyrics: true })}
            />
          )}
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
