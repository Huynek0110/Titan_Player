import { useCallback, useEffect, useRef } from "react"

/**
 * Liquid Glass.
 *
 * The effect is refraction, not transparency. A plain `backdrop-filter: blur()`
 * makes a surface look like frosted plastic; what makes it look like *glass* is
 * that the pixels behind it are displaced, and displaced more the further from
 * the centre you look — so the surface bends what is behind it hardest along its
 * rim, the way a real lens does.
 *
 * Three moving parts:
 *
 *  1. A displacement map, generated as an SVG image sized exactly to the element.
 *     Red ramps horizontally and blue ramps vertically; `feDisplacementMap` reads
 *     those two channels as a 2D vector and shifts the backdrop along it. Where
 *     the map is black, there is no vector and the backdrop is untouched.
 *  2. A blurred rounded rect inset into the middle of that map, at a brightness
 *     that wins the screen blend. This is the part that makes the difference
 *     between glass and a wobble: it holds the centre flat and leaves only an
 *     edge band to refract. Without it the whole panel swims.
 *  3. The two screen-blended, so a pixel displaces diagonally and the rim picks
 *     up colour from both gradients.
 *
 * The map has to be regenerated whenever the element resizes, which is why this
 * is a hook that observes its own element rather than a constant. Generating a
 * data URL is not free and the filter is re-parsed on every change, so the
 * observer only regenerates when the size actually differs.
 *
 * One filter is shared by every glass surface on screen, keyed on a per-size
 * basis by a counter. Filters are referenced by id from CSS, so two panels of the
 * same size can share one, and two of different sizes cannot — the map is
 * generated for specific pixel dimensions and is meaningless at any other size.
 *
 * Reduced motion does not apply here: nothing about this animates on its own. It
 * is a static refraction that responds to what is behind it, and that is the
 * entire point of the material.
 */

export interface GlassOptions {
  /**
   * How hard the rim bends what is behind it, in pixels of displacement at full
   * deflection. Roughly the blur radius of the rim itself; much above 60 and the
   * edge stops reading as glass and starts reading as a funhouse mirror.
   */
  displacement?: number
  /**
   * The rest of the filter chain, written after the refraction.
   *
   * The hook sets `backdrop-filter` on the element, which *replaces* whatever a
   * stylesheet declared there rather than adding to it. The first version took a
   * `blur` number and rebuilt the whole chain, and the queue drawer — which
   * declared `blur(28px) saturate(1.6)` in CSS — silently lost its saturation the
   * moment the hook ran. So the trailing part is passed through verbatim instead,
   * and a surface can keep whatever treatment its stylesheet already had.
   */
  extra?: string
  /** Fraction of the shortest side that stays flat, 0 to 0.5. */
  flat?: number
  /**
   * Split the displacement per colour channel.
   *
   * On, and on by default, because it is the difference between a pane that has
   * been warped and a lens. See the three `feDisplacementMap`s in `attach`.
   */
  chromatic?: boolean
  /** Extra displacement on each channel, in pixels, on top of `displacement`. */
  aberration?: [number, number, number]
}

/**
 * The reference implementation's defaults, in full.
 *
 * Taken from `DEFAULTS` in Liquify's `theme.js` rather than invented, because
 * they were arrived at there and they are the numbers the look was tuned against.
 * Two of them are the opposite of what instinct suggests, and both matter:
 *
 *   `displacementScale: -80` — *negative*. The sign is the direction the rim
 *   bends, and a negative scale pulls the edge inward, which magnifies what is
 *   behind the panel at its border. That is what a thick lens does. Positive
 *   pushes outward and reads as a thin flexible film.
 *
 *   `borderWidth: 0.07` — the flat centre is only 7% of the shortest side, so
 *   most of the panel is *not* flat. This app first used 0.32, which left a large
 *   undistorted middle and made the effect read as a frame rather than as glass.
 */
export const GLASS_DEFAULTS = {
  borderRadius: 20,
  flat: 0.07,
  /** 50% grey, which in a 0-to-1 map is exactly "no vector". */
  brightness: 50,
  /** Softening blur, as a fraction of a pixel. */
  displace: 0.2,
  distortionScale: -80,
  chromaticAberration: true,
  redOffset: 0,
  greenOffset: 6,
  blueOffset: 10,
  mixBlendMode: "screen",
} as const

