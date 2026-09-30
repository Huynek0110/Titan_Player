import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { splitWords, wordBodyProblem } from "@shared/lyrics"
import type { LyricLine, Lyrics } from "@shared/types"
import { ChevronDown, ChevronUp, Close, Lyrics as LyricsIcon, Play, Plus, Refresh, Trash } from "./Icons"
import "./LyricsEditor.css"

/**
 * Editing lyrics, and writing them to a sidecar `.lrc`.
 *
 * The lyrics pane deliberately has no scroll container and no per-line DOM: it
 * shows the current line and two upcoming ones, and everything about it assumes
 * timings are correct. This is the opposite screen. Every line is here, every one
 * is wrong somewhere, and the job is to change them — so a list with a scroll
 * container and an input per line is the correct shape rather than a regression
 * away from the pane.
 *
 * The reason it exists is the word sweep. Line-level timing is a guarantee and
 * word-level is a bonus that only Enhanced LRC provides, and almost nothing
 * writes Enhanced LRC, so the sweep has never had a file to run on. Tapping the
 * words along as the track plays is how you make one, and it is a few seconds of
 * work per line.
 */
interface LyricsEditorProps {
  /** Absolute path of the audio file. The sidecar is written beside it. */
  audioPath: string
  meta: { title: string; artist: string; album: string; duration: number }
  /** The lines currently on screen, from tags, a sidecar, or an online lookup. */
  lines: LyricLine[]
  plain?: string
  /** The audio clock, read through a callback so it can stay stable. */
  getTime: () => number
  isPlaying: boolean
  onTogglePlay: () => void
  onSeek: (seconds: number) => void
  /** Adopt freshly parsed lyrics so the pane shows exactly what was written. */
  onAdopt: (lyrics: Lyrics) => void
  onClose: () => void
}

/** How often the playhead is sampled for the "this line is playing" highlight. */
const CLOCK_POLL_MS = 250
/** How far a line moves on a nudge. A tenth of a second is below what a listener
 *  can hear as a change of position but is above the file's own resolution. */
const NUDGE_STEP = 0.1

/**
 * Millisecond-accurate `m:ss.xx`, for editing rather than for display.
 *
 * `formatDuration` truncates to whole seconds, which is right for a playback
 * readout and useless here: two lines a second apart would show the same value
 * and there would be no way to tell which is which. Centiseconds, because that is
 * the resolution the file format itself has — anything finer would be a number
 * this app cannot save.
 */
function formatStamp(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0
  const centis = Math.floor(safe * 100)
  const minutes = Math.floor(centis / 6000)
  const secs = Math.floor(centis / 100) % 60
  return `${minutes}:${String(secs).padStart(2, "0")}.${String(centis % 100).padStart(2, "0")}`
}

/**
 * Accepts `m:ss.xx`, `ss.xx` or `m:ss`, so a time can be typed the way it is
 * displayed without ceremony. Returns null for anything unparseable, which the
 * caller treats as "leave the old value alone" rather than as zero.
 */
function parseStamp(value: string): number | null {
  const text = value.trim()
  if (text.length === 0) return null
  const colon = text.lastIndexOf(":")
  if (colon >= 0) {
    const minutes = Number(text.slice(0, colon))
    const seconds = Number(text.slice(colon + 1))
    if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) return null
    return Math.max(0, minutes * 60 + seconds)
  }
  const only = Number(text)
  return Number.isFinite(only) ? Math.max(0, only) : null
}

/** Why a line's word timing is not being written, as a sentence. */
const WORD_PROBLEM_TEXT: Record<string, string> = {
  "no-words": "This line is empty.",
  "single-word": "One word is not a karaoke fill — there is nothing to sweep across.",
  gap: "The word timings do not cover the whole line.",
  overlap: "The word timings overlap each other.",
  "short-cover": "The word timings stop before the end of the line.",
  backwards: "The word timings run backwards in time.",
}

type Status =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; at: string }
  | { kind: "error"; detail: string }
  | { kind: "note"; detail: string }

/**
 * A timestamp that can be edited without fighting the user.
 *
 * Held as local text while focused and committed on blur or Enter, because
 * reformatting on every keystroke makes intermediate states impossible to type:
 * typing "1:23.45" one character at a time would rewrite the field to "0:01" the
 * moment the "1" landed, and the rest of the time would go somewhere else.
 */
