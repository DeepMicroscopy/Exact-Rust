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
  /** a group the item belongs to: a heading is shown above the first item of every group (items of a group should follow each other) */
  group?: string | null;
  /** an eye in front of the item: on or off (undefined: no eye); a click on it does not pick the item and does not close the list */
  eye?: boolean;
  eyeDisabled?: boolean;
  eyeTitle?: string;
  onEye?(): void;
  /** the swatch is striped (a mask that is shown but is not the one being painted) */
  striped?: boolean;
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

/** An eye, open or shut. */
function Eye({ on }: { on: boolean }) {
  const common = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  return on ? (
    <svg {...common}>
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ) : (
    <svg {...common}>
      <path d="M3 3l18 18" />
      <path d="M10.6 6.1A10 10 0 0 1 12 6c6.4 0 10 6 10 6a17 17 0 0 1-3.2 3.9M6.5 7.6A16 16 0 0 0 2 12s3.6 7 10 7a9.6 9.6 0 0 0 4-.9" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    </svg>
  );
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
            {shown.map((i, n) => (
              <div key={i.id} className={`dd-row ${i.group ? "in-group" : ""}`} data-id={i.id}>
                {i.group && i.group !== shown[n - 1]?.group && (
                  <div className="dd-group" data-testid="dd-group" title="The masks of this group exclude each other: a voxel painted for one is taken from the others">
                    ⛓ {i.group} <span className="muted small">exclusive</span>
                  </div>
                )}
                <div className="dd-line">
                  {i.eye !== undefined && (
                    <button type="button" className={`dd-eye ${i.eye ? "on" : ""}`} disabled={i.eyeDisabled} aria-pressed={i.eye} aria-label={`${i.eye ? "Hide" : "Show"} ${i.label}`} title={i.eyeTitle} data-testid="dd-eye" onClick={() => i.onEye?.()}>
                      <Eye on={i.eye} />
                    </button>
                  )}
                  <button className={`dd-item ${i.checked ? "checked" : ""}`} role="option" aria-selected={!!i.checked} disabled={i.disabled} onClick={() => pick(i)}>
                    {i.color && <span className={`swatch ${i.striped ? "striped" : ""}`} style={i.striped ? ({ ["--c" as string]: i.color } as React.CSSProperties) : { background: i.color }} />}
                    <span className="dd-label">{i.label}</span>
                    {i.key != null && <kbd>{i.key}</kbd>}
                    {i.checked && <span className="tick">✓</span>}
                  </button>
                </div>
              </div>
            ))}
            {shown.length === 0 && <div className="dd-empty muted small">Nothing matches.</div>}
          </div>
        </div>
      )}
    </div>
  );
}
