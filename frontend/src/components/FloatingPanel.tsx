import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

const MARGIN = 8;

function remembered(key: string): { x: number; y: number } | null {
  try {
    const o = JSON.parse(localStorage.getItem(key) ?? "null") as { x?: number; y?: number } | null;
    return o && typeof o.x === "number" && typeof o.y === "number" ? { x: o.x, y: o.y } : null;
  } catch {
    return null;
  }
}

/**
 * A small window that floats over the page and can be moved by its title (mouse, pen or finger). It stays inside the
 * window, remembers where it was put (`storageKey`) and does not block the page behind it.
 */
export function FloatingPanel({ title, onClose, storageKey, initial, children, className = "" }: { title: string; onClose(): void; storageKey: string; initial: { right: number; top: number }; children: ReactNode; className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(() => remembered(storageKey));
  const drag = useRef<{ dx: number; dy: number } | null>(null);

  const keep = useCallback((x: number, y: number) => {
    const r = box.current?.getBoundingClientRect();
    const [w, h] = [r?.width ?? 0, r?.height ?? 0];
    return { x: Math.max(MARGIN, Math.min(x, window.innerWidth - w - MARGIN)), y: Math.max(MARGIN, Math.min(y, window.innerHeight - h - MARGIN)) };
  }, []);

  // first placement: at the top right, below the bar; and back inside after the window shrank
  useLayoutEffect(() => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    setPos((p) => keep(p?.x ?? window.innerWidth - r.width - initial.right, p?.y ?? initial.top));
  }, [keep, initial.right, initial.top]);
  useEffect(() => {
    const resize = () => setPos((p) => (p ? keep(p.x, p.y) : p));
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [keep]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && box.current?.contains(document.activeElement)) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [onClose]);

  const down = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    drag.current = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const move = (e: React.PointerEvent) => {
    if (drag.current) setPos(keep(e.clientX - drag.current.dx, e.clientY - drag.current.dy));
  };
  const up = () => {
    if (!drag.current) return;
    drag.current = null;
    try {
      if (pos) localStorage.setItem(storageKey, JSON.stringify(pos));
    } catch {
      /* private mode */
    }
  };

  return (
    <div ref={box} className={`float-panel glass ${className}`} role="dialog" aria-label={title} style={pos ? { left: pos.x, top: pos.y } : { left: 0, top: 0, visibility: "hidden" }}>
      <header className="float-head" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} title="Drag to move">
        <span className="float-grip" aria-hidden="true">
          ⋮⋮
        </span>
        <h2>{title}</h2>
        <button className="btn ghost" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </header>
      <div className="float-body">{children}</div>
    </div>
  );
}
