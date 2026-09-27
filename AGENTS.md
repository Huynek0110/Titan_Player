# Titan Player — project state and hand-off

Read this first. It records exactly where the build stopped and what remains.

## Goal

A Windows desktop music player (Electron) that reads a local music folder —
defaulting to the Windows Music folder — and plays it with a UI deliberately
better than Spotify. Ships as both a portable `.exe` and an NSIS installer.

## Status: all source written, both tsconfigs typecheck clean, app never launched

### Verification so far

- `tsc --noEmit -p tsconfig.node.json` — **clean**
- `tsc --noEmit -p tsconfig.web.json` — **clean**
- `npm run dev` — **never run.** No build, no packaged output, no runtime test.

### Done

| Area | Files |
| --- | --- |
| Shared | `types.ts` (+ `DEFAULT_EXTENSIONS`), `lyrics.ts` |
| Main | `index.ts`, `library.ts`, `protocol.ts`, `store.ts` |
| Preload | `index.ts` |
| Renderer lib/state | `lib/format.ts`, `lib/palette.ts`, `lib/usePlayer.ts`, `state/store.tsx`, `styles/global.css` |
| Renderer components | `Icons`, `TitleBar`, `Sidebar`, `Artwork`, `ContextMenu`, `TrackList`, `LyricsPane`, `PlayerBar`, `NowPlaying`, `CollectionViews` (albums + artists), `PlaylistView`, `QueuePanel`, `Settings`, `Visualiser` |
| Renderer root | `App.tsx`, `App.css`, `main.tsx`, `env.d.ts`, `index.html` |

Every component has a colocated `.css` file.

### Still to do

1. `npm run dev` and fix whatever the runtime shows.
2. `electron-builder.yml`.
3. `build/icon.png` at 1024×1024 — electron-builder v26 auto-converts to `.ico`, so
   no `png-to-ico` needed.
4. `.gitignore`.
5. `README.md`.
6. Git init + push to `https://github.com/Huynek0110/Titan_Player`.
7. Three read-only review subagents, then act on their findings.

### Two new traps, found while making it compile

8. **TypeScript 7 removed `baseUrl`.** Both tsconfigs had to drop it and use
   relative paths in `paths` instead (`"./src/shared/*"`). With `baseUrl`
   present, `tsc` fails with TS5102.
9. **`moduleResolution: "node16"` forces explicit `.js` extensions** on every
   relative ESM import. All main/preload/shared imports are now written that
   way. Do not strip them — that is what keeps `music-metadata` resolving to its
   Node build rather than the browser stub.

Also note: `DEFAULT_EXTENSIONS` lives in `src/shared/types.ts`, not in
`src/main/store.ts`. The renderer needs it, and importing a main-process module
from the renderer would drag `electron` into the browser bundle.


### Done and working

| File | What it does |
| --- | --- |
| `src/shared/types.ts` | `Track`, `Playlist`, `Lyrics`, `LibrarySettings`, `ScanProgress`, `ScanResult` |
| `src/shared/lyrics.ts` | LRC parser: line-level **and** word-level ("enhanced" LRC). Handles multi-timestamp lines, 1–3 digit minutes, `[.:]` fractions, `[offset:]`, CRLF, ID tags. Exports `activeLineIndex()` binary search. |
| `src/main/store.ts` | Atomic JSON persistence (temp file + rename) in `userData`. Settings, playlists, favourites, hidden tracks. `prunePlaylists()` drops vanished tracks. |
| `src/main/protocol.ts` | Privileged `media://` scheme. Serves cover art from an in-memory map and audio from `net.fetch(file://)` with a path-traversal jail rooted at the user's music folders. |
| `src/main/library.ts` | Recursive scan, bounded-concurrency tag parsing, artwork publishing, lyrics extraction, sidecar `.lrc` fallback, typed error classification. |
| `src/main/index.ts` | Window (`titleBarStyle: hidden` + overlay), all IPC handlers, external-link and navigation lockdown. |
| `src/preload/index.ts` | The entire renderer-facing API. Plain serialisable values only. |
| `src/renderer/src/state/store.tsx` | Reducer + context: library, queue, playlists, favourites, sorting, search, view routing. Derives visible/queue/current track. |
| `src/renderer/src/lib/usePlayer.ts` | `<audio>` engine: play/pause/seek/volume, prev-restart-after-3s, repeat/shuffle, keyboard shortcuts, lazy Web Audio `AnalyserNode`. |
| `src/renderer/src/lib/format.ts` | Duration, bitrate, sample rate, file size, natural-order collation. |
| `src/renderer/src/lib/palette.ts` | Hue-bucketed dominant-colour extraction on a 64×64 canvas, memoised, with luminance-based readable text. |
| `src/renderer/src/styles/global.css` | Design tokens, ambient wash, grain overlay, scrollbars, focus rings, reduced-motion. |

