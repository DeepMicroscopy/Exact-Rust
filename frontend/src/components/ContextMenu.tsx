import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PaletteEntry } from "../viewer-core/palette";

export interface MenuModel {
  x: number;
  y: number;
  typeId: number;
  /** the types the annotation can change to (compatible shapes) */
  classes: PaletteEntry[];
  canCrop: boolean;
  cropWhy: string;
  /** several annotations selected together: the menu acts on all of them */
  count?: number;
}

interface Props {
  model: MenuModel;
  onClose(): void;
  onInfo(): void;
  onClass(typeId: number): void;
  onCrop(): void;
  onDelete(): void;
  onCopy?(): void;
}

/** The right-click (or long-press) menu of an annotation. Closes on a choice, Escape, or a click elsewhere. */
export function ContextMenu({ model, onClose, onInfo, onClass, onCrop, onDelete, onCopy }: Props) {
  const many = (model.count ?? 1) > 1;
  const root = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: model.x, top: model.y });
  const [classes, setClasses] = useState(false);
  const [q, setQ] = useState("");

  // keep the menu inside the window
  useLayoutEffect(() => {
    const r = root.current?.getBoundingClientRect();
    if (!r) return;
    setPos({ left: Math.max(8, Math.min(model.x, window.innerWidth - r.width - 8)), top: Math.max(8, Math.min(model.y, window.innerHeight - r.height - 8)) });
  }, [model.x, model.y, classes]);

  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [onClose]);

  const shown = model.classes.filter((c) => c.name.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div className="ctx glass" ref={root} style={pos} role="menu" onContextMenu={(e) => e.preventDefault()}>
      {many ? (
        <div className="ctx-title muted small">{model.count} annotations selected</div>
      ) : (
        <button role="menuitem" onClick={onInfo}>
          Info…
        </button>
      )}
      <button role="menuitem" aria-expanded={classes} onClick={() => setClasses((c) => !c)} disabled={model.classes.length < 2}>
        Change class <span className="caret">{classes ? "▾" : "▸"}</span>
      </button>
      {classes && (
        <div className="ctx-sub">
          {model.classes.length > 7 && <input className="dd-filter" autoFocus placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} />}
          <div className="dd-list">
            {shown.map((c) => (
              <button key={c.id} role="menuitemradio" aria-checked={c.id === model.typeId} className={`dd-item ${c.id === model.typeId ? "checked" : ""}`} onClick={() => (c.id === model.typeId ? onClose() : onClass(c.id))}>
                <span className="swatch" style={{ background: c.color }} />
                <span className="dd-label">{c.name}</span>
                {c.key != null && <kbd>{c.key}</kbd>}
                {c.id === model.typeId && <span className="tick">✓</span>}
              </button>
            ))}
          </div>
        </div>
      )}
      {many && (
        <button role="menuitem" onClick={onCopy}>
          Copy
        </button>
      )}
      {!many && <button role="menuitem" onClick={onCrop} disabled={!model.canCrop} title={model.canCrop ? "Save the region of this annotation as a new image" : model.cropWhy}>
        Crop to new image…
      </button>}
      <hr />
      <button role="menuitem" className="danger" onClick={onDelete}>
        {many ? `Delete ${model.count} annotations…` : "Delete annotation…"}
      </button>
    </div>
  );
}
