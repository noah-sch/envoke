import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Dropdown: a button, and a list that closes on Escape, on a click outside, or once an item is
 * chosen. Arrow keys move between items.
 */
export function Menu({
  label,
  button,
  buttonClass = "btn",
  align = "left",
  direction = "down",
  children,
}: {
  label: string;
  button: ReactNode;
  buttonClass?: string;
  align?: "left" | "right";
  direction?: "up" | "down";
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const items = () => [
      ...(root.current?.querySelectorAll<HTMLButtonElement>("[role^=menuitem]:not(:disabled)") ??
        []),
    ];
    items()[0]?.focus();
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const list = items();
        const index = list.indexOf(document.activeElement as HTMLButtonElement);
        const next = e.key === "ArrowDown" ? index + 1 : index - 1;
        list.at(next % list.length)?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  return (
    <div className="menu" ref={root}>
      <button
        ref={trigger}
        type="button"
        className={buttonClass}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {button}
      </button>
      {open && (
        <div
          role="menu"
          aria-label={label}
          className={`menu-pop ${direction} ${align === "right" ? "right" : ""}`}
        >
          {children(close)}
        </div>
      )}
    </div>
  );
}
