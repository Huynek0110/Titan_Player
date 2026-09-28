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
| `shot-nowplaying-quiet.mjs <port> <out.png> [row]` | The same view without playing anything: volume is pinned to zero and playback is paused before the view opens. Use this one when sound is not wanted. |
| `test-playback.mjs <port> [row]` | The one that matters: does a real double-click actually start playback, and does the playhead advance? Exits non-zero if not. |
| `inspect-runtime.mjs <port>` | One snapshot of library state, sort order, the resolved accent, artwork load state and the media element. Good for "is the accent following the cover". |
| `probe-*.mjs` | Lower-level network, protocol and strategy probes written while the audio path was being diagnosed. Kept because they are the fastest way back into that area. |
| `make-test-audio.mjs` | Generates a short synthetic FLAC for testing the scanner and the player without using real music. |
| `inspect-audio.mjs` | Dumps the tags of one file, for checking what the scanner will see. |
| `render-icon.mjs` | Rasterises `build/icon.svg` to `build/icon.png` using the Chromium already inside Electron. Run via `npm run icon`. |

## Before committing

A file written by a PowerShell here-string once gained a literal NUL byte in
place of a space, which made the TypeScript compiler report nonsense
("Cannot find binary file"). If a file suddenly reads as binary, check for it:

```powershell
$b = [IO.File]::ReadAllBytes("path\to\file.ts")
($b | Where-Object { $_ -eq 0 }).Count
```
