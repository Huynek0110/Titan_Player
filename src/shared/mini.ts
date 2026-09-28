/**
 * The floating mini player's state and its vocabulary.
 *
 * This lives in `shared` for the same reason the rest of the types do: the main
 * process relays it, the main window produces it, and the mini window consumes
 * it. Defining it once means the three cannot drift, and it is plain data so it
 * survives the IPC bridge without any of the three sides knowing the others
 * exist.
 */

/**
 * The track, reduced to what a 380px bar can show.
 *
 * Not the whole `Track`. The mini player needs a title, a credit line and a
 * picture, and sending a full track — which carries a filesystem path, a bitrate,
 * a sample rate and a size — across the bridge several times a second for a
 * window that renders three of those fields would be waste that shows up in the
 * position the payload is meant to be accurate about.
 */
export interface MiniTrack {
  id: string
  title: string
  artist: string
  album: string
  /** `media://` URL, or null when the track has no embedded art. */
  artwork: string | null
  /** Seconds, so the mini window can draw a seek bar with no extra round trip. */
  duration: number
}

/** Everything the mini window renders. Sent whole, never patched. */
export interface MiniState {
  track: MiniTrack | null
  /** Seconds. The mini window extrapolates between updates rather than stepping. */
  position: number
  playing: boolean
  volume: number
  muted: boolean
  shuffled: boolean
  /** "off" | "all" | "one", matching the main window's own vocabulary. */
  repeat: "off" | "all" | "one"
  favourite: boolean
  /** Milliseconds since the epoch, so the window can discard a stale packet. */
  at: number
}

/**
 * What the mini window can ask the main window to do.
 *
 * A closed set of verbs rather than "send any IPC you like", because the mini
 * window is a remote control for an audio element it does not own. Every one of
 * these is forwarded verbatim to the main window's own handlers, so there is
 * exactly one implementation of "next track" in the app and the mini bar cannot
 * drift out of sync with the real transport.
 */
export type MiniCommand =
  | { type: "play-pause" }
  | { type: "next" }
  | { type: "previous" }
  | { type: "seek"; seconds: number }
  | { type: "volume"; value: number }
  | { type: "toggle-mute" }
  | { type: "toggle-shuffle" }
  | { type: "cycle-repeat" }
  | { type: "toggle-favourite" }
  /**
   * Open the full Now Playing view.
   *
   * A command rather than a window command, because it is not a request about
   * the *bar* — it is a request about the main window's view state, and only the
   * main window can change that. Routing it through the same path as the
   * transport keeps one forwarding rule instead of two.
   */
  | { type: "open-now-playing" }

/** What the mini window can ask of its own window. Handled in the main process. */
export type MiniWindowCommand =
  | { type: "close-mini" }
  | { type: "show-main" }
  /** Persisted, so the bar comes back where it was left. */
  | { type: "mini-moved"; x: number; y: number }
  | { type: "mini-resized"; width: number; height: number }
