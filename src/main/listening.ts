/**
 * Persisting listening history.
 *
 * Its own file rather than a field in the store's state, for two reasons. It is
 * written far more often than anything else the app saves — every track change is
 * a write, and the store's file is rewritten wholesale each time, so folding this
 * in would mean rewriting settings and playlists four times an hour. And it wants
 * a different retention policy: settings are permanent and small, whereas this is
 * bounded by the library and pruned after every scan.
 *
 * Writes are queued and atomic for the same reason as the store's: two sessions
 * ending at once, or a crash mid-write, must not leave a truncated file. The
 * history is the one thing here that genuinely cannot be rebuilt — the music is on
 * disk, the record of having heard it is not.
 */
import { promises as fs } from "node:fs"
import path from "node:path"
import { app } from "electron"
import type { ListeningHistory, ListenRecord } from "../shared/listening.js"

/**
 * Above this the file is not something this app wrote, and it is refused rather
 * than repaired. Corrupt history is a nuisance; discarding a year of it silently
 * would be worse than the nuisance, and there is nothing here worth risking that.
 */
const MAX_BYTES = 32 * 1024 * 10

let history: ListeningHistory | null = null
let writeQueued: Promise<void> = Promise.resolve()

function historyFilePath(): string {
  return path.join(app.getPath("userData"), "listening.json")
}

/** Drop anything that is not a usable record, so one bad entry cannot fail a load. */
function sanitise(raw: unknown): ListeningHistory {
  if (!raw || typeof raw !== "object") return {}
  const out: ListeningHistory = {}
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue
    const record = value as Partial<ListenRecord>
    const plays = Number(record.plays)
    const skips = Number(record.skips)
    const listenedMs = Number(record.listenedMs)
    const lastPlayed = typeof record.lastPlayed === "string" ? record.lastPlayed : ""
    if (!Number.isFinite(plays) && !Number.isFinite(skips) && lastPlayed === "") continue
    out[id] = {
      plays: Number.isFinite(plays) && plays > 0 ? Math.floor(plays) : 0,
      skips: Number.isFinite(skips) && skips > 0 ? Math.floor(skips) : 0,
      // An unparseable date sorts as never-played, which is the safe reading: it
      // cannot be shown as recent, so the track stays where a first play would put
      // it rather than jumping to the top of "recently played".
      lastPlayed: Number.isFinite(Date.parse(lastPlayed)) ? lastPlayed : "",
      listenedMs: Number.isFinite(listenedMs) && listenedMs > 0 ? Math.floor(listenedMs) : 0,
    }
  }
  return out
}

export async function loadHistory(): Promise<ListeningHistory> {
  if (history) return history
  try {
    const file = historyFilePath()
    const stat = await fs.stat(file)
    if (stat.size > MAX_BYTES) throw new Error("listening.json is implausibly large")
    history = sanitise(JSON.parse(await fs.readFile(file, "utf8")))
  } catch {
    // No history yet, or unreadable. Starting empty is right: the app is about
    // music, and refusing to open a window because a side file is corrupt would
    // be a worse outcome than losing the listening record.
    history = {}
  }
  return history
}

function flush(): Promise<void> {
  const snapshot = history
  if (!snapshot) return Promise.resolve()
  const file = historyFilePath()
  writeQueued = writeQueued
    .then(async () => {
      const tmp = `${file}.tmp`
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(tmp, JSON.stringify(snapshot), "utf8")
      await fs.rename(tmp, file)
    })
    .catch((err) => {
      console.error("[listening] failed to persist:", err)
    })
  return writeQueued
}

/**
 * Replace the history wholesale and persist it.
 *
 * Takes the whole map rather than a single record on purpose. Folding one
 * session into one track is `applyListen`'s job and it lives in `shared`, so there
 * is exactly one implementation of the increment and no way for a caller to
 * "update" a record by overwriting it with zeroes — which is what a
 * per-track setter invites the first time someone writes it.
 *
 * One write per finished session, which is at most one per track change. Not
 * debounced further: a listener who closes the app mid-track should not lose that
 * track, and the file is a few tens of kilobytes for a large library.
 */
export async function saveHistory(next: ListeningHistory): Promise<ListeningHistory> {
  history = next
  await flush()
  return history
}

/**
 * Forget tracks that are no longer in the library.
 *
 * Called after a scan, alongside `prunePlaylists`, and gated the same way. An
 * earlier version of the playlist pruning checked only that the library was
 * non-empty, so a library split across two drives permanently erased everything on
 * the drive that was asleep; requiring every configured folder to have been
 * reached is what keeps a disconnected `E:` from wiping the record of having
 * listened to everything on `C:`.
 */
export async function pruneHistory(validIds: Set<string>): Promise<void> {
  const current = await loadHistory()
  let changed = false
  const next: ListeningHistory = {}
  for (const [id, record] of Object.entries(current)) {
    if (validIds.has(id)) next[id] = record
    else changed = true
  }
  if (!changed) return
  history = next
  await flush()
}
