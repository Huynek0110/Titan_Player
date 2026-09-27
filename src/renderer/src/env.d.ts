/// <reference types="vite/client" />

import type { TitanApi } from "../preload"

declare global {
  interface Window {
    titan: TitanApi
  }
}

export {}
