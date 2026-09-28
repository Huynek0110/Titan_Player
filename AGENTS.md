# Titan Player — project state and hand-off

Read this first. It records exactly where the build stopped and what remains.

## Goal

A Windows desktop music player (Electron) that reads a local music folder —
defaulting to the Windows Music folder — and plays it with a UI deliberately
better than Spotify. Ships as both a portable `.exe` and an NSIS installer.

## Status: source complete, both tsconfigs clean, app runs and plays audio

### Verification

- `tsc --noEmit -p tsconfig.node.json` — **clean**
- `tsc --noEmit -p tsconfig.web.json` — **clean**
- `npm run dev` — **runs.** HMR confirmed working, so the dev-only CSP relaxation is
  correct. Screenshots taken from a live window.
- `npm run dist` — **builds.** NSIS installer and portable `.exe` produced.
- Audio confirmed playing: `currentTime` advances, no media error.

### The mistake that cost two build cycles

Running `npm run build` and then launching `release/win-unpacked/titan-player.exe`
shows the **old** build. The packaged app runs its own `app.asar`; only
`npm run dist:dir` or `npm run dist` refreshes it.

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

1. `npm run dist` and verify the packaged app.
2. `scripts/README.md` documents the CDP diagnostics. Use
   `shot-nowplaying-quiet.mjs`, not `shot-nowplaying.mjs`, when sound is not
   wanted — the first pins the volume to zero, the second plays the track.

Everything else on the original list is complete: `electron-builder.yml`,
`build/icon.png` (1024×1024, rendered from `icon.svg` by
`npm run icon`), `.gitignore`, `README.md`, and three rounds of review
subagents whose findings have been acted on.

### Traps found while making it compile

3. **TypeScript 7 removed `baseUrl`.** Both tsconfigs had to drop it and use
   relative paths in `paths` instead (`"./src/shared/*"`). With `baseUrl`
   present, `tsc` fails with TS5102.
4. **`moduleResolution: "node16"` forces explicit `.js` extensions** on every
   relative ESM import. All main/preload/shared imports are now written that
   way. Do not strip them — that is what keeps `music-metadata` resolving to its
   Node build rather than the browser stub.

### Two traps that cost real debugging time

5. **`src/renderer/src/env.d.ts` imported the bridge type from `"../preload"`.**
   From `src/renderer/src` that resolves to `src/renderer/preload`, which does
   not exist. The import failed silently and `window.titan` was `any` across the
   entire renderer, so every callback crossing the bridge became an implicit
   `any` and no error pointed at the real cause. It is `"../../preload"` now.
   `tsconfig.web.json` also had `src/preload/*.d.ts` in `include` while the file
   is `index.ts`, so it was not in the program at all.
6. **npm blocks install scripts on this machine.** `electron` and `esbuild`
   postinstalls do not run by default, which leaves a missing `electron.exe` and
   a missing esbuild binary. Approved once via
   `npm install-scripts approve esbuild electron`. If `npm ci` is ever run
   fresh, re-approve or the app will not start.

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
| `src/main/index.ts` | Window (`titleBarStyle: hidden`, no native overlay), all IPC handlers, single-instance lock, `open with` handling, external-link and navigation lockdown. |
| `src/preload/index.ts` | The entire renderer-facing API. Plain serialisable values only. |
| `src/renderer/src/state/store.tsx` | Reducer + context: library, queue, playlists, favourites, hidden tracks, sorting, search, view routing. Derives visible/queue/current track. |
| `src/renderer/src/lib/usePlayer.ts` | `<audio>` engine: play/pause/seek/volume, prev-restart-after-3s, repeat/shuffle, keyboard shortcuts, lazy Web Audio `AnalyserNode`. |
| `src/renderer/src/lib/format.ts` | Duration, bitrate, sample rate, file size, natural-order collation, diacritic folding. |
| `src/renderer/src/lib/palette.ts` | Hue-bucketed dominant-colour extraction on a 64×64 canvas, memoised, with luminance-based readable text. |
| `src/renderer/src/styles/global.css` | Design tokens, ambient wash, grain overlay, scrollbars, focus rings, reduced-motion. |