/** Registry of live filters, so a resize can find the one that needs rebuilding. */
let serial = 0

/** Id of the shared, zero-sized SVG that every glass filter is appended to. */
const GLASS_DEFS_ID = "titan-glass-defs"

/**
 * How many frames a mount will re-measure before giving up on a zero-sized box.
 *
 * Small on purpose. The point is to survive an element that has not been laid out
 * yet, not to keep trying forever on one that legitimately has no size — which is
 * what a genuinely absent surface looks like, and retrying that forever is a
 * per-frame cost for nothing.
 */
const MAX_MEASUREMENT_RETRIES = 8

/**
 * Apply Liquid Glass to an element.
 *
 * Returns a **callback ref**, not an object ref, and that is load-bearing.
 *
 * The queue drawer is the reason. `QueuePanel` returns `null` until the user
 * opens it, so on the component's first commit there is no element to attach
 * anything to. The first version of this hook read `ref.current` inside a
 * `useEffect` and returned early when it was null — and because the effect's
 * dependencies are three primitives that never change, it never ran again. The
 * drawer's hook had run exactly once, against nothing, and then never again.
 *
 * The surface was on screen, correctly sized at 340x752, with a plain `blur()`
 * and no refraction, and nothing in the code, the DOM, or the computed style said
 * why. `scripts/probe-glass-surfaces.mjs` is what found it, and it is worth
 * knowing that a glass surface which has silently degraded looks almost exactly
 * like one whose refraction is too weak to see.
 *
 * A callback ref runs when the node arrives, whenever that is, and React calls it
 * with `null` when the node goes away — so the teardown is wired to the same
 * lifecycle as the setup and cannot drift out of sync with it.
 *
 * The glass is a `backdrop-filter`, so it needs something behind it to refract.
 * An element whose own background is opaque hides the effect entirely, which looks
 * like the glass silently failing.
 */
export function useGlassSurface<T extends HTMLElement>(options: GlassOptions = {}) {
  const {
    displacement = GLASS_DEFAULTS.distortionScale,
    extra = "blur(2px)",
    flat = GLASS_DEFAULTS.flat,
    chromatic = GLASS_DEFAULTS.chromaticAberration,
    aberration = [GLASS_DEFAULTS.redOffset, GLASS_DEFAULTS.greenOffset, GLASS_DEFAULTS.blueOffset],
  } = options

  /*
   * Kept in a ref so the callback returned below is stable. If it were rebuilt on
   * every render React would call it with null and then the node again, tearing
   * down and recreating the filter — and re-parsing an SVG filter per render is
   * the opposite of cheap.
   */
  const optionsRef = useRef({ displacement, extra, flat, chromatic, aberration })
  optionsRef.current = { displacement, extra, flat, chromatic, aberration }

  const teardown = useRef<(() => void) | null>(null)

  const ref = useCallback(
    (el: T | null) => {
      // Called with null on unmount, or with a different node if the element was
      // replaced. Either way the previous surface has to be released first.
      teardown.current?.()
      teardown.current = null
      if (!el) return

      teardown.current = attach(el, optionsRef.current)
    },
    [],
  )

  // Release on unmount. A callback ref is called with null when the node is
  // detached, but a component that unmounts without ever having rendered the node
  // never gets that call, and the defs element would be left behind.
  useEffect(() => () => teardown.current?.(), [])

  return ref
}

/** Everything a mounted surface needs, so it can be released in one call. */
interface Teardown {
  (): void
}