### Not yet written

Nothing in `src/renderer/src/components/` exists yet, and neither does `App.tsx`.
This is the remaining bulk of the work:

- `Icons.tsx` — shared inline SVG set
- `TitleBar.tsx` — drag region + window controls
- `Sidebar.tsx` — nav, playlists, rescan
- `TrackList.tsx` — virtualised rows, drag-to-reorder, context menu
- `PlayerBar.tsx` — transport, seek bar, volume
- `NowPlaying.tsx` — full-screen view
- `LyricsPane.tsx` — the karaoke fill
- `AlbumsView.tsx`, `ArtistsView.tsx`
- `PlaylistView.tsx`
- `QueuePanel.tsx`
- `Settings.tsx`
- `Visualiser.tsx`
- `ContextMenu.tsx`
- `App.tsx` — layout, routing, keyboard

### Not yet done at all

- `electron-builder.yml` + `build/icon.png` (1024×1024)
- `.gitignore`
- `README.md`
- Git init + push to `https://github.com/Huynek0110/Titan_Player`
- Three read-only review subagents, then act on their findings
- First `npm run dev` — **the app has never been launched**, so nothing is
  compile-verified yet. Run `npm run typecheck` first; expect real errors.

## Toolchain (installed and verified)

```
electron 44.4.5 · electron-vite 5.0.0 · vite 7.3.6 · electron-builder 26.15.3
react 19 · react-dom 19 · music-metadata 11.16.1 · typescript 7.0.2
```

Three traps already paid for, do not undo them:

1. **`@vitejs/plugin-react` must stay at `^5`.** v6 requires Vite 8, but
   `electron-vite@5` caps its peer range at Vite 7. There is no combination that
   satisfies both at v6/8.
2. **`tsconfig.node.json` must keep `moduleResolution: "node16"`.** With
   `"bundler"`, `music-metadata`'s `parseFile` silently resolves to the browser
   `core` stub and throws at runtime instead of failing to compile.
3. **npm blocks install scripts on this machine.** `electron` and `esbuild`
   postinstalls do not run by default, which leaves a missing `electron.exe` and
   a missing esbuild binary. Approved once via
   `npm install-scripts approve esbuild electron`. If `npm ci` is ever run
   fresh, re-approve or the app will not start.

PowerShell on this box blocks `.ps1` shims — use `npm.cmd` / `npx.cmd`.

## Decisions made with the user

- Scaffold and build the full v1 in one pass.
- Produce **both** a portable `.exe` and an NSIS installer.
- Library defaults to `%USERPROFILE%\Music`, is changeable, and supports
  adding several folders that merge into one library.

## Technical decisions worth keeping

**`music-metadata` 11.16.1** is pure JS with zero native dependencies, so
packaging to `.exe` needs no `asarUnpack` and no ABI rebuild. It is ESM-only,
which Electron 44's Node 24 loads fine.

Its real shapes, which are easy to get wrong:

- `common.track` is `{ no, of }`, not a number.
- `common.picture[].data` is a `Uint8Array`, not a `Buffer`.
- Duration is `format.duration`, in seconds, and needs `{ duration: true }`.
- **`common.lyrics` is an array** of `ILyricsTag`, never a string.
- **`SYNCEDLYRICS` is not mapped at all** by the Vorbis tag mapper, so it only
  exists in `meta.native.vorbis` and must be read by hand. `LYRICS` and
  `UNSYNCEDLYRICS` do get mapped.