## Online lyrics

LRCLib, and only when a track has no lyrics in its tags and no `.lrc` beside it.
`src/main/lyrics-online.ts` owns it. Three decisions worth not re-litigating:

- **It runs in the main process, not the renderer.** A `connect-src` widened to
  a lyrics host would be a policy relaxation for the whole app and the whole
  session, rather than only while a lookup is in flight. The renderer sends
  metadata, never a URL, so there is nothing there for it to redirect.
- **It is off by default.** An automatic lookup sends the artist, title and album
  of everything you play to another machine, which is a record of your listening.
  The app is complete without it, so the choice is made in Settings rather than
  discovered afterwards.
- **Duration is the strongest matching signal.** Two recordings of one song share
  a title and differ in length, and a lyric file timed for the other one is
  visibly wrong within seconds. A candidate more than 12 seconds off is rejected
  rather than ranked, and anything scoring below the threshold is treated as a
  different song — showing near-miss lyrics is worse than showing none, because
  the user cannot tell and will trust them.

Matches are cached by artist/title/duration rather than by path, so a re-tag or a
moved file still hits. A confirmed miss is cached too, or every track without
lyrics would re-query on every play.

## Bugs that only a running app could find

Each of these looked correct in review and was invisible until the app ran.

- **Nothing animated, and the code was wrong about why.** This machine reports
  `prefers-reduced-motion: reduce`, because Windows has *Settings → Accessibility
  → Visual effects → Animation effects* switched off. Every motion in the app is
  correctly suppressed by that preference, which is why "there are no animations"
  kept coming up. The code was also wrong in its handling: it emitted the outgoing
  lyric line and then hid it with `opacity: 0` under a reduced-motion media
  query, so a node rendered for the full 380ms of the animation and was invisible
  for all of it. `useReducedMotion` now decides the *content*, not just the
  timing — under `reduce` the outgoing line is never rendered, and the incoming
  line still cross-fades, because a change with no indication at all is worse for
  everyone. **If someone reports the app feels static, check the OS setting before
  looking for a bug.**
- **A probe can fake a broken feature.** Calling `audio.play()` from a script
  advances the media clock but leaves the app's own `isPlaying` false, so the
  lyrics pane stays on its paused backoff poll and the current line never moves —
  which looks exactly like a broken animation while the feature is fine. Same for
  `userGesture: true`, which unblocks the play but still bypasses the app's state.
  Anything that observes playback has to start it through a real
  `Input.dispatchMouseEvent`, and has to report the clock span so a stopped clock
  is distinguishable from a broken feature. `scripts/README.md` records this.

- **Five window buttons.** `titleBarStyle: "hidden"` was combined with
  `titleBarOverlay`, which draws the native minimise/maximise/close, *and*
  `TitleBar.tsx` drew its own. All three are now drawn by the app. The overlay
  also had a fully transparent `color`, so hovering the native close button
  painted the Windows system hover rectangle over the near-black UI.
- **The accent palette never worked.** `palette.ts` built an `Image` with no
  `crossOrigin`, so `media://` cover art loaded in no-cors mode, the canvas
  stayed tainted, and `getImageData` threw a `SecurityError` that the `catch`
  swallowed into the fallback. `corsEnabled: true` and the
  `access-control-allow-origin` header are both necessary and neither is
  sufficient; only the attribute makes it a CORS-mode request.
- **Silent audio with a moving playhead.** `enableVisualiser` called
  `createMediaElementSource` *before* checking whether the `AudioContext` was
  running. That call is a one-way door: if the context then fails to start, the
  element's output exists only inside a silent graph, `currentTime` keeps
  advancing, and no error surfaces anywhere. The context must be `running`
  first.
- **Clicking a track loaded it without playing it.** A flag armed only by the
  transport's Play button gated auto-play, so all eight "choose a track" entry
  points — row double-click, the row play button, the context menu, an album
  card, Play all, a playlist's Play — silently queued instead of playing.
  A track change is now always an implicit request to hear the track.
