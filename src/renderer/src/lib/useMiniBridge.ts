import { useEffect, useRef } from "react"
import type { MiniCommand, MiniState } from "@shared/mini"
import type { usePlayer } from "./usePlayer"
import type { useStore } from "../state/store"

/**
 * The main window's half of the floating mini player.
 *
 * Two jobs, and they are deliberately asymmetric.
 *
 * **Receiving** is exact. Every command from the bar is routed to the same
 * function the main window's own transport buttons call, so there is exactly one
 * implementation of "next track" in the app. The alternative — the bar maintaining
 * its own queue — was rejected because two queues over one library is a
 * desynchronisation bug waiting for the first time a track is hidden or removed
 * in one of them.
 *
 * **Publishing** is on a timer, and the reason is bandwidth-shaped. The bar's
 * playhead is an estimate between packets anyway, so the rate only has to be
 * fast enough that a change appears promptly and slow enough that a three-minute
 * track is not ten thousand messages. A quarter-second heartbeat is that
 * compromise; a per-frame push would be two hundred times the traffic for a
 * position the bar can extrapolate on its own.
 */

type Player = ReturnType<typeof usePlayer>
type Store = ReturnType<typeof useStore>

/** How often the position is reported while nothing else is changing. */
const HEARTBEAT_MS = 250

export function useMiniBridge(
  player: Player,
  store: Store,
  audioRef: React.RefObject<HTMLAudioElement | null>,
  onOpenNowPlaying: () => void,
): void {
  /*
   * The command handlers are read through a ref rather than captured.
   *
   * `useEffect` re-subscribing on every render would tear down and rebuild the
   * IPC listener each time the audio clock ticked, which drops commands that
   * arrive in the gap. A ref is always current and never changes identity.
   */
  const handlers = useRef({ player, store, audioRef, onOpenNowPlaying })
  handlers.current = { player, store, audioRef, onOpenNowPlaying }

  useEffect(() => {
    return window.titan.onMiniCommand((command: MiniCommand) => {
      const { player: p, store: s, onOpenNowPlaying: open } = handlers.current
      switch (command.type) {
        case "play-pause":
          p.toggle()
          break
        case "next":
          p.next()
          break
        case "previous":
          p.previous()
          break
        case "seek":
          p.seek(command.seconds)
          break
        case "volume":
          p.setVolume(Math.min(1, Math.max(0, command.value)))
          break
        case "toggle-mute":
          p.toggleMute()
          break
        case "toggle-shuffle":
          p.toggleShuffle()
          break
        case "cycle-repeat":
          p.cycleRepeat()
          break
        case "toggle-favourite":
          if (s.currentTrack) s.toggleFavourite(s.currentTrack.id)
          break
        case "open-now-playing":
          open()
          break
      }
    })
  }, [])

  /*
   * The publish loop.
   *
   * Position is read from the element rather than from `player.state.time`,
   * which only updates on `timeupdate` — roughly four times a second, and not at
   * all while the tab is throttled. The bar can interpolate a stale-but-correct
   * reading, but it cannot invent one, so what is sent has to be the real clock.
   */
  useEffect(() => {
    const publish = () => {
      const { currentTrack, favourites, settings, shuffled } = handlers.current.store
      const audio = handlers.current.audioRef.current
      const st = handlers.current.player.state

      const payload: MiniState = {
        track: currentTrack
          ? {
              id: currentTrack.id,
              title: currentTrack.title,
              artist: currentTrack.artist,
              album: currentTrack.album,
              artwork: currentTrack.hasArtwork
                ? window.titan.coverUrl(currentTrack.id, true)
                : null,
              duration: Number.isFinite(st.duration) ? st.duration : currentTrack.duration,
            }
          : null,
        position: audio ? audio.currentTime : st.time,
        // The element's own `paused` is the truth. `player.state.isPlaying` is
        // maintained by events, and a packet that says "playing" while the element
        // is paused would make the bar's playhead run away from the music.
        playing: audio ? !audio.paused : st.isPlaying,
        volume: st.volume,
        muted: st.muted,
        shuffled,
        repeat: settings?.repeat ?? "off",
        favourite: currentTrack ? favourites.has(currentTrack.id) : false,
        at: Date.now(),
      }
      window.titan.pushMini(payload)
    }

    // One immediately, so opening the bar shows the current track rather than an
    // empty panel for a quarter of a second.
    publish()
    const timer = window.setInterval(publish, HEARTBEAT_MS)
    return () => window.clearInterval(timer)
  }, [])
}
