import { useEffect, useRef } from "react"
import { classifyListen } from "@shared/listening"

/**
 * Measures what was really listened to, and reports it when a track is done with.
 *
 * "Done with" means one of three things: a different track became current, nothing
 * is current any more, or the window is going away. All three are covered,
 * because missing the third is the one that actually loses data — closing the app
 * partway through an album is the most common way anyone leaves a player.
 *
 * The clock is sampled on a timer into a ref, never into state. This runs for the
 * whole session, and a `setState` here would re-render the library every second
 * for a number nothing on screen displays.
 *
 * A single interval rather than the `timeupdate` event, deliberately:
 * `timeupdate` fires irregularly and is throttled by the browser to roughly 4Hz,
 * which makes "how far did the position move" ambiguous — and the whole question
 * here is whether that movement was playback or a seek. Polling makes the two
 * distinguishable, because a seek shows up as a jump far larger than the elapsed
 * wall-clock time.
 */
export function useListeningHistory({
  trackId,
  /** Playback position in seconds, read on every tick. */
  getTime,
  /** Total track length in seconds, or 0 before metadata has arrived. */
  getDuration,
  isPlaying,
  onRecord,
}: {
  trackId: string | null
  getTime: () => number
  getDuration: () => number
  isPlaying: boolean
  onRecord: (trackId: string, outcome: "play" | "skip", listenedMs: number) => void
}) {
  /*
   * The running tally for the *current* track, plus which track it belongs to.
   *
   * Held in one ref rather than several, because the two have to change together:
   * a position reset without resetting the tally would add the previous track's
   * listening time to the new track, and that is the kind of error that shows up
   * as a plausible number rather than as a crash.
   */
  const session = useRef({ trackId: null as string | null, listenedMs: 0, lastTime: 0 })

  // Report and reset whenever the track changes, and once more on the way out.
  const report = useRef(onRecord)
  report.current = onRecord

  useEffect(() => {
    const close = () => {
      const current = session.current
      if (!current.trackId) return
      const outcome = classifyListen({
        durationSec: getDuration(),
        positionSec: current.lastTime,
        listenedMs: current.listenedMs,
      })
      session.current = { trackId: null, listenedMs: 0, lastTime: 0 }
      if (outcome !== "ignore") report.current(current.trackId, outcome, current.listenedMs)
    }

    // The change of track is the moment to close the previous session.
    if (session.current.trackId !== trackId) {
      close()
      session.current = { trackId, listenedMs: 0, lastTime: 0 }
    }
  }, [trackId, getDuration])

  useEffect(() => {
    const timer = window.setInterval(() => {
      const current = session.current
      if (!current.trackId) return

      const time = getTime()
      const deltaMs = (time - current.lastTime) * 1000
      current.lastTime = time

      /*
       * Count forward motion only, and cap what a single tick can contribute.
       *
       * Backwards motion is a seek and is not listening. Forward motion larger than
       * the elapsed wall time is also a seek — nobody hears three minutes of a
       * track in one second — and without the cap, skipping to the end of a long
       * track and playing the last fifteen seconds would log a full listen.
       *
       * The cap is generous because it has to survive a genuine hiccup: a stalled
       * buffer resumes and the media clock jumps forward in one tick, and that gap
       * was still listened to, just not in real time.
       */
      if (isPlaying && deltaMs > 0) {
        current.listenedMs += Math.min(deltaMs, 3000)
      }
    }, 1000)

    return () => window.clearInterval(timer)
  }, [getTime, isPlaying])

  /*
   * The window going away.
   *
   * `beforeunload` fires on close and on a reload, and `pagehide` covers the cases
   * where `beforeunload` is skipped. Both are registered because the failure mode
   * is asymmetric: the cost of registering twice is a second call that classifies
   * as `ignore`, and the cost of missing one is losing the current track's listen.
   *
   * The session is cleared after the first report, so the second listener has
   * nothing left to close and does not double-count.
   */
  useEffect(() => {
    const onExit = () => {
      const current = session.current
      if (!current.trackId) return
      const outcome = classifyListen({
        durationSec: getDuration(),
        positionSec: current.lastTime,
        listenedMs: current.listenedMs,
      })
      session.current = { trackId: null, listenedMs: 0, lastTime: 0 }
      if (outcome !== "ignore") report.current(current.trackId, outcome, current.listenedMs)
    }
    window.addEventListener("beforeunload", onExit)
    window.addEventListener("pagehide", onExit)
    return () => {
      window.removeEventListener("beforeunload", onExit)
      window.removeEventListener("pagehide", onExit)
    }
  }, [getDuration])
}
