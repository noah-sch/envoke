import { useId } from "react";

/**
 * The envoke "e": a ring cut open on the right, crossed by its bar. `ink` draws the ring,
 * `bar` the crossbar (coral on light backgrounds, ink on the coral avatar).
 */
export function LogoMark({
  size = 24,
  ink = "#141416",
  bar = "#FF6363",
}: {
  size?: number;
  ink?: string;
  bar?: string;
}) {
  const id = useId().replace(/:/g, "");
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      aria-hidden="true"
      focusable="false"
      style={{ flexShrink: 0 }}
    >
      <defs>
        <mask id={`m${id}`} maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">
          <rect width="100" height="100" fill="#fff" />
          <rect x="30" y="38" width="70" height="22" fill="#000" />
          <rect x="50" y="56" width="50" height="12" fill="#000" />
        </mask>
        <clipPath id={`c${id}`}>
          <circle cx="50" cy="50" r="40" />
        </clipPath>
      </defs>
      <circle
        cx="50"
        cy="50"
        r="30"
        fill="none"
        stroke={ink}
        strokeWidth="20"
        mask={`url(#m${id})`}
      />
      <rect x="34" y="42" width="60" height="14" fill={bar} clipPath={`url(#c${id})`} />
    </svg>
  );
}

export function Wordmark() {
  return (
    <span className="brand">
      <LogoMark size={24} />
      <span className="wordmark">envoke</span>
    </span>
  );
}

/** Assistant avatar: coral tile, ink mark. */
export function Avatar() {
  return (
    <div className="avatar">
      <LogoMark size={22} ink="#0B0B0D" bar="#0B0B0D" />
    </div>
  );
}
