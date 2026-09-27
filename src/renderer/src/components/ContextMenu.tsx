import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"
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
const ROW_H = 30
const SEP_H = 9

/**
 * A portal-rendered context menu. It measures itself after mount and flips or
 * clamps against the viewport edges, because an item list near the bottom-right
 * would otherwise open off screen.
 */
export default function ContextMenu({ anchor, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<MenuAnchor | null>(null)

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
  }, [anchor, items])

  useEffect(() => {
    if (!anchor) return

    const onPointerDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    const onBlur = () => onClose()

    // `capture` on the contextmenu event stops the browser's own menu from
    // appearing when the user right-clicks somewhere else while this is open.
    window.addEventListener("pointerdown", onPointerDown, true)
    window.addEventListener("keydown", onKey)
    window.addEventListener("blur", onBlur)
    window.addEventListener("contextmenu", onPointerDown, true)

    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true)
      window.removeEventListener("keydown", onKey)
      window.removeEventListener("blur", onBlur)
      window.removeEventListener("contextmenu", onPointerDown, true)
    }
  }, [anchor, onClose])

  if (!anchor) return null

  // Rough height used to size the backdrop so hover is killed immediately.
  const approxHeight = items.reduce(
    (sum, item) => sum + (item.separator ? SEP_H : ROW_H),
    8,
  )

  return createPortal(
    <>
      <div
        className="context-backdrop"
        style={{ height: Math.max(approxHeight, 40) }}
        aria-hidden="true"
      />
      <div
        ref={ref}
        className="context-menu glass"
        role="menu"
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
          ) : (
            <button
              key={item.label ?? index}
              className={`context-item ${item.danger ? "danger" : ""}`}
              role="menuitem"
              disabled={item.disabled}
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
      </div>
    </>,
    document.body,
  )
}
