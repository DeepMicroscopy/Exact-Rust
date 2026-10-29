import { useState } from "react";
import type { BrushMode } from "../viewer-core/editor";
import { usePen } from "../viewer-core/pen";

const SIDE = "exact.penPalette.side";
const OPEN = "exact.penPalette.open";
const read = (key: string, fallback: string): string => {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
};
const write = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private window: the choice lasts until the page is left */
  }
};

/**
 * The palette a pen user reaches with the free hand: what the pen does next, and the size of the brush. A browser gets neither the squeeze
 * nor the double tap of an Apple Pencil, so it stays on the screen once a pen has been used, at the edge of the hand that does not draw.
 *
 *  - New: the pen draws new annotations, or selects, as the toolbox says (brush off)
 *  - Add / Subtract: the pen paints onto the selected polygon, or erases from it (the brush of the toolbox, kept for the next strokes)
 */
export function PenPalette(p: { mode: BrushMode; radius: number; reshapable: boolean; on: { mode(m: BrushMode): void; radius(r: number): void } }) {
  const { seen } = usePen();
  const [side, setSide] = useState<"left" | "right">(() => (read(SIDE, "left") === "right" ? "right" : "left"));
  const [open, setOpen] = useState(() => read(OPEN, "1") !== "0");
  if (!seen) return null;
  const toggle = (next: boolean) => {
    setOpen(next);
    write(OPEN, next ? "1" : "0");
  };
  if (!open)
    return (
      <button className={`pen-palette-handle btn glass ${side}`} data-testid="pen-palette-open" onClick={() => toggle(true)} title="Pen palette" aria-label="Open the pen palette">
        ✎
      </button>
    );
  const modes: { id: BrushMode; label: string; title: string }[] = [
    { id: "off", label: "New", title: "Draw new annotations (or select), no brush" },
    { id: "add", label: "Add", title: "Paint area onto the selected polygon" },
    { id: "erase", label: "Subtract", title: "Erase area from the selected polygon" },
  ];
  return (
    <aside className={`pen-palette glass ${side}`} data-testid="pen-palette" aria-label="Pen palette">
      <div className="pp-modes" role="group" aria-label="What the pen does">
        {modes.map((m) => (
          <button key={m.id} className={`pp-mode ${p.mode === m.id ? "active" : ""}`} aria-pressed={p.mode === m.id} title={m.title} onClick={() => p.on.mode(m.id)}>
            {m.label}
          </button>
        ))}
      </div>
      {p.mode !== "off" && (
        <div className="pp-size">
          <span className="pp-ring" style={{ width: Math.max(6, p.radius), height: Math.max(6, p.radius) }} aria-hidden />
          <input type="range" min={4} max={120} value={Math.round(p.radius)} onChange={(e) => p.on.radius(Number(e.target.value))} aria-label="Brush size" />
        </div>
      )}
      {p.mode !== "off" && !p.reshapable && <p className="pp-note">Select a polygon to paint on it.</p>}
      <div className="pp-foot">
        <button
          className="btn pp-small"
          onClick={() => {
            const next = side === "left" ? "right" : "left";
            setSide(next);
            write(SIDE, next);
          }}
          title="Move the palette to the other side (for the other hand)"
          aria-label="Other side"
        >
          ⇄
        </button>
        <button className="btn pp-small" onClick={() => toggle(false)} title="Hide the palette" aria-label="Hide the pen palette">
          ✕
        </button>
      </div>
    </aside>
  );
}
