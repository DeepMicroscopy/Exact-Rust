import { useEffect, useState, type MutableRefObject } from "react";
import type OpenSeadragon from "openseadragon";

/** The longest "round" length (1, 2 or 5 times a power of ten, in µm) that is at most `um`. */
export function niceLength(um: number): number {
  if (!(um > 0)) return 0;
  const pow = 10 ** Math.floor(Math.log10(um));
  const m = um / pow;
  return pow * (m >= 5 ? 5 : m >= 2 ? 2 : 1);
}

export function formatScale(um: number): string {
  return um >= 1000 ? `${um / 1000} mm` : `${um} µm`;
}

/** A scale bar at the bottom left of the viewer: as long as `maxPx` screen pixels allow, for the zoom the viewer has now. */
export function ScaleBar({ viewerRef, mpp, maxPx = 140 }: { viewerRef: MutableRefObject<OpenSeadragon.Viewer | null>; mpp: number; maxPx?: number }) {
  const [bar, setBar] = useState<{ px: number; label: string } | null>(null);
  // the viewer is created by an effect of the page, which runs after this component's: pick it up once it exists
  const [viewer, setViewer] = useState<OpenSeadragon.Viewer | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setViewer(viewerRef.current));
    return () => clearTimeout(t);
  }, [viewerRef]);
  useEffect(() => {
    if (!(mpp > 0) || !viewer) return;
    const update = () => {
      if (!viewer.world.getItemCount()) return setBar(null);
      const perPx = viewer.world.getItemAt(0).viewportToImageZoom(viewer.viewport.getZoom(true)); // screen pixels per image pixel
      if (!(perPx > 0)) return setBar(null);
      const um = niceLength((maxPx / perPx) * mpp);
      const px = um > 0 ? (um / mpp) * perPx : 0;
      setBar((old) => (um > 0 && old?.px === px ? old : um > 0 ? { px, label: formatScale(um) } : null));
    };
    update();
    viewer.addHandler("zoom", update);
    viewer.addHandler("open", update);
    viewer.addHandler("resize", update);
    return () => {
      viewer.removeHandler("zoom", update);
      viewer.removeHandler("open", update);
      viewer.removeHandler("resize", update);
    };
  }, [viewer, mpp, maxPx]);
  if (!bar) return null;
  return (
    <div className="scale-bar" data-testid="scale-bar" aria-label={`Scale: ${bar.label}`}>
      <span>{bar.label}</span>
      <i style={{ width: bar.px }} />
    </div>
  );
}