function attach(el: HTMLElement, o: Required<GlassOptions>): Teardown {
  const { displacement, extra, flat, chromatic, aberration } = o
  const [redOffset, greenOffset, blueOffset] = aberration

  {
    // `<filter>` has to live in the document, and `url(#id)` in a
    // `backdrop-filter` resolves against the document — an SVG filter inside a
    // detached or display:none tree is not found. One shared defs element, so
    // mounting a second surface does not add a second one to the head.
    const NS = "http://www.w3.org/2000/svg"
    const existing = document.getElementById(GLASS_DEFS_ID)
    const defs: SVGSVGElement =
      existing instanceof SVGSVGElement
        ? existing
        : Object.assign(document.createElementNS(NS, "svg"), { id: GLASS_DEFS_ID })
    if (!existing) {
      // Zero-size and inert: this exists only to be a resolution target, and a
      // visible SVG in the corner of the window is a bug waiting to happen.
      defs.setAttribute("aria-hidden", "true")
      defs.style.cssText = "position:absolute;width:0;height:0;pointer-events:none"
      document.body.appendChild(defs)
    }

    const filterId = `titan-glass-${(serial += 1)}`

    /**
     * The box this surface's map was generated for.
     *
     * Per-surface rather than per-hook, because each mounted surface has its own
     * size and they do not change together — the drawer is a fixed 340px column
     * while the rail is the window's height, and they are both open at once.
     */
    let lastKey = ""

    let retries = 0
    const build = (): boolean => {
      const rect = el.getBoundingClientRect()
      /*
       * An unusable first measurement retries rather than giving up, and the
       * reason is a bug this had on the queue drawer.
       *
       * The drawer is mounted by a `showQueue` flag inside a wrapper that is
       * itself still laying out, and the hook measured it at zero height. `build`
       * bailed — and nothing ever retried, because a `ResizeObserver` only fires
       * when the size *changes*, and the element settled straight into the size
       * it already had. The drawer was on screen, correctly sized at 340x752,
       * with a plain `blur()` and no refraction, and nothing in the code or the
       * DOM said why.
       *
       * So a bad measurement schedules another one. The retry budget is small and
       * the callback is idempotent, so the worst case is a few no-op frames on a
       * surface that has not been laid out yet.
       */
      if (rect.width < 2 || rect.height < 2) {
        if (retries < MAX_MEASUREMENT_RETRIES) {
          retries += 1
          requestAnimationFrame(() => build())
        }
        return false
      }
      retries = 0
      const key = `${Math.round(rect.width)}x${Math.round(rect.height)}`
      if (key === lastKey) return true
      lastKey = key

      const filter = document.createElementNS(NS, "filter")
      filter.setAttribute("id", filterId)
      // The filter is drawn into a region the size of the element. The default
      // region is -10%/+120% of the bounding box, which is both larger than needed
      // and, more importantly, offset — the displacement samples from the wrong
      // place and the rim comes out shifted.
      filter.setAttribute("x", "0")
      filter.setAttribute("y", "0")
      filter.setAttribute("width", "100%")
      filter.setAttribute("height", "100%")
      filter.setAttribute("color-interpolation-filters", "sRGB")

      const fe = (name: string, attrs: Record<string, string>) => {
        const n = document.createElementNS(NS, name)
        for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v)
        return n
      }

      // 1. the map
      const image = fe("feImage", {
        result: "map",
        preserveAspectRatio: "none",
        width: "100%",
        height: "100%",
      })
      image.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", buildMap(el, rect, flat))
      // Appended here rather than at the end, because the displacement primitives
      // below are appended inside their branch and the primitives are applied in
      // document order. The map has to come first.
      filter.append(image)

      /*
       * 2. push the backdrop along the map, once per channel, at three slightly
       *    different strengths.
       *
       * This is the chromatic aberration, and it is the single biggest reason the
       * reference implementation's glass reads as a *lens* rather than as a wavy
       * pane. One displacement is a warp: everything behind the surface is bent
       * by the same amount, so it looks like heat haze. Displacing red, green and
       * blue by 0, 6 and 10 pixels means the channels separate at the rim, and
       * a separated edge is something the eye recognises as optics. It is also
       * very easy to overdo — at these offsets it is a couple of pixels of fringe
       * on a hard highlight and invisible everywhere else, which is exactly the
       * amount that reads as "real" rather than as "someone turned on a filter".
       *
       * Each channel is then isolated by a `feColorMatrix` that keeps one
       * component and zeroes the rest, and the three recombined with `screen`,
       * so each contributes only its own colour. The single-displacement path is
       * kept for the surfaces that opt out, and because a filter that is three
       * displacements long is three times the work for a rim you cannot see.
       */
      const buildDisplacement = (
        channel: "R" | "G" | "B",
        offset: number,
        result: string,
      ) => {
        const d = fe("feDisplacementMap", {
          in: "SourceGraphic",
          in2: "map",
          scale: String(displacement + offset),
          xChannelSelector: "R",
          yChannelSelector: "G",
          result: `disp${channel}`,
        })
        // One matrix per channel: keep that component, drop the other two, and
        // keep alpha so the backdrop is not punched out.
        const m = fe("feColorMatrix", {
          in: `disp${channel}`,
          type: "matrix",
          values:
            channel === "R"
              ? "1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0"
              : channel === "G"
                ? "0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0"
                : "0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0",
          result,
        })
        filter.append(d, m)
      }

      if (chromatic && displacement !== 0) {
        buildDisplacement("R", redOffset, "red")
        buildDisplacement("G", greenOffset, "green")
        buildDisplacement("B", blueOffset, "blue")
        filter.append(
          fe("feBlend", { in: "red", in2: "green", mode: "screen", result: "rg" }),
          fe("feBlend", { in: "rg", in2: "blue", mode: "screen", result: "displaced" }),
        )
      } else {
        filter.append(
          fe("feDisplacementMap", {
            in: "SourceGraphic",
            in2: "map",
            scale: String(displacement),
            xChannelSelector: "R",
            yChannelSelector: "G",
            result: "displaced",
          }),
        )
      }

      // 3. a fraction of a pixel, to take the hard edge off the displaced rim
      //    where it meets the flat centre. Larger than that and the flat area
      //    itself goes soft, which throws away the thing that makes it read as
      //    glass.
      const soften = fe("feGaussianBlur", {
        in: "displaced",
        stdDeviation: String(GLASS_DEFAULTS.displace),
      })

      filter.append(soften)
      // Replace rather than append. A resize rebuild leaves exactly one node per
      // id; two nodes sharing an id means `url(#id)` resolves to whichever comes
      // first in document order, which is the map for a size the element no longer
      // has — the rim then reads from the wrong gradient and the refraction looks
      // like it drifted.
      document.getElementById(filterId)?.remove()
      defs.appendChild(filter)

      /*
       * `setProperty` rather than the camelCase property, because TypeScript's
       * DOM lib has no `webkitBackdropFilter` — it exists in the engine and not in
       * the types. Electron is Chromium, which has supported the unprefixed name
       * for years, so this is belt and braces; the prefixed form is what older
       * WebKit-derived engines still need, and it costs one call.
       *
       * If the engine does not honour the `url()`, fall back to a plain blur
       * rather than leaving a `url()` that resolves to nothing. The surface then
       * reads as ordinary frosted glass, which is a slightly plainer version of
       * the design instead of a visibly broken one.
       */
      const value = supportsSvgFilters() ? `url(#${filterId}) ${extra}` : extra
      el.style.setProperty("backdrop-filter", value)
      el.style.setProperty("-webkit-backdrop-filter", value)
      return true
    }

    build()

    // Rebuild on size change only. A ResizeObserver fires for every layout shift
    // including ones that do not change the box, so the size check inside `build`
    // is what keeps this from regenerating a data URL on every scroll-adjacent
    // reflow.
    const observer = new ResizeObserver(build)
    observer.observe(el)

    return () => {
      observer.disconnect()
      el.style.removeProperty("backdrop-filter")
      el.style.removeProperty("-webkit-backdrop-filter")
      document.getElementById(filterId)?.remove()
      // The shared defs element goes when the last surface using it does.
      if (!document.querySelector(`[id^="titan-glass-"]:not([id="${GLASS_DEFS_ID}"])`)) {
        defs.remove()
      }
    }
  }
}

