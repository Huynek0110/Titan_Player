# Spicetify references — what was taken, and why

Three Spotify modifications, read in full before any of it was used. They are
recorded here because the reasoning behind the lyrics rewrite is not obvious from
the diff, and because two of the three are copyleft, which is why this project is
AGPL rather than MIT.

| Project | Licence | What was taken |
| --- | --- | --- |
| [Wave Player](https://github.com/03x1/Wave-Player) | MIT | The lyrics presentation. |
| [Liquify](https://github.com/NMWplays/Liquify) | AGPL-3.0 | The Liquid Glass surface. |
| [spicetify-glassify](https://github.com/sanoojes/spicetify-glassify) | AGPL-3.0 | The glass layering and rim treatment. |

## Wave Player

A 133 KB single file, mostly generated markup and CSS. MIT, so adaptable with
attribution, and the reason this project is AGPL is *not* this one.

The README sells three things: a three-mode floating player, Liquid Glass, and
synced lyrics. The lyrics are the part that mattered, because the bug being fixed
had already survived three attempts here.

### What the lyrics get right

**One font size for every line.** This is the whole answer to "the lines still
look separated". The current line and the two upcoming ones are all the same
`font-size`; the hierarchy is carried entirely by `transform: scale()`,
`filter: blur()`, colour and a `text-shadow` glow.

Everything this project got wrong before is downstream of breaking that rule:

- Giving each state its own `font-size` makes the current line's box change height
  on every lyric change, so the lines below reflow and the current line jumps.
- Worse, a larger font wraps differently from a smaller one. An upcoming line that
  fitted on one row becomes a two-row current line, and the block's rhythm breaks
  on exactly the long lines. That is the complaint verbatim, and it explains why
  it was reported as happening on *some* lines and not others — it is a function of
  line length.
- Pinning each slot to a fixed height to stop the reflow, which was the third
  attempt, made it worse: a one-line lyric floated inside a two-line box.

A `transform` touches no layout. Wrapping is therefore identical in all three
states and promotion cannot reflow anything. The scales are `1 / 0.74 / 0.6`,
chosen so a 35px base renders as the same 35 / 26 / 21 the old ladder produced —
the hierarchy is as strong as it was, and costs nothing.

**The glow is what marks the line, not the size.** Three layers:

```
0 0 12px rgba(255,255,255,.28)
0 0 44px rgba(255,255,255,.20)
0 0 88px var(--accent-glow)
```

This is the part that was missing entirely, and it is why the earlier attempt felt
weak. Marking a line by making it *bigger* fights the layout. Marking it by
making it *lit* does not touch layout at all, so it can be as strong as it likes.

**An overshoot curve on the transform only.** `cubic-bezier(.34, 1.3, .4, 1)` for
`transform`, a plain ease-out for `color` and `filter`. The asymmetry is
deliberate: the scale change is what the eye tracks and earns the pop, while the
focus change should settle without one. One spring on all three made the text
wobble, which is worse than no motion at all.

**`will-change` on the active line only.** With a comment explaining why: it used
to be on every line, which gave a long song a hundred permanently-promoted
compositor layers and cost more memory than it saved frames.

**No outgoing-line animation, at all.** This is the opposite of what was built
here first, and it is strictly better. Every line is keyed on its timestamp and
stays mounted, so the line that *was* current is the same DOM node now carrying
the next state. The transition is a class change on a node that already exists.
There is no outgoing line, so there is nothing to fade out, so a timer, a ref, an
effect and a duplicated DOM node all disappear.

### The karaoke sweep, and its trap

Where the source has word timings each word is an inline box with a gradient
clipped to its text, and the gradient's stop position is written from the audio
clock.

The non-obvious part is recorded as a comment in the original and is easy to
rediscover the hard way: **transparent glyphs let the text-shadow behind them show
through**, so the tight white layers of the active line's glow bleed between the
letters and smear. The karaoke rules therefore drop those layers and keep only
the wide accent halo, which sits far enough out not to reach the glyphs.

Enhanced LRC is the only local format with word timings. Almost nothing writes
it — FLAC stores LRC in a Vorbis comment, which is line-level, and the MP3 `SYLT`
frame that is genuinely word-level is written by almost no encoder. So the sweep
is a bonus for the files that happen to have it, and the line-level display has to
stand on its own for everything else. `src/shared/lyrics.ts` already parsed
Enhanced LRC; the words were parsed and then never read.

## Liquify

AGPL-3.0, and the reason for the licence change. Its `user.css` and `theme.js`
implement what the file itself calls a port of
[react-bits' `GlassSurface`](https://github.com/DavidHDev/react-bits).

### What Liquid Glass actually is

Not transparency. `backdrop-filter: blur()` on its own makes a surface look like
frosted plastic. What makes it look like glass is that the pixels behind it are
**displaced**, and displaced more the further from the centre you look — so the
surface bends what is behind it hardest along its rim, the way a lens does.

Three parts:

1. **A displacement map**, generated as an SVG image sized exactly to the element.
   `feDisplacementMap` reads two channels of it as a 2D vector and shifts the
   backdrop along that vector. Red ramps horizontally, blue ramps vertically, the
   two screen-blended so a corner displaces diagonally while the middle of each
   edge displaces on one axis. Where the map is black there is no vector and the
   backdrop is untouched.
2. **An inset**, a blurred mid-grey rounded rect covering the middle of the map.
   This is the part that separates glass from a wobble. Grey is 50% in all three
   channels and the map's neutral is black, so it does not merely weaken the
   displacement — it *replaces* it, which is what holds the centre genuinely flat
   rather than merely low-distortion. Its own blur makes the hand-off a gradient
   rather than a visible edge.
3. **Applied through `backdrop-filter`**, so the filter refracts the backdrop
   rather than the element's own content.

The map has to be regenerated whenever the element resizes, which is why it is
generated as a data URL and cached on a per-size basis rather than written once.

Two details that are easy to get wrong:

- The filter region. The SVG default is `-10% / 120%` of the bounding box, which
  is both larger than needed and **offset** — the displacement samples from the
  wrong place and the rim comes out shifted. It has to be pinned to `0 / 100%`.
- The radius. The map is drawn in the SVG's own coordinate space, which knows
  nothing about CSS, so the panel's `border-radius` has to be carried across by
  hand. Without it a rounded panel gets a rectangular flat patch through it, which
  is immediately visible as a mistake.

### The motion-policy conflict, on purpose

`global.css` forbids `filter` on anything larger than a thumbnail, because a
transition on it rasterises every frame. Two things now break that rule
deliberately:

- the artwork thumbnail's one-shot `blur(7px) → none` cross-fade
- the lyric depth ramp, on 19–35px text, once every few seconds

Both are caption-sized, once, and not in a loop. The exception is written into
the policy rather than left for the next reader to find and "fix".

## spicetify-glassify

Also AGPL-3.0, so also a reason for the licence change. Read for the layering
rather than for a mechanism: how a glass panel separates from what is behind it.
The border highlights, the shadow depth, and the restraint in how much of the
material is applied to how many surfaces — which is the lesson that the most
conspicuous version of this effect is the one that stops working, because glass
that is on everything is glass that means nothing.

That restraint is why the refraction is on the player bar alone. It is the one
surface that sits over scrolling content, so it is the only one where there is
anything behind it to refract. Four simultaneous full-height glass panels used to
re-blur every frame of a window resize, which is what made maximising stutter.
