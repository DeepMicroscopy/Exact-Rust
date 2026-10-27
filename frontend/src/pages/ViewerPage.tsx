import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import OpenSeadragon from "openseadragon";
import { api, listAll } from "../api/client";
import type { Annotation, AnnotationType, ImageSummary } from "../api/types";
import { AnnotationLayer } from "../viewer-core/annotationLayer";
import { toShape } from "../viewer-core/shapes";
import { loadTileSource } from "../viewer-core/tileSource";
import { ZBlender } from "../viewer-core/zBlend";
import type { ZRange } from "../viewer-core/zFormat";
import { RepairBanner } from "../components/RepairBanner";
import { TimeSlider, ZSlider } from "../components/FrameControls";
import type { Shape, TypeStyle } from "../viewer-core/types";

const PLANES = ["Axial", "Coronal", "Sagittal"];

type FrameKind = "none" | "zstack" | "volume" | "timeseries";

interface Meta {
  frames: number;
  issues?: string[];
  frame_kind?: FrameKind;
  frame_labels?: string[];
  z_range?: ZRange | null;
  planes: { plane: number; name: string; frames: number; frame_descriptors: string[] }[] | null;
}

const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

export function ViewerPage() {
  const { imageId } = useParams();
  const id = Number(imageId);
  const navigate = useNavigate();
  const host = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<OpenSeadragon.Viewer | null>(null);
  const layerRef = useRef<AnnotationLayer | null>(null);
  const blenderRef = useRef<ZBlender | null>(null);
  const [pos, setPosState] = useState(0); // (fractional) frame position
  const posRef = useRef(0);
  const anim = useRef(0);
  const [plane, setPlane] = useState(0);
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const image = useQuery({
    queryKey: ["image", id],
    queryFn: () => api<ImageSummary>(`/api/v2/images/${id}?fields=id,name,width,height,frames,depth,image_set`),
  });
  const meta = useQuery({ queryKey: ["image-meta", id], queryFn: () => api<Meta>(`/api/v2/images/${id}/metadata`) });
  const types = useQuery({ queryKey: ["annotation-types"], queryFn: () => listAll<AnnotationType>("/api/v2/annotation-types", { fields: "id,name,vector_type,color_code,closed" }) });
  const annotations = useQuery({
    queryKey: ["annotations", id],
    queryFn: () => listAll<Annotation>("/api/v2/annotations", { image: id, deleted: false, fields: "id,annotation_type,vector,image" }),
  });

  // single-file volumes (NIfTI) expose their MPR planes through `z`: 1 axial, 2 coronal, 3 sagittal
  const hasPlanes = !!meta.data?.planes && (image.data?.depth ?? 1) === 1;
  const z = hasPlanes ? plane + 1 : 1;
  const kind: FrameKind = meta.data?.frame_kind ?? "none";
  const frames = hasPlanes ? (meta.data?.planes?.[plane]?.frames ?? 1) : (meta.data?.frames ?? image.data?.frames ?? 1);
  const labels = (hasPlanes ? meta.data?.planes?.[plane]?.frame_descriptors : meta.data?.frame_labels) ?? [];
  const zRange = meta.data?.z_range ?? null;
  const blend = kind === "zstack"; // focus planes are cross-faded, slices and movie frames are not

  const setPos = useCallback((v: number) => {
    posRef.current = v;
    setPosState(v);
    blenderRef.current?.setPosition(v);
  }, []);

  /** Moves to `target` with an eased animation (keyboard steps); dragging the slider sets the position directly. */
  const animateTo = useCallback(
    (target: number) => {
      cancelAnimationFrame(anim.current);
      const from = posRef.current;
      const t0 = performance.now();
      const duration = blend ? Math.min(420, 160 + Math.abs(target - from) * 60) : 0;
      if (duration === 0 || from === target) return setPos(target);
      const step = (now: number) => {
        const t = Math.min((now - t0) / duration, 1);
        setPos(from + (target - from) * ease(t));
        if (t < 1) anim.current = requestAnimationFrame(step);
      };
      anim.current = requestAnimationFrame(step);
    },
    [blend, setPos],
  );
  const onSlider = useCallback(
    (v: number) => {
      cancelAnimationFrame(anim.current);
      setPos(v);
    },
    [setPos],
  );

  // viewer lifecycle
  useEffect(() => {
    if (!host.current) return;
    const viewer = OpenSeadragon({
      element: host.current,
      showNavigator: true,
      navigatorPosition: "BOTTOM_RIGHT",
      showNavigationControl: false,
      prefixUrl: "",
      animationTime: 0.25,
      blendTime: 0.1,
      maxZoomPixelRatio: 4,
      gestureSettingsMouse: { clickToZoom: false },
      immediateRender: false,
      // moving along a stack must keep the zoom and position; the view is reset explicitly when an image is opened
      preserveViewport: true,
    });
    viewerRef.current = viewer;
    (window as unknown as { __viewer?: OpenSeadragon.Viewer }).__viewer = viewer; // used by the e2e tests
    layerRef.current = new AnnotationLayer(viewer);
    // the container may be laid out after the viewer was created; keep OSD's idea of its size current
    const el = host.current;
    let wasTiny = true;
    const ro = new ResizeObserver(() => {
      const tiny = el.clientHeight < 50 || el.clientWidth < 50;
      (viewer as unknown as { forceResize(): void }).forceResize();
      if (wasTiny && !tiny && viewer.world.getItemCount()) viewer.viewport.goHome(true);
      wasTiny = tiny;
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(anim.current);
      layerRef.current?.destroy();
      viewer.destroy();
      viewerRef.current = null;
      layerRef.current = null;
    };
  }, []);

  // the stack of planes: one tiled image per plane, cross-faded for focus planes
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !image.data || !meta.data) return;
    setError(null);
    const blender = new ZBlender(viewer, frames, (f) => loadTileSource(id, z, f), {
      blend,
      onReady: () => viewer.viewport.goHome(true),
    });
    blenderRef.current = blender;
    const start = Math.min(Math.round(posRef.current), Math.max(frames - 1, 0));
    posRef.current = start;
    setPosState(start);
    blender.setPosition(start);
    loadTileSource(id, z, start).catch((e: Error) => setError(e.message));
    return () => {
      blender.destroy();
      if (blenderRef.current === blender) blenderRef.current = null;
    };
  }, [id, z, frames, blend, image.data, meta.data]);

  // keyboard: Page Up / Page Down step through the planes
  useEffect(() => {
    if (kind === "none" || frames < 2) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT" && (e.target as HTMLInputElement).type !== "range") return;
      if (e.key !== "PageUp" && e.key !== "PageDown") return;
      e.preventDefault();
      const target = Math.round(posRef.current) + (e.key === "PageUp" ? 1 : -1);
      animateTo(Math.min(Math.max(target, 0), frames - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [kind, frames, animateTo]);

  const styles = useMemo(() => {
    const m = new Map<number, TypeStyle>();
    types.data?.forEach((t) => m.set(t.id, { color: t.color_code, vectorType: t.vector_type, closed: t.closed }));
    return m;
  }, [types.data]);

  const shapes = useMemo(() => {
    const out: Shape[] = [];
    for (const a of annotations.data ?? []) {
      const t = styles.get(a.annotation_type);
      if (!t) continue;
      const s = toShape(a.id, a.annotation_type, t.vectorType, t.closed, a.vector);
      if (s) out.push(s);
    }
    return out;
  }, [annotations.data, styles]);

  useEffect(() => layerRef.current?.setData(shapes, styles), [shapes, styles]);
  useEffect(() => layerRef.current?.setHiddenTypes(hidden), [hidden]);

  const counts = useMemo(() => {
    const m = new Map<number, number>();
    for (const s of shapes) m.set(s.typeId, (m.get(s.typeId) ?? 0) + 1);
    return m;
  }, [shapes]);

  const multiFrame = kind !== "none" && frames > 1;

  return (
    <div className="viewer-shell">
      <header className="viewer-bar glass">
        <Link to={image.data ? `/sets/${image.data.image_set}` : "/"} className="btn ghost">
          ← Back
        </Link>
        <span className="viewer-title">{image.data?.name}</span>
        <span className="spacer" />
        {hasPlanes && (
          <div className="seg">
            {PLANES.map((p, i) => (
              <button
                key={p}
                className={plane === i ? "active" : ""}
                onClick={() => {
                  setPlane(i);
                  posRef.current = 0;
                }}
              >
                {p}
              </button>
            ))}
          </div>
        )}
        <button className="btn ghost" onClick={() => navigate("/")}>
          Image sets
        </button>
      </header>
      <div className={`viewer-body ${multiFrame && (kind === "zstack" || kind === "volume") ? "with-z" : ""}`}>
        <div ref={host} className="osd" />
        {error && <div className="viewer-error glass">{error}</div>}
        {meta.data && <RepairBanner imageId={id} damaged={!!meta.data.issues?.includes("damaged_pyramid")} />}
        <aside className="viewer-side glass">
          <div className="sidebar-title">Annotation types</div>
          {types.data
            ?.filter((t) => counts.has(t.id))
            .map((t) => (
              <label key={t.id} className="type-row">
                <input
                  type="checkbox"
                  checked={!hidden.has(t.id)}
                  onChange={() =>
                    setHidden((h) => {
                      const n = new Set(h);
                      if (n.has(t.id)) n.delete(t.id);
                      else n.add(t.id);
                      return n;
                    })
                  }
                />
                <span className="swatch" style={{ background: t.color_code }} />
                <span className="type-name">{t.name}</span>
                <span className="muted small">{counts.get(t.id)}</span>
              </label>
            ))}
          {annotations.data && shapes.length === 0 && <p className="muted small">No annotations.</p>}
        </aside>
        {multiFrame && (kind === "zstack" || kind === "volume") && (
          <ZSlider frames={frames} value={pos} onChange={onSlider} labels={labels} zRange={kind === "zstack" ? zRange : null} blend={blend} />
        )}
      </div>
      {multiFrame && kind === "timeseries" && <TimeSlider frames={frames} value={pos} onChange={onSlider} labels={labels} />}
    </div>
  );
}
