import { useEffect, useRef, useState } from "react";
import { usePen } from "../viewer-core/pen";

const SIDE = "exact.penTools.side";
const read = (): "left" | "right" => {
  try {
    return localStorage.getItem(SIDE) === "right" ? "right" : "left";
  } catch {
    return "left";
  }
};

/**
 * Two round buttons at the edge of the screen for the hand that does not draw, there once a pen has been used and while the pen is a brush
 * (nothing selected, or a polygon): one switches the brush between adding and subtracting, the other shows its size and opens a vertical
 * slider. A browser gets neither the squeeze nor the double tap of an Apple Pencil, so these stay on the screen.
 */
export function PenTools(p: { show: boolean; mode: "add" | "erase"; radius: number; on: { toggle(): void; radius(r: number): void } }) {
  const { seen } = usePen();
  const [side, setSide] = useState<"left" | "right">(read);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", away, true);
    return () => window.removeEventListener("pointerdown", away, true);
  }, [open]);
  if (!seen || !p.show) return null;
  const erase = p.mode === "erase";
  const ring = Math.min(36, Math.max(8, p.radius * 0.6));
  return (
    <div ref={box} className={`pen-tools ${side}`} data-testid="pen-tools">
      <button className={`pt-round pt-mode ${erase ? "erase" : "add"}`} onClick={p.on.toggle} aria-label={erase ? "The pen subtracts (tap to add)" : "The pen adds (tap to subtract)"} title={erase ? "Subtracting: tap to add" : "Adding: tap to subtract"}>
        {erase ? "−" : "+"}
      </button>
      <button className="pt-round pt-size" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label="Brush size" title="Brush size">
        <span className="pt-ring" style={{ width: ring, height: ring }} />
      </button>
      {open && (
        <div className="pt-pop glass">
          <div className="pt-slider">
            <input type="range" min={4} max={120} value={Math.round(p.radius)} onChange={(e) => p.on.radius(Number(e.target.value))} aria-label="Brush size" />
          </div>
          <button
            className="btn pt-flip"
            onClick={() => {
              const next = side === "left" ? "right" : "left";
              setSide(next);
              try {
                localStorage.setItem(SIDE, next);
              } catch {
                /* the choice lasts until the page is left */
              }
            }}
            aria-label="Other side"
            title="Move these buttons to the other side"
          >
            ⇄
          </button>
        </div>
      )}
    </div>
  );
}
