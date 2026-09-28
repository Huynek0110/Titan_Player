import { resolve } from "node:path"
import { defineConfig, externalizeDepsPlugin } from "electron-vite"
import react from "@vitejs/plugin-react"

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/main/index.ts") },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/preload/index.ts") },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    resolve: {
      alias: {
        "@renderer": resolve(__dirname, "src/renderer/src"),
        "@shared": resolve(__dirname, "src/shared"),
      },
    },
    build: {
      rollupOptions: {
        /*
         * Two documents.
         *
         * The floating mini player is a separate HTML page rather than a route
         * inside the main one, because it is a separate `BrowserWindow` with its
         * own preload and its own — much smaller — `window.titanMini` surface. A
         * route would have put the main window's full API in reach of a 400px
         * control strip, and would have made the main renderer bundle load in a
         * window that has no use for it.
         */
        input: {
          index: resolve(__dirname, "src/renderer/index.html"),
          mini: resolve(__dirname, "src/renderer/mini.html"),
        },
      },
    },
    plugins: [react()],
  },
})
