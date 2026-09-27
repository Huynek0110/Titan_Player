/** Formatting helpers shared across the UI. */

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00"
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
  return `${m}:${String(s).padStart(2, "0")}`
}

/** Long form for the details panel, e.g. "4 min 12 sec". */
export function formatDurationLong(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "--"
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const parts: string[] = []
  if (h > 0) parts.push(`${h} hr`)
  if (m > 0) parts.push(`${m} min`)
  if (s > 0 && h === 0) parts.push(`${s} sec`)
  return parts.join(" ") || "0 sec"
}

export function formatTotalDuration(seconds: number): string {
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.round((total % 3600) / 60)
  if (h > 0) return `${h} hr ${m} min`
  return `${m} min`
}

export function formatBitrate(kbps: number | null): string | null {
  if (!kbps) return null
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${kbps} kbps`
}

export function formatSampleRate(hz: number | null): string | null {
  if (!hz) return null
  return `${(hz / 1000).toFixed(1).replace(/\.0$/, "")} kHz`
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB", "TB"]
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

export function formatCount(n: number, singular: string, plural = `${singular}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? singular : plural}`
}

/** Natural sort so "Track 2" comes before "Track 10". */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" })

export function compareStrings(a: string, b: string): number {
  return collator.compare(a, b)
}
