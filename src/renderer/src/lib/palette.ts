/**
 * Artwork colour extraction.
 *
 * Runs entirely in the renderer against a canvas, which avoids pulling an
 * image-decoding library into the main process just to sample a few pixels.
 * Results are memoised per data URL because the same album art is decoded once
 * per track but requested by several components.
 */

export interface Palette {
  /** Dominant colour, used for the accent. */
  primary: string
  /** Two supporting colours for the ambient gradient. */
  supports: string[]
  /** True when the artwork is too dark or too flat to trust. */
  muted: boolean
}

const cache = new Map<string, Palette>()

const FALLBACK: Palette = {
  primary: "#7c5cff",
  supports: ["#22d3ee", "#ec4899"],
  muted: true,
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255
  g /= 255
  b /= 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]

  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
  else if (max === g) h = ((b - r) / d + 2) / 6
  else h = ((r - g) / d + 4) / 6
  return [h, s, l]
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) {
    const v = Math.round(l * 255)
    return [v, v, v]
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const channel = (t: number): number => {
    let tt = t
    if (tt < 0) tt += 1
    if (tt > 1) tt -= 1
    if (tt < 1 / 6) return p + (q - p) * 6 * tt
    if (tt < 1 / 2) return q
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6
    return p
  }
  return [
    Math.round(channel(h + 1 / 3) * 255),
    Math.round(channel(h) * 255),
    Math.round(channel(h - 1 / 3) * 255),
  ]
}

function toHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("")}`
}

/**
 * Boost saturation and lift lightness so a dark cover still yields an accent
 * that is visible against the near-black canvas.
 */
function makeVivid(h: number, s: number, l: number): string {
  const boostedS = Math.min(1, s < 0.12 ? 0.55 : Math.max(s, 0.45) * 1.25)
  const boostedL = Math.min(0.68, Math.max(l, 0.32) + 0.12)
  return toHex(...hslToRgb(h, boostedS, boostedL))
}

/**
 * Bucket pixels by hue and score each bucket by how much saturated, mid-light
 * area it covers. A plain k-means pass is overkill and slower for the gain.
 */
function extractFromPixels(data: Uint8ClampedArray): Palette | null {
  const buckets = new Map<number, { weight: number; hSum: number; sSum: number; lSum: number; n: number }>()

  // Sample every 4th pixel; album art is uniform enough that this is plenty.
  for (let i = 0; i < data.length; i += 16) {
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]
    const a = data[i + 3]
    if (a < 128) continue

    const [h, s, l] = rgbToHsl(r, g, b)
    // Ignore near-black, near-white and flat greys: they carry no hue signal.
    if (l < 0.08 || l > 0.94 || s < 0.12) continue

    const key = Math.floor(h * 24)
    const entry = buckets.get(key) ?? { weight: 0, hSum: 0, sSum: 0, lSum: 0, n: 0 }
    const weight = s * (1 - Math.abs(l - 0.55) * 1.4)
    entry.weight += weight
    entry.hSum += h
    entry.sSum += s
    entry.lSum += l
    entry.n += 1
    buckets.set(key, entry)
  }

  if (buckets.size === 0) return null

  const ranked = [...buckets.entries()]
    .map(([key, v]) => ({ key, ...v, avgH: v.hSum / v.n }))
    // Reward spread so the supports do not all land on the same hue family.
    .sort((a, b) => b.weight - a.weight)

  const primary = makeVivid(ranked[0].avgH, ranked[0].sSum / ranked[0].n, ranked[0].lSum / ranked[0].n)

  const supports: string[] = []
  for (const bucket of ranked) {
    if (supports.length >= 2) break
    // Skip hues within 30 degrees of one already taken.
    const taken = [ranked[0].avgH]
    if (supports.length >= 1) taken.push(Number.NaN)
    let tooClose = false
    for (let i = 0; i < ranked.indexOf(bucket); i += 1) {
      const other = ranked[i]
      const diff = Math.abs(((bucket.avgH - other.avgH + 0.5) % 1) - 0.5)
      if (diff < 0.08) tooClose = true
    }
    if (tooClose) continue
    taken.length = 0
    supports.push(makeVivid(bucket.avgH, bucket.sSum / bucket.n, bucket.lSum / bucket.n))
  }

  while (supports.length < 2) {
    // Derive complements so short palettes still fill the gradient.
    supports.push(makeVivid((ranked[0].avgH + 0.33 + supports.length * 0.2) % 1, 0.6, 0.55))
  }

  return { primary, supports, muted: false }
}

export function extractPalette(dataUrl: string | null | undefined): Promise<Palette> {
  if (!dataUrl) return Promise.resolve(FALLBACK)

  const cached = cache.get(dataUrl)
  if (cached) return Promise.resolve(cached)

  return new Promise<Palette>((resolve) => {
    const image = new Image()
    image.onload = () => {
      try {
        const size = 64
        const canvas = document.createElement("canvas")
        canvas.width = size
        canvas.height = size
        const ctx = canvas.getContext("2d", { willReadFrequently: true })
        if (!ctx) {
          resolve(FALLBACK)
          return
        }
        ctx.drawImage(image, 0, 0, size, size)
        const { data } = ctx.getImageData(0, 0, size, size)
        const palette = extractFromPixels(data) ?? FALLBACK
        // Bounded cache: a big library would otherwise hold every image's bytes.
        if (cache.size > 400) cache.clear()
        cache.set(dataUrl, palette)
        resolve(palette)
      } catch {
        // A tainted canvas or a decode failure should never break playback.
        resolve(FALLBACK)
      }
    }
    image.onerror = () => resolve(FALLBACK)
    image.src = dataUrl
  })
}

/** Write a palette into CSS custom properties on the document root. */
export function applyPalette(palette: Palette): void {
  const root = document.documentElement
  root.style.setProperty("--accent", palette.primary)
  root.style.setProperty("--accent-soft", `${palette.primary}28`)
  root.style.setProperty("--amb-1", `${palette.primary}4d`)
  root.style.setProperty("--amb-2", `${palette.supports[0]}2b`)
  root.style.setProperty("--amb-3", `${palette.supports[1]}1f`)
}

/** Pick black or white text for a background colour, by relative luminance. */
export function readableOn(hex: string): string {
  const clean = hex.replace("#", "")
  const r = parseInt(clean.slice(0, 2), 16) / 255
  const g = parseInt(clean.slice(2, 4), 16) / 255
  const b = parseInt(clean.slice(4, 6), 16) / 255
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  const luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
  return luminance > 0.45 ? "#0a0a0f" : "#ffffff"
}
