import { useState } from "react"
import { useStore } from "../state/store"
import { DEFAULT_EXTENSIONS } from "@shared/types"
import { formatCount } from "../lib/format"
import { Folder, Plus, Refresh, Trash } from "./Icons"
import "./Settings.css"

export default function Settings() {
  const store = useStore()
  const { settings, tracks, failedCount, lastScanMs, updateSettings, addFolder, removeFolder, rescan } =
    store

  const [customExt, setCustomExt] = useState("")

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
      <header className="settings-head">
        <h1>Settings</h1>
        <p>Everything is stored on this machine. Nothing is uploaded anywhere.</p>
      </header>

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
            onClick={async () => {
              const next = !settings.useSystemMusicFolder
              // Re-scan, or the library silently keeps the old contents until
              // someone presses Rescan by hand.
              await updateSettings({ useSystemMusicFolder: next })
              await rescan()
            }}
            role="switch"
            aria-checked={settings.useSystemMusicFolder}
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
                <span className="truncate" title={folder}>
                  {folder}
                </span>
                <button
                  className="icon-btn"
                  onClick={() => void removeFolder(folder)}
                  aria-label={`Remove ${folder}`}
                >
                  <Trash size={14} />
                </button>
              </li>
            ))
          )}
        </ul>

        <button className="pill" onClick={() => void addFolder()}>
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
              <span className="stat-value tabular warn">{failedCount}</span>
              <span className="stat-label">could not be read</span>
            </div>
          )}
        </div>

        <button className="pill" onClick={() => void rescan()}>
          <Refresh size={15} /> Rescan now
        </button>

        <details className="settings-more">
          <summary>File types ({formatCount(settings.extensions.length, "type")})</summary>
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
        </details>
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
  )
}
