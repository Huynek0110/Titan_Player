import { useEffect, useRef } from "react"

interface VisualiserProps {
  /** Returns the analyser on first call; null until the audio graph exists. */
  getAnalyser: () => AnalyserNode | null
  active: boolean
  height?: number
}

const BARS = 56

/**
 * A frequency-bar visualiser driven straight from an AnalyserNode.
 *
 * Everything is drawn imperatively on one canvas. Pushing this through React
 * state would re-render 60 times a second for no benefit, and the bars would
 * visibly lag the audio.
 */
export default function Visualiser({ getAnalyser, active, height = 64 }: VisualiserProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    let raf = 0
    let data: Uint8Array<ArrayBuffer> | null = null
    let smoothed = new Float32Array(BARS)
    let analyser: AnalyserNode | null = null
    // The accent only changes when the track changes, so resolve it once here.
    // Reading it inside the bar loop meant 56 forced style resolutions per
    // frame — roughly 3,400 a second, all returning the same value.
    let accent = "#7c5cff"
    let dpr = 1

    const resolveAccent = () => {
      const value = getComputedStyle(document.documentElement)
        .getPropertyValue("--accent")
        .trim()
      if (value) accent = value
    }
    resolveAccent()
    const accentTimer = window.setInterval(resolveAccent, 1000)

    const resize = () => {
      // Clamp the same way when dividing back out, or the bars occupy only a
      // fraction of the canvas on a display whose DPR exceeds 2.
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      const rect = canvas.getBoundingClientRect()
      canvas.width = Math.max(1, Math.round(rect.width * dpr))
      canvas.height = Math.max(1, Math.round(height * dpr))
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)

    const draw = () => {
      const w = canvas.width / dpr
      const h = height

      ctx.clearRect(0, 0, w, h)

      // Create the graph lazily: doing it before the first play would trip the
      // autoplay policy and leave the node permanently suspended.
      if (active && !analyser) {
        analyser = getAnalyser()
        if (analyser) data = new Uint8Array(analyser.frequencyBinCount)
      }

      const gap = 2
      const barW = Math.max(1.5, (w - gap * (BARS - 1)) / BARS)

      // One gradient for the whole frame rather than one per bar.
      const gradient = ctx.createLinearGradient(0, 0, 0, h)
      gradient.addColorStop(0, accent)
      gradient.addColorStop(1, "rgba(255,255,255,0.18)")
      ctx.fillStyle = gradient

      for (let i = 0; i < BARS; i += 1) {
        let target = 0
        if (analyser && data && active) {
          // Logarithmic bucketing, because linear bins put almost all the
          // energy in the first few bars and the rest sit flat.
          const t = i / BARS
          const bin = Math.floor(Math.pow(t, 1.85) * (data.length * 0.62))
          target = (data[bin] ?? 0) / 255
        }
        // Fast attack, slow release, which reads as musical rather than noisy.
        smoothed[i] = target > smoothed[i] ? target : smoothed[i] * 0.82 + target * 0.18

        const barH = Math.max(2, smoothed[i] * h * 0.94)
        const x = i * (barW + gap)
        const y = h - barH

        ctx.beginPath()
        ctx.roundRect(x, y, barW, barH, Math.min(barW / 2, 2))
        ctx.fill()
      }

      raf = requestAnimationFrame(draw)
    }

    raf = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(raf)
      window.clearInterval(accentTimer)
      observer.disconnect()
    }
  }, [active, getAnalyser, height])

  return <canvas ref={canvasRef} className="visualiser" style={{ height }} aria-hidden="true" />
}
