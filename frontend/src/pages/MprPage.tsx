import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import OpenSeadragon from "openseadragon";
import { api, listAll } from "../api/client";
import { ANNOTATION_FIELDS } from "../api/annotations";
import type { Annotation, AnnotationType } from "../api/types";
import { AnnotationLayer } from "../viewer-core/annotationLayer";
import { visibleOnFrame } from "../viewer-core/frames";
import { toShape } from "../viewer-core/shapes";
import type { Shape, TypeStyle } from "../viewer-core/types";
import { loadTileSource } from "../viewer-core/tileSource";
import { ZBlender } from "../viewer-core/zBlend";
import { CrosshairLayer } from "../viewer-core/crosshair";
import { installGestures } from "../viewer-core/gestures";
import { classifyWheel } from "../viewer-core/wheel";
import { CROSS_PLANES, PLANE_COLORS, PLANE_NAMES, centreOf, frameOf, pixelOf, shapeOf, stepped, voxelAt, type Plane, type Voxel, type VolumeShape } from "../viewer-core/mpr";

export const MPR_PREFERENCE = "exact.mpr";

/** Whether volumes open in the three-plane view (the default) or in a single plane. */
export function prefersThreePlanes(): boolean {
  try {
    return localStorage.getItem(MPR_PREFERENCE) !== "0";
  } catch {
    return true;
  }
}
export function rememberThreePlanes(on: boolean): void {
  try {
    localStorage.setItem(MPR_PREFERENCE, on ? "1" : "0");
  } catch {
    /* private window */
  }
}

interface PlaneInfo {
  plane: number;
  name: string;
  frames: number;
  width: number;
  height: number;
  frame_descriptors: string[];
}
interface Meta {
  planes: PlaneInfo[] | null;
}

