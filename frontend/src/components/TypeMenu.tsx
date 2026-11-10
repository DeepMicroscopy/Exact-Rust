import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface TypeMenuModel {
  x: number;
  y: number;
  id: number;
  name: string;
  color: string;
  locked: boolean;
}

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
  // the picker reports every step while it is dragged; the colour is saved when it is let go ("change")
  const pick = useRef<HTMLInputElement>(null);
  const done = useRef(onColor);
  done.current = onColor;
  useEffect(() => {
    const el = pick.current;
    const f = () => done.current(el!.value);
    el?.addEventListener("change", f);
    return () => el?.removeEventListener("change", f);
  }, [canColor]);
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
          <label className="type-custom">
            <input ref={pick} type="color" value={/^#[0-9a-f]{6}$/i.test(custom) ? custom : "#cc4444"} onChange={(e) => setCustom(e.target.value)} aria-label="Type colour" data-testid="type-color-input" />
            <span className="muted small">{custom}</span>
          </label>
        </>
      )}
    </div>
  );
}
