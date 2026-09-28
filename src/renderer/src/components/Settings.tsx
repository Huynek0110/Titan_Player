import { useMemo, useState } from "react"
import { useStore } from "../state/store"
import { DEFAULT_EXTENSIONS } from "@shared/types"
import { formatCount } from "../lib/format"
import { ChevronDown, Close, Folder, Info, Plus, Refresh, Trash } from "./Icons"
import "./Settings.css"

export interface SettingsProps {
  /**
   * Per-file scan failures, as `ScanResult.failed` carries them.
   *
   * Optional with a default so `App.tsx` compiles unchanged. The detail *is*
   * already on the renderer — `window.titan.scan()` resolves with the full
   * array — but the store's `scan:done` reducer keeps only `failed.length`, so
   * there is nothing to read here until that is plumbed through. Until then this
   * renders nothing rather than a list of paths that were never available.
   */
  failedFiles?: Array<{ path: string; reason: string }>
}

export default function Settings({ failedFiles = [] }: SettingsProps) {
  const store = useStore()
  const {
    settings,
    tracks,
    failedCount,
    lastScanMs,
    progress,
    updateSettings,
    addFolder,
    removeFolder,
    rescan,
  } = store

  const [customExt, setCustomExt] = useState("")

  /*
   * A scan in flight. Both buttons below start a fresh `library:scan` call and
   * the main process answers a second concurrent one by throwing "A scan is
   * already running" — which the store turns into `error`, which App.tsx paints
   * as a full-screen fatal modal. The folder picker is a modal dialog that can
   * easily be sat on while a background rescan starts, and the folder is
   * written to settings *before* the scan is attempted, so the failure both
   * blocks the app and leaves the on-screen state disagreeing with what was
   * saved.
   */
  const scanning = progress.phase === "walking" || progress.phase === "parsing"

  /*
   * Unreachable folders are reported by the main process as a scan-progress
   * event with `phase: "error"`, and the scan call then returns *normally*.
   *
   * This used to be caught by subscribing to the progress channel directly in
   * this component, which had two problems. The message only existed for about
   * one task before `scan:done` overwrote `progress`, and the component is only
   * mounted on the settings view, so a scan that failed while the user was
   * looking at their library lost the warning entirely. It is now `scanError` in
   * store state, which the reducer keeps until a fully clean scan — and it is
   * surfaced outside Settings too, because this is the one message that explains
   * why playlists and favourites were deliberately left stale.
   */
  const { scanError, clearScanError } = store

  const customOnly = useMemo(
    () => (settings?.extensions ?? []).filter((e) => !DEFAULT_EXTENSIONS.includes(e)),
    [settings],
  )

  if (!settings) return null

  const extList = settings.extensions.join(", ")

  function toggleExtension(ext: string) {
    const next = settings!.extensions.includes(ext)
      ? settings!.extensions.filter((e) => e !== ext)
      : [...settings!.extensions, ext]
    void updateSettings({ extensions: next })
  }

  return (
    <div className="settings">
      <div className="settings-inner">
        <header className="settings-head">
          <h1>Settings</h1>
          <p>Everything is stored on this machine. Nothing is uploaded anywhere.</p>
        </header>

        {scanError && (
          <div className="settings-notice" role="status">
            <Info size={15} />
            <p>{scanError}</p>
            <button
              onClick={clearScanError}
              aria-label="Dismiss this message"
              title="Dismiss"
            >
              <Close size={13} />
            </button>
          </div>
        )}

        <section className="settings-card">
          <h2>Music folders</h2>
          <p className="settings-note">
            Titan Player scans these folders recursively and reads the tags of every audio file it
            finds. The Windows Music folder is included unless you turn it off.
          </p>

          <label className="settings-row">
            <span>
              <strong>Include the Windows Music folder</strong>
              <em>Usually {settings.useSystemMusicFolder ? "on" : "off"}</em>
            </span>
            <button
              className={`toggle ${settings.useSystemMusicFolder ? "on" : ""}`}
              // Toggling ends in a rescan, so it is the same "already running"
              // trap as the buttons below.
              disabled={scanning}
              onClick={async () => {
                const next = !settings.useSystemMusicFolder
                // Re-scan, or the library silently keeps the old contents until
                // someone presses Rescan by hand.
                await updateSettings({ useSystemMusicFolder: next })
                await rescan()
              }}
              role="switch"
              aria-checked={settings.useSystemMusicFolder}
              title={scanning ? "Wait for the current scan to finish" : undefined}
            >
              <i />
            </button>
          </label>

          <ul className="folder-list">
            {settings.musicFolders.length === 0 ? (
              <li className="folder-empty">No extra folders added</li>
            ) : (
              settings.musicFolders.map((folder) => (
                <li key={folder}>
                  <Folder size={15} />
                  {/* Truncation is a last resort for a path, so the full value
                      rides along in `title` — a shortened folder path is
                      useless to anyone who has to find the folder on disk. */}
                  <span className="folder-path truncate" title={folder}>
                    {folder}
                  </span>
                  <button
                    className="icon-btn"
                    onClick={() => void removeFolder(folder)}
                    aria-label={`Remove ${folder}`}
                    title={`Stop scanning ${folder}`}
                  >
                    <Trash size={14} />
                  </button>
                </li>
              ))
            )}
          </ul>

          <button
            className="pill"
            disabled={scanning}
            onClick={() => void addFolder()}
            title={scanning ? "Wait for the current scan to finish" : "Choose a folder to add"}
          >
            <Plus size={15} /> Add folder
          </button>
        </section>

        <section className="settings-card">
          <h2>Library</h2>
          <div className="settings-stats">
            <div>
              <span className="stat-value tabular">{tracks.length.toLocaleString()}</span>
              <span className="stat-label">tracks found</span>
            </div>
            {lastScanMs > 0 && (
              <div>
                <span className="stat-value tabular">{(lastScanMs / 1000).toFixed(1)}s</span>
                <span className="stat-label">last scan</span>
              </div>
            )}
            {failedCount > 0 && (
              <div>
                <span className="stat-value tabular warn">{failedCount.toLocaleString()}</span>
                <span className="stat-label">could not be read</span>
              </div>
            )}
          </div>

          <button
            className="pill"
            disabled={scanning}
            onClick={() => void rescan()}
            title={scanning ? "A scan is already running" : "Re-read every configured folder"}
          >
            <Refresh size={15} /> {scanning ? "Scanning…" : "Rescan now"}
          </button>

          {failedFiles.length > 0 && (
            <details className="settings-more">
              <summary>
                <ChevronDown className="disclosure" size={13} />
                {formatCount(failedFiles.length, "file")} could not be read
              </summary>
              <p className="settings-note">
                These files were found but their tags could not be parsed. Everything else in the
                library is unaffected.
              </p>
              <ul className="fail-list">
                {failedFiles.map((file) => (
                  <li key={file.path}>
                    <span className="fail-path truncate" title={file.path}>
                      {file.path}
                    </span>
                    <span className="fail-reason truncate" title={file.reason}>
                      {file.reason}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}

          <details className="settings-more">
            <summary>
              <ChevronDown className="disclosure" size={13} />
              File types ({formatCount(settings.extensions.length, "type")})
            </summary>
            <p className="settings-note">
              Currently: <code>{extList}</code>. Tick one to include or exclude it.
            </p>
            <div className="ext-grid">
              {DEFAULT_EXTENSIONS.map((ext) => (
                <label key={ext} className="ext-item">
                  <input
                    type="checkbox"
                    checked={settings.extensions.includes(ext)}
                    onChange={() => toggleExtension(ext)}
                  />
                  <span>{ext}</span>
                </label>
              ))}
              <form
                className="ext-add"
                onSubmit={(e) => {
                  e.preventDefault()
                  const value = customExt.trim().toLowerCase()
                  if (!value) return
                  const normalised = value.startsWith(".") ? value : `.${value}`
                  if (!settings.extensions.includes(normalised)) {
                    void updateSettings({ extensions: [...settings.extensions, normalised] })
                  }
                  setCustomExt("")
                }}
              >
                <input
                  value={customExt}
                  onChange={(e) => setCustomExt(e.target.value)}
                  placeholder="wav"
                  aria-label="Add an extension"
                />
                <button className="pill" type="submit">
                  Add
                </button>
              </form>
            </div>

            {customOnly.length > 0 && (
              <p className="settings-warn">
                <Info size={14} />
                <span>
                  {formatCount(customOnly.length, "format")} here —{" "}
                  {customOnly.join(", ")} — {customOnly.length === 1 ? "is" : "are"} outside Titan
                  Player&rsquo;s built-in list. The scanner will find{" "}
                  {customOnly.length === 1 ? "it" : "them"} and list{" "}
                  {customOnly.length === 1 ? "it" : "them"} in your library, but the audio
                  protocol serves only the built-in formats, so{" "}
                  {customOnly.length === 1 ? "it" : "they"} cannot be played.
                </span>
              </p>
            )}
          </details>
        </section>

        <section className="settings-card">
          <h2>Lyrics</h2>
          <p className="settings-note">
            Lyrics are read from the file's own tags first, and from a{" "}
            <code>.lrc</code> file sitting beside it. Only when a track has neither does
            Titan Player look anything up.
          </p>

          <label className="settings-row">
            <span>
              <strong>Look up lyrics online</strong>
              <em>
                {settings.fetchOnlineLyrics
                  ? "On — a track with no local lyrics is looked up on LRCLib"
                  : "Off — lyrics come only from your files"}
              </em>
            </span>
            <button
              className={`toggle ${settings.fetchOnlineLyrics ? "on" : ""}`}
              onClick={() => void updateSettings({ fetchOnlineLyrics: !settings.fetchOnlineLyrics })}
              role="switch"
              aria-checked={settings.fetchOnlineLyrics}
            >
              <i />
            </button>
          </label>

          {/*
            Stated plainly and next to the switch, because this is the one setting
            in the app that sends anything about the user to another machine. A
            track you play tells LRCLib its artist, title and album, which over
            time is a record of what you listen to. The app is complete without
            it, so nobody should turn it on without being told that.
          */}
          {settings.fetchOnlineLyrics && (
            <p className="settings-note settings-privacy">
              <Info size={15} />
              <span>
                When this is on, playing a track with no lyrics sends its artist, title and
                album to <strong>lrclib.net</strong>, a free community lyrics database. That
                is a record of what you listen to. Answers are cached on this machine for a
                month, and nothing is ever uploaded from your library.
              </span>
            </p>
          )}

          <p className="settings-note">
            Online lyrics can be the wrong recording — a live take, a cover, or a different
            master of the same length. Check them against the words. If a track has the wrong
            ones, load your own <code>.lrc</code> from the now-playing view.
          </p>
        </section>

        <section className="settings-card">
          <h2>About</h2>
          <p className="settings-note">
            Titan Player reads tags with <code>music-metadata</code> and serves audio and cover art
            over a private <code>media://</code> protocol jailed to your music folders. It has no
            network features at all.
          </p>
        </section>
      </div>
    </div>
  )
}
