import { useEffect, useRef } from "react"
import "./Visualiser.css"

interface VisualiserProps {
  /** Returns the analyser once it exists; null until the user opts in. */
  getAnalyser: () => AnalyserNode | null
  active: boolean
  height?: number
  /**
   * Bar count. Defaults to a value derived from the canvas width, because a
   * fixed count overflowed narrow containers: at 90px with 56 bars the spacing
   * arithmetic produced a negative bar width, clamped to the minimum, and half
   * the bars were drawn outside the visible area. An explicit count is still
   * capped at what fits, so passing a too-large number cannot bring that back.
   */
  bars?: number
  /**
   * Called once if the component is active but no analyser ever turns up. The
   * loop gives up rather than spinning at 60Hz drawing nothing, so without this
   * the toggle would sit there looking on with no bars and no explanation.
   */
  onUnavailable?: () => void
}

const GAP = 2
const MIN_BAR_W = 1.5

/**
 * A frequency-bar visualiser driven straight from an AnalyserNode.
 *
 * Everything is drawn imperatively on one canvas. Pushing this through React
 * state would re-render 60 times a second for no benefit, and the bars would
 * visibly lag the audio.
 *
 * The component is opt-in and does not build the audio graph. That is the
 * caller's job, in a real user gesture, because `createMediaElementSource` is a
 * one-way door: once the element is routed into a Web Audio graph its output
 * exists only inside it, so a context that never reaches `running` means
 * permanent silence with `currentTime` still advancing and no error anywhere.
 * Sound is the product and the bars are decoration, so the default is off and
 * nothing here runs until the user asks for it.
 */
export default function Visualiser({
  getAnalyser,
  active,
  height = 64,
  bars,
  onUnavailable,
}: VisualiserProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  // Held in a ref so the drawing effect does not have to be rebuilt when the
  // identity of the parent's callback changes.
  const unavailableRef = useRef(onUnavailable)
  unavailableRef.current = onUnavailable

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    let raf = 0
    let data: Uint8Array<ArrayBuffer> | null = null
    let smoothed = new Float32Array(128)
    let analyser: AnalyserNode | null = null
    let accent = "#7c5cff"
    let dpr = 1
    let count = bars ?? 48
    // Layout-derived values, all of which only change on a resize. Recomputing
    // any of them per frame was rebuilding a gradient and redoing the bar-width
    // arithmetic 60 times a second for a canvas that had not moved.
    let barW = MIN_BAR_W
    let gradient: CanvasGradient | null = null

    /*
     * The accent is a runtime value written onto the document root by the
     * palette extractor, so it is observed rather than polled. A 1.5s interval
     * called `getComputedStyle` on the root forever, which forces a style
     * recalculation of the whole document on that interval for the life of the
     * process — and the only thing that ever changes `--accent` is a track
     * change, which is a handful of events an hour.
     */
    const readAccent = () => {
      const value = getComputedStyle(document.documentElement)
        .getPropertyValue("--accent")
        .trim()
      if (value && value !== accent) {
        accent = value
        // Force the cached gradient to be rebuilt, which the next frame does.
        gradient = null
      }
    }
    readAccent()
    const accentObserver = new MutationObserver(readAccent)
    accentObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["style"],
    })

    const resize = () => {
      // Clamp the same way when dividing back out, or the bars occupy only a
      // fraction of the canvas on a display whose DPR exceeds 2.
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      const rect = canvas.getBoundingClientRect()
      canvas.width = Math.max(1, Math.round(rect.width * dpr))
      canvas.height = Math.max(1, Math.round(height * dpr))
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      // Fit the bars to the space available instead of trusting a constant, then
      // cap an explicit count at that. The two used to be alternatives, which
      // meant `bars` was a way to re-break the original overflow.
      const cssWidth = Math.max(1, rect.width)
      const fit = Math.max(1, Math.min(64, Math.floor((cssWidth + GAP) / (4 + GAP))))
      count = bars ? Math.max(1, Math.min(bars, fit)) : fit
      if (smoothed.length !== count) smoothed = new Float32Array(count)
      barW = Math.max(MIN_BAR_W, (cssWidth - GAP * (count - 1)) / count)
      // The gradient is in canvas space, so any resize invalidates it.
      gradient = null
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)

    // How many frames to keep asking for the analyser before declaring it never
    // going to arrive. App only flips `active` after `enableVisualiser` has
    // resolved, so the node already exists; the allowance is for the case where
    // the context was closed underneath us.
    let graceFrames = 0
    let gaveUp = false

    const draw = () => {
      const w = canvas.width / dpr
      const h = height

      ctx.clearRect(0, 0, w, h)

      // Nothing to show, and no reason to keep a 60Hz loop alive.
      if (!active) {
        raf = 0
        return
      }

      // Read lazily: the caller has to create the graph inside a user gesture,
      // so there may be nothing to read on the first frame.
      if (!analyser) {
        analyser = getAnalyser()
        if (analyser) {
          data = new Uint8Array(analyser.frequencyBinCount)
        } else {
          /*
           * Previously this spun forever. A loop that wakes 60 times a second
           * to clear a canvas and draw nothing is a real cost with a zero
           * return, and the visible result — bars that never appear — looks
           * identical to a working one, so the user had no way to tell.
           */
          graceFrames += 1
          if (graceFrames > 20 && !gaveUp) {
            gaveUp = true
            unavailableRef.current?.()
            raf = 0
            return
          }
          raf = requestAnimationFrame(draw)
          return
        }
      }

      if (!analyser || !data) {
        raf = 0
        return
      }

      if (!gradient) {
        const made = ctx.createLinearGradient(0, 0, 0, h)
        made.addColorStop(0, accent)
        made.addColorStop(1, "rgba(255,255,255,0.18)")
        gradient = made
      }
      ctx.fillStyle = gradient

      for (let i = 0; i < count; i += 1) {
        let target = 0
        // Logarithmic bucketing, because linear bins put almost all the energy
        // in the first few bars and the rest sit flat.
        const t = i / count
        const bin = Math.floor(Math.pow(t, 1.85) * (data.length * 0.62))
        target = (data[bin] ?? 0) / 255
        // Fast attack, slow release, which reads as musical rather than noisy.
        smoothed[i] = target > smoothed[i] ? target : smoothed[i] * 0.82 + target * 0.18

        const barH = Math.max(2, smoothed[i] * h * 0.94)
        const x = i * (barW + GAP)
        const y = h - barH

        ctx.beginPath()
        ctx.roundRect(x, y, barW, barH, Math.min(barW / 2, 2))
        ctx.fill()
      }

      raf = requestAnimationFrame(draw)
    }

    if (active) raf = requestAnimationFrame(draw)

    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
      accentObserver.disconnect()
      // The canvas is kept in the DOM by the parent while it is toggled off, so
      // clear it rather than leaving the last frame frozen on screen.
      ctx.clearRect(0, 0, canvas.width, canvas.height)
    }
  }, [active, getAnalyser, height, bars])

  return (
    <canvas
      ref={canvasRef}
      className="visualiser"
      style={{ height }}
      aria-hidden="true"
    />
  )
}
