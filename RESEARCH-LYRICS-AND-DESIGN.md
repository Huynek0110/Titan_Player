# Titan Player — Lyrics Display & Visual Design Research Brief

**Research date:** 2026-09-27
**Target:** local music player, Electron 44 + React 19 + Vite 7 (`electron-vite` 5), TypeScript 7, license **MIT**
**Method:** npm registry API queries, GitHub raw README fetches, vendor docs, community threads.
All package versions below were read from `https://registry.npmjs.org/<pkg>` on 2026-09-27 unless noted.

**Legend:** `[FACT]` = verified from a primary source (npm registry, official docs, vendor page). `[OPINION]` = my judgement / design recommendation.

---

## PART A — LYRICS DISPLAY

### A1. How players display lyrics today

| Player | Model | Word-level? | Interaction notes | Source |
|---|---|---|---|---|
| **Apple Music** (iOS/iPadOS/macOS) | Time-synced lyrics appear "line-by-line, beat-by-beat" against a **"colorful and dynamic background, derived from album art"** | Yes — proprietary, artist-supplied. Artists submit via Apple Music for Artists | Swipeable between `Lyrics` / `Translate` / `Pronounce`; tap a line to jump; `Settings > Apps > Music > Larger Text` splits sizing for original vs pronunciation; full-screen lyrics via the Lyrics button on Apple TV | [Apple Music Provider Support](https://itunespartner.apple.com/music/support/5218-submit-lyrics), [Apple for Artists](https://artists.apple.com/support/1112-send-your-lyrics-to-apple-music), [support.apple.com/105076](https://support.apple.com/en-us/105076), [support.apple.com/105015](https://support.apple.com/en-us/105015) |
| **Spotify** | Since 2022 line-by-line; **Feb 4 2026** shipped 3 upgrades: translations worldwide, **offline lyric download**, and a **"lyrics preview"** rendered *directly beneath the album artwork / Canvas clip* in the Now Playing view (togglable via ⋯ → "Lyrics Off") | Yes internally, not exposed as seek-points | Full-screen tap on the lyrics card; tap a line to highlight + **Share** it to social; desktop (2026) forces full-screen and **dropped the side-by-side art+lyrics layout** — widely disliked in the community | [newsroom.spotify.com/2026-02-04](https://newsroom.spotify.com/2026-02-04/lyric-translations-offline-previews), [support.spotify.com/us/article/lyrics](https://support.spotify.com/us/article/lyrics), [community thread](https://community.spotify.com/t5/Desktop-Windows/Lyrics-display-on-PC-very-unpleasant-only-3-lines-that-jump/td-p/5367764) |
| **Musixmatch** | The data layer most players license. Explicitly sells **"line-by-line and word-by-word"** sync; 12M songs, 250 languages; dynamic lyrics on CarPlay / Lock Screen / Apple Watch; **Live Activities with word-by-word**; has a **translation layer** and per-line **"who's singing"** attribution | Yes | Premium-gated. API is commercial — *selected partners and individual developers only*, key is mandatory, requires a signed agreement | [about.musixmatch.com](https://about.musixmatch.com/business/overview), [docs.musixmatch.com/getting-started](https://docs.musixmatch.com/getting-started) |
| **YouTube Music** | Line-by-line in the lyrics sheet; third-party extension **Better Lyrics** ("Enhance YouTube Music with beautiful time-synced lyrics") is the word-level upgrade path | Only via third-party extension | — | [better-lyrics/better-lyrics](https://github.com/better-lyrics/better-lyrics) |
| **Genius** | Un-synced plain text + annotations, plus a per-line timestamp gutter that you can tap to seek. foobar2000's OpenLyrics **migrated Genius from web scraping to the official API** in v1.12 (2025-02-21) | No | Tap-to-seek on line timestamps | [foobar2000 OpenLyrics releases](https://www.foobar2000.org/components/view/foo_openlyrics/releases) |
| **Poweramp** | LRC is the supported synced format; forum guidance treats it as "the most common way of synced lyrics" for comprehension, not karaoke | Line-level | — | [Poweramp forum](https://forum.powerampapp.com/topic/23478-support-for-lrc-lyrics-synced-lyrics) |
| **foobar2000 + OpenLyrics** | **v1.13, released 2026-01-17.** Own panel, timed + untimed, sources: LRCLib, Musixmatch, **Genius via API**, local files. Has a **manual/custom lyric search dialog that searches all sources**, HTML-entity auto-edit, an **auto-edit to remove timestamps**, auto-save toggle, "mark as instrumental", and an **option to disable automatic scroll in favour of drag/mousewheel** | Line-level; word-level if the source supplies enhanced LRC | The *disable auto-scroll* option is the most interesting UX precedent here: power users explicitly want to break the auto-scroll. | [foo_openlyrics](https://www.foobar2000.org/components/view/foo_openlyrics) |
| **Musicolet** (Android) | `.lrc` sidecar files, **no internet fetching** — you paste/write them yourself. In-app sync editor ("takes about as long as the song to sync it") | Line-level | Tap cover art to toggle art ⇄ lyrics | [Galaxy Store](https://galaxystore.samsung.com/detail/in.krosbits.musicolet), [r/musichoarder](https://www.reddit.com/r/musichoarder/comments/u4oi0i/getting_synced_lyrics_lrc_lyrics_for_almost_any/) |
| **Nuclear** | No built-in lyrics pane in the shipped desktop app. Its differentiation is **6 hand-built themes** (Aurora, Lagoon, Arctic Moss, Canyon, Molten Core, Midnight Terminal) | No | — | [nuclearplayer.com](https://nuclearplayer.com) |

**Key takeaway `[FACT]` → `[OPINION]`:** As of Feb 2026 Spotify and Apple Music both moved to a **"lyrics adjacent to the artwork, not in a separate pane"** model, and Spotify's desktop community backlash for removing the side-by-side view is the strongest available signal that **a dedicated, resizable, always-visible lyrics pane is a differentiator, not a bug** — for a *local* player, where you control the window, this is exactly the right call.

---

### A2. The best-looking current approach for word-level synced lyrics

`[OPINION]` **The Apple Music (iOS/iPadOS) treatment is the current high-water mark**, and `@applemusic-like-lyrics` is a faithful, actively-maintained open reimplementation of it. The recipe, broken into its separable parts:

**1. Active-line emphasis — use opacity + a modest size ramp, not bolding.**
`[OPINION]` Bolding a 28px active line causes reflow of the line below on every line change, which reads as jank. Apple Music keeps the weight constant and shifts **opacity and a small size step**. Concrete ramp:

| State | Size | Weight | Opacity | Blur |
|---|---|---|---|---|
| Active (sung, past) | `1.0rem` (base) | 700 | 1.0 | 0 |
| Active (current) | `1.375rem` (×1.375) | 700 | 1.0 | 0 |
| Next 1 line | `1.0rem` | 600 | 0.55 | 0 |
| Inactive (past/future) | `1.0rem` | 600 | 0.35 | 0.5px |

`0.35` for inactive and `0.55` for "up next" is the specific dimming ratio I'd start at. Apple Music additionally applies a **slight blur to out-of-focus lines**; `filter: blur(0.5px)` is the cheap, tasteful version (0.5–1px — more looks broken).

**2. Per-word fill — the technique is a clipped linear gradient on a duplicated text layer, NOT a per-word colour swap.**
This is the single most important implementation detail. Source: Jesper Vos, [*Karaoke Text*](https://jespervos.com/craft/karaoke-text) — *"The most important ingredient is the one left out."* The trick is that `background-clip: text` **wraps the gradient across the text's line boxes when the element is `display: inline`**, so you get a continuous sweep across a multi-line lyric with no per-word DOM and no reflow.

```css
.karaoke {
  display: inline;                 /* the load-bearing declaration */
  color: transparent;              /* show the gradient, not the glyph */
  background-color: var(--dim);    /* the "not yet sung" colour */
  background-image: linear-gradient(to right, var(--sung) 100%);
  background-repeat: no-repeat;
  background-position: left top;
  background-size: 0% 100%;        /* driven by --progress (0..1) */
  background-clip: text;
}
```

You then set `background-size: calc(var(--progress) * 1%) 100%` from a CSS custom property. Two refinements from that article:
- **Feathering:** if you want a soft leading edge rather than a hard stop, use a multi-stop gradient. The article's overshoot trick: `--color-stop: 80` → `background-size: 125%` at 100% progress, so the feathered tail is still fully covered. Without this the last word never fully lights up.
- **Do not** use `animation-timeline: view()` (the article's scroll-driven variant). For audio you drive `--progress` from `requestAnimationFrame` off `audio.currentTime`. `animation-timeline: view()` is for scroll-linked text, not audio.

**3. Colour treatment — singular accent, not per-word hue.**
`[OPINION]` The premium look comes from *one* accent colour for the sung portion and *one* neutral for the unsung, both derived from the same palette. Spotify's word-level highlight is a two-tone (dim → white) fill. Apple Music's is dim → a colour pulled from the artwork-derived background. Do **not** colour each word differently; that reads as a party, not as music.

**4. Background — the lyrics view does NOT blur the artwork behind the text.**
`[FACT]` Apple Music's lyrics background is a *generated* gradient "derived from album art" (Apple's own provider docs), and iOS 26 makes it an animated fluid mesh. `[OPINION]` For a desktop app: put a large, heavily-blurred copy of the cover art behind the text, plus a scrim. The text must sit on a near-solid-enough surface. Use `backdrop-filter: blur(60px) saturate(180%)` on the *pane*, and a separate solid-ish `linear-gradient(rgba(0,0,0,.55), rgba(0,0,0,.75))` scrim behind the text column specifically.

**5. Layout — the active line sits at ~38% viewport height, not centred.**
`[OPINION]` Centring the active line (`react-lrc`'s `verticalSpace` behaviour) wastes the top half and makes the "what's coming next" invisible. Apple Music parks the active line in the upper third with the incoming line visible just below. The `react-lrc` docs have side-by-side screenshots of this exact decision: [without](https://github.com/mebtte/react-lrc/blob/master/docs/without_vertical_space.png) / [with](https://github.com/mebtte/react-lrc/blob/master/docs/with_vertical_space.png).

---

### A3. React libraries — verified against npm on 2026-09-27

#### Recommended

| Package | Latest | Last publish | License | ESM | CJS | TS | Deps | Word-level? | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| **`lrc-kit`** | **1.2.1** | 2026-03-06 | **MIT** | ✅ | ✅ | ✅ | **0** | **Yes** (Enhanced LRC) | **Use this.** See below. |
| **`react-lrc`** | **3.2.1** | 2024-06-15 | MIT | ✅ | ✅ | ✅ | 2 | No | Good line-level fallback / reference impl |
| `@tanstack/react-virtual` | 3.14.13 | 2026-09-14 | MIT | ✅ | ✅ | ✅ | 1 | n/a | For the library/queue list |

**`lrc-kit` v1.2.1 — why it's the pick `[FACT]`.** From its README: parses standard LRC **and "Enhanced format"** which it documents as *"foobar2000 and A2 formats embed per-word timestamps"*. It gives you both syntaxes:

```
; foobar2000 enhanced — bare [mm:ss.mmm] before each word
[00:05.000] hello [00:06.000] world

; A2 enhanced — angle-bracket form
[00:02.000] <00:02.500> spark <00:03.000> light
```

`Lrc.parse(text, { enhanced: true })` yields per-lyric `wordTimestamps: [{ timestamp, content }]` and preserves `rawContent` (which carries the embedded tags) and `content` (clean, tag-free text). The `Runner` class is the playback engine:

- `runner.timeUpdate(seconds)`, `runner.curIndex()`, `runner.curLyric()`
- **`runner.curWordIndexes()` → `{ wordIndex, charStartIndex, charEndIndex }`** — character offsets into the line, so you can slice precisely.
- `lrc.offset(ms)`, `lrc.info.offset` auto-applied via `new Runner(lrc, offset = true)`.

MIT, zero dependencies, dual ESM/CJS, ships types, actively published. `[OPINION]` This is the only mature, permissively-licensed JS package I found that does real word-level timing.

**`react-lrc` v3.2.1** `[FACT]`: line-level only, but it nails the scroll UX you asked about in Q5 — `recoverAutoScrollInterval` (default **5000 ms**) pauses auto-scroll on user scroll and resumes it, `onAutoScrollChange` reports state, `useRecoverAutoScrollImmediately()` gives you a "resume now" button, and `onLineUpdate` fires on line change. Caveat: last publish 2024-06-15 (~2.3 years stale), 2 transitive deps, and it owns its scroll container so it fights a virtualized layout. `[OPINION]` Steal the *design* of its scroll API; don't take the dependency.

#### Available but license-constrained — `AGPL-3.0`

`[FACT]` This project's `package.json` declares `"license": "MIT"`. AGPL-3.0 is **network/copyleft — it would force you to open-source Titan Player**. Treat these as reference material, not dependencies, unless you make a deliberate licensing decision.

| Package | Latest | Last publish | License | Weight | Why you care |
|---|---|---|---|---|---|
| **`@applemusic-like-lyrics/react`** | 0.6.0 | **2026-09-19** | AGPL-3.0-only | 128 KB | The best-looking Apple Music lyrics implementation that exists in web tech. 35 versions. |
| `@applemusic-like-lyrics/core` | 0.6.0 | 2026-09-19 | AGPL-3.0-only | 1.8 MB | DOM core + **PixiJS** fluid background (6 `@pixi/*` peer deps: `app`, `core`, `sprite`, `display`, `filter-blur`, `filter-bulge-pinch`, `filter-color-matrix`) |
| `@applemusic-like-lyrics/lyric` | 1.1.0 | 2026-09-19 | AGPL-3.0-only | 424 KB | Parser for LyRiC, YRC, QRC, Lyricify Syllable |
| `@applemusic-like-lyrics/vue` | 0.6.0 | 2026-09-19 | AGPL-3.0-only | 162 KB | Vue binding (irrelevant here) |

Repo: [`amll-dev/applemusic-like-lyrics`](https://github.com/amll-dev/applemusic-like-lyrics). `[FACT]` Its own README calls it *"perhaps the most iPad Apple Music-like lyric page you've seen in frontend"* and lists browser floors (Chromium 120+ for full effects, Firefox 100+, Safari 15.4+ — it needs `mask-image` and `mix-blend-mode: plus-lighter`). `[FACT]` It carries a **"Looking for Maintainers"** banner and admits *"only one active maintainer with limited bandwidth."* `[FACT]` Its perf notes are sobering: **30 FPS on mainstream 5-year-old CPUs**; 60 FPS needs ≥3.0 GHz; 144 FPS needs ≥4.2 GHz; full 60 FPS at 1080p needs GTX 10-series / RTX 2070-class. `[OPINION]` That is a strong argument against shipping it in an Electron renderer even ignoring the license — the DOM `background-clip: text` approach in A2 is GPU-cheap and does 60 FPS on integrated graphics. **Read this repo for design cues; reimplement the effect.** Related: [`amll-dev/amll-player`](https://github.com/amll-dev/amll-player) is a Tauri desktop lyrics window, and the author notes that even a browser-plugin version suffered frame drops — corroborating the perf claim.

| Package | Latest | Last publish | License | What it is |
|---|---|---|---|---|
| **`lyric-kit`** (SPlayer-Dev) | **0.6.0** | **2026-09-20** | **AGPL-3.0** | Zero-dep TS toolkit: **LRC, TTML, QRC, KRC, YRC, LyS, SRT, ASS**. Ships `findLyricIndex`, `findActiveLyricIndices` (handles overlapping lines), and **`getWordSweepProgress(word, lineStartTime, currentMs)` → `[0,1]`** — i.e. the karaoke sweep progress, pre-computed. Also `stripLyricMetadata`, `applyLyricLanguages` (infers `ja`/`ko`/`zh-CN` from kana ruby + CJK density). |

`[OPINION]` If you ever *do* accept AGPL, or if you only need it as a **spare-time parser upgrade** (TTML is Apple's actual format), `lyric-kit` is the best-engineered thing in the entire list — 11 versions in 2 weeks, published last week. `getWordSweepProgress` is exactly the primitive A2's CSS needs. Its `LyricWord` model is the nicest: `{ word, startTime, endTime, romanWord?, ruby?: LyricSpan[], obscene?, emptyBeat? }`.

#### Do not use

| Package | Latest | Last publish | Why |
|---|---|---|---|
| `react-lyrics` | 0.1.0 | 2022-05-14 | **ABANDONED.** One version, ever. Its own description is the untouched TSDX boilerplate: *"Congrats! You just saved yourself hours of work by bootstrapping this project with TSDX."* It's a scaffold, not a library. |
| `lyric-parser` | 1.0.1 | 2022-06-19 | **ABANDONED.** 2 versions, CJS-only, no types, `main: dist/lyric.js`. |
| `lyrics.js` | 0.4.2 | 2022-06-19 | **ABANDONED.** 7 versions, CJS-only (`main: lyrics.js`), no types. |
| `ammolite` | 0.1.5 | 2026-06-11 | **Not a lyrics library.** It's a CSS-in-JS library (`gemvale/ammolite`, 3 deps). Irrelevant to this question. |
| `@karaoke/lyrics` | — | — | **404. Does not exist on npm.** |
| `better-lyrics` | — | — | **404 on npm.** It's a YouTube Music *browser extension* ([repo](https://github.com/better-lyrics/better-lyrics)), not a library. |
| `lrclib` | — | — | 404. LRCLib is a **service**, not a package — see A4. |
| `react-lyric` / `lyrics-parser` | — | — | 404 / zero published versions. Placeholder names. |

`[OPINION]` The headline finding: **of nine packages you named, four don't exist and three are abandoned.** The credible set is `lrc-kit`, `react-lrc`, and the two AGPL-3.0 AMLL/lyric-kit projects. Write the renderer yourself.

---

### A4. Where word-level timestamps actually come from

**Being precise, because this determines your whole feature scope.**

#### `[FACT]` Line-level is the realistic floor for local files.
- **FLAC / Vorbis / Opus:** synced lyrics live in a VorbisComment as raw **LRC text** in the **`LYRICS`** (or `SYNCEDLYRICS`) tag. It's line-level LRC, nothing more. Verified via `ffprobe -show_entries format_tags=LYRICS` → `{"LYRICS": "[0:17.576]She'll be gone soon\r\n[0:19.127]..."}` ([Mp3tag forum](https://community.mp3tag.de/t/embedded-lyrics-and-which-tags-to-use/64698), [MusicBee forum](https://getmusicbee.com/forum/index.php?topic=44549.0)).
- **MP3 / ID3v2:** `USLT` = unsynced plain text; **`SYLT` = synced, and it genuinely is per-syllable/word-timed** with millisecond precision. `[FACT]` But: the SYLT frame is a different, non-textual format that no common tool writes. The Mp3tag forum consensus is blunt: *"The SYLT frame seems more complicated and strict than it needs to be (all times in ms, no support for tags in [xxx:yyy] format etc.)"* and *"internal mappings are often quite painful for scripting."* Practical uptake is near zero.
- **Sidecar `.lrc` files** next to the audio: line-level, universally supported (Musicolet, MusicPlayer2, etc.).

#### `[FACT]` The one practical route to real word-level timing: **Enhanced LRC**.
The A2 / foobar2000 enhanced-LRC dialects inline per-word tags inside a line, and `lrc-kit` parses both (see A3). These files exist in the wild but are rare. Same content is also expressible as **TTML** (`<span begin="..." end="...">`) — that is literally **Apple Music's own format**, and `lyric-kit` / AMLL both parse it.

#### `[FACT]` The proprietary routes are closed.
- Apple Music: artists submit time-synced lyrics through [Apple Music for Artists](https://artists.apple.com/support/1112-send-your-lyrics-to-apple-music). No public API for retrieval.
- Spotify: no public lyrics API. Third parties reverse-engineer the mobile client (see `lyricglow`, `LyricFever` on GitHub) — fragile, and legally/ToS grey.
- **Musixmatch** is the *only* legitimate commercial source, and it explicitly sells **word-by-word** sync. `[FACT]` But access is gated: *"The Musixmatch API is available to both selected partners and individual developers"* — you must get in touch, get a key, and agree to their content policy and **display-rights terms**. Not a weekend project.

#### `[FACT]` LRCLib is the free, legitimate, line-level option — and it's good.
Open, community-maintained, no key. `foo_openlyrics` v1.12+ lists it as a source, and it's the recommended open alternative (it also caps result counts). `[OPINION]` Integrate LRCLib as the fetch-on-demand path, cache to a local SQLite/JSON store keyed by `(artist, title, album, duration)` — the duration key is important, it disambiguates remixes/live versions.

#### `[FACT]` `lyricget` is the tool that makes LRCLib practical for a library.
`[FACT]` [`tranxuanthang/lrcget`](https://github.com/tranxuanthang/lrcget) exists to batch-fetch synced LRC for a music folder (issue #75 documents wanting to write them into tags). `[OPINION]` Don't shell out to it — call LRCLib's HTTP API directly from your Electron main process and write the results into your own store *and* optionally back into the files' `LYRICS` tag so the library stays portable.

#### The honest answer

> **For a local player, word-level is an enhancement, not the baseline.** Design for line-level LRC as the guaranteed path (embedded tag → sidecar file → LRCLib fetch → plain text fallback), and treat word-level as a progressive upgrade that lights up only when the source supports it. Ship a **synthetic word distribution** as the fallback so the *animation* is never absent — see the code below.

`[FACT]` One open format that might become the answer: [`tranxuanthang/lyricsfile`](https://github.com/tranxuanthang/lyricsfile) — *"An open, human-readable YAML format for plain, synced, and word-synced lyrics."* `[OPINION]` Early-stage, but it's the right shape. Worth watching, not worth depending on.

---

### A5. Lyrics-pane UX details

| Detail | Recommendation | Basis |
|---|---|---|
| **Auto-scroll** | Smooth-scroll the active line to ~38% viewport height. Use `behavior: 'smooth'` on `scrollTo`, or a critically-damped rAF lerp if you want control. Only issue a scroll when `activeIndex` changes — never every frame. | `[FACT]` `react-lrc` does "Auto scroll smoothly" with an `onLineUpdate` (index-change) trigger |
| **Manual scroll pauses auto-scroll** | On `wheel`, `touchmove`, `pointerdown` on the scrollbar, or `keydown` of an arrow/PageUp/PageDown: set `autoScroll = false`, record `resumeAt = now + 5000`. **Render a small floating "Resume auto-scroll" pill** at the bottom of the pane that also shows the pending line. | `[FACT]` `react-lrc`: `recoverAutoScrollInterval` default **5000 ms** + `onAutoScrollChange` + `useRecoverAutoScrollImmediately`. `[FACT]` foobar2000's OpenLyrics added an explicit "disable automatic scroll and drag/mousewheel instead" option — power users ask for this. |
| **Detect "user scrolled" correctly** | Do **not** use the `wheel` event alone (trackpad momentum + scrollbar drags miss it). Use `pointerdown`/`wheel`/`keydown` on the container. | `[OPINION]` |
| **Click a line to seek** | Every line is a `<button>` (see a11y below), not a clickable `<div>`. Seek to that line's `startTime`; if the click is within the last 1.5 s of the line's duration, advance to the next line instead — that's what users mean when they tap a line they're "on". | `[FACT]` Apple Music, Spotify, and foobar2000 all support tap-to-seek |
| **Show timestamps on hover** | Reveal `mm:ss` next to the line on hover/focus, right-aligned. Fades in over 120 ms. | `[OPINION]` |
| **Instruments / no lyrics** | Don't show an empty pane. Show the cover art at low opacity, or a "Lyrics not available — ⌘L to add" affordance that opens an editor. Never render a blank column. | `[OPINION]` |
| **Font sizing** | Base `--lyric-size: clamp(1.0rem, 1.6vw + 0.6rem, 1.375rem)`. Active line = ×1.375. Respect `prefers-reduced-motion` (kill the fill animation, snap instead). `[FACT]` Apple splits the size control for "original script" vs "pronunciation". | [Apple TV 105015](https://support.apple.com/en-us/105015) |
| **Accessibility** | See below. | — |

**Accessibility checklist `[OPINION]`, built on WCAG 2.2:**

1. **Lyric lines must be real `<button>`s** so they're tab-reachable and fire on Enter/Space. `role="button"` on a `<div>` fails.
2. **`aria-current="true"` on the active line**; the container is `role="log"` or `aria-live="off"`. Do **not** use `aria-live="polite"` on the whole scroller — a word-by-word fill would spam a screen reader dozens of times per line. Announce the *line* change only, via a visually-hidden `aria-live="polite"` region containing just the current line's text, debounced ~500 ms.
3. **Never encode meaning in colour alone** (WCAG 1.4.1). The sung/unsung fill is decorative; the line's *identity* is the text, which is always present at full DOM opacity (the `color: transparent` is on a decorative layer, see the code).
4. **Contrast**: the *inactive* lines are the risk. Dimming to 0.35 white on a mid-tone artwork can land under 4.5:1. `[OPINION]` Floor inactive opacity at **0.45** and put a scrim behind the text column (§A2.4). Use `colorthief`'s `.contrast.foreground` to pick white-vs-black and floor the result.
5. **Target size**: lyric lines get `min-height: 44px` and generous vertical padding so the tap target clears WCAG 2.2 §2.5.8 even though the visual text is smaller.
6. **`prefers-reduced-motion`**: disable the smooth scroll, the fill transition, and the ambient background drift. Make the active line still legible via opacity only.
7. **Font size must be user-adjustable and persist.** Persist `lyricSizeScale`, `autoScrollInterval`, `blurEnabled`, `dimOpacity` to config.

---

## PART B — MUSIC PLAYER VISUAL DESIGN

### B6. What makes a music player UI feel "premium"

Surveyed: Spotify (desktop, 2026), Apple Music (iOS 26 / macOS), Tidal, Deezer, YouTube Music, Plexamp, MusicPlayer2, Nuclear.

**The recurring techniques, in rough order of impact `[OPINION]`:**

1. **The whole surface is a function of the current artwork.** Not a themed chrome — a *per-track* environment. `[FACT]` Apple's own provider docs: time-synced lyrics appear "against a colorful and dynamic background, derived from album art." `[FACT]` iOS 26 goes further: **animated album art** on the Lock Screen that "interacts beautifully with the glass of the playback controls" ([Apple iOS 26 features PDF](https://www.apple.com/os/pdf/All_New_Features_iOS_26_Sept_2025.pdf)). Nuclear ships 6 full hand-designed themes ([nuclearplayer.com](https://nuclearplayer.com)) — proof that surface design is where the differentiation lives.
2. **Depth via real material, not a drop shadow.** `[FACT]` Apple's iOS 26 "Liquid Glass" is the current state of the art: glass that "combines the optical qualities of glass with a sense of fluidity," with **automatic grouping of bar button items into visual groups sharing glass backgrounds**, and — critically — `[FACT]` *"sliders… now preserve momentum and stretch when they are moved"* ([WWDC25 — Build a UIKit app with the new design](https://developer.apple.com/videos/play/wwdc2025/284)). Elasticity reads as expensive.
3. **Restraint in the resting state, extravagance in the transition.** The mini-player is quiet; expanding to Now Playing is a cinematic move. `[FACT]` iOS 26's **Dynamic tab bars** "shrink to create more space as you scroll, and fluidly expand the moment you need them."
4. **A strong type hierarchy with very few sizes.** Spotify historically used Circular (later a custom cut, now reportedly replaced by "Spotify Mix" — `[FACT]` secondary sources only, treat as unconfirmed); Apple Music uses SF Pro. `[FACT]` The lesson that generalises: *a tall x-height, wide weight range, tabular figures, readable from 11px to 40px.* Nothing else in the chrome should compete with the artwork and the lyrics.
5. **The playhead is the hero.** Controls are optically centered in a compact cluster; the progress bar is thin and full-bleed; the time is tabular-figure aligned left/right of it.
6. **Density that still breathes.** Plexamp is the reference for "dense but calm" — heavy use of horizontal dividers, generous row height, and a real settings surface. MusicPlayer2 is the *anti*-reference: information-dense, zero visual hierarchy, no artwork integration. Nuclear proves theming is not enough on its own.

**What does *not* correlate with premium `[OPINION]`:** gradients on buttons, glassmorphism used decoratively rather than structurally, drop shadows on flat surfaces, and animated backgrounds that don't change per track.

---

### B7. The specific techniques, with numbers

`[OPINION]` throughout, except where marked. These are my recommended starting values.

#### Dynamic colour → ambient environment
- Extract a **3–5 colour palette** from the artwork (see B8).
- Build the background as a **three-stop radial mesh**: primary at 20% opacity top-left, secondary at 15% bottom-right, tertiary at 10% centre, over a near-black base. Apple's "fluid" background is essentially this, animated.
- **Never let the extracted colour be the only thing carrying contrast.** Always run it through an OKLCH lightness clamp: `L` into `[0.12, 0.55]`, `C` scaled to `[0.02, 0.14]`. Album art is frequently near-white or near-black; an unclamped average colour will produce an unusable background.
- **Animate between tracks, don't cut.** `background-color`/`--accent` transition over **600–800 ms** with `cubic-bezier(0.4, 0, 0.2, 1)`. `prefers-reduced-motion` → 0 ms.
- Cross-fade the artwork itself: render old and new covers stacked, the new one at `opacity 0→1` over 400 ms.

#### Frosted glass
```css
backdrop-filter: blur(60px) saturate(180%) brightness(0.9);
background: color-mix(in oklab, var(--accent) 8%, transparent);
```
- `blur` **40–80px**. Below 20px it reads as "grey overlay", not glass.
- `saturate(180%)` is the step most people skip — it's what makes it look like glass rather than fog.
- **Fallback:** `@supports not (backdrop-filter: blur(1px)) { background: rgba(18,18,20,0.86); }`. Also set an explicit `rgba()` base; `backdrop-filter` alone gives you a transparent box on unsupported compositors.
- `[FACT]` Electron is Chromium, so `backdrop-filter` is fully available. `--disable-gpu` / software compositing will degrade it, but a desktop music player with a full-screen ambient background is a legitimate reason to keep GPU acceleration on.

#### Typography scale
`[OPINION]`, mobile-first, 1.200 (minor third) mostly, 1.414 for display:
```
--fs-2xs: 0.6875rem  (11px)  metadata, timestamps
--fs-xs:  0.75rem    (12px)  track artist / album
--fs-sm:  0.875rem   (14px)  list row titles
--fs-md:  1rem       (16px)  body / player controls
--fs-lg:  1.25rem    (20px)  pane headers
--fs-xl:  1.5rem     (24px)  Now Playing track title
--fs-2xl: 2.25rem    (36px)  Now Playing track title, large mode
--fs-3xl: clamp(2.5rem, 4vw, 4rem)  lyrics active line
```
Line heights: lyrics `1.25` (tight, so a line's fill sweep reads as one object), list rows `1.35`, track titles `1.2`.
Letter-spacing: `-0.011em` at body, `-0.02em` at display sizes. `[OPINION]` Never positive tracking below 16px.

#### Corner radii & spacing
- Radii: `4` (chips/badges) / `8` (buttons, inputs) / `12` (cards, list containers) / `16` (panels) / `9999` (pills, play button). `[FACT]` Apple groups iOS 26 bar items into shared glass backgrounds; a single radius per surface group is what makes grouping read.
- Spacing: strict **4px base**. Player bar `24px` vertical padding. List row `12px / 16px`. Pane gutter `24px`, grid gutter `16px`. Section headers get `32px` top margin to create the "chapter" rhythm.

#### Motion
| Interaction | Duration | Easing | Note |
|---|---|---|---|
| Hover on list row | 90 ms | `ease-out` | Background only. No transform. |
| Mini-player → Now Playing | 320 ms | `[0.32, 0.72, 0, 1]` | Shared-element: the cover art `layoutId` animates from the row to the hero. |
| Colour change between tracks | 700 ms | `cubic-bezier(0.4, 0, 0.2, 1)` | |
| Lyric active-line change | 250 ms | `ease-out` | Opacity + size. |
| Lyric word fill | **0 ms** (continuous) | linear | Driven by rAF off `audio.currentTime`, never a CSS transition |
| Play/pause button glyph | 140 ms | `ease-out` | Rotate 90° + fade, not a scale-punch. |
| Panel/sidebar expand | 240 ms | `[0.4, 0, 0.2, 1]` | |

`[FACT]` **"Sliders… preserve momentum and stretch when they are moved"** (WWDC25). `[OPINION]` Implement the seek bar as: (a) a stretched thumb on drag/hover (scaleX 1.0 → 1.6 with the hit area preserved), and (b) momentum-based fill — the filled portion *chases* the true position with a spring rather than tracking it exactly, so a fast scrub looks like inertia. This is the single highest-value "premium" detail on the transport bar.

#### Hover / active states
- Rows: `background-color` to `rgba(255,255,255,0.06)` (dark) / `0.04` (light). **No border, no shadow, no scale.** `[OPINION]` Scale-on-hover on a list row reads as a toy.
- Play button: `scale(1.06)` + accent-tinted glow. The one place transform-on-hover is right.
- `:focus-visible` must be visible — 2px accent ring, `2px` offset. Never `outline: none` without a replacement.
- Equalizer bars on the currently-playing row, animated at ~1.2 Hz, `aria-hidden`.

#### Queue / playlist list layout
- **Virtualize.** `[FACT]` `@tanstack/react-virtual` v3.14.13 is headless, MIT, 1 dependency. A 50 000-track library is normal for a *local* player — non-virtualized is not an option. Set `estimateSize` to your fixed row height (rows are fixed-height: no wrapping) so measurement is O(1).
- `react-window` v2.3.3 is a viable alternative (rewritten v2, zero deps) but TanStack Virtual is easier to reason about with dynamic `paddingStart`/headers.
- Row: `[index | eq] [art 40px] [title / artist] [album] [duration] [⋮]`, 48–56px tall, `border-bottom: 1px solid rgba(255,255,255,0.06)` or a plain 8px gap — pick one, never both.
- **Overscan of 8–10 rows** above and below. Pinned header row outside the virtualizer.
- `[OPINION]` Group headers ("A", "Recently Added", "Albums") go *inside* the virtualizer as variable-size items. Pre-computing a flat index → group mapping is simpler and faster than variable measurement.

#### Mini-player → full-screen Now Playing
`[OPINION]`: one shared-element transition via Framer Motion's `layoutId` on the cover art. Persist a `nowPlayingExpanded` state; the ambient background layer and the transport controls are **the same DOM nodes** in both states, only their `flex` positions and scales change. `[OPINION]` Keep a 120 ms delay before mounting the lyrics pane so the layout settles first — otherwise the lyrics pane animates from a wrong height.

---

### B8. Cover-art colour extraction in Electron — verified packages

All four checked against npm on 2026-09-27. **All work in the Electron renderer on a data-URL image with no special config**, because the renderer *is* Chromium and a `data:` URL never taints a canvas.

| Package | Latest | Last publish | License | Deps | Types | Verdict |
|---|---|---|---|---|---|---|
| **`colorthief`** | **3.5.0** | **2026-08-02** | MIT | **0** | ✅ | **Best fit.** See below. |
| `fast-average-color` | 9.6.0 | 2026-09-11 | MIT | **0** | ✅ | Best for *speed*. 1.5k stars. |
| `node-vibrant` | 4.0.4 | 2026-01-27 | MIT | 6 | ✅ | Best-known API. Heaviest. |
| `extract-colors` | 4.2.1 | 2025-08-04 | MIT | **0** | ✅ | Fine, but 14 months stale. |

#### `[FACT]` `colorthief` v3.5.0 — the one to use.
`[FACT]` Lokesh Dhakar completely rewrote it for v3. From the README: **TypeScript**, **zero runtime dependencies**, dual ESM/CJS, works in browser **and** Node, and — critically for a music app — it now ships exactly the primitives a premium player needs:
- **`colorSpace: 'oklch'` is the default quantization space** (perceptually uniform — the "wrong" RGB average problem is fixed). Set `colorSpace: 'rgb'` to opt out.
- **Semantic swatches** via `getSwatches()`: `Vibrant`, `Muted`, `DarkVibrant`, `DarkMuted`, `LightVibrant`, `LightMuted`. This is the Vibrant swatch vocabulary, built in, at 0 deps.
- **`getColorSync` / `getPaletteSync` / `getSwatchesSync`** — synchronous, so you can call them inside a `useLayoutEffect` and paint the ambient background on the *first* frame with no flash. `getPaletteProgressive` gives a 3-pass refinement for instant rough results.
- **`region`** option — fractional `{x, y, width, height}`. `[OPINION]` Sample only the *centre* of the cover (`{x: 0.2, y: 0.2, width: 0.6, height: 0.6}`); album art borders are frequently black or white and will drag the average into uselessness.
- **`ignoreWhite: true` by default**, plus `quality` (1 = every pixel, 10 = every 10th — keep 10 for a 1000×1000 cover).
- **Ready-made contrast helpers:** `.textColor` (returns `#ffffff` or `#000000`), `.isDark`, `.contrast.white` / `.contrast.black` / `.contrast.foreground` — **WCAG ratios, already computed**. This solves the lyrics-pane contrast problem from A5 for free.
- **Display P3** via `gamut: 'display-p3' | 'auto'`; `.rgb()/.array()/.hex()` stay sRGB so existing CSS keeps working.
- **`observe(source, { throttle, onChange })`** for live re-extraction (video, canvas, or `src`-watching on an img).
- **Worker-friendly**: run inside your own Worker and transfer an `ImageBitmap` so decoding + sampling + quantization are all off the main thread. Note `Color` objects don't survive structured clone — send `.hex()` strings.
- `[FACT]` **v3 deprecated and removed the old `worker: true` option** — the README explains it only moved quantization off-thread while leaving the structured clone of the pixel array on it, which *"cost several times more than the quantization it saved"*, and it quantised in RGB so it returned *different colours* from the default path. Good signal about how much this library is being actively reasoned about.
- ⚠️ **Node path requires `sharp`** (heavy). For Electron renderer-only use you never touch it. `[FACT]` Also note there's a separate `colorthief-cli` package bundling sharp.

**Accepts:** `HTMLImageElement`, `HTMLCanvasElement`, `HTMLVideoElement`, `ImageData`, `ImageBitmap`, `OffscreenCanvas` — so it consumes the output of `createImageBitmap` directly.

#### `[FACT]` `fast-average-color` v9.6.0 — the speed play.
`[FACT]` 1.5k stars, MIT, 0 deps, TS, dual ESM/CJS. Three algorithms: `simple`, `sqrt` (**default**), `dominant`. Sources: image, URL/base64 string, video, canvas/`OffscreenCanvas`, `ImageBitmap`, `VideoFrame`, or a raw `Uint8Array`/`Uint8ClampedArray`. Regional sampling, alpha handling, web-worker support, explicit region extraction, and a documented CORS/`SecurityError` section (`crossorigin="anonymous"` — **moot for data URLs**).

#### `[FACT]` `node-vibrant` v4.0.4 — the known API, but v4 changed the import paths.
```ts
import { Vibrant } from "node-vibrant/browser";   // note: /browser subpath
Vibrant.from(dataUrl).getPalette().then(console.log);
```
`[FACT]` It has real worker support (`Vibrant.use(new WorkerPipeline(PipelineWorker))`), but the README is candid about correctness: *"due to the nature of the HTML5 canvas element, image rendering is platform/machine-dependent… Downsampling **will** cause perceptible inconsistent results across browsers due to differences in canvas implementations."* 6 runtime deps. `[OPINION]` `colorthief` supersedes it — same swatch vocabulary, 0 deps, OKLCH by default.

#### `[FACT]` The CORS caveat, in general.
Any of these libraries fails with `SecurityError: The operation is insecure` if you hand it a cross-origin image without `crossorigin="anonymous"`, because the canvas gets tainted. For a **local** player, if you build the art URL as `file://` or a `data:` URL, you are fine. If you ever add remote art, register a custom protocol (e.g. `media://`) in Electron's main process and return the bytes with a permissive CORS header — do **not** enable `webSecurity: false`.

#### `[OPINION]` Verdict
**`colorthief` 3.5.0 in the renderer, synchronous, region-cropped, cached in a `Map<trackId, Palette>`.** Add `fast-average-color` 9.6.0 later only if profiling shows the extraction janks a track change. Don't add `node-vibrant`.

---

### B9. Desktop music player UI references on GitHub

| Repo | Why it's worth studying | Notes |
|---|---|---|
| [`amll-dev/applemusic-like-lyrics`](https://github.com/amll-dev/applemusic-like-lyrics) | **The lyrics UI.** 35 versions on `@applemusic-like-lyrics/react`, published a week ago. AGPL — read, don't link. | Its `packages/core` DOM implementation is the reference for the fluid background + fill mechanics. |
| [`amll-dev/amll-ttml-db`](https://github.com/amll-dev/amll-ttml-db) | A **TTML syllable lyric database** — i.e. a real corpus of word-level lyrics in Apple's own format. Useful for testing your renderer against hard data. | Also [`amll-ttml-tool`](https://github.com/amll-dev/amll-ttml-tool) / [`amll-editor`](https://github.com/amll-dev/amll-editor) for authoring. |
| [`better-lyrics/better-lyrics`](https://github.com/better-lyrics/better-lyrics) | "Enhance YouTube Music with beautiful time-synced lyrics." Real users' preferred lyrics styling, shipped as an extension. | Best available proxy for "what Spotify users *want* the lyrics pane to look like". |
| [`aviwad/LyricFever`](https://github.com/aviwad/LyricFever) | "Best Spotify & Apple Music lyrics experience for macOS (spiritual successor to LyricsX)." | Read its macOS screenshot to calibrate the target visual. |
| [`nuclearplayer/nuclear`](https://nuclearplayer.com) | **18.3k stars**, Electron + React, 6 complete themes. | The best *architectural* reference for a React/Electron player. Look at how it themes the whole surface. |
| [`amll-dev/amll-player`](https://github.com/amll-dev/amll-player) | Tauri desktop lyrics window; documents a real frame-drop problem with in-renderer plugins. | Read the perf section before you consider a plugin architecture. |
| `feishin` | Modern React/TS self-hosted (Jellyfin) client, very well executed. | `[OPINION]` I could not verify its star count — GitHub's API was rate-limited from this environment. Worth a look, unverified. |
| MusicPlayer2, Strawberry, Museeks | C#/C++/Rust. | `[OPINION]` Only as **anti-references** for what "information-dense without hierarchy" looks like. |

**GitHub API note `[FACT]`:** `api.github.com` returned HTTP 403 for every request from this environment (rate-limited / blocked). Star counts above come from rendered GitHub pages and vendor sites; where I couldn't verify a number I say so.

---

### B10. Recommended stack

#### Baseline — already in `package.json`
`[FACT]` Electron 44.4.5, React 19.3.0, Vite 7.3.6, `electron-vite` 5.0.0, TypeScript 7.0.2, `music-metadata` 11.16.1, MIT license. This is a current, correct foundation. **No changes needed to the toolchain.**

#### Additions

| Concern | Package | Version | Why |
|---|---|---|---|
| **CSS** | `tailwindcss` + `@tailwindcss/vite` | **4.3.3** | v4 is current (CSS-first `@theme`, no `tailwind.config.js` needed). Do **not** use `tailwindcss-animate` — v1.0.7, last touched **2023-08-28**, and it's v3-only. |
| **Animation** | `tw-animate-css` | **1.4.0** | The Tailwind v4 replacement. 46 KB, 0 deps. |
| **Animation (JS)** | **`motion`** | **13.4.4** | Use `motion`, not `framer-motion` — they're the **same version and same repo** (`motiondivision/motion`) and `motion` is the current name with 2 deps vs 3. Import as `import { motion, AnimatePresence } from "motion/react"`. |
| **Colour** | **`colorthief`** | **3.5.0** | See B8. Sync API, 0 deps, OKLCH, WCAG contrast helpers. |
| **Colour maths** | `culori` | 4.0.2 | Only if you need gamut mapping / contrast maths outside `colorthief`. MIT, 0 deps. Skip `tinycolor2` (1.6.0, **2023**, no TS types) and `chroma-js` (3.2.0, CJS-only). |
| **Virtualization** | `@tanstack/react-virtual` | 3.14.13 | Headless, 1 dep. See B7. |
| **Lyrics parsing** | **`lrc-kit`** | **1.2.1** | MIT, 0 deps, line + **word**-level (enhanced LRC). See A3. |
| **Primitives** | `@radix-ui/react-slider` (1.4.7), `@radix-ui/react-scroll-area` (1.2.18), `@radix-ui/react-tooltip` (1.2.16) | | All MIT, all updated 2026-07-31. Use for slider/tooltip/scrollbar only; style everything else yourself. |
| **Utilities** | `clsx` 2.1.1 + `tailwind-merge` 3.7.0 | | `cva` 0.7.1 is stale (2024) but stable and still fine for button variants. |
| **Icons** | `lucide-react` | 1.48.0 | ISC, 0 deps, 1px stroke at 24px — matches the "premium = thin stroke" look. |
| **Fonts** | `@fontsource-variable/inter` | **5.3.0** | OFL-1.1, 1.8 MB unpacked (one file, all weights). |
| **Toasts** | `sonner` | 2.0.8 | 0 deps. |
| **Tags** | `music-metadata` | 11.16.1 | Already installed. ✅ |
| **Auto-update** | `electron-updater` | 6.8.9 | 8 deps, active (2026-09-26). |

**Explicitly do not add `[FACT]`/`[OPINION]`:**
- `tailwindcss-animate` — dead since 2023, v3-only.
- `framer-motion` — use `motion`.
- `node-vibrant` — superseded by `colorthief` at 0 deps.
- `tinycolor2` — no types, 3 years stale.
- `react-window` — fine, but TanStack Virtual fits a fixed-height music list better.
- `@electron/remote` — don't. Use preload + `contextBridge`.

#### Font choice `[OPINION]`

**UI: Inter Variable** (`@fontsource-variable/inter` 5.3.0, OFL). `[FACT]` The standard justification: tall x-height, wide weight range, tabular figures, OpenType features for interfaces, legible from caption to heading. It is the closest freely-licensed analogue to SF Pro (the face behind Apple Music), and it ships as a single variable file so you can do `font-variation-settings: "wght" 450` for that "expensive" in-between weight. Local install via Fontsource = no network fetch = works offline, which matters for a local music player.

**Lyrics: the same Inter, but deliberately different settings.** This is the detail that makes lyrics look designed rather than defaulted:
```css
.lyric-line {
  font-family: "Inter Variable", system-ui, sans-serif;
  font-weight: 700;
  font-variation-settings: "wght" 700, "opsz" 32;  /* optical size */
  letter-spacing: -0.02em;
  line-height: 1.25;
  font-feature-settings: "ss01";  /* Inter's alternate a/g, if you like it */
}
```
`[OPINION]` **Do not** use a serif for lyrics. A display serif is a strong choice for the *Now Playing track title* (it reads as editorial/artisanal and is genuinely distinctive) but it wrecks karaoke legibility at small sizes, and legibility-at-a-glance is the entire job of a lyric line.

If you do want a display face for titles, candidates verified on npm, all OFL-1.1, all Fontsource v5.3.0:
- `@fontsource/instrument-serif` (144 KB) — high-contrast, editorial. Good for album/playlist headers.
- `@fontsource-variable/figtree` (79 KB) — geometric, friendly, pairs with Inter.
- `@fontsource-variable/instrument-sans` (414 KB) — neutral grotesque with more character than Inter.
- `@fontsource-variable/bricolage-grotesque` (531 KB) — expressive; too loud for a player UI, good for splash/about screens.

**Recommendation: Inter Variable everywhere, plus Instrument Serif for album/playlist display titles only.** One UI family, one accent family, no more.

#### Animation: JS or CSS-only?
`[OPINION]` **Both, split by whether the animation is audio-driven.**

- **CSS-only** for: hover states, pane transitions, colour cross-fades, the mini-player → Now Playing layout morph, the ambient background drift. These are state changes, not continuous signals. Use `tw-animate-css` + Tailwind utilities, or `motion`'s `<motion.div>` with `initial`/`animate` when you need a spring or a shared layout.
- **JS (`motion` 13.4.4)** for exactly two things: (1) the **shared-element `layoutId` transition** on the cover art between mini-player and Now Playing — this is genuinely hard in pure CSS and `layoutId` is the reason to have the library; (2) the **momentum seek bar**, which needs per-frame value interpolation.
- **Neither — raw `requestAnimationFrame`** for the **lyric fill**. This is the important call. A 60 Hz rAF loop reading `audio.currentTime` and writing one CSS custom property (`--progress`) on **one element** is cheaper and smoother than anything either library would give you. Driving it through React state would re-render 60×/s; don't. Write the custom property imperatively from a ref.

`[FACT]` AMLL's own benchmarks — 30 FPS on mainstream CPUs for its DOM lyric component — are the cautionary tale for the "let the library animate the lyrics" approach.

#### Baseline config
```css
/* app.css — Tailwind v4 CSS-first */
@import "tailwindcss";
@import "tw-animate-css";

@theme {
  --font-sans: "Inter Variable", system-ui, sans-serif;
  --font-display: "Instrument Serif", Georgia, serif;

  --radius-chip: 4px;
  --radius-control: 8px;
  --radius-card: 12px;
  --radius-panel: 16px;

  --ease-out-soft: cubic-bezier(0.4, 0, 0.2, 1);
  --ease-panel:  cubic-bezier(0.32, 0.72, 0, 1);

  --text-2xs: 0.6875rem; --text-2xs--line-height: 1rem;
  --text-xs:  0.75rem;   --text-xs--line-height:  1rem;
  --text-sm:  0.875rem;  --text-sm--line-height:  1.25rem;
  --text-md:  1rem;      --text-md--line-height:  1.5rem;
  --text-lg:  1.25rem;   --text-lg--line-height:  1.75rem;
  --text-xl:  1.5rem;    --text-xl--line-height:  2rem;
}

:root {
  --accent: oklch(0.62 0.16 264);
  --accent-2: oklch(0.55 0.14 200);
  --accent-3: oklch(0.48 0.12 300);
  --surface: oklch(0.16 0.01 264);
  --lyric-size: clamp(1rem, 1.6vw + 0.6rem, 1.375rem);
  color-scheme: dark;
}
```

---

## Appendix — Code

### 1. Lyric timing: `useLyricSync` (word-level, with a synthetic fallback)

```ts
// src/renderer/lib/useLyricSync.ts
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Lrc, Runner, type Lyric } from "lrc-kit";

export type Line = {
  index: number;
  startTime: number;  // seconds
  endTime: number;    // seconds
  text: string;       // clean, no timestamp tags
  /** null when the source is line-level only. */
  words: { startTime: number; endTime: number; text: string }[] | null;
  /** 0..1 — the sung fraction of the whole line, for the clip layer. */
  progress: number;
  /** 0..1 — the sung fraction within the current word. */
  wordProgress: number;
};

export type ParsedLyrics = { lines: Line[]; hasWordTiming: boolean } | null;

const LRC_TIME_RE = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

/**
 * Fallback word distribution: split the line's duration across its words
 * weighted by character count. This is a *lie* about timing, and that's fine —
 * it's what Musixmatch/Apple do with crowd-sourced data too, and it keeps the
 * animation present instead of absent. Mark the UI as estimated.
 */
function estimateWords(text: string, startTime: number, endTime: number) {
  const tokens = text.match(/\S+\s*/g);
  if (!tokens || tokens.length === 0) return null;
  const totalChars = tokens.reduce((n, t) => n + t.trim().length, 0) || 1;
  const span = endTime - startTime;
  let t = startTime;
  return tokens.map((raw) => {
    const dur = (raw.trim().length / totalChars) * span;
    const w = { startTime: t, endTime: t + dur, text: raw };
    t += dur;
    return w;
  });
}

export function parseLyrics(raw: string): ParsedLyrics {
  if (!raw?.trim()) return null;

  // Try enhanced (A2 / foobar2000 per-word tags) first; fall back to plain LRC.
  let lrc: Lyric;
  let hasWordTiming = false;
  try {
    lrc = Lrc.parse(raw, { enhanced: true });
    hasWordTiming = lrc.lyrics.some((l) => (l.wordTimestamps?.length ?? 0) > 0);
  } catch {
    lrc = Lrc.parse(raw);
  }
  if (lrc.lyrics.length === 0) return null;

  const out: Line[] = [];
  let previous: Line | null = null;

  // Consecutive lines sharing a timestamp are a simultaneous-duet/background
  // vocal group. Flatten them rather than dropping them.
  for (const [i, l] of lrc.lyrics.entries()) {
    const startTime = l.timestamp;
    const endTime =
      l.wordTimestamps?.length > 1
        ? l.wordTimestamps[l.wordTimestamps.length - 1].timestamp
        : (lrc.lyrics[i + 1]?.timestamp ?? startTime + 4);

    const words =
      l.wordTimestamps && l.wordTimestamps.length > 0
        ? l.wordTimestamps.map((w, j, arr) => ({
            startTime: w.timestamp,
            endTime: arr[j + 1]?.timestamp ?? endTime,
            text: w.content,
          }))
        : estimateWords(l.content, startTime, endTime);

    const line: Line = {
      index: out.length,
      startTime,
      endTime: Math.max(endTime, startTime + 0.2),
      text: l.content,
      words,
      progress: 0,
      wordProgress: 0,
    };
    out.push(line);
    previous = line;
  }
  void previous;

  return { lines: out, hasWordTiming };
}

/**
 * One rAF loop, one DOM write per frame. Never put this in React state.
 *
 * `getState()` returns the current playback position in seconds — wire it to
 * `<audio>.currentTime` or, in Electron, to the main process's audio clock
 * (which is more accurate than an <audio> element's own clock for gapless).
 */
export function useLyricSync(
  parsed: ParsedLyrics,
  getTime: () => number,
  onIndexChange?: (index: number) => void
) {
  const [activeIndex, setActiveIndex] = useState(-1);
  const activeIndexRef = useRef(-1);

  useEffect(() => {
    if (!parsed || parsed.lines.length === 0) {
      setActiveIndex(-1);
      activeIndexRef.current = -1;
      return;
    }

    // Binary search for the active line. Lines are sorted by startTime.
    const findIndex = (t: number) => {
      const { lines } = parsed;
      let lo = 0;
      let hi = lines.length - 1;
      let found = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (lines[mid].startTime <= t) {
          found = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      return found;
    };

    let raf = 0;
    const tick = () => {
      const t = getTime();
      const idx = findIndex(t);

      if (idx !== activeIndexRef.current) {
        activeIndexRef.current = idx;
        setActiveIndex(idx);
        onIndexChange?.(idx);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [parsed, getTime, onIndexChange]);

  const activeLine: Line | undefined = parsed?.lines[activeIndex];

  /** Per-word [0,1] progress, written imperatively to the DOM. */
  const applyProgress = useCallback(() => {
    const root = progressRootRef.current;
    if (!root || !activeLine) return;
    const t = getTime();

    // Whole-line progress drives the base text layer's opacity ramp.
    const span = Math.max(activeLine.endTime - activeLine.startTime, 0.001);
    root.style.setProperty("--line-progress", String(clamp01((t - activeLine.startTime) / span)));

    if (!activeLine.words) return;

    // Each word span carries --w-start / --w-end (seconds) and gets its own
    // --w-progress. One style write per word, ~5-10 per line. Cheap.
    const spans = wordSpansRef.current;
    if (!spans) return;
    for (let i = 0; i < spans.length; i++) {
      const el = spans[i];
      if (!el) continue;
      const w = activeLine.words[i];
      if (!w) continue;
      const d = Math.max(w.endTime - w.startTime, 0.001);
      el.style.setProperty("--w-progress", String(clamp01((t - w.startTime) / d)));
    }
  }, [activeLine, getTime]);

  return { activeIndex, activeLine, progressRootRef, wordSpansRef, applyProgress };
}

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);
export { LRC_TIME_RE };
```

### 2. The karaoke line component (the visual payload)

```tsx
// src/renderer/components/LyricLine.tsx
import { memo } from "react";
import type { Line } from "../lib/useLyricSync";

type Props = {
  line: Line;
  isActive: boolean;
  /** "active" | "sung" | "next" | "inactive" */
  state: "active" | "sung" | "next" | "inactive";
  hasWordTiming: boolean;
  estimated: boolean;
  onSeek: (line: Line) => void;
  registerWordSpan?: (i: number, el: HTMLSpanElement | null) => void;
};

export const LyricLine = memo(function LyricLine({
  line, state, hasWordTiming, onSeek, registerWordSpan, registerRoot,
}: Props) {
  const isActive = state === "active";

  if (line.text.trim() === "") return <div className="h-6" aria-hidden />;

  return (
    <button
      type="button"
      onClick={() => onSeek(line)}
      aria-current={isActive ? "true" : undefined}
      data-state={state}
      data-has-words={hasWordTiming ? "" : undefined}
      className="lyric-line group block w-full text-left"
    >
      <span className="lyric-line__bg" aria-hidden>
        {line.words?.map((w, i) => (
          <span
            key={i}
            className="karaoke"
            ref={(el) => registerWordSpan?.(i, el)}
          >
            {w.text}
          </span>
        )) ?? line.text}
      </span>

      {/* The real, always-legible text. The layer above is decorative. */}
      <span className="sr-only">{line.text}</span>

      {isActive && (
        <span className="lyric-line__ts tabular-nums opacity-0 transition-opacity duration-100 group-hover:opacity-60 group-focus-visible:opacity-60">
          {fmt(line.startTime)}
        </span>
      )}
    </button>
  );
});

const fmt = (s: number) => {
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, "0")}`;
};
```

Screen-reader announcement goes in the **pane**, not the line — one live region for the whole scroller, debounced:

```tsx
// src/renderer/components/LyricsPane.tsx
const liveRef = useRef<HTMLParagraphElement>(null);

useEffect(() => {
  if (!activeLine) return;
  const t = setTimeout(() => {
    if (liveRef.current) liveRef.current.textContent = activeLine.text;
  }, 500); // debounce: don't announce during a fast scrub
  return () => clearTimeout(t);
}, [activeLine?.index]);

return (
  <>
    {/* aria-live on the scroller itself would fire per-word. This is the only
        live region, and it carries line text only. */}
    <p ref={liveRef} className="sr-only" role="status" aria-live="polite" aria-atomic="true" />
    <div ref={paneRef} className="lyric-pane">
      {/* …lines… */}
    </div>
  </>
);
```

### 3. The CSS — this is the whole visual trick

```css
/* src/renderer/styles/lyrics.css */

.lyric-line {
  /* Position context for the per-word absolute positioning below. */
  position: relative;
  display: block;
  width: 100%;

  padding: 0.5rem 0.75rem;      /* 44px+ tap target via min-height below */
  min-height: 44px;             /* WCAG 2.2 §2.5.8 */
  text-align: left;

  font-family: "Inter Variable", system-ui, sans-serif;
  font-variation-settings: "wght" 600, "opsz" 32;
  font-size: var(--lyric-size);
  line-height: 1.25;
  letter-spacing: -0.02em;

  color: transparent;           /* see .lyric-line__bg */
  transition:
    font-size 250ms var(--ease-out-soft),
    opacity   250ms var(--ease-out-soft),
    filter    250ms var(--ease-out-soft);
  will-change: font-size, opacity, filter;
}

/* ── State ramp ─────────────────────────────────────────────── */

/* Inactive: dimmed + very slightly blurred. 0.5px is the ceiling; more
   reads as broken. The 0.45 opacity floor keeps contrast passable. */
.lyric-line[data-state="inactive"] {
  font-size: var(--lyric-size);
  opacity: 0.45;
  filter: blur(0.5px);
}

/* Already sung: full opacity, base size. */
.lyric-line[data-state="sung"] {
  font-size: var(--lyric-size);
  opacity: 0.55;
}

/* Up next: a touch brighter than the rest of the past/future. */
.lyric-line[data-state="next"] {
  font-size: var(--lyric-size);
  opacity: 0.55;
}

/* The hero. ×1.375 size ramp, constant weight (no bolding → no reflow). */
.lyric-line[data-state="active"] {
  font-size: calc(var(--lyric-size) * 1.375);
  font-variation-settings: "wght" 700, "opsz" 40;
  opacity: 1;
  filter: none;
}

.lyric-line:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: var(--radius-control);
}

/* ── The two layers ──────────────────────────────────────────── */

.lyric-line__bg {
  position: absolute;
  inset: 0.5rem 0.75rem;
  pointer-events: none;
}

/* Line-level only (or estimated): the whole line sweeps. */
.lyric-line:not([data-has-words]) .lyric-line__bg {
  display: inline;
  background-image: linear-gradient(to right, var(--lyric-sung) 100%);
  background-color: var(--lyric-unsung);
  background-repeat: no-repeat;
  background-position: left top;
  background-size: calc(var(--line-progress, 0) * 100%) 100%;
  background-clip: text;
  -webkit-background-clip: text;
  color: transparent;
}

/* THE load-bearing declaration: `display: inline` makes
   background-clip: text wrap the gradient across line boxes, so a multi-line
   lyric gets one continuous sweep with zero per-word layout.
   Source: https://jespervos.com/craft/karaoke-text */
.karaoke {
  display: inline;
  background-image: linear-gradient(
    to right,
    var(--lyric-sung) 0%,
    var(--lyric-sung) 82%,        /* feathered leading edge */
    var(--lyric-unsung) 100%
  );
  background-color: var(--lyric-unsung);
  background-repeat: no-repeat;
  background-position: left top;

  /* Overshoot so the feather is fully covered at progress = 1. */
  --overshoot: 1.22;
  background-size: calc(var(--w-progress, 0) * var(--overshoot) * 100%) 100%;

  background-clip: text;
  -webkit-background-clip: text;
  color: transparent;
  transition: none; /* driven imperatively by rAF, never a CSS transition */
}

/* Inactive/next lines: static, no fill, just a flat dim colour. */
.lyric-line[data-state="inactive"] .karaoke,
.lyric-line[data-state="next"] .karaoke,
.lyric-line[data-state="sung"] .karaoke {
  background-image: none;
  background-size: 100% 100%;
  opacity: inherit;
}

/* ── Timestamps ─────────────────────────────────────────────── */
.lyric-line__ts {
  position: absolute;
  right: 0.75rem;
  top: 50%;
  translate: 0 -50%;
  font-size: 0.6875rem;
  font-variant-numeric: tabular-nums;
  color: var(--lyric-unsung);
  pointer-events: none;
}

/* ── Tokens ─────────────────────────────────────────────────── */
.lyric-sung   { color: #ffffff; }   /* single accent; never per-word hues */
.lyric-unsung { color: color-mix(in oklab, #ffffff 38%, transparent); }

/* ── Accessibility ──────────────────────────────────────────── */
.sr-only {
  position: absolute;
  width: 1px; height: 1px;
  padding: 0; margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border-width: 0;
}

@media (prefers-reduced-motion: reduce) {
  .lyric-line {
    transition: opacity 120ms linear;
    filter: none !important;
    will-change: opacity;
  }
  .karaoke { transition: none; }
}
```

### 4. The rAF driver — one write per frame, no React re-render

```ts
// src/renderer/components/LyricsPane.tsx (excerpt)
useEffect(() => {
  let raf = 0;
  const loop = () => {
    applyProgress();          // writes --line-progress + per-word --w-progress
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
  return () => cancelAnimationFrame(raf);
}, [applyProgress]);

// Auto-scroll, keyed on line-index change only — never per frame.
useEffect(() => {
  if (!autoScroll) return;
  const el = paneRef.current?.querySelector<HTMLElement>(
    `[data-line-index="${activeIndex}"]`
  );
  if (!el) return;
  // Park the active line at ~38% viewport height, not centred. Centring
  // wastes the top half and hides what's coming next.
  const target = el.offsetTop - paneRef.current!.clientHeight * 0.38;
  paneRef.current!.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
}, [activeIndex, autoScroll]);

// Manual scroll pauses auto-scroll, then resumes.
const resumeTimer = useRef<ReturnType<typeof setTimeout>>();
const pauseAutoScroll = useCallback(() => {
  setAutoScroll(false);
  clearTimeout(resumeTimer.current);
  resumeTimer.current = setTimeout(() => setAutoScroll(true), 5000);
}, []);
// Attach to wheel + touchmove + pointerdown + relevant keys, NOT just `wheel`.
```

### 5. Colour extraction → ambient theme

```ts
// src/renderer/lib/palette.ts
import { getPaletteSync, getSwatchesSync, type Color } from "colorthief";

export type Palette = {
  accent: string; accent2: string; accent3: string;
  /** WCAG-correct foreground for text on the ambient background. */
  foreground: string;
  isDark: boolean;
};

const cache = new Map<string, Palette>();

/** Clamp a colour into a usable ambient range. Album art is routinely
 *  near-white or near-black; an unclamped average makes an unusable UI. */
function clampAmbient(c: Color, targetL: number): string {
  const { l, c: chroma, h } = c.oklch();
  return `oklch(${targetL.toFixed(3)} ${Math.min(Math.max(chroma, 0.02), 0.14).toFixed(3)} ${h.toFixed(1)})`;
}

export function extractPalette(img: HTMLImageElement, key?: string): Palette | null {
  if (key) {
    const hit = cache.get(key);
    if (hit) return hit;
  }

  // Centre-crop: album-art borders are usually black or white and drag the
  // average into uselessness. `region` is fractional, so it works on the
  // thumbnail and the full-size original identically.
  const region = { x: 0.2, y: 0.2, width: 0.6, height: 0.6 };

  let swatches: Record<string, Color | undefined>;
  try {
    swatches = getSwatchesSync(img, { region, quality: 10, colorCount: 6 });
  } catch {
    return null; // tainted canvas — shouldn't happen with data:/file: URLs
  }

  // Vibrant → Muted → DarkVibrant → dominant. Ordered fallbacks matter:
  // plenty of covers are monochrome and have no Vibrant swatch.
  const pick =
    swatches.Vibrant ?? swatches.Muted ?? swatches.DarkVibrant ??
    swatches.LightVibrant ?? getPaletteSync(img, { region, colorCount: 3 })[0];
  if (!pick) return null;

  const palette: Palette = {
    accent:  clampAmbient(pick, 0.62),
    accent2: clampAmbient(swatches.DarkVibrant ?? pick, 0.55),
    accent3: clampAmbient(swatches.LightVibrant ?? pick, 0.48),
    // .textColor / .contrast.foreground are computed by the library — free
    // WCAG-correct foreground, which is exactly what the lyrics pane needs.
    foreground: pick.contrast.foreground === pick.contrast.black ? "#000" : "#fff",
    isDark: pick.isDark,
  };

  if (key) cache.set(key, palette);
  return palette;
}

/** Load a cover into an HTMLImageElement. data: and file: URLs never taint
 *  the canvas, so no crossorigin attribute is needed. For remote art, register
 *  a custom `media://` protocol in main — do NOT set webSecurity: false. */
export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (/^https?:/i.test(src)) img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/** Off the main thread, if profiling ever demands it. Color objects don't
 *  survive structured clone — send hex strings. */
export async function extractInWorker(blob: Blob): Promise<Palette | null> {
  const bitmap = await createImageBitmap(blob); // transferable
  const worker = new Worker(new URL("./palette.worker.ts", import.meta.url), {
    type: "module",
  });
  return new Promise((resolve) => {
    worker.onmessage = (e) => { worker.terminate(); resolve(e.data); };
    worker.postMessage({ bitmap }, [bitmap]);
  });
}
```

```css
/* Ambient background: three-stop radial mesh over near-black.
   Apple's iOS 26 "fluid" background is this idea, animated. */
.ambient {
  position: fixed;
  inset: 0;
  z-index: -1;
  pointer-events: none;
  background-color: var(--surface);
  background-image:
    radial-gradient(60% 55% at 18% 12%, var(--accent)  0%, transparent 65%),
    radial-gradient(55% 50% at 82% 78%, var(--accent2) 0%, transparent 62%),
    radial-gradient(45% 45% at 55% 50%, var(--accent3) 0%, transparent 60%);
  opacity: 0.9;
  /* 700ms cross-fade between tracks. Don't cut — the transition is what
     makes it feel like one continuous environment. */
  transition: background-image 700ms var(--ease-out-soft);
}

/* Scrim behind the text column only, so lyrics always clear contrast. */
.lyric-pane__scrim {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: linear-gradient(
    to bottom,
    rgb(0 0 0 / 0.55),
    rgb(0 0 0 / 0.70) 40%,
    rgb(0 0 0 / 0.78)
  );
}

.frosted {
  backdrop-filter: blur(60px) saturate(180%) brightness(0.9);
  background: color-mix(in oklab, var(--accent) 8%, transparent);
}

@supports not (backdrop-filter: blur(1px)) {
  .frosted { background: rgb(18 18 20 / 0.86); }
}
```

---

## The five decisions that matter most

1. **`lrc-kit` 1.2.1 (MIT) for parsing** — it's the only mature, permissively-licensed package that does real word-level (enhanced LRC) timing, at zero dependencies. `react-lyrics`, `lyric-parser`, and `lyrics.js` are all abandoned; `@karaoke/lyrics` and `better-lyrics` don't exist on npm; `ammolite` is a CSS-in-JS library.
2. **Skip AGPL.** `@applemusic-like-lyrics` is the best-looking implementation that exists and was updated last week — but it's AGPL-3.0-only (Titan Player is MIT) and it needs six PixiJS peer deps to run at 30 FPS on a five-year-old CPU. Read it; reimplement the effect.
3. **The word fill is `display: inline` + `background-clip: text` + a `background-size` percentage**, driven by a rAF writing one CSS custom property. Not React state, not a per-word colour swap, not a CSS transition. Source: https://jespervos.com/craft/karaoke-text
4. **Design for line-level as the guarantee.** Local FLAC gives you LRC in a VorbisComment, full stop; MP3's word-level `SYLT` frame is real but essentially never written. Use LRCLib for on-demand fetch, and a character-weighted synthetic distribution so the animation is never absent.
5. **`colorthief` 3.5.0** — 0 deps, TypeScript, OKLCH by default, Vibrant-style semantic swatches, **synchronous** (paint the ambient background on frame 1, no flash), and pre-computed WCAG contrast ratios. It beats `node-vibrant` (6 deps, non-deterministic across canvas implementations) and `fast-average-color` (faster, but no swatches).