- **Four large `backdrop-filter` surfaces re-blurred every frame of a window
  resize**, which is what made maximising stutter. Only the player bar keeps a
  blur, and at 20px rather than 40px.
- **The lyrics pane reflowed on every lyric change.** `.lyric-line` transitioned
  `font-size`, and the pane is a flex column, so one line changing size pushed
  every line below it — 40 lines re-flowing over 420ms, fighting the auto-scroll
  whose target was itself moving. Size is now constant; hierarchy is weight,
  opacity and an inner `transform: scale()`.
- **`stateRef.current` is only refreshed when React commits.** Every playlist
  mutation that patched the renderer's copy instead of re-reading from the main
  process lost any playlist created in the same gesture. `createPlaylist` then
  `setPlaylistTracks` wrote back a list without the new playlist, and it vanished
  from the sidebar. Mutations now re-read the list.
- **The pruning guard was all-or-nothing.** Checking `tracks.length > 0` let a
  library split across `C:` and an external `E:` permanently erase every `E:`
  track from every playlist when one scan could not reach the drive. It now
  requires that every configured folder was actually reachable.
- **Seeking did nothing at all.** The audio was served with `net.fetch` on a
  `file://` URL, which loads and plays correctly, but the response does not
  advertise `Accept-Ranges`. Chromium therefore reported the media as
  non-seekable — `seekable.end(0)` stayed `0` and every `currentTime` assignment
  was silently ignored. `readyState` reached 4 and the duration was correct, so
  nothing looked wrong: playback worked, the seek bar was draggable, it just
  never went anywhere, and no error surfaced anywhere either. `protocol.ts` now
  serves the bytes itself with explicit `206` and `Content-Range`. **A media
  element decides whether it can seek from `Accept-Ranges` on the first
  response**, so it has to be present on the `200` as well as the partial one.
- **`import fs from "node:fs"` is callback-based.** `await fs.stat()` returns
  `void` rather than rejecting, so it does not throw — it yields `undefined` and
  every property read fails with a confusing error instead of a 404. Use
  `fs.promises.stat()`. This was hit twice, in two different files.
- **PowerShell blocks `.ps1` shims on this machine** — use `npm.cmd`, `npx.cmd`.
- **Synthetic mouse clicks from PowerShell never reached the window.** Use CDP
  `Input.dispatchMouseEvent` via `scripts/play-a-track.mjs`.
- **`composite: true` + `noEmit` still writes `tsconfig.*.tsbuildinfo`, and a
  hand-edited `.d.ts` is then ignored.** A wrong import path in an `env.d.ts`
  produced a correct-looking build for several minutes *after* it had been fixed.
  Delete both `.tsbuildinfo` files before trusting a typecheck that should have
  changed.
- **`skipLibCheck: true` hides errors inside your own `.d.ts` files**, and a
  hand-written `env.d.ts` is one. A bad import there becomes `any` with no
  diagnostic, and the only symptom is an implicit `any` somewhere far away. Run
  `npx.cmd tsc -p tsconfig.web.json --noEmit --skipLibCheck false` when a global
  declared in a `.d.ts` is not taking effect. The mini bar hit this on its first
  compile: `src/renderer/src/mini/env.d.ts` needs `../../../preload` — **three**
  levels up, not two — and the wrong path was completely silent.
- **A `const` referenced above its own declaration in a preload throws a
  temporal dead zone error, which Electron reports as "preload failed to load"**
  rather than as the line that caused it. Both `contextBridge.exposeInMainWorld`
  calls are at the bottom of `src/preload/index.ts`, after both objects.
- **PowerShell string surgery corrupts UTF-8 and mangles multi-line `git commit -m`.**
  A backtick inside a commit message is eaten, so messages go through a file
  written with `[System.IO.File]::WriteAllText` and a BOM-less UTF8 encoding —
  `Set-Content -Encoding utf8` adds a BOM and the commit subject starts with
  `﻿`. For multi-line file surgery inside a source file, a `node` one-liner that
  slices by line number is more reliable than either, because the `edit` tool
  cannot match text containing the file's own em-dashes and quotes.

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
3. **Vite is pinned to `^7` for the same reason as #1.**

