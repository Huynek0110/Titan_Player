import { useEffect, useRef } from "react"

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
  /** Blur underneath the refraction, in pixels. Small — the glass is the refraction. */
  blur?: number
  /** Fraction of the shortest side that stays flat, 0 to 0.5. */
  flat?: number
}

/** Registry of live filters, so a resize can find the one that needs rebuilding. */
let serial = 0

/** Id of the shared, zero-sized SVG that every glass filter is appended to. */
const GLASS_DEFS_ID = "titan-glass-defs"

/**
 * Apply Liquid Glass to an element.
 *
 * Returns a ref for the element. The glass is a `backdrop-filter`, so it needs
 * something behind it to refract — an element whose own background is opaque
 * hides the effect entirely, which looks like the glass silently failing.
 */
export function useGlassSurface<T extends HTMLElement>(options: GlassOptions = {}) {
  const { displacement = 42, blur = 2, flat = 0.32 } = options
  const ref = useRef<T>(null)
  const idRef = useRef<string | null>(null)
  const sizeRef = useRef("")

  useEffect(() => {
    const el = ref.current
    if (!el) return

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
    idRef.current = filterId

    const build = () => {
      const rect = el.getBoundingClientRect()
      if (rect.width < 2 || rect.height < 2) return
      const key = `${Math.round(rect.width)}x${Math.round(rect.height)}`
      if (key === sizeRef.current) return
      sizeRef.current = key

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

      // 2. push the backdrop along the map
      const displace = fe("feDisplacementMap", {
        in: "SourceGraphic",
        in2: "map",
        scale: String(displacement),
        xChannelSelector: "R",
        yChannelSelector: "G",
        result: "displaced",
      })

      // 3. a fraction of a pixel, to take the hard edge off the displaced rim
      //    where it meets the flat centre. Larger than that and the flat area
      //    itself goes soft, which throws away the thing that makes it read as
      //    glass.
      const soften = fe("feGaussianBlur", {
        in: "displaced",
        stdDeviation: "0.35",
      })

      filter.append(image, displace, soften)
      defs.appendChild(filter)

      /*
       * `setProperty` rather than the camelCase property, because TypeScript's
       * DOM lib has no `webkitBackdropFilter` — it exists in the engine and not in
       * the types. Electron is Chromium, which has supported the unprefixed name
       * for years, so this is belt and braces; the prefixed form is what older
       * WebKit-derived engines still need, and it costs one call.
       */
      const value = `url(#${filterId}) blur(${blur}px)`
      el.style.setProperty("backdrop-filter", value)
      el.style.setProperty("-webkit-backdrop-filter", value)
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
  }, [displacement, blur, flat])

  return ref
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
    `<rect width="${w}" height="${h}" rx="${radius}" fill="url(%23b)" style="mix-blend-mode:screen"/>` +
    `<rect x="${inset}" y="${inset}" width="${innerW}" height="${innerH}" rx="${innerRadius}" ` +
    `fill="rgb(128,128,128)" style="filter:blur(${Math.max(2, inset * 0.35)}px)"/>` +
    `</svg>`

  return `data:image/svg+xml,${encodeURIComponent(svg)}`
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
