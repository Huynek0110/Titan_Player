import { useCallback, useEffect, useRef, useState } from "react"
import type { MiniCommand, MiniState } from "@shared/mini"
import { useGlassSurface } from "@renderer/lib/glass"
import { useReducedMotion } from "@renderer/lib/useReducedMotion"
import "./MiniPlayer.css"

/**
 * The floating bar.
 *
 * A remote control, not a player. There is no `<audio>` here and there must not
 * be: the element lives in the main window and moving or duplicating it would
 * mean two clocks for one file, which drift inside a minute and cannot be
 * resynchronised without a visible jump. So this window sends commands, and
 * renders whatever state the main window last reported.
 *
 * The consequence that shapes the whole component is that the position on screen
 * is an *estimate*, not a reading. Packets arrive a few times a second; the
 * playhead has to move smoothly between them. It does that by extrapolating from
 * the last packet's position and the local clock, and re-syncing whenever a new
 * packet lands. If a packet arrives late the playhead is corrected, which is
 * imperceptible at four updates a second; the alternative — stepping the bar in
 * visible jumps — is not.
 */

const EMPTY: MiniState = {
  track: null,
  position: 0,
  playing: false,
  volume: 1,
  muted: false,
  shuffled: false,
  repeat: "off",
  favourite: false,
  at: 0,
}

