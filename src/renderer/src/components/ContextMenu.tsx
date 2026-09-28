import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"
import "./ContextMenu.css"

export interface MenuItem {
  label?: string
  icon?: ReactNode
  onSelect?: () => void
  disabled?: boolean
  danger?: boolean
  separator?: boolean
  /** Optional trailing hint, e.g. a shortcut. */
  hint?: string
  /**
   * Arbitrary content in place of a row, for the one thing a menu cannot do with
   * a label: collect a text value. Excluded from keyboard navigation, because a
   * focused field owns its own keys.
   */
  node?: ReactNode
}

export interface MenuAnchor {
  x: number
  y: number
}

interface ContextMenuProps {
  anchor: MenuAnchor | null
  items: MenuItem[]
  onClose: () => void
}

const MARGIN = 8

/**
 * A portal-rendered context menu. It measures itself after mount and flips or
 * clamps against the viewport edges, because an item list near the bottom-right
 * would otherwise open off screen.
 */
export default function ContextMenu({ anchor, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<MenuAnchor | null>(null)
  const [activeIndex, setActiveIndex] = useState(-1)

  // Indices of the selectable rows, so arrow keys skip separators and the rows
  // that are just content.
  const selectable = useMemo(
    () => items.map((item, i) => (item.separator || item.node ? -1 : i)).filter((i) => i !== -1),
    [items],
  )

  /*
   * Identity of the item list, for the two effects that have to re-run when the
   * menu genuinely changes shape.
   *
   * Not the array reference. A caller rebuilding its items on every render is
   * normal, and keying on identity made the menu re-measure and drop the
   * keyboard cursor back to the first row every time an inline text field
   * changed — which is to say, on every keystroke typed into it.
   *
   * The separator is a written escape rather than a literal control byte: a real
   * NUL makes git treat the file as binary.
   */
  const ITEM_SEP = "\u0000"

  const signature =
    items
      .map((item, i) => (item.separator ? "-" : item.node ? `#${i}` : item.label ?? String(i)))
      .join(ITEM_SEP) || "empty"

  // Measure then position. Doing this in an effect rather than at render keeps
  // the first paint from flashing at the wrong spot.
  useLayoutEffect(() => {
    if (!anchor || !ref.current) return
    const rect = ref.current.getBoundingClientRect()
    let x = anchor.x
    let y = anchor.y

    if (x + rect.width + MARGIN > window.innerWidth) {
      x = Math.max(MARGIN, x - rect.width)
    }
    if (y + rect.height + MARGIN > window.innerHeight) {
      // Slide up rather than flipping, so the first item stays nearest the
      // cursor, which is where the user is reaching.
      y = Math.max(MARGIN, window.innerHeight - rect.height - MARGIN)
    }
    setPos({ x, y })
    // `signature` rather than `items`: the width and height being clamped here
    // depend on the labels, not on the identity of the array holding them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor, signature])

  // Move real focus into the menu. Without this a keyboard user can only ever
  // dismiss the menu, never use it, and a screen reader is never told it opened.
  useEffect(() => {
    if (!anchor) return
    setActiveIndex(selectable[0] ?? -1)
    const id = window.setTimeout(() => {
      // Unless something inside already has it. Switching to a level that
      // reveals a text field autofocuses that field, and an unconditional
      // `focus()` here stole it back on the very next tick — so the caret landed
      // nowhere and every keystroke went to the menu.
      const active = document.activeElement
      if (ref.current && !ref.current.contains(active)) ref.current.focus()
    }, 0)
    return () => window.clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor, signature])

  // Mirrors of the values the window key handler needs, so that handler can be
  // bound once per menu rather than re-bound on every arrow key.
  const live = useRef({ items, selectable, activeIndex })
  useEffect(() => {
    live.current = { items, selectable, activeIndex }
  })

  useEffect(() => {
    if (!anchor) return

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose()
        return
      }
      /*
       * A text field inside the menu owns its own keys. This listener is
       * registered in the capture phase so it runs before the input's, so
       * without this guard the arrow keys and Home/End would move the menu's
       * cursor instead of the caret.
       */
      const target = event.target as HTMLElement | null
      const inField =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable === true
      if (inField) return

      const { items: rows, selectable: keys, activeIndex: atIndex } = live.current

      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault()
        if (keys.length === 0) return
        const at = keys.indexOf(atIndex)
        const delta = event.key === "ArrowDown" ? 1 : -1
        const nextAt = at === -1 ? 0 : (at + delta + keys.length) % keys.length
        setActiveIndex(keys[nextAt])
        return
      }
      if (event.key === "Home") {
        event.preventDefault()
        setActiveIndex(keys[0] ?? -1)
        return
      }
      if (event.key === "End") {
        event.preventDefault()
        setActiveIndex(keys[keys.length - 1] ?? -1)
        return
      }
      // Activation. Without it the cursor is a decoration: moving through the
      // list and then pressing Enter does nothing, because focus sits on the
      // menu container rather than on a row.
      if (event.key === "Enter" || event.key === " ") {
        const item = rows[atIndex]
        if (!item || item.disabled || item.separator || item.node) return
        event.preventDefault()
        onClose()
        item.onSelect?.()
      }
    }

    // Dismissal: Escape above, plus a click anywhere outside.
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose()
    }

    window.addEventListener("keydown", onKey, true)
    window.addEventListener("pointerdown", onPointerDown, true)
    window.addEventListener("blur", onClose)

    return () => {
      window.removeEventListener("keydown", onKey, true)
      window.removeEventListener("pointerdown", onPointerDown, true)
      window.removeEventListener("blur", onClose)
    }
    // `items` and the two index values are read through a ref rather than
    // listed as deps. They change on every hover, and re-binding three window
    // listeners that often costs more than the key press that caused it. The
    // listener is bound once per open instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor, onClose])

  if (!anchor) return null

  /*
   * No backdrop element. The previous version put a transparent, pointer-
   * swallowing div over the top strip of the window, which meant that while a
   * menu was open you could not hover, highlight or click anything else — you
   * could not even move the selection to see what the next action would do.
   * Dismissal is handled by the window-level `pointerdown` listener above.
   */
  return createPortal(
    <div
      ref={ref}
      className="context-menu glass"
      role="menu"
      tabIndex={-1}
      style={{
        left: pos?.x ?? anchor.x,
        top: pos?.y ?? anchor.y,
        // Fade in only once measured and placed, so it never slides from 0,0.
        opacity: pos ? 1 : 0,
      }}
    >
      {items.map((item, index) =>
        item.separator ? (
          <div key={`sep-${index}`} className="context-sep" role="separator" />
        ) : item.node ? (
          // Not focusable itself: the child decides what is focusable, and the
          // row must not be a second stop in the roving tabindex sequence.
          <div key={`node-${index}`} className="context-node">
            {item.node}
          </div>
        ) : (
          <button
            key={item.label ?? index}
            className={`context-item ${item.danger ? "danger" : ""} ${
              index === activeIndex ? "kb" : ""
            }`}
            role="menuitem"
            // Roving tabindex, so Tab enters and leaves the menu as one unit.
            tabIndex={index === activeIndex ? 0 : -1}
            disabled={item.disabled}
            onMouseEnter={() => setActiveIndex(index)}
            onClick={() => {
              onClose()
              item.onSelect?.()
            }}
          >
            {item.icon && <span className="context-icon">{item.icon}</span>}
            <span className="truncate">{item.label}</span>
            {item.hint && <span className="context-hint">{item.hint}</span>}
          </button>
        ),
      )}
    </div>,
    document.body,
  )
}
