import { FloatingPanel } from "./FloatingPanel";
import { GAMMA_FILTER_ID, isNeutral, NEUTRAL, type Adjust } from "../viewer-core/adjust";

/** The icon of the top bar: a circle half filled (the usual sign of contrast). A dot shows that something is changed. */
export function AdjustButton({ open, active, onClick }: { open: boolean; active: boolean; onClick(): void }) {
  return (
    <button className={`btn ghost icon-btn adjust-btn ${open ? "on" : ""}`} onClick={onClick} aria-pressed={open} aria-label="Image adjustments" title={active ? "Image adjustments (changed)" : "Image adjustments: brightness, contrast, ..."}>
      <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path d="M10 2.5a7.5 7.5 0 0 1 0 15z" fill="currentColor" />
      </svg>
      {active && <span className="adjust-dot" aria-hidden="true" />}
    </button>
  );
}

/** The gamma curve as an SVG filter, which CSS filters can refer to (they have no gamma of their own). */
export function GammaFilter({ gamma }: { gamma: number }) {
  const e = 1 / gamma;
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true" focusable="false">
      <filter id={GAMMA_FILTER_ID} colorInterpolationFilters="sRGB">
        <feComponentTransfer>
          <feFuncR type="gamma" amplitude="1" exponent={e} offset="0" />
          <feFuncG type="gamma" amplitude="1" exponent={e} offset="0" />
          <feFuncB type="gamma" amplitude="1" exponent={e} offset="0" />
        </feComponentTransfer>
      </filter>
    </svg>
  );
}

interface Slider {
  key: "brightness" | "contrast" | "saturation" | "gamma" | "hue";
  label: string;
  min: number;
  max: number;
  step: number;
  show(v: number): string;
}

const SLIDERS: Slider[] = [
  { key: "brightness", label: "Brightness", min: 0, max: 200, step: 1, show: (v) => `${v} %` },
  { key: "contrast", label: "Contrast", min: 0, max: 200, step: 1, show: (v) => `${v} %` },
  { key: "gamma", label: "Gamma", min: 0.3, max: 3, step: 0.01, show: (v) => v.toFixed(2) },
  { key: "saturation", label: "Saturation", min: 0, max: 300, step: 1, show: (v) => `${v} %` },
  { key: "hue", label: "Hue", min: -180, max: 180, step: 1, show: (v) => `${v > 0 ? "+" : ""}${v}°` },
];

/** The movable window with the sliders. What it changes is how the image is shown; the file and the annotations stay as they are. */
export function ImageAdjustPanel({ value, onChange, onClose }: { value: Adjust; onChange(a: Adjust): void; onClose(): void }) {
  return (
    <FloatingPanel title="Image adjustments" onClose={onClose} storageKey="exact.adjust.pos" initial={{ right: 16, top: 64 }} className="adjust-panel">
      {SLIDERS.map((s) => (
        <label key={s.key} className="adjust-row">
          <span className="adjust-label" onDoubleClick={() => onChange({ ...value, [s.key]: NEUTRAL[s.key] })} title="Double-click to reset">
            {s.label}
          </span>
          <input
            type="range"
            min={s.min}
            max={s.max}
            step={s.step}
            value={value[s.key]}
            onChange={(e) => onChange({ ...value, [s.key]: Number(e.target.value) })}
            onPointerUp={(e) => (e.target as HTMLElement).blur()} // arrow keys belong to the viewer again
            onDoubleClick={() => onChange({ ...value, [s.key]: NEUTRAL[s.key] })}
          />
          <output className="adjust-val">{s.show(value[s.key])}</output>
        </label>
      ))}
      <div className="adjust-checks">
        <label className="check">
          <input type="checkbox" checked={value.grayscale} onChange={(e) => onChange({ ...value, grayscale: e.target.checked })} /> Grayscale
        </label>
        <label className="check">
          <input type="checkbox" checked={value.invert} onChange={(e) => onChange({ ...value, invert: e.target.checked })} /> Invert
        </label>
        <span className="spacer" />
        <button className="btn" onClick={() => onChange({ ...NEUTRAL })} disabled={isNeutral(value)}>
          Reset
        </button>
      </div>
    </FloatingPanel>
  );
}
