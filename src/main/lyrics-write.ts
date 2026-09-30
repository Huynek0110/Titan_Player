/**
 * Writing lyrics back to disk.
 *
 * A sidecar `.lrc` next to the audio file, and nothing else. `music-metadata`
 * reads tags and cannot write them, and rewriting a Vorbis comment or an ID3v2
 * frame in place would mean a second tagger, a dependency, and a real risk of
 * damaging a file the user cares about. A sidecar is the same information in a
 * file that costs nothing to write and can be opened, diffed and corrected in any
 * text editor — so when something goes wrong with the format, the user has a way
 * out that does not involve this app.
 *
 * That does mean one thing the UI has to be honest about: a save does not change
 * the file the music is in. The embedded tag and the sidecar can then disagree,
 * and `preferSynced` picks between them by line count, so a sidecar with *fewer*
 * lines than an embedded tag would lose. `saveLyrics` therefore reports what the
 * scanner will make of the result rather than assuming the sidecar wins.
 */
import { promises as fs } from "node:fs"
import path from "node:path"
import { formatLrc, parseLrc, type LrcMeta } from "../shared/lyrics.js"
import type { LyricLine, Lyrics, LyricsSaveFailure } from "../shared/types.js"
import { isAllowedAudio } from "./protocol.js"

/**
 * A lyric file is a few kilobytes. Anything past this is not one, and reading it
 * anyway would put an unbounded string in front of the parser.
 */
const MAX_BYTES = 512 * 10

/**
 * Writes are serialised so two saves cannot interleave and leave a `.tmp` behind
 * or rename over each other. Same reasoning as the store's queue: the operations
 * are fast and independent, but the file they share is not.
 */
let writeQueued: Promise<unknown> = Promise.resolve()

/** Where the sidecar for `audioPath` lives. Same rule the scanner reads by. */
export function sidecarPath(audioPath: string): string {
  return path.join(
    path.dirname(audioPath),
    `${path.basename(audioPath, path.extname(audioPath))}.lrc`,
  )
}

/**
 * Why a save was refused.
 *
 * `reason` is a code the editor can branch on and `detail` is a sentence it can
 * show verbatim, and they are separate because the two have different jobs: the
 * code decides what the editor does next, the sentence is what the user reads.
 * A single message field would force the renderer to either parse English to get
 * a branch or to show the same text for a folder that is read-only as for a path
 * outside the library.
 *
 * The Error message is the detail rather than the code, so this lands legibly in
 * a log where `detail` is the only part that makes sense.
 */
export class LyricsWriteError extends Error {
  constructor(
    readonly reason: LyricsSaveFailure,
    readonly detail: string,
  ) {
    super(detail)
    this.name = "LyricsWriteError"
  }
}

export interface SaveLyricsResult {
  /** The sidecar that was written. */
  path: string
  /** The exact bytes on disk, as a string. */
  lrc: string
  /** Those bytes parsed back, which is what the pane will now show. */
  lyrics: Lyrics
}

/**
 * Read an existing sidecar, or null when there is none.
 *
 * Size-capped for the same reason the online lookup caps its response, and
 * unreadable files are treated as absent rather than as errors: a `.lrc` the user
 * opened and corrupted should leave the editor able to start from a clean file,
 * not stuck.
 */
export async function readLyricsSidecar(audioPath: string): Promise<string | null> {
  try {
    const file = sidecarPath(audioPath)
    const stat = await fs.stat(file)
    if (!stat.isFile() || stat.size > MAX_BYTES) return null
    return await fs.readFile(file, "utf8")
  } catch {
    return null
  }
}

/**
 * Serialise `lines` and write them beside the track.
 *
 * The result is parsed back from the bytes that were written rather than from the
 * lines that were passed in, so what the pane shows after a save is what the
 * scanner will produce from the same file. Anything less would mean the editor
 * and the library could disagree about the same file, with a save as the only
 * thing that changed and no visible reason.
 */
export async function saveLyricsSidecar(
  audioPath: string,
  lines: readonly LyricLine[],
  meta?: LrcMeta,
): Promise<SaveLyricsResult> {
  /*
   * Checked before serialising, not before writing, and it is the same jail the
   * audio protocol uses. The renderer supplies this path, and writing a file is a
   * wider privilege than reading one, so it gets the narrower check applied in
   * the one place that already enforces it rather than a copy that will drift.
   */
  if (!isAllowedAudio(audioPath)) {
    throw new LyricsWriteError(
      "out-of-library",
      "That track is not in a folder this app is allowed to write to.",
    )
  }

  const lrc = formatLrc(lines, meta)
  if (lrc.length === 0) {
    throw new LyricsWriteError("nothing-to-save", "There are no lyric lines to save.")
  }
  if (Buffer.byteLength(lrc, "utf8") > MAX_BYTES) {
    throw new LyricsWriteError(
      "too-large",
      "That is more lyric text than a .lrc file is allowed to hold.",
    )
  }

  const file = sidecarPath(audioPath)

  const written = writeQueued
    .then(async () => {
      const tmp = `${file}.tmp`
      try {
        await fs.writeFile(tmp, lrc, "utf8")
        /*
         * Rename rather than write-in-place. On the same volume it is atomic, so a
         * crash or a full disk leaves the previous sidecar exactly as it was — and
         * an existing sidecar is the user's own file, possibly hand-edited, which
         * is the one thing here that cannot be regenerated.
         */
        await fs.rename(tmp, file)
      } catch (err) {
        // A temp file left behind would sit next to the track forever and the
        // scanner would ignore it, but it would still be in the user's folder.
        await fs.rm(tmp, { force: true }).catch(() => {})
        const code = (err as NodeJS.ErrnoException).code
        if (code === "EACCES" || code === "EPERM") {
          throw new LyricsWriteError(
            "not-writable",
            "Windows refused to write there. Check the file's permissions, or move the " +
              "track to a folder this app can write to.",
          )
        }
        if (code === "EISDIR") {
          throw new LyricsWriteError(
            "blocked",
            "A folder is already sitting where the .lrc file needs to go.",
          )
        }
        throw new LyricsWriteError("write-failed", `The file could not be written. (${code ?? err})`)
      }
    })
    .finally(() => {
      // Keep the queue alive after a rejection, or one failed save would refuse
      // every save after it with the same error forever.
      writeQueued = writeQueued.catch(() => {})
    })

  await written

  const parsed = parseLrc(lrc)
  return {
    path: file,
    lrc,
    lyrics: {
      synced: parsed.synced,
      lines: parsed.lines,
      plain: parsed.plain,
      source: "lrc-sidecar",
    },
  }
}

/**
 * Delete the sidecar, so the embedded tag takes over again.
 *
 * The one irreversible thing in this module, which is why the caller has to
 * confirm it and why there is no "restore". A user who removes the sidecar and
 * wants it back can re-edit and re-save; a user whose sidecar was silently
 * replaced by something worse cannot.
 */
export async function removeLyricsSidecar(audioPath: string): Promise<boolean> {
  if (!isAllowedAudio(audioPath)) {
    throw new LyricsWriteError(
      "out-of-library",
      "That track is not in a folder this app is allowed to change.",
    )
  }
  try {
    await fs.rm(sidecarPath(audioPath), { force: true })
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    throw new LyricsWriteError(
      "delete-failed",
      code === "EACCES" || code === "EPERM"
        ? "Windows refused to delete the file. Check its permissions."
        : `The file could not be deleted. (${code ?? err})`,
    )
  }
}