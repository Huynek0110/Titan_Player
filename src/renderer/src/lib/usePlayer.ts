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
  2: "A network error interrupted playback.",
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
    volume: settings?.volume ?? 0.8,
    muted: false,
    buffered: 0,
    error: null,
    isLoading: false,
  })

  // Set when the element should start playing, so a track change triggered by
  // the queue can autoplay while an explicit pause does not.
  const shouldPlayRef = useRef(false)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)

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

    if (shouldPlayRef.current) {
      // play() rejects when the user has not interacted with the window yet;
      // that is expected on a cold start and not worth surfacing as an error.
      void audio.play().catch(() => {
        shouldPlayRef.current = false
        setState((s) => ({ ...s, isPlaying: false }))
      })
    }
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
      setState((s) => ({
        ...s,
        isPlaying: false,
        isLoading: false,
        error: code ? (MEDIA_ERR_TEXT[code] ?? "Playback failed.") : "Playback failed.",
      }))
    }
    const onEnded = () => {
      const mode = store.settings?.repeat ?? "off"
      if (mode === "one") {
        audio.currentTime = 0
        void audio.play()
        return
      }
      const last = queueIndex >= queue.length - 1
      if (last && mode !== "all") {
        shouldPlayRef.current = false
        setState((s) => ({ ...s, isPlaying: false }))
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
      // Never steal keys from a text field.
      if (target && ["INPUT", "TEXTAREA"].includes(target.tagName)) return
      if (target?.isContentEditable) return

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

  const setVolume = useCallback((volume: number) => {
    const clamped = Math.max(0, Math.min(1, volume))
    setState((s) => ({ ...s, volume: clamped, muted: clamped === 0 ? s.muted : false }))
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
    void store.updateSettings({ shuffle: !(settings?.shuffle ?? false) })
  }, [settings?.shuffle, store])

  // --- Web Audio analyser for the visualiser -----------------------------
  // Created lazily and only once; recreating it on every render would drop the
  // audio graph and produce clicks.
  const ensureAnalyser = useCallback((): AnalyserNode | null => {
    const audio = audioRef.current
    if (!audio) return null
    if (analyserRef.current) return analyserRef.current

    try {
      const Ctor = window.AudioContext ?? (window as never as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      const ctx = audioCtxRef.current ?? new Ctor()
      audioCtxRef.current = ctx

      // A MediaElementSource can only be created once per element, so guard it.
      if (!(audio as HTMLAudioElement & { __titanSource?: MediaElementAudioSourceNode }).__titanSource) {
        const source = ctx.createMediaElementSource(audio)
        ;(audio as HTMLAudioElement & { __titanSource?: MediaElementAudioSourceNode }).__titanSource = source
        source.connect(ctx.destination)
      }

      const analyser = ctx.createAnalyser()
      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.8
      const source = (audio as HTMLAudioElement & { __titanSource?: MediaElementAudioSourceNode }).__titanSource
      source?.connect(analyser)

      analyserRef.current = analyser
      return analyser
    } catch {
      // Autoplay policy or an unavailable AudioContext. The visualiser simply
      // stays empty; playback itself is unaffected.
      return null
    }
  }, [audioRef])

  return {
    state,
    play,
    pause,
    toggle,
    seek,
    setVolume,
    toggleMute,
    previous,
    next: store.playNext,
    cycleRepeat,
    toggleShuffle,
    ensureAnalyser,
  }
}
