/// <reference types="vite/client" />

// `src/renderer/src` -> `src/preload` is two levels up. The previous
// "../preload" resolved to `src/renderer/preload`, which does not exist, so the
// import failed silently and `window.titan` degraded to `any` across the entire
// renderer. That is invisible until something changes shape: every callback
// parameter crossing the bridge then becomes an implicit `any`, and no compiler
// error points at the real cause.
import type { TitanApi } from "../../preload"

declare global {
  interface Window {
    titan: TitanApi
  }
}

export {}
