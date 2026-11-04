import { useEffect, useRef, useState, type ReactNode } from "react";

export interface DropdownItem {
  id: string | number;
  label: string;
  /** colour swatch */
  color?: string;
  /** shortcut shown at the right */
  key?: string | number | null;
  checked?: boolean;
  disabled?: boolean;
}

interface Props {
  /** content of the button */
  children: ReactNode;
  items: DropdownItem[];
  onPick(id: string | number): void;
  title?: string;
  className?: string;
  disabled?: boolean;
  /** a filter field above the list (default: when there are more than 7 items) */
  filter?: boolean;
  /** open downwards (the default is upwards: the tools of the viewer sit at the bottom) */
  down?: boolean;
  /** data-testid style hook for tests */
  name?: string;
}

/**
 * A button that opens a list: for the many annotation types of an image set. Opens upwards (the tools sit at the bottom),
 * closes on a pick, a click elsewhere or Escape (which then does not reach the viewer's own Escape handling).
 */
export function Dropdown({ children, items, onPick, title, className = "", disabled, filter, name, down }: Props) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const showFilter = filter ?? items.length > 7;

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  const shown = items.filter((i) => i.label.toLowerCase().includes(q.trim().toLowerCase()));
  const pick = (i: DropdownItem) => {
    if (i.disabled) return;
    setOpen(false);
    setQ("");
    onPick(i.id);
  };

  return (
    <div
      className={`dropdown ${down ? "down" : ""} ${className}`}
      ref={root}
      data-name={name}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button className="btn trigger" onClick={() => setOpen((o) => !o)} disabled={disabled} aria-haspopup="listbox" aria-expanded={open} title={title}>
        {children}
        <span className="caret" aria-hidden>
          ▾
        </span>
      </button>
      {open && (
        <div className="dd-pop glass" role="listbox">
          {showFilter && (
            <input
              className="dd-filter"
              autoFocus
              placeholder="Filter…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && shown[0]) pick(shown[0]);
              }}
            />
          )}
          <div className="dd-list">
            {shown.map((i) => (
              <button key={i.id} className={`dd-item ${i.checked ? "checked" : ""}`} role="option" aria-selected={!!i.checked} disabled={i.disabled} onClick={() => pick(i)}>
                {i.color && <span className="swatch" style={{ background: i.color }} />}
                <span className="dd-label">{i.label}</span>
                {i.key != null && <kbd>{i.key}</kbd>}
                {i.checked && <span className="tick">✓</span>}
              </button>
            ))}
            {shown.length === 0 && <div className="dd-empty muted small">Nothing matches.</div>}
          </div>
        </div>
      )}
    </div>
  );
}
