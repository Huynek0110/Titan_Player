import { useEffect, useState } from "react"
import { Close, Maximize, Minimize, Restore } from "./Icons"
import "./TitleBar.css"

/**
 * The window chrome.
 *
 * All three caption buttons are drawn here rather than taken from
 * `titleBarOverlay`. Requesting the overlay put the system's
 * minimise/maximise/close *on top of* these, so the window had five
 * buttons, and the native close then sat on a fully transparent overlay
 * colour — hovering it painted the Windows system hover rectangle over
 * the near-black interface. `titleBarStyle: "hidden"` with no overlay
 * gives the app the whole strip, and the corner can then match the rest
 * of the UI. See the comment in src/main/index.ts.
 */
export default function TitleBar({ title }: { title?: string }) {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    void window.titan.isMaximized().then(setMaximized)
    return window.titan.onMaximizeChange(setMaximized)
  }, [])

  return (
    <header className="titlebar">
      {/*
        The drag region. `-webkit-app-region: drag` is inherited, so this
        div and the wordmark inside it are both draggable, and text
        selection has to be off or the double-click that maximises gets
        swallowed by selecting the wordmark. Body sets `user-select: none`
        globally, which is what makes this work.
      */}
      <div className="titlebar-drag">
        <span className="titlebar-title truncate">{title ?? "Titan Player"}</span>
      </div>

      {/* `no-drag` on the buttons, and `pointer-events: auto` to undo the
          `none` on the strip, which is what lets the strip stay a drag
          region while the buttons stay clickable. */}
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
        <button
          className="titlebar-btn close"
          onClick={() => window.titan.close()}
          aria-label="Close"
          title="Close"
        >
          <Close size={15} />
        </button>
      </div>
    </header>
  )
}
