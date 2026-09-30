/**
 * Listening history: what has actually been listened to.
 *
 * The store's `addedAt` is a filing date, not a listening one, and it is the only
 * thing the app knows about a track's history — so every question a listener
 * actually asks ("what have I been playing", "what do I never skip", "what did I
 * just play") is unanswerable. This is the foundation for all of them, and it is
 * small on purpose: a per-track count, a skip count, a total of what was really
 * heard, and when it was last heard.
 *
 * Everything crossing the bridge is a plain number, so nothing here depends on
 * knowing where a track is or what it is called. The renderer measures; the main
 * process decides and persists. That split is deliberate — the clock lives with
 * the audio element, and the file lives in the main process, and neither should
 * have to reach across to the other for the other's half.
 */

/** What happened to one track. */
export interface ListenRecord {
  /** Times it was listened to past the threshold. */
  plays: number
  /**
   * Times it was started and abandoned before the threshold.
   *
   * Kept separately from `plays` because the *ratio* is the useful signal: a
   * track with 40 plays and 3 skips is a favourite, and one with 3 plays and 30
   * skips is a song that should never come up again. Collapsing them into one
   * number would throw that away.
   */
  skips: number
  /** ISO date the track was last counted, whether played or skipped. */
  lastPlayed: string
  /** Milliseconds actually heard, summed across every session. */
  listenedMs: number
}

export type ListeningHistory = Record<string, ListenRecord>

/**
 * How far in a track counts as having listened to it.
 *
 * Halfway through, or four minutes, whichever comes first — the rule Last.fm uses
 * and the one most people already hold without knowing it. It is the right shape
 * for two different kinds of track: a two-minute song earns it at sixty seconds,
 * and a twelve-minute drone earns it at four, because nobody finishes the latter
 * and penalising them for it would be wrong.
 *
 * The floor of ten seconds is for tracks short enough that halfway is reached by
 * a stutter. A twenty-second intro would otherwise be logged as a play the moment
 * it loaded and then next.
 */
export function playThresholdSeconds(durationSec: number): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return 10
  return Math.max(10, Math.min(durationSec * 0.5, 240))
}

/**
 * Below this much real listening, a session is neither a play nor a skip.
 *
 * A click on a track that immediately goes to the next one is not a skip, it is a
 * mis-click, and counting it would make the skip statistics useless — a library
 * where "skips" mostly means "double-clicked the wrong row" cannot tell a user
 * anything about which tracks they dislike.
 */
const SKIP_FLOOR_MS = 5_000

/**
 * Whether a finished session counts as a play, a skip, or nothing.
 *
 * `listenedMs` is used rather than the playback position, and the difference
 * matters: someone who scrubs to the middle of a track, listens to twenty seconds
 * and moves on has *not* listened to it, and a position-based rule would log that
 * as a full play every single time. Real listening is also what makes the total
 * worth keeping — position would report two hours of "minutes listened" for a
 * track that was skimmed.
 */
export function classifyListen(input: {
  /** Track length in seconds. */
  durationSec: number
  /** Where playback actually reached. */
  positionSec: number
  /** Milliseconds genuinely heard, not skipped over. */
  listenedMs: number
}): "play" | "skip" | "ignore" {
  const listened = Number.isFinite(input.listenedMs) ? Math.max(0, input.listenedMs) : 0
  const threshold = playThresholdSeconds(input.durationSec)
  if (listened >= threshold * 1000) return "play"
  if (listened >= SKIP_FLOOR_MS) return "skip"
  return "ignore"
}

const EMPTY: ListenRecord = { plays: 0, skips: 0, lastPlayed: "", listenedMs: 0 }

/** One record, or a zeroed one for a track that has never been played. */
export function recordFor(history: ListeningHistory | undefined, trackId: string): ListenRecord {
  return history?.[trackId] ?? EMPTY
}

/**
 * Fold one finished session into the history.
 *
 * Pure, and returns a new object rather than mutating, so the renderer can diff it
 * against what it had and re-render only when something actually changed.
 */
export function applyListen(
  history: ListeningHistory,
  trackId: string,
  outcome: "play" | "skip" | "ignore",
  listenedMs: number,
  at: string,
): ListeningHistory {
  if (outcome === "ignore") return history
  const previous = history[trackId] ?? EMPTY
  return {
    ...history,
    [trackId]: {
      plays: previous.plays + (outcome === "play" ? 1 : 0),
      skips: previous.skips + (outcome === "skip" ? 1 : 0),
      lastPlayed: at,
      listenedMs: previous.listenedMs + Math.max(0, listenedMs),
    },
  }
}

/** Sort key for "most played": plays first, then how much was heard. */
export function playsOf(history: ListeningHistory | undefined, trackId: string): number {
  return history?.[trackId]?.plays ?? 0
}

/** Last-played timestamp as a number, so it can be compared and sorted. */
export function lastPlayedAt(history: ListeningHistory | undefined, trackId: string): number {
  const iso = history?.[trackId]?.lastPlayed
  if (!iso) return 0
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : 0
}