PowerShell on this box blocks `.ps1` shims — use `npm.cmd` / `npx.cmd`.

## Decisions made with the user

- Scaffold and build the full v1 in one pass.
- Produce **both** a portable `.exe` and an NSIS installer.
- Library defaults to `%USERPROFILE%\Music`, is changeable, and supports
  adding several folders that merge into one library.
- **Keep AGPL-3.0** rather than going back to MIT, and **no in-app licence
  banner.** The banner was proposed and then declined: AGPL only creates
  obligations when the program is *conveyed* to someone, running it locally
  triggers none, and the repository already carries a `LICENSE` and
  `NOTICE.md`, which is what the licence actually requires of a distribution.
  Do not re-add it without being asked.

## Licence

AGPL-3.0-or-later, and that is a consequence of a choice, not an accident.

`Wave Player` is MIT. **`Liquify` and `spicetify-glassify` are AGPL-3.0**, and
the Liquid Glass surface in `src/renderer/src/lib/glass.ts` is derived from them.
Deriving from AGPL code makes the whole work AGPL, so `LICENSE` (the verbatim
FSF text) and `NOTICE.md` exist and `package.json` says
`AGPL-3.0-or-later`.

If the glass is ever rewritten from the technique alone, with no line taken from
either project, the licence can go back to MIT. `RESEARCH-SPICETIFY-REFERENCES.md`
records the technique in enough detail to do that without re-reading either repo.
The lyrics work is not a constraint — that came from Wave Player, which is MIT.

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

### The line change is a change of appearance, never of position

The outgoing line dissolves in place — a blur and a fade at a fixed position — and
never travels. Sliding it up and out was tried and reads as a scroll, which is the
one thing this layout exists not to be. Apple Music's synced lyrics work the same
way: the current line resolves sharp and bright while the others recede and go
soft, and nothing moves.

Two consequences that will look like mistakes if undone:

- **`filter: blur()` is allowed here, despite the motion policy.** It is excluded
  for anything larger than a caption. Two lines of text changing once every few
  seconds is the case where the depth cue *is* the effect, and blur is what makes
  the block read as a surface with a depth rather than as three shades of grey.
- **The lyric slots have natural height.** They were pinned to two lines so the
  stack could not change height, and a one-line lyric then floated inside a
  two-line box — the reported "the lines look separated". Top-aligning the stack
  and letting the slots size to their content fixes it, because the current line is
  first and its top edge then never moves. Only the dim lines below shift, and
  only when the current line changes row count.

The current line's size is derived from the measured column width, not fixed: at a
literal 40px a Vietnamese lyric wraps to two rows in a narrow window, which breaks
the rhythm worse than a slightly smaller type does.

Rejected: `@applemusic-like-lyrics/react` and `lyric-kit` are both AGPL-3.0. The
project is AGPL now — for the glass, not for anything here — but the lyrics pane
here is hand-rolled and working, so the reason is not licensing. `lrc-kit` 1.2.1
is a fine MIT alternative to `src/shared/lyrics.ts` if the local one ever proves
insufficient.

## The floating mini player

A second `BrowserWindow` (`src/main/mini-window.ts`, its own `mini.html` entry,
its own `src/renderer/src/mini/` document) that floats over everything. It is a
**remote control, not a second player**, and that is the whole design:

**There is no `<audio>` element in the bar, and there must never be one.** The
element lives in the main window's renderer and stays there. A second element
means a second copy of the same file on a second clock, and the two drift inside
a minute with no way to resynchronise that does not involve a visible jump.

So every transport verb is forwarded to the main process, which relays it to
whichever window owns the audio, and the main window runs it through the *same*
function its own buttons call. There is exactly one implementation of "next
track" in the app, which is the reason to do it this way rather than giving the
bar its own queue: two queues over one library desynchronise the first time a
track is hidden or removed in one of them.

