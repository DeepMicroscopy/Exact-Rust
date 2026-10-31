import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import OpenSeadragon from "openseadragon";
import { api, listAll } from "../api/client";
import { ANNOTATION_FIELDS, createAnnotation } from "../api/annotations";
import { useAuth } from "../auth/AuthContext";
import { Dropdown, type DropdownItem } from "../components/Dropdown";
import { DEFAULT_TOOL, Segment3DPanel, type SegTool } from "../components/Segment3DPanel";
import { AutoSegmentDialog } from "../components/AutoSegmentDialog";
import { Render3D } from "../components/Render3D";
import { useSegment3D, type Op } from "../hooks/useSegment3D";
import { BrushLayer } from "../viewer-core/brushLayer";
import { MaskOverlay } from "../viewer-core/maskOverlay";
import { brushDiameterMm, brushRadii, dropClose, hexDigits, resized, thin, toleranceOf, type Extent } from "../viewer-core/mpr3d";
import { pen } from "../viewer-core/pen";
import { isTypingTarget } from "../viewer-core/shortcuts";
import type { Annotation, AnnotationType } from "../api/types";
import { AnnotationLayer } from "../viewer-core/annotationLayer";
import { visibleOnFrame } from "../viewer-core/frames";
import { toShape } from "../viewer-core/shapes";
import { VectorType, type Shape, type TypeStyle } from "../viewer-core/types";
import { loadTileSource } from "../viewer-core/tileSource";
import { ZBlender } from "../viewer-core/zBlend";
import { CrosshairLayer } from "../viewer-core/crosshair";
import { installGestures, POINTER_GESTURES } from "../viewer-core/gestures";
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
  const [render3d, setRender3d] = useState(false);
  useEffect(() => setRender3d(false), [id]);

  // ---- 3D segmentation: the mask of one segmentation type, shown on all three planes and edited with the tool window ----
  const qc = useQueryClient();
  const { user: me } = useAuth();
  const readOnly = !!me?.read_only;
  const imageSetId = image.data?.image_set;
  const imageSet = useQuery({
    queryKey: ["image-set", imageSetId],
    enabled: imageSetId != null,
    queryFn: () => api<{ id: number; product_set: number[] }>(`/api/v2/image-sets/${imageSetId}?fields=id,product_set`),
  });
  const segTypes = useMemo(
    () => (types.data ?? []).filter((t) => t.vector_type === VectorType.Segmentation && (!imageSet.data || imageSet.data.product_set.includes(t.product as number))),
    [types.data, imageSet.data],
  );
  const [segTypeId, setSegTypeId] = useState<number | null>(null);
  const [tool, setTool] = useState<SegTool>(DEFAULT_TOOL);
  const [segError, setSegError] = useState<string | null>(null);
  const segType = segTypes.find((t) => t.id === segTypeId) ?? null;
  const segAnnotation = segTypeId == null ? null : (annotations.data ?? []).find((a) => a.annotation_type === segTypeId && !a.deleted && a.id > 0) ?? null;
  const seg3d = useSegment3D(segAnnotation?.id ?? null);
  const [autoOpen, setAutoOpen] = useState(false);
  // the one mask annotation of the type is made with the first use of the type in this image
  const creating = useRef(false);
  useEffect(() => {
    if (segTypeId == null || !annotations.data || segAnnotation || !planes || creating.current || readOnly) return;
    creating.current = true;
    createAnnotation({ image: id, annotation_type: segTypeId, vector: { tile_size: 256, width: planes[0].width, height: planes[0].height }, unique_identifier: crypto.randomUUID() })
      .then(() => qc.invalidateQueries({ queryKey: ["annotations", id] }))
      .catch((e: Error) => setSegError(`Could not create the mask: ${e.message}`))
      .finally(() => {
        creating.current = false;
      });
  }, [segTypeId, annotations.data, segAnnotation, planes, id, qc, readOnly]);
  useEffect(() => setSegTypeId(null), [id]);
  const ext: Extent | null = seg3d.state?.extent_mm ?? null;
  const editable = !readOnly && !!segAnnotation && !!ext;
  const doOp = seg3d.op;
  const segLive = useRef({ tool, doOp, undo: seg3d.undo, redo: seg3d.redo, ext });
  segLive.current = { tool, doOp, undo: seg3d.undo, redo: seg3d.redo, ext };
  const patchTool = useCallback((p: Partial<SegTool>) => setTool((t) => ({ ...t, ...p })), []);
  const segPane: SegPane | null =
    segAnnotation && segType
      ? {
          annotationId: segAnnotation.id,
          color: segType.color_code,
          version: seg3d.version,
          tool,
          editable,
          ext,
          onStroke: (plane, frame, points, erase) =>
            segLive.current.doOp({ op: "stroke", plane, frame, points, radius_mm: (planes ? brushDiameterMm(segLive.current.tool, plane as Plane, planes[plane], segLive.current.ext ?? [1, 1, 1]) : 0) / 2, ball: segLive.current.tool.ball, mode: erase ? "remove" : "add" }),
          onLasso: (plane, frame, points, erase) => segLive.current.doOp({ op: "lasso", plane, frame, points, mode: erase ? "remove" : "add" }),
          onWand: (plane, frame, point, erase) => {
            const t = segLive.current.tool;
            const o: Op = { op: "wand", plane, frame, point, tolerance: toleranceOf(t.tolerance), volume: t.wand3d, mode: erase ? "remove" : "add", ...(t.maxRadiusMm > 0 ? { max_radius_mm: t.maxRadiusMm } : {}) };
            return segLive.current.doOp(o);
          },
          onSize: (steps) => setTool((t) => ({ ...t, size: resized(t.size, steps, t.unit) })),
        }
      : null;
  const segItems: DropdownItem[] = [...segTypes.map((t) => ({ id: t.id, label: `▨ ${t.name}`, color: t.color_code, checked: t.id === segTypeId })), ...(segTypeId != null ? [{ id: "off", label: "Leave segmentation" }] : [])];

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
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") && isTypingTarget(el)) return;
      if (segTypeId != null) {
        const k = e.key.toLowerCase();
        const mod = e.ctrlKey || e.metaKey;
        if (e.key === "Escape") setSegTypeId(null);
        else if (mod && k === "z") void (e.shiftKey ? segLive.current.redo() : segLive.current.undo());
        else if (mod && k === "y") void segLive.current.redo();
        else if (!mod && !e.altKey && editableRef.current && (k === "b" || k === "l" || k === "w")) setTool((t) => ({ ...t, tool: k === "b" ? "brush" : k === "l" ? "lasso" : "wand" }));
        else if (!mod && !e.altKey && editableRef.current && k === "e") setTool((t) => ({ ...t, erase: !t.erase }));
        else if (!mod && !e.altKey && editableRef.current && (e.key === "[" || e.key === "]")) setTool((t) => ({ ...t, size: resized(t.size, e.key === "]" ? 1 : -1, t.unit) }));
        else if (!(e.key === "PageUp" || e.key === "ArrowUp" || e.key === "PageDown" || e.key === "ArrowDown")) return;
        else {
          step(active, e.key === "PageUp" || e.key === "ArrowUp" ? 1 : -1);
        }
        e.preventDefault();
        return;
      }
      if (e.key === "PageUp" || e.key === "ArrowUp") step(active, 1);
      else if (e.key === "PageDown" || e.key === "ArrowDown") step(active, -1);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [active, step, segTypeId]);
  const editableRef = useRef(editable);
  editableRef.current = editable;

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
        <Dropdown
          items={segItems}
          onPick={(pid) => setSegTypeId(pid === "off" ? null : Number(pid))}
          disabled={segTypes.length === 0}
          title={segTypes.length === 0 ? "This image set has no segmentation type: add a product that has one" : "Paint or look at the mask of a segmentation type on all three planes"}
          className={segTypeId != null ? "on" : ""}
          name="segment"
        >
          {segType ? `▨ ${segType.name}` : "Segment"}
        </Dropdown>
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
              <Pane key={p} imageId={id} plane={p} shapes={p === 0 ? shapes : null} styles={styles} shape={shape} info={planes[p]} voxel={voxel} active={active === p} onActivate={() => setActive(p)} onPick={setVoxel} onStep={(d) => step(p, d)} seg={segPane} />
            ))
          : null}
        <div className={`mpr-info glass ${render3d ? "has-render" : ""}`} data-testid="mpr-info">
          {render3d ? (
            <Render3D imageId={id} mask={segAnnotation && segType ? { annotationId: segAnnotation.id, color: segType.color_code, version: seg3d.version } : null} onHide={() => setRender3d(false)} />
          ) : voxel && shape ? (
            <Info voxel={voxel} shape={shape} planes={planes ?? []} segmenting={segTypeId != null && editable} onRender3D={() => setRender3d(true)} />
          ) : (
            <span className="muted">Loading…</span>
          )}
          {segError && <p className="error small" role="alert">{segError}</p>}
        </div>
      </div>
      {segType && shape && voxel && (
        <Segment3DPanel
          type={{ name: segType.name, color: segType.color_code }}
          state={seg3d.state}
          message={seg3d.message}
          busy={seg3d.busy}
          tool={tool}
          onTool={patchTool}
          readOnly={readOnly}
          z={voxel.z}
          slices={shape.nz}
          onOp={(o) => void seg3d.op(o)}
          onUndo={() => void seg3d.undo()}
          onRedo={() => void seg3d.redo()}
          onClose={() => setSegTypeId(null)}
          extra={
            readOnly ? null : (
              <button className="btn" onClick={() => setAutoOpen(true)} data-testid="auto-segment" title="Let a program segment the whole volume">
                Auto segment…
              </button>
            )
          }
        />
      )}
      {autoOpen && (
        <AutoSegmentDialog
          imageId={id}
          segTypes={[...segTypes].sort((a, b) => Number(b.id === segTypeId) - Number(a.id === segTypeId)).map((t) => ({ id: t.id, name: t.name, color: t.color_code }))}
          onClose={() => setAutoOpen(false)}
          onDone={() => void seg3d.reload()}
        />
      )}
    </div>
  );
}

