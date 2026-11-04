import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { useRegisteredImages } from "../hooks/useRegisteredImages";
import { usePreferences } from "../hooks/usePreferences";
import type OpenSeadragon from "openseadragon";
import { Ring } from "./UploadTile";
import { overlayPlacement, RegistrationOverlay } from "../viewer-core/overlay";

/**
 * The images registered with the current one (in either direction), one of which can be shown on top of it. Renders
 * nothing when there is no registration. Mount it with `key={imageId}` so that the choice does not carry over.
 */
/** Sent by the O key: the overlay image on / off. */
export const OVERLAY_TOGGLE = "exact:overlay-toggle";

export function OverlayControl({ viewerRef, imageId, width }: { viewerRef: MutableRefObject<OpenSeadragon.Viewer | null>; imageId: number; width: number }) {
  const [picked, setPicked] = useState<number | null>(null);
  const { prefs } = usePreferences();
  const start = prefs.overlay_opacity / 100;
  const [opacity, setOpacity] = useState(start);
  // the setting may arrive after the control is mounted; the slider is only followed until it has been used
  const touched = useRef(false);
  useEffect(() => {
    if (!touched.current) setOpacity(start);
  }, [start]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const overlay = useRef<RegistrationOverlay | null>(null);
  const lastOpacity = useRef(start);
  const live = useRef({ picked, opacity });
  live.current = { picked, opacity };
  const startRef = useRef(start);
  startRef.current = start;
  useEffect(() => {
    const toggle = () => {
      const { picked: p, opacity: o } = live.current;
      if (p == null) return;
      if (o > 0) {
        lastOpacity.current = o;
        setOpacity(0);
      } else setOpacity(lastOpacity.current || startRef.current || 0.5);
    };
    window.addEventListener(OVERLAY_TOGGLE, toggle);
    return () => window.removeEventListener(OVERLAY_TOGGLE, toggle);
  }, []);

  const regs = useRegisteredImages(imageId);
  const candidates = regs.data;
  // "Auto-enable first overlay" (a setting of the account): the only registered image is shown when the image opens
  const autoDone = useRef<number | null>(null);
  useEffect(() => {
    if (!prefs.auto_overlay || !candidates || autoDone.current === imageId) return;
    autoDone.current = imageId;
    if (candidates.length === 1) setPicked(candidates[0].id);
  }, [prefs.auto_overlay, candidates, imageId]);
  const chosen = useMemo(() => candidates?.find((c) => c.id === picked) ?? null, [candidates, picked]);

  const opacityRef = useRef(opacity);
  opacityRef.current = opacity;
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !chosen) return;
    setError(null);
    const o = new RegistrationOverlay(viewer, chosen.id, overlayPlacement(chosen.map, chosen.width, chosen.height, width), opacityRef.current, (e) => setError(e.message), setLoading);
    overlay.current = o;
    (window as unknown as { __overlay?: RegistrationOverlay | null }).__overlay = o; // used by the e2e tests
    return () => {
      setLoading(false);
      o.destroy();
      overlay.current = null;
    };
  }, [chosen, viewerRef, width]);
  useEffect(() => overlay.current?.setOpacity(opacity), [opacity]);

  if (!candidates?.length) return null;
  return (
    <div className="overlay-control" data-testid="overlay-control">
      <label className="muted small" htmlFor="overlay-pick">
        Overlay
      </label>
      <select id="overlay-pick" value={picked ?? ""} onChange={(e) => setPicked(e.target.value ? Number(e.target.value) : null)} title="Show a registered image on top of this one (O switches it on and off)">
        <option value="">none</option>
        {candidates.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      {chosen && (
        <input type="range" min={0} max={1} step={0.05} value={opacity} onChange={(e) => {
            touched.current = true;
            setOpacity(Number(e.target.value));
          }} aria-label="Overlay opacity" title={`Opacity ${Math.round(opacity * 100)} %`} />
      )}
      {chosen && loading && (
        <span className="overlay-loading" role="status" aria-label="Loading the overlay" data-testid="overlay-loading">
          <Ring progress={0} spinning />
        </span>
      )}
      {error && <span className="error small">{error}</span>}
    </div>
  );
}