- The bundled LRC parser only handles one timestamp per line and demands a
  2-digit minute. `src/shared/lyrics.ts` replaces it for the sidecar path.

**Cover art and audio go over `media://`, not base64 data URLs.** A 400 KB cover
becomes ~533 KB of JSON, so a thousand-track library would push ~500 MB through
the IPC bridge on first scan. The protocol also fixes dev mode, where the
renderer is on `http://localhost` and cannot load a `file://` media source.

**FLAC, MP3, M4A/AAC and Ogg all decode natively in Electron 44.** Chromium
carries FLAC in its baseline codec set, and Electron enables
`proprietary_codecs`. Do not add `ffmpeg.wasm` — it is ~65 MB and would
reimplement in WebAssembly what Chromium already does in C++.

One real failure mode to guard: a FLAC whose `METADATA_BLOCK_PICTURE` block has
a malformed MIME type makes Chromium's demuxer reject the **whole file**, not
just the art (crbug 40902437). `usePlayer` already surfaces `audio.error` and
maps code 4 to an explanatory message — keep that.

## Lyrics rendering — the design decision

`RESEARCH-LYRICS-AND-DESIGN.md` in this directory has the full brief. The
short version:

- **Word-level timings are not realistically available from local files.** FLAC
  only stores LRC text in a Vorbis comment, which is line-level. MP3's `SYLT`
  frame *is* word-level but almost nothing writes it. The only practical source
  of word timing is Enhanced LRC, and the only legitimate provider is LRCLib
  (free, no key). Apple and Spotify are closed.
- Therefore: **design for line-level as the guarantee.** `src/shared/lyrics.ts`
  already parses Enhanced LRC when present, so word-level animation is free for
  files that have it. For everything else, distribute the fill across the line
  with a character-weighted sweep so the animation still reads correctly.
- The fill technique that matters: `background-clip: text` on a
  `display: inline` element wraps the gradient across line boxes, giving one
  continuous sweep through a multi-line lyric with **zero per-word DOM and zero
  reflow**. Drive it by writing one CSS custom property from a `requestAnimation
  Frame` loop — never React state, never a CSS transition.
- A dedicated resizable lyrics pane is a differentiator, not a bug: Spotify
  removed side-by-side art+lyrics from its desktop app in Feb 2026 and drew
  heavy backlash for it.
- foobar2000's OpenLyrics added an explicit "disable automatic scroll" toggle,
  which tells you power users want to break auto-scroll on purpose.

Rejected: `@applemusic-like-lyrics/react` and `lyric-kit` are both AGPL-3.0 and
this project is MIT. `lrc-kit` 1.2.1 is a fine MIT alternative to the hand-rolled
parser if the local one ever proves insufficient.

## Design direction

Cover art drives everything: a hue-bucketed extraction sets `--accent` and three
ambient gradient stops on the document root, which the whole UI inherits. That
is the core of the "better than Spotify" claim — Spotify's palette is per-album
and static, while this tracks the *currently playing* track continuously.

Premium details to carry into the components, from the research brief:

- Spring-chased seek bar rather than a position tracker, so dragging has
  momentum (Apple shipped this on iOS 26).
- Glass panels: `blur(28px) saturate(1.6)` over the ambient wash.
- Radii 6/10/16/24px, motion 120/220/420ms on
  `cubic-bezier(0.22, 1, 0.36, 1)`.
- A grain overlay at ~2% opacity, already in `global.css`, to stop the large flat
  gradients from banding.
- `prefers-reduced-motion` is already honoured globally.

Optional libraries, only if the hand-rolled version gets painful:
`motion` 13.x (not `framer-motion` — same project, current name, one fewer dep)
for the cover-art `layoutId` transition, and `@tanstack/react-virtual` for the
track list. Neither is installed yet.

## When resuming

1. `npm run typecheck` — nothing has been compiled yet, expect errors.
2. Write the components listed above, then `App.tsx`.
3. `npm run dev`.
4. Only then: `electron-builder.yml`, `build/icon.png` (1024×1024 PNG is enough —
   electron-builder v26 auto-converts to `.ico`), `.gitignore`, `README.md`,
   git init and push.
5. Then spawn the three read-only review subagents and act on what they find.