/** The three planes of a volume side by side, linked by a crosshair: a click in one plane moves the slices of the others. */
export function MprPage() {
  const id = Number(useParams().imageId);
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const image = useQuery({ queryKey: ["image", id], queryFn: () => api<{ id: number; name: string; image_set?: number }>(`/api/v2/images/${id}?fields=id,name,width,height,frames,depth,image_set,mpp,crop_source,crop_x,crop_y,crop_frame`) });
  const meta = useQuery({ queryKey: ["image-meta", id], queryFn: () => api<Meta & Record<string, unknown>>(`/api/v2/images/${id}/metadata`) });
  const planes = meta.data?.planes ?? null;
  const shape = useMemo(() => (planes ? shapeOf(planes) : null), [planes]);
  const [voxel, setVoxel] = useState<Voxel | null>(null);
  // the annotations of the axial slice, shown read-only (drawing is done in the single-plane view)
  const types = useQuery({
    queryKey: ["annotation-types"],
    queryFn: () => listAll<AnnotationType>("/api/v2/annotation-types", { fields: "id,name,vector_type,color_code,closed,node_count,default_width,default_height,size_unit,sort_order,product,multi_frame" }),
  });
  const annotations = useQuery({ queryKey: ["annotations", id], queryFn: () => listAll<Annotation>("/api/v2/annotations", { image: id, deleted: false, fields: ANNOTATION_FIELDS }) });
  const styles = useMemo(() => new Map<number, TypeStyle>((types.data ?? []).map((t) => [t.id, { color: t.color_code, vectorType: t.vector_type, closed: t.closed }])), [types.data]);
  const shapes = useMemo(() => {
    const multi = new Set((types.data ?? []).filter((t) => t.multi_frame).map((t) => t.id));
    const out: Shape[] = [];
    for (const a of annotations.data ?? []) {
      const t = styles.get(a.annotation_type);
      if (a.deleted || !t || !voxel || !visibleOnFrame(a.vector, multi.has(a.annotation_type), voxel.z + 1)) continue;
      const sh = toShape(a.id, a.annotation_type, t.vectorType, t.closed, a.vector);
      if (sh) out.push(sh);
    }
    return out;
  }, [annotations.data, types.data, styles, voxel]);
  const [active, setActive] = useState<Plane>(0);

  // the crosshair starts where a link says, else in the middle of the volume
  useEffect(() => {
    if (!shape || voxel) return;
    const q = (k: string) => (search.get(k) == null ? NaN : Number(search.get(k)));
    const [x, y, z] = [q("vx"), q("vy"), q("vz")];
    const c = centreOf(shape);
    setVoxel(Number.isFinite(x + y + z) ? { x: Math.min(Math.max(x, 0), shape.nx - 1), y: Math.min(Math.max(y, 0), shape.ny - 1), z: Math.min(Math.max(z, 0), shape.nz - 1) } : c);
  }, [shape, voxel, search]);

  // the address bar carries the crosshair, so that a link shows the same position
  useEffect(() => {
    if (!voxel) return;
    const t = window.setTimeout(() => {
      const u = new URL(window.location.href);
      u.searchParams.set("vx", String(voxel.x));
      u.searchParams.set("vy", String(voxel.y));
      u.searchParams.set("vz", String(voxel.z));
      if (u.href !== window.location.href) window.history.replaceState(window.history.state, "", u);
    }, 250);
    return () => window.clearTimeout(t);
  }, [voxel]);

  const step = useCallback((plane: Plane, delta: number) => setVoxel((v) => (v && shape ? stepped(shape, plane, v, delta) : v)), [shape]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT")) return;
      if (e.key === "PageUp" || e.key === "ArrowUp") step(active, 1);
      else if (e.key === "PageDown" || e.key === "ArrowDown") step(active, -1);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [active, step]);

  if (image.isError) return <p className="error">Image {id} was not found.</p>;
  if (meta.data && !planes) return <p className="muted">This image has no planes to show. <Link to={`/images/${id}`}>Open it</Link></p>;
  return (
    <div className="viewer-shell mpr" data-testid="mpr">
      <header className="viewer-bar glass">
        <Link to={image.data?.image_set ? `/sets/${image.data.image_set}` : "/"} className="btn ghost">
          ← Back
        </Link>
        <span className="viewer-title">{image.data?.name ?? "…"}</span>
        <span className="spacer" />
        <button
          className="btn"
          onClick={() => {
            rememberThreePlanes(false);
            navigate(`/images/${id}`);
          }}
          title="Show one plane at a time, with the annotation tools"
        >
          Single plane
        </button>
        <button className="btn ghost" onClick={() => navigate("/")}>
          Image sets
        </button>
      </header>
      <div className="mpr-grid">
        {shape && planes && voxel
          ? ([0, 1, 2] as Plane[]).map((p) => (
              <Pane key={p} imageId={id} plane={p} shapes={p === 0 ? shapes : null} styles={styles} shape={shape} info={planes[p]} voxel={voxel} active={active === p} onActivate={() => setActive(p)} onPick={setVoxel} onStep={(d) => step(p, d)} />
            ))
          : null}
        <div className="mpr-info glass" data-testid="mpr-info">
          {voxel && shape ? <Info voxel={voxel} shape={shape} planes={planes ?? []} /> : <span className="muted">Loading…</span>}
        </div>
      </div>
    </div>
  );
}

function Info({ voxel, shape, planes }: { voxel: Voxel; shape: VolumeShape; planes: PlaneInfo[] }) {
  const label = (p: Plane) => planes[p]?.frame_descriptors[frameOf(p, voxel)] ?? "";
  return (
    <>
      <h3>Position</h3>
      <p data-testid="mpr-voxel">
        voxel x {voxel.x + 1}/{shape.nx} · y {voxel.y + 1}/{shape.ny} · z {voxel.z + 1}/{shape.nz}
      </p>
      <p className="muted small">
        {label(2)} · {label(1)} · {label(0)}
      </p>
      <p className="muted small">Click in a plane to set the crosshair. Scroll or Page Up / Down steps the slices of the plane you used last. Drag moves the image, Ctrl + scroll or a pinch zooms.</p>
    </>
  );
}

