# scripts/

Diagnostics for the app, run against a **packaged** build over the Chrome
DevTools Protocol. None of them are part of the shipped bundle.

## Why CDP and not a UI automation library

The app is a Chromium surface with a hidden title bar, so a synthetic click
raised from PowerShell never reaches the window — it is not delivered to the
process at all. Going through CDP `Input.dispatchMouseEvent` is the only way that
works, and it needs no dependency: Node 22+ ships a global `WebSocket`, so
`ws` is not required.

## Running the app for these

```sh
npm run dist:dir
release\win-unpacked\titan-player.exe --remote-debugging-port=9222
```

`npm run build` is not enough — the packaged app runs its own `app.asar`, so
only `dist:dir` or `dist` refreshes it.

PowerShell blocks `.ps1` files on some machines, which is why these are `.mjs`
and run through `node` rather than as shell scripts.

## The scripts

| Script | What it does |
| --- | --- |
| `screenshot.mjs <port> <out.png> [maximise]` | Captures the window. `maximise` drives the app's own maximise button, so it also exercises the resize path. |
| `shot-nowplaying.mjs <port> <out.png> [row]` | Double-clicks a track, opens the now-playing view, reports which parts of it mounted, then captures. **This plays audio.** |
| `shot-nowplaying-quiet.mjs <port> <out.png> [row] [seekSeconds]` | The same view with the volume pinned to zero and playback paused, plus an optional seek so the active lyric line and the `--fill` karaoke sweep can be checked without sound. Use this one whenever sound is not wanted. |
| `test-playback.mjs <port> [row]` | The one that matters: does a real double-click actually start playback, and does the playhead advance? Exits non-zero if not. |
| `inspect-runtime.mjs <port>` | One snapshot of library state, sort order, the resolved accent, artwork load state and the media element. Good for "is the accent following the cover". |
| `dump-dom.mjs <port> [selector] [maxChars]` | Element counts, some text, and the measured geometry of the now-playing layout. Faster than a screenshot for "did it render, and is it inside the window". |
| `probe-seek.mjs <port> <seconds>` | Sets `currentTime` and reports `readyState`, `seekable` and the position before and after. This is how the non-seekable `media://` response was found. |
| `probe-clock.mjs <port>` | Ten plain reads of the media clock. Written because two other probes disagreed about whether the clock was moving, and printing the numbers was faster than reconciling the two. |
| `probe-lyric-animation.mjs <port> [ms]` | Watches the lyric line change for ~20s and records the outgoing line's computed opacity and transform on every sample. Reports the clock span and the number of distinct lines, so a stopped clock cannot be mistaken for a broken animation. For it to see anything, playback must already be running — see below. |
| `probe-*.mjs` | Lower-level network, protocol and strategy probes written while the audio path was being diagnosed. Kept because they are the fastest way back into that area. |
| `make-test-audio.mjs` | Generates a short synthetic FLAC for testing the scanner and the player without using real music. |
| `inspect-audio.mjs` | Dumps the tags of one file, for checking what the scanner will see. |
| `render-icon.mjs` | Rasterises `build/icon.svg` to `build/icon.png` using the Chromium already inside Electron. Run via `npm run icon`. |

## Starting playback from a probe

Every attempt to start playback from inside a probe failed in a way that looked
like the feature under test was broken:

- `audio.play()` from a script advances the media clock but leaves the app's own
  `isPlaying` false, so anything the app gates on playback state stays idle. The
  clock moves and the feature looks dead.
- `Runtime.evaluate` with `userGesture: true` satisfies Chromium's autoplay
  policy, and still bypasses the app's state.
- Clicking a transport button only lands when the view is open and the button is
  where `getBoundingClientRect` says, and it is a *toggle* — so a second run
  pauses what the first one started.

The reliable path is a real `Input.dispatchMouseEvent` double-click on a track
row, which goes through the app's own code. `shot-nowplaying-quiet.mjs` does that,
and its trailing `keep-playing` argument leaves the clock running so an observing
probe can watch it:

```sh
node scripts\shot-nowplaying-quiet.mjs 9222 out.png 1 30 keep-playing
node scripts\probe-lyric-animation.mjs 9222
```

## Windows animation effects

This machine reports `prefers-reduced-motion: reduce`, because *Settings →
Accessibility → Visual effects → Animation effects* is switched off. Every
transition in the app is correctly suppressed by that preference, so motion bugs
cannot be observed here without forcing the other branch. `probe-lyric-animation`
does that with Chromium's own media emulation:

```js
await send("Emulation.setEmulatedMedia", {
  features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
})
```

Turn the OS setting on to see the interface as most users will.

## Before committing

A file written by a PowerShell here-string once gained a literal NUL byte in
place of a space, which made the TypeScript compiler report nonsense
("Cannot find binary file"). If a file suddenly reads as binary, check for it:

```powershell
$b = [IO.File]::ReadAllBytes("path\to\file.ts")
($b | Where-Object { $_ -eq 0 }).Count
```
