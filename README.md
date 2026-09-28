# Titan Player

A local music player for Windows, built with Electron and React. It reads the
tags of the audio files already on your disk — no streaming service, no account,
no network calls of any kind — and plays them in an interface built around the
album art.

Ships as both a portable `.exe` you can copy anywhere and a normal NSIS
installer.

![Electron](https://img.shields.io/badge/electron-44-blue) ![React](https://img.shields.io/badge/react-19-61dafb) ![License](https://img.shields.io/badge/license-MIT-green)

---

## What it does

**Library**

- Scans the Windows Music folder automatically, plus any folders you add
- Recursive, with a bounded worker pool so a large library does not stall the app
- Reads MP3, FLAC, M4A/AAC, Ogg, Opus, WAV, WMA, AIFF, APE, WavPack and MP4 —
  all of which decode natively in Electron, so there is no bundled codec
- Artist, album, year, genre, track and disc numbers, bitrate, sample rate,
  channel count, file size, and lossless flag
- Search across title, artist, album, genre, year and track number, ignoring
  diacritics, so `muoi` finds `Mười`; sort by any field, ascending or
  descending; play count, duration and album views

**Artwork and colour**

- Embedded cover art, preferring the front cover over a back scan or band logo
- The dominant colour is extracted from the art and drives the accent colour and
  the ambient background gradient across the whole interface, continuously
  tracking whatever is playing
- Missing or unreadable art falls back to a tinted monogram rather than a grey box

**Lyrics**

- Read from the file's own tags, and from a `.lrc` file sitting beside it
- Understands `LYRICS`, `UNSYNCEDLYRICS` and `SYNCEDLYRICS` Vorbis comments,
  plus ID3 `USLT` and `SYLT` frames
- Parses plain LRC and word-level "enhanced" LRC
- A karaoke fill that sweeps continuously through the active line, including
  across wrapped lines, with no per-word DOM
- When a file *does* carry word-level timings, the fill follows the words rather
  than sweeping the line at a constant rate
- Click any line to seek to it; auto-scroll suspends while you scroll and
  resumes on its own
- Nudge the timing forward or back when a file's sync is off
- Falls back to a readable plain-text view when there is no timing data
- Load an external `.lrc` from anywhere without touching the audio file

**Player**

- Play, pause, previous, next, seek, volume, mute
- Shuffle, repeat off / all / one
- A queue panel that survives the track list being reordered underneath it
- "Play next", "add to queue", and multi-select queueing
- Frequency-bar visualiser driven from a Web Audio analyser
- Track details panel: full technical readout of the current file
- Keyboard: `Space` play/pause, `Shift+←/→` seek, `↑/↓` volume, `/` search,
  `Q` queue, `S` settings, `L` library. `Esc` closes the queue panel and the
  now-playing view; it does nothing on the library itself.

**Playlists**

- Create, rename, duplicate, delete
- Drag rows to reorder, or remove tracks from a playlist
- Favourites, kept separately from playlists
- Hide a track from the library views without losing it from a playlist
- Everything persists across restarts

---

## Install and run

Requires Node 24 or newer.

```sh
npm install
npm run dev
```

On Windows, if PowerShell refuses to run `npm`, use the `.cmd` shim:

```sh
npm.cmd install
npm.cmd run dev
```

### Build an executable

```sh
npm run build     # typecheck and bundle into out/
npm run dist      # produces both .exe files in release/
```

You end up with:

```
release/
├── titan-player-0.1.0-setup.exe      # NSIS installer
├── titan-player-0.1.0-portable.exe   # standalone, no install
└── win-unpacked/                     # unpacked directory, same code as the above
```

Or just the unpacked app directory, which is the fastest way to check a build:

```sh
npm run dist:dir
```

> If you ever run `npm ci` on a machine that blocks install scripts, approve
> them first with `npm install-scripts approve esbuild electron`. Without
> Electron's postinstall there is no `electron.exe` and the app cannot start.

---

## How it is put together

```
src/
├── shared/          types and the LRC parser, used by both sides
├── main/            Electron main process
│   ├── index.ts       window, IPC, navigation lockdown
│   ├── library.ts     folder walk, tag parsing, lyrics
│   ├── protocol.ts    the media:// scheme
│   └── store.ts       atomic JSON persistence
├── preload/         the single contextBridge surface
└── renderer/        React UI
    ├── src/lib/       formatting, colour extraction, audio engine
    ├── src/state/     the store
    └── src/components/
```

### Two decisions worth explaining

**Cover art and audio are served over a custom `media://` protocol**, not sent
across the IPC bridge as base64. A 400 KB cover becomes roughly 533 KB of JSON
once base64-encoded, so a thousand-track library would push around half a
gigabyte through IPC on the first scan. The protocol also fixes a dev-mode
problem: in development the renderer is served from `http://localhost` and
cannot load a `file://` media source, so routing both through one scheme makes
development and production behave identically.

The audio side of the protocol is jailed to the folders you chose. A path that
resolves outside them gets a `403`, so a compromised renderer cannot read your
disk.

**Nothing is bundled to make decoding work.** FLAC, MP3, AAC and Ogg are all in
Chromium's codec set already, and Electron enables `proprietary_codecs`. The
tempting alternative, `ffmpeg.wasm`, would add around 65 MB and reimplement in
WebAssembly something Chromium already does in C++.

### Security posture

- `contextIsolation` on, `nodeIntegration` off
- The renderer's entire API surface is one `contextBridge` object of plain
  serialisable values — no `fs`, no `Buffer`, no raw `ipcRenderer`
- A Content-Security-Policy that does not need a `data:` hole, because media
  comes from the custom scheme
- `will-navigate` and `setWindowOpenHandler` both locked down, so the shell
  cannot navigate away or open windows
- The app runs `asInvoker` and never requests elevation

---

## Known limitations

- **Word-level lyric timing is rare in local files.** FLAC stores lyrics as LRC
  text in a Vorbis comment, which is line-level only. Word timing needs
  "enhanced" LRC, which few taggers write. Where it is present the fill follows
  the words; otherwise the fill is distributed across the line. The line-level
  path is the guarantee, not a fallback.
- **A malformed cover-art block can make a FLAC unplayable.** Chromium's FLAC
  demuxer rejects the whole file when a `METADATA_BLOCK_PICTURE` block has a bad
  MIME type, even though the audio is fine. The player surfaces this as an
  error rather than failing silently.
- Tracks are re-read on every scan. There is no incremental cache, so scanning a
  very large library takes a few seconds each time.
- No gapless playback or crossfade. There is an audible gap between tracks, and
  the first fraction of a second of each is spent seeking.
- No loudness normalisation. `REPLAYGAIN` and `R128` tags are neither read nor
  applied, so switching between a quiet folk recording and a loud EDM master at a
  fixed volume is as uneven here as it is in any player without the feature.
- No scrobbling, no online lyrics lookup, no audio equaliser.
- Duplicate files across folders are not detected. Two copies of the same album in
  two folders appear as two albums.

---

## Licence

MIT.