function Pane({ imageId, plane, shapes, styles, shape, info, voxel, active, onActivate, onPick, onStep }: { imageId: number; plane: Plane; shapes: Shape[] | null; styles: Map<number, TypeStyle>; shape: VolumeShape; info: PlaneInfo; voxel: Voxel; active: boolean; onActivate(): void; onPick(v: Voxel): void; onStep(delta: number): void }) {
  const host = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<OpenSeadragon.Viewer | null>(null);
  const blender = useRef<ZBlender | null>(null);
  const cross = useRef<CrosshairLayer | null>(null);
  const notes = useRef<AnnotationLayer | null>(null);
  const live = useRef({ shape, plane, voxel, onPick, onStep, onActivate, shapes, styles });
  live.current = { shape, plane, voxel, onPick, onStep, onActivate, shapes, styles };
  const [busy, setBusy] = useState(false);
  const frame = frameOf(plane, voxel);

  useEffect(() => {
    if (!host.current) return;
    const v = OpenSeadragon({ element: host.current, prefixUrl: "", showNavigationControl: false, showNavigator: false, gestureSettingsMouse: { clickToZoom: false }, maxZoomPixelRatio: 6, animationTime: 0.2, blendTime: 0.1, immediateRender: false, preserveViewport: true });
    viewerRef.current = v;
    (window as unknown as Record<string, unknown>)[`__mpr_${plane}`] = v; // used by the e2e tests
    v.addHandler("canvas-key", (e) => {
      e.preventDefaultAction = true;
    });
    // a plain mouse wheel steps through the slices (a pinch and Ctrl + wheel zoom, a track pad swipe moves the image)
    const el = v.canvas as HTMLElement;
    let rest = 0;
    const wheel = (e: WheelEvent) => {
      if (classifyWheel(e, performance.now(), -Infinity) !== "wheel") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      // a notch of a wheel is 100 or so pixels, finer wheels and line-mode events add up to the same
      rest += e.deltaMode === 0 ? e.deltaY : Math.sign(e.deltaY) * 100;
      const d = Math.trunc(rest / 100);
      if (d) {
        rest -= d * 100;
        live.current.onStep(d);
      }
    };
    el.addEventListener("wheel", wheel, { passive: false, capture: true });
    installGestures(v, () => false);
    v.addHandler("canvas-click", (e) => {
      const item = v.world.getItemAt(0);
      if (!e.quick || !item) return;
      const p = item.viewerElementToImageCoordinates(e.position);
      const { shape: s, plane: pl, voxel: vx } = live.current;
      live.current.onActivate();
      live.current.onPick(voxelAt(s, pl, p.x, p.y, frameOf(pl, vx)));
    });
    v.addHandler("canvas-press", () => live.current.onActivate());
    notes.current = plane === 0 ? new AnnotationLayer(v) : null; // below the crosshair
    if (live.current.shapes) notes.current?.setData(live.current.shapes, live.current.styles);
    const c = new CrosshairLayer(v);
    cross.current = c;
    const b = new ZBlender(v, info.frames, (f) => loadTileSource(imageId, plane + 1, f), {
      blend: false,
      onBusy: setBusy,
      onReady: () => v.viewport.goHome(true),
    });
    blender.current = b;
    b.setPosition(frameOf(plane, live.current.voxel));
    return () => {
      el.removeEventListener("wheel", wheel, { capture: true });
      b.destroy();
      c.destroy();
      notes.current?.destroy();
      notes.current = null;
      v.destroy();
      viewerRef.current = null;
      blender.current = null;
      cross.current = null;
    };
  }, [imageId, plane, info.frames]);

  useEffect(() => {
    blender.current?.setPosition(frame);
  }, [frame]);
  useEffect(() => {
    if (shapes) notes.current?.setData(shapes, styles);
  }, [shapes, styles]);
  useEffect(() => {
    const [px, py] = pixelOf(shape, plane, voxel);
    cross.current?.set([px, py], { vertical: PLANE_COLORS[CROSS_PLANES[plane].vertical], horizontal: PLANE_COLORS[CROSS_PLANES[plane].horizontal] });
  }, [shape, plane, voxel]);

  return (
    <div className={`mpr-pane ${active ? "active" : ""}`} data-testid={`mpr-${PLANE_NAMES[plane].toLowerCase()}`} style={{ borderColor: PLANE_COLORS[plane] }}>
      <div ref={host} className="osd" />
      <div className="mpr-label" style={{ color: PLANE_COLORS[plane] }}>
        {PLANE_NAMES[plane]} · {frame + 1} / {info.frames}
        <span className="muted small"> {info.frame_descriptors[frame] ?? ""}</span>
      </div>
      {busy && <span className="spinner mpr-busy" role="status" aria-label="Loading the slice" />}
      <input className="mpr-slider" type="range" min={0} max={info.frames - 1} value={frame} onChange={(e) => onStep(Number(e.target.value) - frame)} aria-label={`${PLANE_NAMES[plane]} slice`} />
    </div>
  );
}
