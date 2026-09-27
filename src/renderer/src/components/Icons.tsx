import type { SVGProps } from "react"

/**
 * One inline icon set. Every glyph is stroked with `currentColor` and sized from
 * the `size` prop, so a parent can recolour or resize the whole set through CSS
 * without touching each instance.
 */

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function Icon({ size = 18, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  )
}

export const Play = (p: IconProps) => (
  <Icon {...p} fill="currentColor" stroke="none">
    <path d="M7.5 5.6c0-.9 1-1.5 1.8-1l8.2 5.4a1.2 1.2 0 0 1 0 2l-8.2 5.4c-.8.5-1.8 0-1.8-1V5.6Z" />
  </Icon>
)

export const Pause = (p: IconProps) => (
  <Icon {...p} fill="currentColor" stroke="none">
    <rect x="6.5" y="5" width="3.6" height="14" rx="1.2" />
    <rect x="13.9" y="5" width="3.6" height="14" rx="1.2" />
  </Icon>
)

export const Prev = (p: IconProps) => (
  <Icon {...p} fill="currentColor" stroke="none">
    <rect x="5" y="5.5" width="2.2" height="13" rx="1.1" />
    <path d="M20 6.9c0-.9-1-1.4-1.7-1l-8 5c-.5.3-.8.9-.8 1.5s.3 1.2.8 1.5l8 5c.7.4 1.7-.1 1.7-1V6.9Z" />
  </Icon>
)

export const Next = (p: IconProps) => (
  <Icon {...p} fill="currentColor" stroke="none">
    <rect x="16.8" y="5.5" width="2.2" height="13" rx="1.1" />
    <path d="M4 6.9c0-.9 1-1.4 1.7-1l8 5c.5.3.8.9.8 1.5s-.3 1.2-.8 1.5l-8 5C5 19.4 4 18.9 4 18V6.9Z" />
  </Icon>
)

export const Shuffle = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 17h3.2a4 4 0 0 0 3.3-1.8l4.4-6.4A4 4 0 0 1 17.2 7H21" />
    <path d="M18.5 4.5 21 7l-2.5 2.5" />
    <path d="M3 7h3.2a4 4 0 0 1 2.2.6" />
    <path d="M14.3 15.6a4 4 0 0 0 2.9 1.4H21" />
    <path d="M18.5 14.5 21 17l-2.5 2.5" />
  </Icon>
)

export const Repeat = (p: IconProps) => (
  <Icon {...p}>
    <path d="M17 2.5 20 5.5l-3 3" />
    <path d="M20 5.5H7a4 4 0 0 0-4 4v1" />
    <path d="M7 21.5 4 18.5l3-3" />
    <path d="M4 18.5h13a4 4 0 0 0 4-4v-1" />
  </Icon>
)

export const RepeatOne = (p: IconProps) => (
  <Icon {...p}>
    <path d="M17 2.5 20 5.5l-3 3" />
    <path d="M20 5.5H7a4 4 0 0 0-4 4v1" />
    <path d="M7 21.5 4 18.5l3-3" />
    <path d="M4 18.5h13a4 4 0 0 0 4-4v-1" />
    <path d="M11.4 10.6 13 9.8v4.4" strokeWidth={1.6} />
  </Icon>
)

export const Volume = (p: IconProps) => (
  <Icon {...p}>
    <path d="M11 5.5 7 9H4.5A1.5 1.5 0 0 0 3 10.5v3A1.5 1.5 0 0 0 4.5 15H7l4 3.5V5.5Z" />
    <path d="M15.2 9.2a4 4 0 0 1 0 5.6" />
    <path d="M17.9 6.5a8 8 0 0 1 0 11" />
  </Icon>
)

export const VolumeLow = (p: IconProps) => (
  <Icon {...p}>
    <path d="M11 5.5 7 9H4.5A1.5 1.5 0 0 0 3 10.5v3A1.5 1.5 0 0 0 4.5 15H7l4 3.5V5.5Z" />
    <path d="M15.2 9.2a4 4 0 0 1 0 5.6" />
  </Icon>
)

export const VolumeMute = (p: IconProps) => (
  <Icon {...p}>
    <path d="M11 5.5 7 9H4.5A1.5 1.5 0 0 0 3 10.5v3A1.5 1.5 0 0 0 4.5 15H7l4 3.5V5.5Z" />
    <path d="m15.5 9.5 5 5" />
    <path d="m20.5 9.5-5 5" />
  </Icon>
)

export const Heart = ({ filled, ...p }: IconProps & { filled?: boolean }) => (
  <Icon {...p} fill={filled ? "currentColor" : "none"}>
    <path d="M12 20s-7.2-4.4-7.2-9.3A4.2 4.2 0 0 1 12 8.2a4.2 4.2 0 0 1 7.2 2.5C19.2 15.6 12 20 12 20Z" />
  </Icon>
)

export const Music = (p: IconProps) => (
  <Icon {...p}>
    <path d="M9 18V6.2l10-2v11.5" />
    <circle cx="6.5" cy="18" r="2.5" />
    <circle cx="16.5" cy="15.7" r="2.5" />
  </Icon>
)

export const Disc = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <circle cx="12" cy="12" r="2.2" />
  </Icon>
)

export const Artist = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="8" r="3.6" />
    <path d="M4.8 20a7.4 7.4 0 0 1 14.4 0" />
  </Icon>
)

export const Library = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 4.5h2.5v15H4z" />
    <path d="M8.5 4.5h2.5v15H8.5z" />
    <path d="m13.6 5.4 2.4-.6 3.2 13.9-2.4.6z" />
  </Icon>
)

