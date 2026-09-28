import { useCallback, useEffect, useRef, useState, type RefObject } from "react"
import { useStore } from "../state/store"

export interface PlayerState {
  isPlaying: boolean
  /** Current position in seconds. */
  time: number
  duration: number
  volume: number
  muted: boolean
  /** Seconds still buffered ahead of the playhead. */
  buffered: number
  /** Set when the browser refuses the file, so the UI can explain why. */
  error: string | null
  isLoading: boolean
}

const MEDIA_ERR_TEXT: Record<number, string> = {
  1: "Loading was aborted.",
  // The media is fetched over the app's own `media://` scheme from a local
  // file, so there is no network involved. Saying "network error" here points at
  // something the user cannot act on.
  2: "The file could not be read. It may have been moved or deleted.",
  3: "This file could not be decoded.",
  4: "This format is not supported, or the file has a damaged cover-art block.",
}

export function usePlayer(audioRef: RefObject<HTMLAudioElement | null>) {
  const store = useStore()
  const { currentTrack, queueIndex, queue, settings } = store

  const [state, setState] = useState<PlayerState>({
    isPlaying: false,
    time: 0,
    duration: 0,
    volume: 0.8,
    muted: false,
    buffered: 0,
    error: null,
    isLoading: false,
  })

  // The useState initialiser runs once, before the async bootstrap has delivered
  // the persisted settings, so reading volume from there silently discarded it.
  // Adopt it as soon as it arrives.
  useEffect(() => {
    if (!settings) return
    setState((s) => (s.volume === 0.8 && settings.volume !== 0.8 ? { ...s, volume: settings.volume } : s))
  }, [settings])

  // Set when the element should start playing, so a track change triggered by
  // the queue can autoplay while an explicit pause does not.
  const shouldPlayRef = useRef(false)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  /** Last queue index an auto-skip was fired for, so it cannot loop forever. */
  const errorSkipRef = useRef(-1)

  // --- load the current track -------------------------------------------
  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    if (!currentTrack) {
      audio.removeAttribute("src")
      audio.load()
      setState((s) => ({ ...s, isPlaying: false, time: 0, duration: 0, error: null }))
      return
    }

    const url = window.titan.audioUrl(currentTrack.path)
    if (audio.src !== url) {
      setState((s) => ({ ...s, isLoading: true, error: null, time: 0 }))
      audio.src = url
      audio.load()
    }

    /*
     * Always attempt playback on a track change.
     *
     * The previous design armed a flag from the transport's Play button only,
     * which meant the app's central action was silent: every entry point that
     * chooses a track (row double-click, the row's play button, the context
     * menu, an album card, Play all, a playlist's Play) updated the queue and the
     * artwork and then sat at 0:00 waiting for a second press. Treating a track
     * change as an implicit request to hear the track is both simpler and what
     * every music player does — there is no state in which the user deliberately
     * loads a track and wants silence.
     */
    shouldPlayRef.current = true
    // play() rejects when the window has not been interacted with yet, which is
    // expected on a cold start and is not worth surfacing as an error.
    void audio.play().catch(() => {
      shouldPlayRef.current = false
      setState((s) => ({ ...s, isPlaying: false }))
    })
  }, [currentTrack, audioRef])

  // --- wire up element events once ---------------------------------------
  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return

    const onPlay = () => setState((s) => ({ ...s, isPlaying: true, isLoading: false }))
    const onPause = () => setState((s) => ({ ...s, isPlaying: false }))
    const onWaiting = () => setState((s) => ({ ...s, isLoading: true }))
    const onPlaying = () => setState((s) => ({ ...s, isLoading: false }))
    const onTime = () =>
      setState((s) =>
        // Avoid a re-render when the delta is below a frame's worth of time.
        Math.abs(s.time - audio.currentTime) < 0.05 ? s : { ...s, time: audio.currentTime },
      )
    const onDuration = () =>
      setState((s) => ({ ...s, duration: Number.isFinite(audio.duration) ? audio.duration : 0 }))
    const onProgress = () => {
      try {
        if (audio.buffered.length > 0) {
          setState((s) => ({ ...s, buffered: audio.buffered.end(audio.buffered.length - 1) }))
        }
      } catch {
        // buffered can throw before any data has arrived.
      }
    }
    const onError = () => {
      const code = audio.error?.code
      const reason = code ? (MEDIA_ERR_TEXT[code] ?? "Playback failed.") : "Playback failed."
      const failedTrack = store.currentTrack

      setState((s) => ({
        ...s,
        isPlaying: false,
        isLoading: false,
        // Name the track. A queue of two hundred with one broken file in it
        // otherwise gives the user no way to know which one to delete.
        error: failedTrack ? `${failedTrack.title} — ${reason}` : reason,
      }))

      // Move on rather than stopping dead. One deleted or corrupt file used to
      // end the session: the queue sat there, the playhead at 0:00, and the user
      // had to press Next themselves. Bounded so a queue of all-broken files
      // cannot spin.
      if (failedTrack && queueIndex >= 0 && queueIndex < queue.length - 1) {
        errorSkipRef.current = queueIndex
        shouldPlayRef.current = true
        store.playNext()
      }
    }
    const onEnded = () => {
      const mode = store.settings?.repeat ?? "off"
      if (mode === "one") {
        audio.currentTime = 0
        void audio.play().catch(() => {
          setState((s) => ({ ...s, isPlaying: false }))
        })
        return
      }
      // `queue:step` refuses to move past the end, so repeat-all has to wrap
      // explicitly or playback simply stops at the last track.
      if (queueIndex >= queue.length - 1) {
        if (mode === "all" && queue.length > 0) {
          // Wrap. The flag has to be set, or the load effect would load track
          // one and sit there silent, which looks like the player gave up.
          shouldPlayRef.current = true
          store.jumpTo(0)
        } else {
          shouldPlayRef.current = false
          setState((s) => ({ ...s, isPlaying: false }))
        }
        return
      }
      store.playNext()
    }

    audio.addEventListener("play", onPlay)
    audio.addEventListener("pause", onPause)
    audio.addEventListener("waiting", onWaiting)
    audio.addEventListener("playing", onPlaying)
    audio.addEventListener("timeupdate", onTime)
    audio.addEventListener("durationchange", onDuration)
    audio.addEventListener("progress", onProgress)
    audio.addEventListener("error", onError)
    audio.addEventListener("ended", onEnded)

    return () => {
      audio.removeEventListener("play", onPlay)
      audio.removeEventListener("pause", onPause)
      audio.removeEventListener("waiting", onWaiting)
      audio.removeEventListener("playing", onPlaying)
      audio.removeEventListener("timeupdate", onTime)
      audio.removeEventListener("durationchange", onDuration)
      audio.removeEventListener("progress", onProgress)
      audio.removeEventListener("error", onError)
      audio.removeEventListener("ended", onEnded)
    }
  }, [audioRef, queueIndex, queue.length, store])

  // --- volume ------------------------------------------------------------
  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    audio.volume = state.volume
    audio.muted = state.muted
  }, [state.volume, state.muted, audioRef])

  // --- media keys and global shortcuts -----------------------------------
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      // Never steal keys from a text field, or from a control the user is
      // operating. Preventing the default on Space would break keyboard
      // activation of every button in the app.
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return
      if (target?.isContentEditable) return
      if (event.ctrlKey || event.metaKey || event.altKey) return
      // A focused button, link or slider owns Space and the arrow keys.
      const interactive = target?.closest(
        "button, a, input, select, textarea, [role='slider'], [role='button'], [contenteditable='true']",
      )
      if (interactive) return
      if (event.defaultPrevented) return

      switch (event.key) {
        case " ":
          event.preventDefault()
          toggle()
          break
        case "ArrowRight":
          if (event.shiftKey) {
            event.preventDefault()
            seek(state.time + 5)
          }
          break
        case "ArrowLeft":
          if (event.shiftKey) {
            event.preventDefault()
            seek(Math.max(0, state.time - 5))
          }
          break
        case "ArrowUp":
          event.preventDefault()
          setVolume(Math.min(1, state.volume + 0.05))
          break
        case "ArrowDown":
          event.preventDefault()
          setVolume(Math.max(0, state.volume - 0.05))
          break
        default:
          break
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.time, state.volume])

  // --- commands ----------------------------------------------------------
  const play = useCallback(() => {
    shouldPlayRef.current = true
    void audioRef.current?.play().catch(() => {
      shouldPlayRef.current = false
    })
  }, [audioRef])

  const pause = useCallback(() => {
    shouldPlayRef.current = false
    audioRef.current?.pause()
  }, [audioRef])

  const toggle = useCallback(() => {
    if (audioRef.current?.paused) play()
    else pause()
  }, [audioRef, play, pause])

  const seek = useCallback(
    (seconds: number) => {
      const audio = audioRef.current
      if (!audio || !Number.isFinite(audio.duration)) return
      audio.currentTime = Math.max(0, Math.min(seconds, audio.duration))
    },
    [audioRef],
  )

  /*
   * Persisting on every input event meant a full state serialise-and-rename per
   * step of the volume slider, and the state file contains a first-seen entry
   * per track. On a large library that is megabytes written dozens of times for
   * one drag. Debounced, and flushed on window close.
   */
  const persistTimer = useRef<number | null>(null)

  const setVolume = useCallback(
    (volume: number) => {
      const clamped = Math.max(0, Math.min(1, volume))
      setState((s) => ({ ...s, volume: clamped, muted: clamped === 0 ? s.muted : false }))

      if (persistTimer.current) window.clearTimeout(persistTimer.current)
      persistTimer.current = window.setTimeout(() => {
        persistTimer.current = null
        void store.updateSettings({ volume: clamped }).catch(() => {})
      }, 400)
    },
    [store],
  )

  // Make sure a pending volume write is not lost on the way out.
  useEffect(() => {
    const flush = () => {
      if (persistTimer.current) {
        window.clearTimeout(persistTimer.current)
        persistTimer.current = null
      }
    }
    window.addEventListener("beforeunload", flush)
    return () => {
      flush()
      window.removeEventListener("beforeunload", flush)
    }
  }, [])

  const toggleMute = useCallback(() => {
    setState((s) => ({ ...s, muted: !s.muted }))
  }, [])

  /**
   * Previous restarts the track when playback is past three seconds in, which
   * is the behaviour every physical transport uses.
   */
  const previous = useCallback(() => {
    const audio = audioRef.current
    if (audio && audio.currentTime > 3) {
      audio.currentTime = 0
      return
    }
    store.playPrev()
  }, [audioRef, store])

  const cycleRepeat = useCallback(() => {
    const order: Array<"off" | "all" | "one"> = ["off", "all", "one"]
    const current = settings?.repeat ?? "off"
    void store.updateSettings({ repeat: order[(order.indexOf(current) + 1) % order.length] })
  }, [settings?.repeat, store])

  const toggleShuffle = useCallback(() => {
    // Read the queue's own shuffled flag, not the persisted setting. The
    // setting is only seeded at startup, so reading it made the toggle one-way:
    // it could switch shuffle on but never off.
    store.setShuffle(!store.shuffled)
  }, [store])

  // --- Web Audio analyser for the visualiser -----------------------------
  // Created lazily and only once; recreating it on every render would drop the
  // audio graph and produce clicks.
  /**
   * Build the Web Audio graph, which is what the visualiser reads.
   *
   * This is deliberately NOT wired to playback. Routing an element through
   * `createMediaElementSource` is irreversible: the element's output then exists
   * only inside the graph, so if the AudioContext is ever suspended the result
   * is permanent silence while `currentTime` keeps advancing, with no error
   * anywhere. A media clock that runs and a speaker that stays quiet is the
   * worst possible failure to diagnose.
   *
   * The context must therefore be created inside a real user gesture, so
   * `resume()` actually succeeds. The visualiser's toggle is that gesture, and
   * it is off by default: sound is the product, the bars are decoration.
   */
  const enableVisualiser = useCallback(async (): Promise<boolean> => {
    const audio = audioRef.current
    if (!audio) return false

    if (analyserRef.current) {
      void audioCtxRef.current?.resume().catch(() => {})
      return true
    }

    try {
      const Ctor =
        window.AudioContext ??
        (window as never as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      const ctx = new Ctor()
      ;(audio as HTMLAudioElement & { __titanCtx?: AudioContext }).__titanCtx = ctx

      /*
       * The context must be *running* before the element is routed into the
       * graph. `createMediaElementSource` is a one-way door: from that moment the
       * element's output exists only inside the graph, so a context that never
       * reaches `running` means permanent silence with `currentTime` still
       * advancing and no error anywhere. Checking afterwards is too late.
       */
      await ctx.resume().catch(() => {})
      if (ctx.state !== "running") {
        // Nothing has been routed yet, so give the element straight back to the
        // speakers rather than stranding it in a silent graph.
        void ctx.close().catch(() => {})
        audioCtxRef.current = null
        ;(audio as HTMLAudioElement & { __titanCtx?: AudioContext }).__titanCtx = undefined
        console.error(`[titan] AudioContext is ${ctx.state}; visualiser left off`)
        return false
      }

      const element = audio as HTMLAudioElement & {
        __titanSource?: MediaElementAudioSourceNode
      }
      const source = ctx.createMediaElementSource(audio)
      element.__titanSource = source
      // Connect to the speakers as well as the analyser, outside any conditional.
      source.connect(ctx.destination)

      const analyser = ctx.createAnalyser()
      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.8
      source.connect(analyser)

      analyserRef.current = analyser
      audioCtxRef.current = ctx
      return true
    } catch (err) {
      console.error("[titan] visualiser setup failed, audio unaffected:", err)
      return false
    }
  }, [audioRef])

  // Must be stable. An inline arrow gave it a new identity on every re-render,
  // which tore down and rebuilt the visualiser's whole effect several times a
  // second and reset its smoothing buffer, making the bars visibly flicker.
  const getAnalyser = useCallback((): AnalyserNode | null => analyserRef.current, [])

  const next = useCallback(() => {
    const { queueIndex, queue, settings } = store
    if (queue.length === 0) return
    // Repeat-all wraps, so the transport button has to agree with what
    // auto-advance does when the current track runs out.
    if (queueIndex >= queue.length - 1) {
      if ((settings?.repeat ?? "off") === "all") {
        shouldPlayRef.current = true
        store.jumpTo(0)
      }
      return
    }
    shouldPlayRef.current = true
    store.playNext()
  }, [store])

  return {
    state,
    play,
    pause,
    toggle,
    seek,
    setVolume,
    toggleMute,
    previous,
    next,
    cycleRepeat,
    toggleShuffle,
    enableVisualiser,
    getAnalyser,
  }
}
