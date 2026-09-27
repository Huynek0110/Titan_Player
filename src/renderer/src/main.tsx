import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import App from "./App"
import { StoreProvider } from "./state/store"
import "./styles/global.css"

const root = document.getElementById("root")

if (root) {
  // A missing preload is the one failure that otherwise produces a blank
  // window with no clue as to why. Check for it before mounting anything.
  if (!window.titan) {
    root.innerHTML = `
      <div style="height:100%;display:grid;place-content:center;justify-items:center;gap:12px;
                  padding:40px;text-align:center;font:14px/1.6 system-ui,sans-serif;color:#b6b6c6;
                  background:#06060a">
        <strong style="font-size:17px;color:#ff9d9d">The preload script did not load</strong>
        <p style="max-width:420px;margin:0;color:#82829a">
          The bridge to the main process is missing, so the interface cannot run.
          This is a build problem, not a data problem.
        </p>
        <p style="max-width:520px;margin:0;font:12px/1.6 ui-monospace,monospace;color:#56566b">
          Expected <code>out/preload/index.mjs</code> to sit beside
          <code>out/main/index.js</code>. Rebuild, and check the main process log.
        </p>
      </div>`
  } else {
    createRoot(root).render(
      <StrictMode>
        <StoreProvider>
          <App />
        </StoreProvider>
      </StrictMode>,
    )
  }
}
