import { useEffect, useId, useRef, useState } from "react";
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

const PRESETS = [1, 2, 5, 10, 15, 24, 25, 30, 50, 60];

interface Playback {
  playing: boolean;
  onPlay(): void;
  /** frames per second in use */
  fps: number;
  /** the speed the movie was recorded at, if the file says */
  nativeFps: number | null;
  /** `null`: the movie's own speed */
  onFps(fps: number | null): void;
}

/** Play / pause; a right click chooses the speed (presets, the movie's own, or any number). */
function PlayButton({ playing, onPlay, fps, nativeFps, onFps }: Playback) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [custom, setCustom] = useState("");
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setMenu(null);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setMenu(null);
      }
    };
    document.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [menu]);
  const choose = (v: number | null) => {
    onFps(v);
    setMenu(null);
  };
  return (
    <div className="play" ref={root}>
      <button
        className={`btn play-btn ${playing ? "primary" : ""}`}
        onClick={onPlay}
        onContextMenu={(e) => {
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          setMenu({ x: r.left, y: r.top });
        }}
        title={`${playing ? "Pause" : "Play"} (Space) · ${fps.toFixed(fps % 1 ? 1 : 0)} frames per second · right click: speed`}
        aria-label={playing ? "Pause" : "Play"}
      >
        {playing ? "❚❚" : "▶"}
      </button>
      {menu && (
        <div className="ctx glass fps-menu" style={{ left: menu.x, bottom: window.innerHeight - menu.y + 8, top: "auto" }} role="menu">
          <div className="muted small fps-title">Frames per second</div>
          {nativeFps != null && (
            <button role="menuitemradio" aria-checked={Math.abs(fps - nativeFps) < 1e-6} onClick={() => choose(null)}>
              Movie's own ({nativeFps.toFixed(nativeFps % 1 ? 2 : 0)}) {Math.abs(fps - nativeFps) < 1e-6 && <span className="tick">✓</span>}
            </button>
          )}
          {PRESETS.map((p) => (
            <button key={p} role="menuitemradio" aria-checked={fps === p} onClick={() => choose(p)}>
              {p} {fps === p && <span className="tick">✓</span>}
            </button>
          ))}
          <form
            className="fps-custom"
            onSubmit={(e) => {
              e.preventDefault();
              const v = Number(custom.replace(",", "."));
              if (v > 0 && v <= 240) choose(v);
            }}
          >
            <input inputMode="decimal" placeholder="other…" value={custom} onChange={(e) => setCustom(e.target.value)} aria-label="Frames per second" />
            <button className="btn" type="submit">
              OK
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

/** Horizontal slider at the bottom for the frames of a movie or time series, with play / pause on its left. */
export function TimeSlider({ frames, value, onChange, labels, playback }: Common & { playback?: Playback }) {
  const nearest = Math.round(value);
  return (
    <footer className="viewer-foot glass" role="group" aria-label="Frame">
      {playback && <PlayButton {...playback} />}
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
