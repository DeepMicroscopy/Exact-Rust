import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface TypeMenuModel {
  x: number;
  y: number;
  id: number;
  name: string;
  color: string;
  locked: boolean;
}

const PRESETS = ["#e6194b", "#f58231", "#ffe119", "#bfef45", "#3cb44b", "#42d4f4", "#4363d8", "#911eb4", "#f032e6", "#a9a9a9", "#ffffff", "#9a6324"];

/** The right-click menu of an annotation type in the viewer's side list: make it unclickable for now, and change its colour for good. */
export function TypeMenu({ model, canColor, onClose, onLock, onColor }: { model: TypeMenuModel; canColor: boolean; onClose(): void; onLock(locked: boolean): void; onColor(color: string): void }) {
  const root = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: model.x, top: model.y });
  const [custom, setCustom] = useState(model.color);
  useLayoutEffect(() => {
    const r = root.current?.getBoundingClientRect();
    if (r) setPos({ left: Math.max(8, Math.min(model.x, window.innerWidth - r.width - 8)), top: Math.max(8, Math.min(model.y, window.innerHeight - r.height - 8)) });
  }, [model.x, model.y]);
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
  const valid = /^#[0-9a-f]{6}$/i.test(custom);
  return (
    <div className="ctx glass" ref={root} style={pos} role="menu" data-testid="type-menu" onContextMenu={(e) => e.preventDefault()}>
      <div className="ctx-title muted small">{model.name}</div>
      <button role="menuitemcheckbox" aria-checked={model.locked} data-testid="type-lock" onClick={() => onLock(!model.locked)} title="Annotations of this type cannot be clicked, selected or moved until you switch this off, so that they do not get in the way of annotating on top of them">
        <span>{model.locked ? "Make clickable again" : "Make not clickable"}</span>
        {model.locked && <span className="tick">✓</span>}
      </button>
      {canColor && (
        <>
          <hr />
          <div className="ctx-title muted small">Colour (kept for everybody)</div>
          <div className="type-colors">
            {PRESETS.map((c) => (
              <button key={c} className={`type-color ${c.toLowerCase() === model.color.toLowerCase() ? "on" : ""}`} style={{ background: c }} aria-label={`Colour ${c}`} data-testid="type-color" onClick={() => onColor(c)} />
            ))}
          </div>
          <div className="type-custom">
            <input type="color" value={valid ? custom : "#cc4444"} onChange={(e) => setCustom(e.target.value)} aria-label="Other colour" data-testid="type-color-input" />
            <button className="btn" disabled={!valid || custom.toLowerCase() === model.color.toLowerCase()} onClick={() => onColor(custom)} data-testid="type-color-apply">Apply</button>
          </div>
        </>
      )}
    </div>
  );
}