export default function MiniPlayer() {
  const [state, setState] = useState<MiniState>(EMPTY)
  const reduced = useReducedMotion()

  /*
   * The playhead, as a live number.
   *
   * Kept out of `state` on purpose: it changes sixty times a second and putting
   * it in React state would re-render the whole bar on every frame. It is a
   * custom property written straight to the element from a rAF loop, which is the
   * one thing the motion policy in `global.css` explicitly allows a rAF loop to
   * touch.
   */
  const progressRef = useRef<HTMLDivElement>(null)
  /** Where the bar was when the last packet arrived, and when that was. */
  const anchor = useRef({ position: 0, at: 0, playing: false })
  /** The last packet whose `at` was newer than the one before it. */
  const lastPacket = useRef(0)

  const send = useCallback((command: MiniCommand) => window.titanMini.send(command), [])

  /*
   * Liquid Glass on the transport pill, not on the panel.
   *
   * The window is transparent, so the panel has *nothing behind it to refract* —
   * the renderer cannot see the desktop, and a `backdrop-filter` over an
   * empty backdrop is a no-op that looks like a bug. Refraction only becomes
   * real where an opaque surface sits behind the glass, which is the pill on top
   * of the panel. That is where it is applied.
   */
  const pillRef = useGlassSurface<HTMLDivElement>({
    displacement: 34,
    extra: "blur(2px)",
    flat: 0.22,
  })

  useEffect(() => {
    return window.titanMini.onState((next) => {
      // Packets are timestamped by the sender. Two windows can deliver out of
      // order — a seek that races a periodic tick — and applying a stale one
      // would visibly rewind the bar for a frame.
      if (next.at < lastPacket.current) return
      lastPacket.current = next.at
      anchor.current = { position: next.position, at: next.at, playing: next.playing }
      setState(next)
    })
  }, [])

  /*
   * Move the playhead.
   *
   * Extrapolates from the last packet rather than displaying it, so the fill
   * advances at the right speed between updates. `performance.now()` is the
   * clock rather than `Date.now()` because only the former is monotonic — the
   * system clock can step, and a seek bar that jumps because the user's clock
   * was corrected is a bug with no cause anyone can find.
   */
  useEffect(() => {
    let raf = 0
    const tick = () => {
      const el = progressRef.current
      if (el) {
        const a = anchor.current
        const duration = state.track?.duration ?? 0
        const elapsed = a.playing ? (performance.now() - a.at) / 1000 : 0
        const p = duration > 0 ? Math.min(1, Math.max(0, (a.position + elapsed) / duration)) : 0
        el.style.setProperty("--p", `${(p * 100).toFixed(2)}%`)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [state.track?.duration])

  /*
   * Seeking from the bar.
   *
   * Computed from the bar's own geometry rather than from `clientX` alone, so
   * the click lands where the pointer is even when the window is partially off
   * the edge of a screen and the coordinate space disagrees with the layout one.
   */
  const onSeekPointer = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const el = event.currentTarget
      const rect = el.getBoundingClientRect()
      if (rect.width <= 0) return
      const duration = state.track?.duration ?? 0
      if (duration <= 0) return
      const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
      send({ type: "seek", seconds: ratio * duration })
    },
    [send, state.track?.duration],
  )

  const track = state.track
  const repeatLabel =
    state.repeat === "one" ? "Repeat one" : state.repeat === "all" ? "Repeat all" : "Repeat off"

  return (
    <div className="mini" data-empty={track ? undefined : "true"}>
      <div className="mini-panel">
        {/*
          The drag strip. `-webkit-app-region: drag` is what makes a frameless
          window movable at all, and it is on this element only — the transport
          below opts back out, because a drag region swallows clicks and a button
          that cannot be pressed is worse than a bar that cannot be moved.
        */}
        <div className="mini-drag" />

        {track?.artwork ? (
          <img className="mini-art" src={track.artwork} alt="" draggable={false} />
        ) : (
          <div className="mini-art mini-art-empty" aria-hidden="true">
            {track ? <span>{track.title.slice(0, 1).toUpperCase()}</span> : null}
          </div>
        )}

        <button
          className="mini-meta"
          onClick={() => send({ type: "open-now-playing" })}
          title={`${track?.title ?? "Nothing playing"} — ${track?.artist ?? ""}`}
        >
          <span className="mini-title">{track?.title ?? "Nothing playing"}</span>
          <span className="mini-artist">{track?.artist ?? ""}</span>
        </button>

        <div className="mini-transport" ref={pillRef}>
          <button
            className={`mini-btn ${state.shuffled ? "is-on" : ""}`}
            onClick={() => send({ type: "toggle-shuffle" })}
            title="Shuffle"
            aria-label="Shuffle"
            aria-pressed={state.shuffled}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M13.151.922a.75.75 0 1 0-1.06 1.06L13.109 3H11.16a3.75 3.75 0 0 0-2.873 1.34l-6.173 7.356A2.25 2.25 0 0 1 .39 12.5H0V14h.391a3.75 3.75 0 0 0 2.873-1.34l6.173-7.356a2.25 2.25 0 0 1 1.724-.804h1.947l-1.017 1.018a.75.75 0 1 0 1.06 1.06l2.306-2.306a.75.75 0 0 0 0-1.06L13.15.922zM.391 3.5H0V2h.391c1.109 0 2.16.49 2.873 1.34L4.89 5.277l-.979 1.167-1.796-2.14A2.25 2.25 0 0 0 .391 3.5z" />
              <path d="m7.5 10.723.98-1.167 1.796 2.14a2.25 2.25 0 0 0 1.724.804h1.947l-1.017-1.018a.75.75 0 1 1 1.06-1.06l2.306 2.306a.75.75 0 0 1 0 1.06l-2.306 2.306a.75.75 0 0 1-1.06 0l-1.787-2.14z" />
            </svg>
          </button>

          <button
            className="mini-btn"
            onClick={() => send({ type: "previous" })}
            title="Previous"
            aria-label="Previous track"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M3.3 1a.7.7 0 0 1 .7.7v5.15l9.95-5.744a.7.7 0 0 1 1.05.606v12.575a.7.7 0 0 1-1.05.607L4 9.149V14.3a.7.7 0 0 1-.7.7H1.7a.7.7 0 0 1-.7-.7V1.7a.7.7 0 0 1 .7-.7h1.6z" />
            </svg>
          </button>

          <button
            className="mini-btn mini-btn-play"
            onClick={() => send({ type: "play-pause" })}
            title={state.playing ? "Pause" : "Play"}
            aria-label={state.playing ? "Pause" : "Play"}
          >
            {state.playing ? (
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M4 2.5A.5.5 0 0 1 4.5 2h1a.5.5 0 0 1 .5.5v11a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5v-11Zm6 0A.5.5 0 0 1 10.5 2h1a.5.5 0 0 1 .5.5v11a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5v-11Z" />
              </svg>
            ) : (
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M4 2.8v10.4c0 .86.94 1.39 1.67.94l8.2-5.2a1.1 1.1 0 0 0 0-1.88l-8.2-5.2A1.1 1.1 0 0 0 4 2.8Z" />
              </svg>
            )}
          </button>

          <button
            className="mini-btn"
            onClick={() => send({ type: "next" })}
            title="Next"
            aria-label="Next track"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M12.7 1a.7.7 0 0 0-.7.7v5.15L2.05 1.107A.7.7 0 0 0 1 1.712v12.575a.7.7 0 0 0 1.05.607L12 9.149V14.3a.7.7 0 0 0 .7.7h1.6a.7.7 0 0 0 .7-.7V1.7a.7.7 0 0 0-.7-.7h-1.6Z" />
            </svg>
          </button>

          {/*
            Repeat is three states, so it is a button that cycles rather than a
            toggle. The "one" state is the one that has to be visible — a repeat
            that silently plays the same track forever is the kind of thing a user
            only notices when it is annoyed them.
          */}
          <button
            className={`mini-btn ${state.repeat !== "off" ? "is-on" : ""}`}
            onClick={() => send({ type: "cycle-repeat" })}
            title={repeatLabel}
            aria-label={repeatLabel}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M0 4.75A3.75 3.75 0 0 1 3.75 1h8.5A3.75 3.75 0 0 1 16 4.75v5a3.75 3.75 0 0 1-3.75 3.75H9.81l1.018 1.018a.75.75 0 1 1-1.06 1.06L7.617 13.426a.75.75 0 0 1 0-1.06l2.15-2.152a.75.75 0 0 1 1.062 1.06l-.966.967h1.887A2.25 2.25 0 0 0 14.5 9.75v-5A2.25 2.25 0 0 0 12.25 2.5h-8.5A2.25 2.25 0 0 0 1.5 4.75v5A2.25 2.25 0 0 0 3.75 12.25H5v1.5H3.75A3.75 3.75 0 0 1 0 9.75v-5Z" />
            </svg>
            {state.repeat === "one" && <span className="mini-badge">1</span>}
          </button>
        </div>

        <div className="mini-tail">
          <button
            className={`mini-btn mini-btn-sm ${state.muted || state.volume === 0 ? "is-off" : ""}`}
            onClick={() => send({ type: "toggle-mute" })}
            title={state.muted || state.volume === 0 ? "Unmute" : "Mute"}
            aria-label={state.muted || state.volume === 0 ? "Unmute" : "Mute"}
          >
            {state.muted || state.volume === 0 ? (
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M8 1.5A6.5 6.5 0 0 1 14.5 8v.5a.75.75 0 0 1-1.5 0V8a5 5 0 0 0-8.9-3.1.75.75 0 0 1-1.22-.88A6.5 6.5 0 0 1 8 1.5ZM3.28 5.22a.75.75 0 0 0-1.06 1.06L3.5 7.56l-1.28 1.28a.75.75 0 1 0 1.06 1.06L4.56 8.62l1.28 1.28a.75.75 0 1 0 1.06-1.06L5.62 7.56l1.28-1.28a.75.75 0 0 0-1.06-1.06L4.56 6.5 3.28 5.22Zm5.2 2.2a.75.75 0 0 0-1.06 1.06l1.28 1.28-1.28 1.28a.75.75 0 1 0 1.06 1.06l1.28-1.28 1.28 1.28a.75.75 0 0 0 1.06-1.06L10.84 8.62l1.28-1.28a.75.75 0 0 0-1.06-1.06L9.78 7.56 8.5 6.28a.75.75 0 0 0-1.06 1.06l1.28 1.28L7.44 8.62Z" />
              </svg>
            ) : (
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M7.25 3.033a.75.75 0 0 1 1.28-.53l5.25 4.2a.75.75 0 0 1 0 1.194l-5.25 4.2a.75.75 0 0 1-1.28-.53V7.936L4.03 6.463a.75.75 0 0 0-1.06 1.06L4.81 9.37l-1.84 1.847a.75.75 0 1 0 1.06 1.06L5.25 10.43v2.364a.75.75 0 0 0 1.28.53l5.25-4.2a.75.75 0 0 0 0-1.194l-5.25-4.2a.75.75 0 0 0-1.28.53v.84L2.97 4.403a.75.75 0 0 0-1.06 1.06L3.78 7.31 2.91 8.177a.75.75 0 0 0 1.06 1.06l.11-.111v.4a.75.75 0 0 0 1.28.53l1.89-1.512Z" />
              </svg>
            )}
          </button>

          {/*
            Closing the bar is not closing the app. That is the whole reason this
            exists as a `window` command rather than letting Electron's own close
            do it — and the main process intercepts the window's own close event
            for the same reason, so the ✕ in the OS layer and this one behave
            identically.
          */}
          <button
            className="mini-btn mini-btn-sm"
            onClick={() => window.titanMini.window({ type: "close-mini" })}
            title="Hide the mini player"
            aria-label="Hide the mini player"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M3.47 3.47a.75.75 0 0 1 1.06 0L8 6.94l3.47-3.47a.75.75 0 1 1 1.06 1.06L9.06 8l3.47 3.47a.75.75 0 0 1-1.06 1.06L8 9.06l-3.47 3.47a.75.75 0 0 1-1.06-1.06L6.94 8 3.47 4.53a.75.75 0 0 1 0-1.06Z" />
            </svg>
          </button>
        </div>

        {/*
          The seek bar, last in the document and spanning the full width on its
          own row.

          *Last* is load-bearing, not incidental. Grid auto-placement walks the
          children in order, and this one has a definite column span
          (`1 / -1`) with an automatic row. Sitting in the middle, it consumed
          row 2 and pushed the mute and close buttons onto an implicit third row,
          which shortened the row above and made the artwork look cropped. Put
          last, it lands on row 2 because that is the only row left.

          It is also the right order semantically: the transport is the content
          and the bar that scrubs it is the chrome.
        */}
        <div
          className="mini-progress"
          ref={progressRef}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId)
            onSeekPointer(e)
          }}
          onPointerMove={(e) => {
            if (e.currentTarget.hasPointerCapture(e.pointerId)) onSeekPointer(e)
          }}
          role="slider"
          tabIndex={0}
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={Math.round(track?.duration ?? 0)}
          aria-valuenow={Math.round(state.position)}
          onKeyDown={(e) => {
            const d = track?.duration ?? 0
            if (d <= 0) return
            if (e.key === "ArrowRight") send({ type: "seek", seconds: Math.min(d, state.position + 5) })
            else if (e.key === "ArrowLeft") send({ type: "seek", seconds: Math.max(0, state.position - 5) })
            else return
            e.preventDefault()
          }}
        >
          <span className="mini-progress-fill" />
        </div>
      </div>

      {/*
        The whole panel fades in rather than appearing. A floating window that
        pops into existence over the desktop is startling in a way that a panel
        inside a window is not, and this is the only animation here that is not
        driven by the music.
      */}
      <style>{`@keyframes mini-in{from{opacity:0;transform:translateY(6px) scale(.98)}to{opacity:1;transform:none}}
.mini-panel{animation:mini-in ${reduced ? 1 : 260}ms cubic-bezier(.22,1,.36,1)}`}</style>
    </div>
  )
}