function Info({ voxel, shape, planes, segmenting, onRender3D }: { voxel: Voxel; shape: VolumeShape; planes: PlaneInfo[]; segmenting: boolean; onRender3D(): void }) {
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
      {segmenting && <p className="muted small">A click or stroke with a tool also moves the crosshair to that point; Ctrl (Cmd) + click moves it without painting.</p>}
      <p>
        <button className="btn" onClick={onRender3D} data-testid="show-render3d" title="Draws the volume (and the mask) in 3D here: it loads a reduced copy first and may take a few seconds">
          Show 3D render
        </button>
      </p>
      <p className="muted small">Click in a plane to set the crosshair. Scroll or Page Up / Down steps the slices of the plane you used last. Drag moves the image, Ctrl + scroll or a pinch zooms.</p>
    </>
  );
}

/** What a plane needs to show and edit the mask of the segmentation type that is chosen. */
interface SegPane {
  annotationId: number;
  color: string;
  version: number;
  tool: SegTool;
  /** tools work: the mask exists, its geometry is known and the account may change it */
  editable: boolean;
  ext: Extent | null;
  onStroke(plane: number, frame: number, points: [number, number][], erase: boolean): Promise<unknown>;
  onLasso(plane: number, frame: number, points: [number, number][], erase: boolean): Promise<unknown>;
  onWand(plane: number, frame: number, point: [number, number], erase: boolean): Promise<unknown>;
  onSize(steps: number): void;
}

