import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import MiniPlayer from "./MiniPlayer"
import "../styles/global.css"
import "./mini.css"

/*
 * The mini bar's own document.
 *
 * Deliberately not the main renderer with a prop. That document mounts the whole
 * library view, opens a Web Audio context for the visualiser and owns the
 * `<audio>` element — none of which a 400px control strip needs, and all of
 * which would be reachable from this window's document if it shared the bundle.
 */

const host = document.getElementById("root")
if (!host) throw new Error("mini: no #root")

createRoot(host).render(
  <StrictMode>
    <MiniPlayer />
  </StrictMode>,
)
