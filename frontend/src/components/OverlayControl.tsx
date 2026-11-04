import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import type OpenSeadragon from "openseadragon";
import { api } from "../api/client";
import type { Page } from "../api/client";
import type { Registration } from "../api/types";
import { Ring } from "./UploadTile";
import { affineOf, invertAffine, overlayPlacement, RegistrationOverlay, type Affine } from "../viewer-core/overlay";

interface Other {
  id: number;
  name: string;
  width: number;
  height: number;
}

interface Candidate extends Other {
  /** maps the pixels of this image to the pixels of the current one */
  map: Affine;
}

/**
 * The images registered with the current one (in either direction), one of which can be shown on top of it. Renders
 * nothing when there is no registration. Mount it with `key={imageId}` so that the choice does not carry over.
 */
/** Sent by the O key: the overlay image on / off. */
export const OVERLAY_TOGGLE = "exact:overlay-toggle";

export function OverlayControl({ viewerRef, imageId, width }: { viewerRef: MutableRefObject<OpenSeadragon.Viewer | null>; imageId: number; width: number }) {
  const [picked, setPicked] = useState<number | null>(null);
  const [opacity, setOpacity] = useState(0.5);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const overlay = useRef<RegistrationOverlay | null>(null);
  const lastOpacity = useRef(0.5);
  const live = useRef({ picked, opacity });
  live.current = { picked, opacity };
  useEffect(() => {
    const toggle = () => {
      const { picked: p, opacity: o } = live.current;
      if (p == null) return;
      if (o > 0) {
        lastOpacity.current = o;
        setOpacity(0);
      } else setOpacity(lastOpacity.current || 0.5);
    };
    window.addEventListener(OVERLAY_TOGGLE, toggle);
    return () => window.removeEventListener(OVERLAY_TOGGLE, toggle);
  }, []);

  const regs = useQuery({
    queryKey: ["overlay-registrations", imageId],
    queryFn: async () => {
      const [a, b] = await Promise.all([
        api<Page<Registration>>(`/api/v2/registrations?source_image__in=${imageId}&limit=1000`),
        api<Page<Registration>>(`/api/v2/registrations?target_image__in=${imageId}&limit=1000`),
      ]);
      const ids = [...new Set([...a.items, ...b.items].flatMap((r) => [r.source_image, r.target_image]))].filter((i) => i !== imageId);
      const images = ids.length ? (await api<Page<Other>>(`/api/v2/images?id__in=${ids.join(",")}&fields=id,name,width,height&limit=1000`)).items : [];
      const byId = new Map(images.map((i) => [i.id, i]));
      const out = new Map<number, Candidate>();
      // the registration onto this image is used as it is, the other direction is inverted
      for (const r of [...a.items, ...b.items]) {
        const m = r.transformation_matrix && affineOf(r.transformation_matrix);
        if (!m) continue;
        const direct = r.target_image === imageId;
        const other = byId.get(direct ? r.source_image : r.target_image);
        const map = direct ? m : invertAffine(m);
        if (!other || !map || (!direct && out.has(other.id))) continue;
        out.set(other.id, { ...other, map });
      }
      return [...out.values()].sort((x, y) => x.name.localeCompare(y.name));
    },
  });
  const candidates = regs.data;
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
        <input type="range" min={0} max={1} step={0.05} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} aria-label="Overlay opacity" title={`Opacity ${Math.round(opacity * 100)} %`} />
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
