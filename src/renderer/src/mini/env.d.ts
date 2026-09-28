import type { TitanMiniApi } from "../../../preload"

/**
 * The mini bar's globals.
 *
 * Declared rather than cast, and the import path is the one that matters: from
 * `src/renderer/src/mini` the preload is *three* levels up, at
 * `src/preload`. Two levels resolves to `src/renderer/preload`, which does not
 * exist.
 *
 * That is the exact trap documented in `AGENTS.md` for the main renderer's own
 * `env.d.ts`, and it is worth repeating because the failure is invisible: the
 * import resolves to nothing, `window.titanMini` becomes `any`, and every value
 * crossing the bridge in this document quietly loses its type with nothing
 * pointing at the real cause. Count the directories.
 */
declare global {
  interface Window {
    titanMini: TitanMiniApi
  }
}

export {}
