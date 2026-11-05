import { useEffect, useState, type MutableRefObject } from "react";
import type OpenSeadragon from "openseadragon";
import { usePreferences } from "../hooks/usePreferences";
import { zoomFactor } from "../viewer-core/zoomStep";

const STEPS = 1000;

/** "37 %", "3.5 %": the zoom as screen pixels per image pixel in percent. */
export function formatZoom(z: number): string {
  const p = z * 100;
  return `${p >= 10 ? Math.round(p) : p >= 1 ? p.toFixed(1) : p.toFixed(2)} %`;
}

/** Slider position (0..STEPS) of a zoom between `min` and `max`: the scale is logarithmic, as zooming feels. */
export function zoomToPos(z: number, min: number, max: number): number {
  if (!(min > 0) || !(max > min) || !(z > 0)) return 0;
  return Math.min(STEPS, Math.max(0, Math.round((Math.log(z / min) / Math.log(max / min)) * STEPS)));
}

export function posToZoom(pos: number, min: number, max: number): number {
  return min * (max / min) ** (pos / STEPS);
}

/** A slider for the current zoom (top right of the viewer, an option of the personal settings): the zoom the viewer has now, in screen pixels per image pixel. */
export function ZoomSlider({ viewerRef }: { viewerRef: MutableRefObject<OpenSeadragon.Viewer | null> }) {
  // the viewer is created by an effect of the page, which runs after this component's: pick it up once it exists
  const { prefs } = usePreferences();
  const [viewer, setViewer] = useState<OpenSeadragon.Viewer | null>(null);
  const [state, setState] = useState<{ z: number; min: number; max: number } | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setViewer(viewerRef.current));
    return () => clearTimeout(t);
  }, [viewerRef]);
  useEffect(() => {
    if (!viewer) return;
    const update = () => {
      if (!viewer.world.getItemCount()) return setState(null);
      const item = viewer.world.getItemAt(0);
      const vp = viewer.viewport;
      const [z, min, max] = [vp.getZoom(true), vp.getMinZoom(), vp.getMaxZoom()].map((v) => item.viewportToImageZoom(v));
      setState((old) => (old && old.z === z && old.min === min && old.max === max ? old : { z, min, max }));
    };
    update();
    // "zoom" fires when a zoom is asked for, before the animation has moved: the value follows the animation
    const events = ["zoom", "animation", "animation-finish", "open", "resize"] as const;
    for (const e of events) viewer.addHandler(e, update);
    return () => {
      for (const e of events) viewer.removeHandler(e, update);
    };
  }, [viewer]);
  if (!viewer || !state || !(state.max > state.min)) return null;
  const setZoom = (z: number) => {
    if (!viewer.world.getItemCount()) return;
    viewer.viewport.zoomTo(viewer.world.getItemAt(0).imageToViewportZoom(z));
    viewer.viewport.applyConstraints();
  };
  const zoomBy = (zoomIn: boolean) => {
    viewer.viewport.zoomBy(zoomFactor(prefs.zoom_step, zoomIn));
    viewer.viewport.applyConstraints();
  };
  return (
    <div className="zoom-slider glass" role="group" aria-label="Zoom" data-testid="zoom-slider">
      <button className="btn ghost" title="Zoom out (−)" aria-label="Zoom out" onClick={() => zoomBy(false)}>
        −
      </button>
      <input
        type="range"
        min={0}
        max={STEPS}
        step={1}
        value={zoomToPos(state.z, state.min, state.max)}
        onChange={(e) => setZoom(posToZoom(Number(e.target.value), state.min, state.max))}
        aria-label="Zoom level"
        aria-valuetext={formatZoom(state.z)}
        data-testid="zoom-slider-input"
      />
      <button className="btn ghost" title="Zoom in (+)" aria-label="Zoom in" onClick={() => zoomBy(true)}>
        +
      </button>
      <button className="zoom-value" title="Zoom to 100 % (one screen pixel per image pixel)" onClick={() => setZoom(1)} data-testid="zoom-value">
        {formatZoom(state.z)}
      </button>
    </div>
  );
}
