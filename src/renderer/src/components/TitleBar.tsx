import { useEffect, useState } from "react"
import { Maximize, Minimize, Restore } from "./Icons"
import "./TitleBar.css"

/**
 * The window chrome. The whole strip is a drag region except the buttons, and
 * the left inset leaves room for the native overlay controls that
 * `titleBarOverlay` puts at the top right.
 */
export default function TitleBar({ title }: { title?: string }) {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    void window.titan.isMaximized().then(setMaximized)
    return window.titan.onMaximizeChange(setMaximized)
  }, [])

  return (
    <header className="titlebar">
      <div className="titlebar-drag">
        <span className="titlebar-title truncate">{title ?? "Titan Player"}</span>
      </div>
      <div className="titlebar-actions">
        <button
          className="titlebar-btn"
          onClick={() => window.titan.minimize()}
          aria-label="Minimise"
          title="Minimise"
        >
          <Minimize size={14} />
        </button>
        <button
          className="titlebar-btn"
          onClick={() => window.titan.maximize()}
          aria-label={maximized ? "Restore" : "Maximise"}
          title={maximized ? "Restore" : "Maximise"}
        >
          {maximized ? <Restore size={13} /> : <Maximize size={12} />}
        </button>
      </div>
    </header>
  )
}
