# Third-party notices

Titan Player is licensed under the **GNU Affero General Public License v3.0 or
later** — see [LICENSE](LICENSE). It was MIT until the Liquid Glass and lyrics
work below was brought in, because both of those projects are copyleft.

## Wave Player

<https://github.com/03x1/Wave-Player> — MIT, © 2026 Ekko

The lyrics presentation was adapted from this project: the scale-and-blur
hierarchy, the lit-glow `text-shadow` on the active line, the overshoot spring on
the line-change transition, the `will-change`-only-on-the-active-line rule, and
the word-level fill sweep.

What was taken is design and approach rather than a block of code, and it was
rewritten for React and for this app's types. The parts that are genuinely a
mechanism rather than a taste — the karaoke fill's `background-clip: text` sweep
and its handling of transparent glyphs — follow the same approach the original
uses.

## Liquify

<https://github.com/NMWplays/Liquify> — AGPL-3.0

The Liquid Glass surface. This is the reason for the licence change: the
displacement-map refraction used by `src/renderer/src/lib/glass.ts` is derived
from this project's `user.css` and `theme.js`, which implement a port of
[react-bits' `GlassSurface`](https://github.com/DavidHDev/react-bits). The
technique is:

1. Build a gradient map sized to the element — red ramping horizontally, blue
   vertically, the two screen-blended.
2. Inset a blurred rounded rect in the middle of that map so the centre stays
   clear and only the edge band displaces.
3. Feed the map to `feDisplacementMap` as `in2` and apply the whole filter through
   `backdrop-filter`.

The map has to be regenerated whenever the element resizes, which is why the
glass hook observes its own element rather than reading a size once.

## spicetify-glassify

<https://github.com/sanoojes/spicetify-glassify> — AGPL-3.0

Read for the glass surface treatment — the layering, the border highlights and
the way a glass panel separates from what is behind it. Also AGPL, and also a
reason for the licence change.

## LRCLib

<https://lrclib.net> — used for online lyrics lookup, at no cost and with no API
key. Requests are made from the main process and are off by default.