function StampField({
  value,
  onCommit,
  label,
}: {
  value: number
  onCommit: (seconds: number) => void
  label: string
}) {
  const [text, setText] = useState(() => formatStamp(value))
  const focused = useRef(false)

  // Reformat when the value changes from outside, but never mid-edit: the parent
  // nudges this same line from its own buttons, and a field that reflows to
  // "0:12.30" between two keystrokes loses the caret's surroundings.
  useEffect(() => {
    if (!focused.current) setText(formatStamp(value))
  }, [value])

  return (
    <input
      className="ed-stamp tabular"
      type="text"
      inputMode="decimal"
      aria-label={label}
      value={text}
      onFocus={() => {
        focused.current = true
      }}
      onChange={(event) => setText(event.target.value)}
      onBlur={() => {
        focused.current = false
        const parsed = parseStamp(text)
        setText(formatStamp(parsed ?? value))
        if (parsed !== null && parsed !== value) onCommit(parsed)
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.currentTarget.blur()
          return
        }
        if (event.key === "Escape") {
          setText(formatStamp(value))
          event.currentTarget.blur()
        }
      }}
    />
  )
}

export default function LyricsEditor({
  audioPath,
  meta,
  lines,
  plain,
  getTime,
  isPlaying,
  onTogglePlay,
  onSeek,
  onAdopt,
  onClose,
}: LyricsEditorProps) {
  /*
   * The draft owns every edit and nothing else does.
   *
   * A track change has to reset it, and the parent keys this component on the
   * track id rather than passing a reset down: a `useEffect` that watches the id
   * fires *after* the first paint, which shows the previous track's lyric in the
   * editor for a frame — and if the user saved in that frame they would write one
   * track's lyrics over another's file.
   */
  const [draft, setDraft] = useState<LyricLine[]>(() => lines.map((line) => ({ ...line })))
  const [dirty, setDirty] = useState(false)
  const [status, setStatus] = useState<Status>({ kind: "idle" })
  const [sidecarExists, setSidecarExists] = useState<boolean | null>(null)
  const [now, setNow] = useState(0)

  /** A tap-to-time session in progress, or null. */
  const [tap, setTap] = useState<{ index: number; times: number[] } | null>(null)
  const tapSurfaceRef = useRef<HTMLDivElement>(null)
  const rowsRef = useRef<HTMLDivElement>(null)

  // --- the playhead ------------------------------------------------------
  /*
   * A poll, not a `requestAnimationFrame` loop. This screen re-renders the whole
   * list on every change, and at sixty frames a second that is a hundred
   * re-renders of every input on the screen per minute of playback, which costs
   * enough to make typing feel sticky. A quarter of a second is faster than
   * anyone can read a highlight moving between lines.
   */
  useEffect(() => {
    const tick = () => setNow(getTime())
    tick()
    const timer = window.setInterval(tick, CLOCK_POLL_MS)
    return () => window.clearInterval(timer)
  }, [getTime])

  // Does a sidecar exist? Only used to phrase the delete button honestly.
  useEffect(() => {
    let live = true
    void window.titan
      .readLyricsSidecar(audioPath)
      .then((text) => {
        if (live) setSidecarExists(text !== null && text.trim().length > 0)
      })
      .catch(() => {
        if (live) setSidecarExists(false)
      })
    return () => {
      live = false
    }
  }, [audioPath])

  // --- editing -----------------------------------------------------------

  /** Apply a change to one line and mark the draft dirty. */
  const edit = useCallback((index: number, patch: Partial<LyricLine>) => {
    setDraft((prev) => {
      const next = [...prev]
      const line = next[index]
      if (!line) return prev
      // `time` is clamped here rather than at each call site: every path that sets
      // it is arithmetic on a clock, and a negative timestamp is a file that will
      // not parse back.
      const time = patch.time !== undefined ? Math.max(0, patch.time) : line.time
      next[index] = { ...line, ...patch, time }
      return next
    })
    setDirty(true)
    setStatus({ kind: "idle" })
  }, [])

  const move = useCallback((index: number, delta: number) => {
    setDraft((prev) => {
      const to = index + delta
      if (index < 0 || to < 0 || to >= prev.length) return prev
      const next = [...prev]
      const [line] = next.splice(index, 1)
      next.splice(to, 0, line)
      return next
    })
    setDirty(true)
  }, [])

  const remove = useCallback((index: number) => {
    setDraft((prev) => prev.filter((_, i) => i !== index))
    setDirty(true)
    setStatus({ kind: "idle" })
  }, [])

  const addLine = useCallback(() => {
    const at = Math.max(0, getTime())
    setDraft((prev) => {
      // Insert in time order, so a line added mid-playback lands next to what is
      // playing rather than at the bottom of a list the user is reading in order.
      const at2 = prev.findIndex((line) => line.time > at)
      const next = [...prev]
      next.splice(at2 === -1 ? next.length : at2, 0, { time: at, text: "" })
      return next
    })
    setDirty(true)
  }, [getTime])

  const shiftAll = useCallback((delta: number) => {
    setDraft((prev) =>
      prev.map((line) => ({
        ...line,
        time: Math.max(0, line.time + delta),
        // Word timings are absolute, so a line-level shift has to move them too.
        // Leaving them behind would move the sweep out from under the line, which
        // is the one edit that silently breaks karaoke.
        words: line.words?.map((word) => ({ ...word, time: Math.max(0, word.time + delta) })),
      })),
    )
    setDirty(true)
  }, [])

  const sortByTime = useCallback(() => {
    setDraft((prev) => [...prev].sort((a, b) => a.time - b.time))
    setDirty(true)
  }, [])

  /**
   * Turn untagged plain text into editable lines.
   *
   * The one flow the editor enables that nothing else does: a track with lyrics
   * but no timing is exactly the track a user opens this for, and requiring them
   * to retype the words to get at the timing would be absurd. The lines all start
   * at zero because there is no honest guess — the user sets each one by ear, or
   * by tapping, and a plausible-looking spread would be a lie about where the
   * singing is.
   */
  const importPlain = useCallback(() => {
    if (!plain) return
    const imported = plain
      .split(/\r?\n/)
      .map((text) => text.trim())
      .filter((text) => text.length > 0)
      .map((text) => ({ time: 0, text }))
    if (imported.length === 0) return
    setDraft(imported)
    setDirty(true)
    setStatus({
      kind: "note",
      detail: `Added ${imported.length} lines. Set each one's time, or tap the words as the track plays.`,
    })
  }, [plain])

  // --- tapping word timings ----------------------------------------------

  const startTap = useCallback(
    (index: number) => {
      const line = draft[index]
      if (!line) return
      const text = line.text.replace(/\s+/g, " ").trim()
      const segments = splitWords(text)
      if (segments.length < 2) {
        setStatus({
          kind: "error",
          detail: "A word-by-word fill needs at least two words in the line.",
        })
        return
      }
      // Word one takes the line's own time. In an LRC the line tag and the first
      // word tag are the same moment by construction, so pre-filling it is not a
      // guess — and it saves the one tap that is always the least interesting.
      setTap({ index, times: [line.time] })
      setStatus({ kind: "idle" })
      if (!isPlaying) onTogglePlay()
    },
    [draft, isPlaying, onTogglePlay],
  )

  const cancelTap = useCallback(() => {
    setTap(null)
  }, [])

  /**
   * Commit a tap session, keeping the word timing only if it is complete.
   *
   * A partial word array does not save as word timing at all — `formatLrc`
   * degrades it to a plain line, because an untimed tail would light up all at
   * once and read as the words being shouted. So the same rule is applied here,
   * where the user can be told, rather than at save time, where they cannot.
   */
  const finishTap = useCallback(
    (index: number, times: number[]) => {
      const line = draft[index]
      const text = line?.text.replace(/\s+/g, " ").trim() ?? ""
      const segments = splitWords(text)
      setTap(null)
      if (!line) return
      if (times.length !== segments.length) {
        edit(index, { words: undefined, time: times[0] ?? line.time })
        setStatus({
          kind: "note",
          detail: `Timed ${times.length} of ${segments.length} words, so this line was left as a normal line. A word-by-word fill needs every word.`,
        })
        return
      }
      edit(index, {
        time: times[0],
        words: segments.map((segment, i) => ({
          time: times[i],
          start: segment.start,
          end: segment.end,
        })),
      })
      setStatus({ kind: "idle" })
    },
    [draft, edit],
  )

  /**
   * The tap surface's keyboard handler.
   *
   * A React handler rather than a `window` listener, and that is deliberate.
   * `usePlayer` owns the app's global shortcuts and is registered on `window` when
   * the player mounts — which is long before this screen exists, so it always
   * fires first and `preventDefault()` from a window listener registered later
   * would arrive too late to stop Space pausing the track. React attaches at the
   * root container, which is *below* `window` in the bubble path, so preventing
   * the default here sets `defaultPrevented` in time for `usePlayer` to bail on.
   */
  const onTapKey = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (!tap) return
      const line = draft[tap.index]
      if (!line) return
      const text = line.text.replace(/\s+/g, " ").trim()
      const segments = splitWords(text)

      if (event.key === "Escape") {
        event.preventDefault()
        setTap(null)
        setStatus({ kind: "idle" })
        return
      }
      if (event.key === "Enter") {
        event.preventDefault()
        finishTap(tap.index, tap.times)
        return
      }
      if (event.key === "Backspace") {
        event.preventDefault()
        // Mis-taps are the normal case, not the exception, so the way back is one
        // key and not a restart. Never drops the pre-filled first word, so there
        // is always something to tap onto.
        setTap({ index: tap.index, times: tap.times.slice(0, Math.max(1, tap.times.length - 1)) })
        return
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return
      if (event.key.length !== 1 && event.key !== " ") return

      event.preventDefault()
      const last = tap.times[tap.times.length - 1]
      // Clamped to be non-decreasing. Seeking backwards mid-session would
      // otherwise produce a word array running backwards in time, which
      // `formatLrc` refuses and the save would silently drop the karaoke for.
      const at = Math.max(getTime(), last)
      const times = [...tap.times, at]
      if (times.length >= segments.length) finishTap(tap.index, times)
      else setTap({ index: tap.index, times })
    },
    [tap, draft, getTime, finishTap],
  )

  // Focus the tap surface so it receives keys without the user having to click.
  useEffect(() => {
    if (tap) tapSurfaceRef.current?.focus()
  }, [tap])

  // --- saving ------------------------------------------------------------

  const save = useCallback(async () => {
    const usable = draft.filter((line) => line.text.trim().length > 0)
    if (usable.length === 0) {
      setStatus({ kind: "error", detail: "There are no lyric lines to save." })
      return
    }
    setStatus({ kind: "saving" })
    const result = await window.titan.saveLyrics({
      audioPath,
      lines: usable,
      meta: {
        title: meta.title,
        artist: meta.artist,
        album: meta.album,
        length: meta.duration,
      },
    })
    if (!result.ok) {
      setStatus({ kind: "error", detail: result.detail })
      return
    }
    /*
     * Adopt the parsed form, not the draft. The response carries what the file
     * actually contains after a round trip, so the pane and the editor show the
     * same thing the next scan will — rather than the optimistic in-memory copy,
     * which is the version that quietly disagrees with the disk.
     */
    setDraft(result.lyrics.lines.map((line) => ({ ...line })))
    setDirty(false)
    setSidecarExists(true)
    setStatus({ kind: "saved", at: result.path })
    onAdopt(result.lyrics)
  }, [audioPath, draft, meta, onAdopt])

  const revert = useCallback(() => {
    setDraft(lines.map((line) => ({ ...line })))
    setDirty(false)
    setStatus({ kind: "idle" })
  }, [lines])

  const deleteSidecar = useCallback(async () => {
    const result = await window.titan.removeLyricsSidecar(audioPath)
    if (!result.ok) {
      setStatus({ kind: "error", detail: result.detail })
      return
    }
    setSidecarExists(false)
    setStatus({
      kind: "note",
      detail: "Lyric file removed. Rescan the library to go back to the lyrics inside the audio file.",
    })
  }, [audioPath])

  // --- derived -----------------------------------------------------------

  const timedWords = useMemo(
    () => draft.filter((line) => line.words && line.words.length >= 2).length,
    [draft],
  )

  const untimed = useMemo(
    () => draft.filter((line) => !line.words || line.words.length < 2).length,
    [draft],
  )

  const tapLine = tap ? draft[tap.index] : null
  const tapSegments = tapLine ? splitWords(tapLine.text.replace(/\s+/g, " ").trim()) : []

  return (
    <div className="editor">
      <header className="editor-head">
        <div className="editor-head-text">
          <strong>Edit lyrics</strong>
          <span>
            {draft.length === 0
              ? "No lines yet"
              : `${draft.length} line${draft.length === 1 ? "" : "s"}`}
            {untimed === 0 && timedWords > 0
              ? ` · ${timedWords} with word timing`
              : timedWords > 0
                ? ` · ${timedWords} with word timing, ${untimed} without`
                : ""}
          </span>
        </div>
        <button
          className="icon-btn"
          onClick={onClose}
          aria-label="Close the lyrics editor"
          title="Close"
        >
          <Close size={16} />
        </button>
      </header>

      {/*
        The tap surface.

        Replaces the line list entirely while a session is running, so there is
        exactly one thing on screen to tap against and no way to click a control
        that would steal the keys. `role="application"` is what tells a screen
        reader that the arrow of keys here is a data-entry instrument rather than
        navigation, and `aria-live` on the count announces progress — a session
        that only shows progress on the screen is unusable without sight.
      */}
      {tap ? (
        <div
          className="ed-tap"
          ref={tapSurfaceRef}
          tabIndex={0}
          role="application"
          aria-label="Tap each word as you hear it"
          onKeyDown={onTapKey}
          onClick={(event) => event.currentTarget.focus()}
        >
          <p className="ed-tap-hint">
            Tap any key on each word as you hear it. <kbd>Enter</kbd> to finish,{" "}
            <kbd>Esc</kbd> to cancel, <kbd>Backspace</kbd> to undo the last word.
          </p>

          <p className="ed-tap-count" aria-live="polite">
            {Math.min(tap.times.length, tapSegments.length)} / {tapSegments.length} words
          </p>

          <ol className="ed-tap-words">
            {tapSegments.map((segment, i) => {
              const stamped = i < tap.times.length
              const isNext = i === tap.times.length
              return (
                <li
                  key={segment.start}
                  className={`ed-tap-word ${stamped ? "is-stamped" : ""} ${
                    isNext ? "is-next" : ""
                  }`}
                >
                  {segment.text.trim()}
                </li>
              )
            })}
          </ol>

          <div className="ed-tap-foot">
            <button className="np-action" onClick={cancelTap}>
              Cancel
            </button>
            <button
              className="np-action lead"
              onClick={() => finishTap(tap.index, tap.times)}
            >
              Finish now
            </button>
          </div>
        </div>
      ) : (
        <>
          {draft.length === 0 ? (
            <div className="editor-empty">
              <LyricsIcon size={24} />
              <p>Nothing to edit</p>
              <span>
                {plain
                  ? "This track has lyrics but no timing. Start from the text and set the times."
                  : "This track has no lyrics. Open an .lrc file from the actions on the left, or start a blank line here."}
              </span>
              {plain && (
                <button className="ed-empty-action" onClick={importPlain}>
                  Use the plain text
                </button>
              )}
            </div>
          ) : (
            <div className="ed-rows" ref={rowsRef}>
              {draft.map((line, index) => {
                const problem = wordBodyProblem(line)
                const words = line.words?.length ?? 0
                const isCurrent =
                  now >= line.time && (index === draft.length - 1 || now < draft[index + 1].time)
                return (
                  <div
                    /*
                     * Keyed on the slot, deliberately.
                     *
                     * The obvious key is the line itself — index, time and text —
                     * and it loses the caret after a single character. Editing a
                     * line changes its text, the key changes, React tears the row
                     * down and builds a new one, and focus goes with it: the first
                     * character lands and then the user is typing nowhere.
                     *
                     * Keying on the index costs something real in the other
                     * direction — moving a row keeps its input in place and swaps
                     * what is in it — but every row here is fully controlled, so
                     * the values are correct a frame later, and the focus the user
                     * is relying on survives. Typing is the common case and losing
                     * the caret on every keystroke is the failure that makes the
                     * screen unusable; a momentary swap during a deliberate reorder
                     * is not.
                     */
                    key={index}
                    className={`ed-row ${isCurrent ? "is-current" : ""} ${
                      line.text.trim().length === 0 ? "has-no-text" : "has-text"
                    }`}
                  >
                    <div className="ed-row-main">
                      <StampField
                        value={line.time}
                        label={`Start time of line ${index + 1}`}
                        onCommit={(seconds) => edit(index, { time: seconds })}
                      />

                      <input
                        className="ed-text"
                        type="text"
                        aria-label={`Text of line ${index + 1}`}
                        value={line.text}
                        onChange={(event) => edit(index, { text: event.target.value })}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault()
                            addLine()
                          }
                        }}
                        placeholder="…"
                      />

                      <div className="ed-row-btns">
                        <button
                          className="icon-btn"
                          onClick={() => edit(index, { time: getTime() })}
                          aria-label={`Set line ${index + 1} to the current playback position`}
                          title="Set to where the track is playing now"
                        >
                          <Play size={14} />
                        </button>
                        <button
                          className="icon-btn"
                          onClick={() => edit(index, { time: line.time - NUDGE_STEP })}
                          aria-label={`Move line ${index + 1} 0.1 seconds earlier`}
                          title="0.1s earlier"
                        >
                          &minus;
                        </button>
                        <button
                          className="icon-btn"
                          onClick={() => edit(index, { time: line.time + NUDGE_STEP })}
                          aria-label={`Move line ${index + 1} 0.1 seconds later`}
                          title="0.1s later"
                        >
                          +
                        </button>
                        <button
                          className="icon-btn"
                          onClick={() => startTap(index)}
                          aria-label={`Tap the word timings for line ${index + 1}`}
                          title={
                            words >= 2
                              ? "Tap the word timings again"
                              : "Tap the word timings as the track plays"
                          }
                        >
                          <LyricsIcon size={14} />
                        </button>
                        {words >= 2 && (
                          <button
                            className="icon-btn"
                            onClick={() => edit(index, { words: undefined })}
                            aria-label={`Remove the word timings from line ${index + 1}`}
                            title="Remove word timing"
                          >
                            <Refresh size={14} />
                          </button>
                        )}
                        <button
                          className="icon-btn"
                          onClick={() => move(index, -1)}
                          disabled={index === 0}
                          aria-label={`Move line ${index + 1} up`}
                        >
                          <ChevronUp size={14} />
                        </button>
                        <button
                          className="icon-btn"
                          onClick={() => move(index, 1)}
                          disabled={index === draft.length - 1}
                          aria-label={`Move line ${index + 1} down`}
                        >
                          <ChevronDown size={14} />
                        </button>
                        <button
                          className="icon-btn"
                          onClick={() => remove(index)}
                          aria-label={`Delete line ${index + 1}`}
                          title="Delete this line"
                        >
                          <Trash size={14} />
                        </button>
                      </div>
                    </div>

                    <div className="ed-row-meta">
                      <button
                        className="ed-jump"
                        onClick={() => onSeek(Math.max(0, line.time))}
                        title="Play from this line"
                      >
                        {formatStamp(line.time)}
                      </button>
                      {words >= 2 ? (
                        <span className="ed-words-ok">{words} words timed</span>
                      ) : problem && problem !== "no-words" ? (
                        <span className="ed-words-bad">{WORD_PROBLEM_TEXT[problem]}</span>
                      ) : (
                        <span className="ed-words-none">no word timing</span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          <footer className="editor-foot">
            {status.kind === "error" && (
              <p className="editor-msg is-error" role="alert">
                {status.detail}
              </p>
            )}
            {status.kind === "note" && (
              <p className="editor-msg" role="status">
                {status.detail}
              </p>
            )}
            {status.kind === "saved" && (
              <p className="editor-msg is-ok" role="status">
                Saved. {status.at}
              </p>
            )}

            <div className="editor-actions">
              <button className="np-action" onClick={addLine} title="Add a line at the current position">
                <Plus size={13} />
                Line
              </button>
              <button
                className="np-action"
                onClick={() => shiftAll(-NUDGE_STEP)}
                title="Move every line 0.1 seconds earlier"
              >
                All &minus;
              </button>
              <button
                className="np-action"
                onClick={() => shiftAll(NUDGE_STEP)}
                title="Move every line 0.1 seconds later"
              >
                All +
              </button>
              <button className="np-action" onClick={sortByTime} title="Order the list by time">
                Sort
              </button>

              <span className="editor-gap" />

              {sidecarExists && (
                <button
                  className="np-action"
                  onClick={() => void deleteSidecar()}
                  title="Delete the .lrc file beside the track and go back to the lyrics inside it"
                >
                  <Trash size={13} />
                  File
                </button>
              )}

              <button
                className="np-action"
                onClick={revert}
                disabled={!dirty}
                title="Discard every unsaved change"
              >
                Revert
              </button>
              <button
                className="np-action lead"
                onClick={() => void save()}
                disabled={status.kind === "saving" || draft.length === 0}
                title="Write these lyrics to a .lrc file beside the track"
              >
                {status.kind === "saving" ? "Saving…" : "Save .lrc"}
              </button>
            </div>
          </footer>
        </>
      )}
    </div>
  )
}