/**
 * The displacement map, as an SVG data URL.
 *
 * Red ramps from transparent at the left to full at the right, so the
 * displacement grows left-to-right. Blue ramps top-to-bottom. The two are screen
 * blended inside the SVG, so a corner gets both and displaces diagonally while
 * the middle of each edge gets one axis only.
 *
 * Then the inset: a rounded rect covering the middle `flat` fraction of the
 * panel, filled with a mid grey and blurred. Grey is 50% in all three channels,
 * and the map's neutral is black, so this does not only suppress the
 * displacement — it also *replaces* it, which is what keeps the centre genuinely
 * undistorted rather than merely low-distortion. Its own blur is what makes the
 * hand-off from flat to refracting a gradient instead of a visible edge.
 *
 * The panel's own border radius goes into the map so the flat region follows the
 * shape of the surface. Without it a rounded panel gets a rectangular flat patch
 * through it, which is immediately visible as a mistake.
 */
function buildMap(el: Element, rect: DOMRect, flat: number): string {
  const w = Math.max(1, Math.round(rect.width))
  const h = Math.max(1, Math.round(rect.height))
  const radius = readRadius(el, rect)

  // The flat region is inset from the shorter side, so the refracting band is the
  // same width on all four edges of a wide panel. Insetting by a fraction of the
  // width instead would leave a wide panel with a nearly invisible rim and a tall
  // one with a very thick one.
  const inset = Math.min(w, h) * flat
  const innerW = Math.max(0, w - inset * 2)
  const innerH = Math.max(0, h - inset * 2)
  const innerRadius = Math.max(0, radius - inset)

  // 50% grey. In a displacement map the neutral is 0, so exactly half in every
  // channel is exactly no vector — which is what "flat" has to mean numerically.
  // The blur on it is what turns the boundary from a line into a gradient, and a
  // hard line between flat and refracting is the thing that reads as a frame
  // rather than as glass.
  const grey = Math.round((GLASS_DEFAULTS.brightness / 100) * 255)

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<defs>` +
    `<linearGradient id="r" x1="0%" y1="0%" x2="100%" y2="0%">` +
    `<stop offset="0%" stop-color="#0000"/><stop offset="100%" stop-color="red"/>` +
    `</linearGradient>` +
    `<linearGradient id="b" x1="0%" y1="0%" x2="0%" y2="100%">` +
    `<stop offset="0%" stop-color="#0000"/><stop offset="100%" stop-color="blue"/>` +
    `</linearGradient>` +
    `</defs>` +
    `<rect width="${w}" height="${h}" fill="black"/>` +
    `<rect width="${w}" height="${h}" rx="${radius}" fill="url(%23r)"/>` +
    `<rect width="${w}" height="${h}" rx="${radius}" fill="url(%23b)" ` +
    `style="mix-blend-mode:${GLASS_DEFAULTS.mixBlendMode}"/>` +
    `<rect x="${inset}" y="${inset}" width="${innerW}" height="${innerH}" rx="${innerRadius}" ` +
    `fill="rgb(${grey},${grey},${grey})" style="filter:blur(${Math.max(2, inset * 0.4)}px)"/>` +
    `</svg>`

  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

/**
 * Whether this engine honours an SVG filter referenced from `backdrop-filter`.
 *
 * Adapted from `supportsSVGFilters` in Liquify's `theme.js`, including its
 * Safari-and-Firefox carve-out. That is not paranoia: both engines parse the
 * value and then drop the `url()`, so a surface gets *plain transparency* and
 * looks like a slightly wrong version of the design rather than like a failure.
 * Probing for it costs one property write.
 *
 * Cached, because the answer cannot change within a session and the check runs
 * once per surface mount.
 */
let svgFilterSupport: boolean | null = null

export function supportsSvgFilters(): boolean {
  if (svgFilterSupport !== null) return svgFilterSupport
  const ua = navigator.userAgent
  if (/Safari/.test(ua) && !/Chrome/.test(ua)) svgFilterSupport = false
  else if (/Firefox/.test(ua)) svgFilterSupport = false
  else {
    const div = document.createElement("div")
    div.style.backdropFilter = "url(#titan-glass-probe)"
    svgFilterSupport = div.style.backdropFilter !== ""
  }
  return svgFilterSupport
}

/**
 * The element's own border radius, read out of its computed style.
 *
 * The map is drawn in the SVG's own coordinate space, which knows nothing about
 * CSS, so the radius has to be carried across. It is read per rebuild rather than
 * taken as an option because it changes with the theme and with responsive
 * breakpoints, and a stale radius shows up as a rectangular flat patch.
 */
function readRadius(el: Element, rect: DOMRect): number {
  const raw = getComputedStyle(el).borderTopLeftRadius
  // Computed as a percentage resolves to a px string in Chromium, but a token
  // like "9999px" is a pill and clamping to half the shortest side is what keeps
  // the map from drawing a shape the panel does not have.
  const n = Number.parseFloat(raw)
  if (!Number.isFinite(n)) return 0
  return Math.min(n, Math.min(rect.width, rect.height) / 2)
}