**The position on the bar is an estimate, not a reading.** Packets go out four
times a second; the playhead interpolates between them from `performance.now()` —
monotonic, unlike `Date.now()`, which can step and would make the bar jump with
no cause anyone could find. The bar's `--p` is written from a rAF loop, never
React state, for the same reason the lyrics sweep is.

Things that were not obvious and are worth not rediscovering:

- **The glass is on the transport pill, not on the panel.** The window is
  transparent, so the panel has nothing behind it to refract — a `backdrop-filter`
  over an empty backdrop is a no-op that looks like a bug. The pill sits on the
  opaque panel, which is the only place in that window where refraction is real.
- **Both windows share one preload file**, so the preload branches on
  `process.argv` looking for `--titan-surface=mini`, passed in via
  `webPreferences.additionalArguments`. Branching on `location.pathname` would
  also work and would also silently remove a security boundary the first time a
  file is renamed. `scripts/probe-mini-player.mjs` asserts that `window.titan` is
  `undefined` in the bar.
- **The seek bar is last in the DOM.** It has a definite column span and an
  automatic row, so sitting in the middle it consumed row 2 and pushed the mute
  and close buttons onto an implicit third row, which shortened the row above and
  made the artwork look cropped.
- **`window-all-closed` only fires on the *last* window**, and the bar hides
  rather than closes when dismissed, so without `mini.dispose()` in both that
  handler and the main window's `closed` event the process can survive with
  nothing on screen, or leave a floating player whose every button does nothing
  because the audio element it was driving has just been destroyed.
- The bar's own ✕ and the window manager's close both `preventDefault` and hide.
  Closing the bar is not closing the app.

## Design direction

Cover art drives everything: a hue-bucketed extraction sets `--accent` and three
ambient gradient stops on the document root, which the whole UI inherits. That
is the core of the "better than Spotify" claim — Spotify's palette is per-album
and static, while this tracks the *currently playing* track continuously.

Premium details carried into the components, from the research brief:

- Spring-chased seek bar rather than a position tracker, so dragging has
  momentum (Apple shipped this on iOS 26). The knob is written from the same
  rAF loop as the fill, in pixels rather than percentages, because a percentage
  translate on a 12px element moves it 12px and not the width of the track.
- Glass panels over the ambient wash. **Only where they earn it** — the player
  bar, which sits over scrolling content. Four simultaneous full-height blurs
  re-blurred every frame of a window resize and made maximising stutter.
- Radii 6/10/16/24px, motion 120/220/420ms on
  `cubic-bezier(0.22, 1, 0.36, 1)`, all in `global.css`.
- A grain overlay to stop the large flat gradients from banding. It has to sit
  *above* the shell to do that; underneath, the three surfaces with the largest
  gradients hid it and the only visible region was the flattest one.
- `prefers-reduced-motion` is honoured globally, and explicitly for the two
  rAF-driven effects it cannot reach on its own.

**The accent is spent on three things only:** the play/pause button, the
current-track indicator, and focus rings. An engaged toggle is deliberately not
one of them — eight toggles whose state is independent of what is playing would
otherwise mean four accent-coloured things with no way to tell which one is the
current track.

The font is **Segoe UI Variable**, not Inter. Inter was declared in the stack
but never loaded, and the display tracking and the fifteen font weights had all
been authored against it. `780`, `800` and every value between 450 and 680 do
not exist in static Segoe UI, so on Windows 10 the whole hairline hierarchy
collapsed to 400 or 700.

## When resuming

1. `npm run typecheck`.
2. `npm run dev`, then `npm run dist:dir` and launch
   `release/win-unpacked/titan-player.exe` — **not** `npm run build`, which does
   not refresh the packaged `app.asar`.
3. Verify with `scripts/play-a-track.mjs` over CDP on port 9222, and screenshot
   with `PrintWindow`.
4. `npm run dist`, then commit and push.
