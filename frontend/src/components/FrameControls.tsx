import { useId } from "react";
import { formatZ, positionAt, type ZRange } from "../viewer-core/zFormat";

interface Common {
  frames: number;
  /** (fractional) frame position */
  value: number;
  onChange(v: number): void;
  labels: string[];
}

/**
 * Vertical slider on the right-hand side for the planes of a microscopy z-stack (`blend`: continuous, the viewer
 * cross-fades the planes) or the slices of a radiology volume (discrete steps). The top of the slider is the last plane.
 * The ends show the real positions of the first and the last plane when the file knows them.
 */
export function ZSlider({ frames, value, onChange, labels, zRange, blend }: Common & { zRange: ZRange | null; blend: boolean }) {
  const id = useId();
  const nearest = Math.round(value);
  const first = zRange ? formatZ(zRange.start, zRange.unit) : (labels[0] ?? "1");
  const last = zRange ? formatZ(zRange.end, zRange.unit) : (labels[frames - 1] ?? String(frames));
  const current = zRange ? formatZ(positionAt(zRange, value), zRange.unit) : (labels[nearest] ?? `${nearest + 1}`);
  return (
    <div className={`zslider glass ${blend ? "blend" : ""}`} role="group" aria-label={blend ? "Focus plane" : "Slice"}>
      <div className="zslider-end" title="last plane">
        {last}
      </div>
      <input
        id={id}
        type="range"
        min={0}
        max={Math.max(frames - 1, 0)}
        step={blend ? "any" : 1}
        value={value}
        aria-valuetext={current}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <div className="zslider-end" title="first plane">
        {first}
      </div>
      <div className="zslider-current">
        <strong>{current}</strong>
        <span className="muted small">
          {nearest + 1} / {frames}
        </span>
      </div>
    </div>
  );
}

/** Horizontal slider at the bottom for the frames of a movie or time series. */
export function TimeSlider({ frames, value, onChange, labels }: Common) {
  const nearest = Math.round(value);
  return (
    <footer className="viewer-foot glass" role="group" aria-label="Frame">
      <span className="muted small time-end">{labels[0] ?? "1"}</span>
      <input type="range" min={0} max={Math.max(frames - 1, 0)} step={1} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="muted small time-end">{labels[frames - 1] ?? String(frames)}</span>
      <span className="time-current">
        <strong>{labels[nearest] ?? nearest + 1}</strong>
        <span className="muted small">
          {" "}
          Frame {nearest + 1} / {frames}
        </span>
      </span>
    </footer>
  );
}
