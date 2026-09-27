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

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const rect = canvas.getBoundingClientRect()
      canvas.width = Math.max(1, Math.round(rect.width * dpr))
      canvas.height = Math.max(1, Math.round(height * dpr))
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)

    const draw = () => {
      const w = canvas.width / (window.devicePixelRatio || 1)
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

        const gradient = ctx.createLinearGradient(0, y, 0, h)
        gradient.addColorStop(0, getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#7c5cff")
        gradient.addColorStop(1, "rgba(255,255,255,0.18)")

        ctx.fillStyle = gradient
        ctx.beginPath()
        ctx.roundRect(x, y, barW, barH, Math.min(barW / 2, 2))
        ctx.fill()
      }

      raf = requestAnimationFrame(draw)
    }

    raf = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
    }
  }, [active, getAnalyser, height])

  return <canvas ref={canvasRef} className="visualiser" style={{ height }} aria-hidden="true" />
}