export const Lyrics = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4.5 5.5h15" />
    <path d="M4.5 10h10" />
    <path d="M4.5 14.5h13" />
    <path d="M4.5 19h7" />
  </Icon>
)

export const Queue = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 6.5h11" />
    <path d="M4 12h11" />
    <path d="M4 17.5h7" />
    <circle cx="18" cy="16" r="2.6" />
    <path d="M20.6 16V8.2l-3.2.8" />
  </Icon>
)

export const Plus = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 5.5v13" />
    <path d="M5.5 12h13" />
  </Icon>
)

export const Search = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="11" cy="11" r="6.2" />
    <path d="m15.6 15.6 4 4" />
  </Icon>
)

export const Close = (p: IconProps) => (
  <Icon {...p}>
    <path d="m6.5 6.5 11 11" />
    <path d="m17.5 6.5-11 11" />
  </Icon>
)

export const Minimize = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5.5 12h13" />
  </Icon>
)

export const Maximize = (p: IconProps) => (
  <Icon {...p} strokeWidth={1.5}>
    <rect x="5.5" y="5.5" width="13" height="13" rx="2" />
  </Icon>
)

export const Restore = (p: IconProps) => (
  <Icon {...p} strokeWidth={1.5}>
    <rect x="4.5" y="8" width="11.5" height="11.5" rx="2" />
    <path d="M8 8V6.5a2 2 0 0 1 2-2h7.5a2 2 0 0 1 2 2V14a2 2 0 0 1-2 2h-1.5" />
  </Icon>
)

export const Settings = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="2.9" />
    <path d="M19.4 14a1.5 1.5 0 0 0 .3 1.7l.1.1a1.8 1.8 0 1 1-2.6 2.6l-.1-.1a1.5 1.5 0 0 0-2.5 1v.3a1.8 1.8 0 1 1-3.6 0v-.2a1.5 1.5 0 0 0-2.6-1l-.1.1a1.8 1.8 0 1 1-2.6-2.6l.1-.1a1.5 1.5 0 0 0-1-2.5h-.3a1.8 1.8 0 1 1 0-3.6h.2a1.5 1.5 0 0 0 1-2.6l-.1-.1a1.8 1.8 0 1 1 2.6-2.6l.1.1a1.5 1.5 0 0 0 1.7.3h.1a1.5 1.5 0 0 0 .9-1.4v-.3a1.8 1.8 0 1 1 3.6 0v.2a1.5 1.5 0 0 0 2.5 1l.1-.1a1.8 1.8 0 1 1 2.6 2.6l-.1.1a1.5 1.5 0 0 0 1 2.5h.3a1.8 1.8 0 1 1 0 3.6h-.2a1.5 1.5 0 0 0-1.4.9Z" />
  </Icon>
)

export const Refresh = (p: IconProps) => (
  <Icon {...p}>
    <path d="M20 11.5a8 8 0 0 0-14-4.4L3.5 9.5" />
    <path d="M4 12.5a8 8 0 0 0 14 4.4l2.5-2.4" />
    <path d="M3.5 5.5v4h4" />
    <path d="M20.5 18.5v-4h-4" />
  </Icon>
)

export const ChevronDown = (p: IconProps) => (
  <Icon {...p}>
    <path d="m6.5 9.5 5.5 5.5 5.5-5.5" />
  </Icon>
)

export const ChevronUp = (p: IconProps) => (
  <Icon {...p}>
    <path d="m6.5 14.5 5.5-5.5 5.5 5.5" />
  </Icon>
)

export const More = (p: IconProps) => (
  <Icon {...p} fill="currentColor" stroke="none">
    <circle cx="6" cy="12" r="1.6" />
    <circle cx="12" cy="12" r="1.6" />
    <circle cx="18" cy="12" r="1.6" />
  </Icon>
)

export const Trash = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4.5 7h15" />
    <path d="M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7" />
    <path d="M6.5 7.5 7.4 19a1.6 1.6 0 0 0 1.6 1.5h6a1.6 1.6 0 0 0 1.6-1.5l.9-11.5" />
    <path d="M10.5 11v5.5" />
    <path d="M13.5 11v5.5" />
  </Icon>
)

export const Folder = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h3.6a1.5 1.5 0 0 1 1.2.6l1 1.3H19a1.5 1.5 0 0 1 1.5 1.5v7.1A1.5 1.5 0 0 1 19 18H5a1.5 1.5 0 0 1-1.5-1.5v-9Z" />
  </Icon>
)

export const Waveform = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 12h2" />
    <path d="M7 8v8" />
    <path d="M11 5v14" />
    <path d="M15 9v6" />
    <path d="M19 11.5v1" />
  </Icon>
)

export const Info = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5" />
    <path d="M12 7.8h.01" strokeWidth={2.2} />
  </Icon>
)

export const Grip = (p: IconProps) => (
  <Icon {...p} fill="currentColor" stroke="none">
    <circle cx="9" cy="7" r="1.35" />
    <circle cx="15" cy="7" r="1.35" />
    <circle cx="9" cy="12" r="1.35" />
    <circle cx="15" cy="12" r="1.35" />
    <circle cx="9" cy="17" r="1.35" />
    <circle cx="15" cy="17" r="1.35" />
  </Icon>
)

export const External = (p: IconProps) => (
  <Icon {...p}>
    <path d="M14 4.5h5.5V10" />
    <path d="m19.5 4.5-8 8" />
    <path d="M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10" />
  </Icon>
)