function Pane({ imageId, plane, shapes, styles, shape, info, voxel, active, onActivate, onPick, onStep, seg }: { imageId: number; plane: Plane; shapes: Shape[] | null; styles: Map<number, TypeStyle>; shape: VolumeShape; info: PlaneInfo; voxel: Voxel; active: boolean; onActivate(): void; onPick(v: Voxel): void; onStep(delta: number): void; seg: SegPane | null }) {
  const host = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<OpenSeadragon.Viewer | null>(null);
  const blender = useRef<ZBlender | null>(null);
  const cross = useRef<CrosshairLayer | null>(null);
  const notes = useRef<AnnotationLayer | null>(null);
  const brush = useRef<BrushLayer | null>(null);
  const overlay = useRef<MaskOverlay | null>(null);
  const live = useRef({ shape, plane, voxel, onPick, onStep, onActivate, shapes, styles, seg, info });
  live.current = { shape, plane, voxel, onPick, onStep, onActivate, shapes, styles, seg, info };
  const pointer = useRef<[number, number] | null>(null);
  const [busy, setBusy] = useState(false);
  const frame = frameOf(plane, voxel);

  useEffect(() => {
    if (!host.current) return;
    const v = OpenSeadragon({ element: host.current, prefixUrl: "", showNavigationControl: false, showNavigator: false, gestureSettingsMouse: POINTER_GESTURES, gestureSettingsPen: POINTER_GESTURES, maxZoomPixelRatio: 6, animationTime: 0.2, blendTime: 0.1, immediateRender: false, preserveViewport: true });
    viewerRef.current = v;
    (window as unknown as Record<string, unknown>)[`__mpr_${plane}`] = v; // used by the e2e tests
    v.addHandler("canvas-key", (e) => {
      e.preventDefaultAction = true;
    });
    // a plain mouse wheel steps through the slices (a pinch and Ctrl + wheel zoom, a track pad swipe moves the image)
    const el = v.canvas as HTMLElement;
    let rest = 0;
    const wheel = (e: WheelEvent) => {
      const sg = live.current.seg;
      if (sg?.editable && e.altKey && sg.tool.tool === "brush") {
        // Alt + wheel sizes the brush
        e.preventDefault();
        e.stopImmediatePropagation();
        const d = e.deltaY || e.deltaX;
        if (d) sg.onSize(d < 0 ? 1 : -1);
        return;
      }
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

    // the mask tools: a drag with the brush or eraser is one stroke (previewed here, stored when the pointer is lifted), a click with the wand grows a region
    let stroke: { points: [number, number][]; erase: boolean; frame: number; lasso: boolean } | null = null;
    let space = false;
    const spaceKey = (e: KeyboardEvent) => {
      if (e.code === "Space" && !isTypingTarget(e.target)) space = e.type === "keydown";
    };
    const blur = () => (space = false);
    window.addEventListener("keydown", spaceKey);
    window.addEventListener("keyup", spaceKey);
    window.addEventListener("blur", blur);
    const toPlane = (pos: OpenSeadragon.Point): [number, number] | null => {
      if (!v.world.getItemCount()) return null;
      const q = v.world.getItemAt(0).viewerElementToImageCoordinates(pos);
      return [q.x, q.y];
    };
    const radii = (sg: SegPane): [number, number] => (sg.ext ? brushRadii(live.current.plane, live.current.info, sg.ext, brushDiameterMm(sg.tool, live.current.plane, live.current.info, sg.ext)) : [0, 0]);
    type PointerEv = { position: OpenSeadragon.Point; preventDefaultAction: boolean; originalEvent?: MouseEvent; pointerType?: string };
    const on = (name: string, fn: (e: never) => void) => v.addHandler(name as keyof OpenSeadragon.ViewerEventMap, fn as unknown as OpenSeadragon.EventHandler<OpenSeadragon.ViewerEvent>);
    on("canvas-press", (e: PointerEv) => {
      live.current.onActivate();
      const sg = live.current.seg;
      const oe = e.originalEvent;
      if (!sg?.editable || space || oe?.button === 1 || oe?.ctrlKey || oe?.metaKey || pen.ignores(e.pointerType)) return;
      const at = toPlane(e.position);
      if (!at) return;
      pen.note({ pointerType: e.pointerType ?? "mouse" });
      e.preventDefaultAction = true;
      const { shape: s, plane: pl, voxel: vx } = live.current;
      const frame = frameOf(pl, vx);
      live.current.onPick(voxelAt(s, pl, at[0], at[1], frame)); // the other planes follow the point that is worked on
      const erase = sg.tool.erase !== !!oe?.altKey;
      if (sg.tool.tool === "wand") {
        void sg.onWand(pl, frame, at, erase);
        return;
      }
      stroke = { points: [at], erase, frame, lasso: sg.tool.tool === "lasso" };
      if (stroke.lasso) {
        brush.current?.setLasso({ points: stroke.points, erase });
        return;
      }
      const [rx, ry] = radii(sg);
      brush.current?.setStroke({ points: stroke.points, rx, ry, erase });
    });
    on("canvas-drag", (e: PointerEv) => {
      const sg = live.current.seg;
      if (!stroke || !sg) return;
      e.preventDefaultAction = true;
      const at = toPlane(e.position);
      if (!at) return;
      stroke.points.push(at);
      if (stroke.lasso) {
        brush.current?.setLasso({ points: stroke.points, erase: stroke.erase });
        return;
      }
      const [rx, ry] = radii(sg);
      brush.current?.setStroke({ points: stroke.points, rx, ry, erase: stroke.erase });
    });
    on("canvas-release", () => {
      const sg = live.current.seg;
      if (!stroke || !sg) return;
      const done = stroke;
      stroke = null;
      const points = thin(dropClose(done.points, 0.5), 2000);
      if (done.lasso) {
        if (points.length < 3) return brush.current?.setLasso(null);
        void sg
          .onLasso(live.current.plane, done.frame, points, done.erase)
          .finally(() => window.setTimeout(() => brush.current?.setLasso(null), 1200));
        return;
      }
      // the preview stays until the stored mask is shown (the overlay clears it); this is for a failed or unseen answer
      void sg
        .onStroke(live.current.plane, done.frame, points, done.erase)
        .finally(() => window.setTimeout(() => brush.current?.setStroke(null), 1200));
    });
    // the ring of the brush follows the pointer
    const move = (ev: PointerEvent) => {
      const sg = live.current.seg;
      const r = el.getBoundingClientRect();
      const at = toPlane(new OpenSeadragon.Point(ev.clientX - r.left, ev.clientY - r.top));
      pointer.current = at;
      if (!sg?.editable || sg.tool.tool !== "brush" || !at) return brush.current?.setRing(null);
      const [rx, ry] = radii(sg);
      brush.current?.setRing({ at, rx, ry, erase: sg.tool.erase !== ev.altKey });
    };
    const leave = () => {
      pointer.current = null;
      brush.current?.setRing(null);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerleave", leave);
    notes.current = plane === 0 ? new AnnotationLayer(v) : null; // below the crosshair
    if (live.current.shapes) notes.current?.setData(live.current.shapes, live.current.styles);
    const c = new CrosshairLayer(v);
    cross.current = c;
    brush.current = new BrushLayer(v);
    const b = new ZBlender(v, info.frames, (f) => loadTileSource(imageId, plane + 1, f), {
      blend: false,
      onBusy: setBusy,
      onReady: () => v.viewport.goHome(true),
    });
    blender.current = b;
    b.setPosition(frameOf(plane, live.current.voxel));
    return () => {
      el.removeEventListener("wheel", wheel, { capture: true });
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerleave", leave);
      window.removeEventListener("keydown", spaceKey);
      window.removeEventListener("keyup", spaceKey);
      window.removeEventListener("blur", blur);
      brush.current?.destroy();
      brush.current = null;
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

  // the mask of the chosen type over this plane: a PNG of the slice, reloaded when the slice or the mask changes
  const annotationId = seg?.annotationId ?? null;
  useEffect(() => {
    const v = viewerRef.current;
    if (!v || annotationId == null) return;
    const o = new MaskOverlay(v, info.width, info.height, () => {
      brush.current?.setStroke(null);
      brush.current?.setLasso(null);
    });
    overlay.current = o;
    return () => {
      o.destroy();
      overlay.current = null;
    };
  }, [annotationId, info.width, info.height, imageId, plane, info.frames]);
  const color = seg?.color;
  const version = seg?.version;
  useEffect(() => {
    if (annotationId == null || color == null) return;
    const t = window.setTimeout(() => overlay.current?.load(`/api/v2/segmentation/${annotationId}/slice/${plane}/${frame}?color=${hexDigits(color)}&alpha=255&v=${version}`), 30);
    return () => window.clearTimeout(t);
  }, [annotationId, color, plane, frame, version, imageId, info.frames]);
  const opacity = seg?.tool.opacity;
  useEffect(() => {
    if (opacity != null) overlay.current?.setOpacity(opacity);
  }, [opacity, annotationId, imageId, info.frames]);
  // the ring changes with the size and the tool even when the pointer rests
  const sizeMm = seg?.tool.size;
  const sizeUnit = seg?.tool.unit;
  const toolName = seg?.tool.tool;
  const toolErase = seg?.tool.erase;
  const editable = !!seg?.editable;
  useEffect(() => {
    const sg = live.current.seg;
    const at = pointer.current;
    if (!sg?.editable || !sg.ext || !at || sg.tool.tool !== "brush") return brush.current?.setRing(null);
    const [rx, ry] = brushRadii(plane, info, sg.ext, brushDiameterMm(sg.tool, plane, info, sg.ext));
    brush.current?.setRing({ at, rx, ry, erase: sg.tool.erase });
  }, [sizeMm, sizeUnit, toolName, toolErase, editable, plane, info]);

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
