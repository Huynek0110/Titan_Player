import { useEffect, useState } from "react"

/**
 * Whether the user has asked the system for less motion.
 *
 * Worth reading rather than only styling against in CSS, because the two cases
 * need *different content*, not just different timing. A line-change animation
 * has two parts: the incoming line arriving, and the outgoing line leaving. Under
 * `reduce` the first is still wanted — a cross-fade says "this changed" — and
 * only the second has to go, because it is pure movement. Emitting the outgoing
 * element anyway and then hiding it, as a `prefers-reduced-motion` block in CSS
 * did, produces the worst of both: a node that renders for the length of the
 * animation and is invisible for all of it.
 *
 * This also means the whole interface is static whenever Windows has animation
 * effects switched off, which is worth knowing when someone reports that
 * nothing moves. `prefers-reduced-motion` is a real preference, not a bug, and
 * the fix is in the OS rather than in the app.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches
  })

  useEffect(() => {
    if (!window.matchMedia) return
    const query = window.matchMedia("(prefers-reduced-motion: reduce)")
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches)
    // `addEventListener` is the modern form and is what Chromium supports; the
    // deprecated `addListener` is here only for older WebKit.
    if (typeof query.addEventListener === "function") {
      query.addEventListener("change", onChange)
      return () => query.removeEventListener("change", onChange)
    }
    query.addListener(onChange)
    return () => query.removeListener(onChange)
  }, [])

  return reduced
}
