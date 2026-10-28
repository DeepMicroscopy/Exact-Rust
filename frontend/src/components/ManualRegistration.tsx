import { useEffect, useRef, useState } from "react";
import OpenSeadragon from "openseadragon";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { Page } from "../api/client";
import type { Registration } from "../api/types";
import { loadTileSource } from "../viewer-core/tileSource";

export interface PointPair {
  source: [number, number];
  target: [number, number];
}

/** One image in which points are clicked; `points` are shown as numbered markers. */
function PointViewer({ imageId, points, label, active, onPick }: { imageId: number; points: [number, number][]; label: string; active: boolean; onPick(p: [number, number]): void }) {
  const host = useRef<HTMLDivElement>(null);
  const viewer = useRef<OpenSeadragon.Viewer | null>(null);
  const pick = useRef(onPick);
  pick.current = onPick;
  const act = useRef(active);
  act.current = active;
  const [ready, setReady] = useState(0);
  const [hover, setHover] = useState<[number, number] | null>(null);

  useEffect(() => {
    if (!host.current) return;
    const v = OpenSeadragon({ element: host.current, prefixUrl: "", showNavigationControl: false, showNavigator: true, navigatorPosition: "BOTTOM_RIGHT", gestureSettingsMouse: { clickToZoom: false }, maxZoomPixelRatio: 8, animationTime: 0.2 });
    viewer.current = v;
    (window as unknown as Record<string, unknown>)[`__reg_${label}`] = v; // used by the e2e tests
    (window as unknown as Record<string, unknown>).__osd = OpenSeadragon;
    v.addHandler("canvas-key", (e) => {
      e.preventDefaultAction = true;
    });
    v.addHandler("canvas-click", (e) => {
      const item = v.world.getItemAt(0);
      if (!e.quick || !item || !act.current) return;
      const p = item.viewerElementToImageCoordinates(e.position);
      pick.current([Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10]);
    });
    let gone = false;
    loadTileSource(imageId, 0, 0).then((ts) => {
      if (gone) return;
      v.addTiledImage({ tileSource: ts as OpenSeadragon.TileSourceOptions, success: () => setReady((n) => n + 1) });
    });
    return () => {
      gone = true;
      v.destroy();
      viewer.current = null;
    };
  }, [imageId, label]);

  useEffect(() => {
    const v = viewer.current;
    const item = v?.world.getItemCount() ? v.world.getItemAt(0) : null;
    if (!v || !item) return;
    v.clearOverlays();
    points.forEach((p, i) => {
      const el = document.createElement("div");
      el.className = "reg-marker";
      el.textContent = String(i + 1);
      v.addOverlay(el, item.imageToViewportCoordinates(p[0], p[1]), OpenSeadragon.Placement.CENTER);
    });
  }, [points, ready]);

  return (
    <div className={`reg-viewer ${active ? "active" : ""}`}>
      <div className="reg-viewer-title">{label}</div>
      <div
        className="reg-stage"
        onPointerMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setHover([e.clientX - r.left, e.clientY - r.top]);
        }}
        onPointerLeave={() => setHover(null)}
      >
        <div ref={host} className="osd" data-testid={`reg-viewer-${label}`} />
        {active && hover && (
          <div className="crosshair" aria-hidden="true" data-testid={`crosshair-${label}`}>
            <i className="h" style={{ top: hover[1] }} />
            <i className="v" style={{ left: hover[0] }} />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Registers two images by hand: a point is clicked in the source image, then the same spot in the target image, and so on.
 * One pair gives a shift, two a shift, scale and rotation, three or more an affine map (least squares). Saving replaces
 * the registration of the pair.
 */
export function ManualRegistration({ source, target, names, onClose, onSaved }: { source: number; target: number; names: [string, string]; onClose(): void; onSaved(): void }) {
  const [pairs, setPairs] = useState<PointPair[]>([]);
  const [pending, setPending] = useState<[number, number] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<Registration | null>(null);
  const [inverse, setInverse] = useState(true);
  const existing = useQuery({ queryKey: ["registration-exists", source, target], queryFn: async () => (await api<Page<Registration>>(`/api/v2/registrations?source_image=${source}&target_image=${target}`)).items[0] ?? null });

  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (pendingRef.current) setPending(null);
      else closeRef.current();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, []);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<Registration>("/api/v2/registrations/manual", { json: { source_image: source, target_image: target, points: pairs, inverse } });
      setSaved(r);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const hint = pending ? `Now click the same spot in “${names[1]}” (right).` : pairs.length ? `Point ${pairs.length + 1}: click a distinctive spot in “${names[0]}” (left).` : `Click a distinctive spot in “${names[0]}” (left), then the same spot in “${names[1]}” (right).`;
  return (
    <div className="reg-full" role="dialog" aria-modal="true" aria-label="Register manually">
      <header>
        <h2>Register manually</h2>
        <span className="spacer" />
        <button className="btn ghost" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </header>
      <p className="muted small">{hint} More points make it more accurate; with three or more it also corrects shear.</p>
      <div className="reg-viewers">
        <PointViewer imageId={source} label="source" points={[...pairs.map((p) => p.source), ...(pending ? [pending] : [])]} active={!pending} onPick={setPending} />
        <PointViewer
          imageId={target}
          label="target"
          points={pairs.map((p) => p.target)}
          active={!!pending}
          onPick={(t) => {
            if (!pending) return;
            setPairs((ps) => [...ps, { source: pending, target: t }]);
            setPending(null);
            setSaved(null);
          }}
        />
      </div>
      <div className="reg-pairs">
        {pairs.map((p, i) => (
          <span key={i} className="chip">
            {i + 1}: ({Math.round(p.source[0])}, {Math.round(p.source[1])}) → ({Math.round(p.target[0])}, {Math.round(p.target[1])})
            <button className="btn ghost small" aria-label={`Remove point ${i + 1}`} onClick={() => setPairs((ps) => ps.filter((_, j) => j !== i))}>
              ×
            </button>
          </span>
        ))}
        {pending && (
          <button className="btn ghost small" onClick={() => setPending(null)}>
            Cancel the point
          </button>
        )}
      </div>
      {existing.data && !saved && <p className="warn small">A registration of this pair exists already; saving replaces it.</p>}
      <label className="check">
        <input type="checkbox" checked={inverse} onChange={(e) => setInverse(e.target.checked)} /> Also create the inverse registration
      </label>
      {saved && (
        <p className="ok" data-testid="manual-saved">
          Saved: mean error {saved.registration_error.toFixed(2)} px{saved.rotation_angle != null ? `, rotation ${saved.rotation_angle.toFixed(1)}°` : ""}. Add more points and save again to refine it.
        </p>
      )}
      {error && <p className="error">{error}</p>}
      <div className="reg-full-actions">
        <button className="btn ghost" onClick={onClose}>
          {saved ? "Close" : "Cancel"}
        </button>
        <button className="btn primary" onClick={() => void save()} disabled={busy || pairs.length === 0 || !!pending}>
          Save registration
        </button>
      </div>
    </div>
  );
}
