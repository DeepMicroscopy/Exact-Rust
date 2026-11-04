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
import { ImageFinder } from "../components/ImageFinder";
import { LinkedPanel, type LinkedView } from "../components/LinkedPanel";
import { ImportSegmentsDialog } from "../components/ImportSegmentsDialog";
import type { LinkedFile } from "../components/LinkSegmentationDialog";
import { brushDiameterMm, brushRadii, dropClose, hexDigits, resized, thin, toleranceOf, type Extent } from "../viewer-core/mpr3d";
import { pen } from "../viewer-core/pen";
import { isTypingTarget } from "../viewer-core/shortcuts";
import type { Annotation, AnnotationType, Product } from "../api/types";
import { AnnotationLayer } from "../viewer-core/annotationLayer";
import { visibleOnFrame } from "../viewer-core/frames";
import { toShape } from "../viewer-core/shapes";
import { VectorType, type Shape, type TypeStyle } from "../viewer-core/types";
import { loadTileSource } from "../viewer-core/tileSource";
import { ZBlender } from "../viewer-core/zBlend";
import { CrosshairLayer } from "../viewer-core/crosshair";
import { installGestures, POINTER_GESTURES } from "../viewer-core/gestures";
import { classifyWheel, WheelStepper } from "../viewer-core/wheel";
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

/** What a mouse wheel does in the planes: zoom (as everywhere else in EXACT) or step through the slices (as in radiology programs). */
export type WheelMode = "zoom" | "slices";
const WHEEL_PREFERENCE = "exact.mpr.wheel";
export function wheelMode(): WheelMode {
  try {
    return localStorage.getItem(WHEEL_PREFERENCE) === "slices" ? "slices" : "zoom";
  } catch {
    return "zoom";
  }
}
function rememberWheelMode(m: WheelMode): void {
  try {
    localStorage.setItem(WHEEL_PREFERENCE, m);
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

/** Sent when a plane is dragged with Space held (that is moving it, so the Space key must not switch add / subtract afterwards). */
const SPACE_DRAG = "exact:mpr-space-drag";

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
  const [maxed, setMaxed] = useState<Plane | null>(null);
  const [wheelModeState, setWheelModeState] = useState<WheelMode>(wheelMode);
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
    queryFn: () => api<{ id: number; product_set: number[]; images?: number[] }>(`/api/v2/image-sets/${imageSetId}?fields=id,product_set,images`),
  });
  const segTypes = useMemo(
    () => (types.data ?? []).filter((t) => t.vector_type === VectorType.Segmentation && (!imageSet.data || imageSet.data.product_set.includes(t.product as number))),
    [types.data, imageSet.data],
  );
  const [segTypeId, setSegTypeId] = useState<number | null>(null);
  // the volume has masks (segmentation annotations) that can be exported
  const hasMasks = (annotations.data ?? []).some((a) => !a.deleted && a.id > 0 && segTypes.some((t) => t.id === a.annotation_type));
  const [tool, setTool] = useState<SegTool>(DEFAULT_TOOL);
  const [segError, setSegError] = useState<string | null>(null);
  const segType = segTypes.find((t) => t.id === segTypeId) ?? null;
  const segAnnotation = segTypeId == null ? null : (annotations.data ?? []).find((a) => a.annotation_type === segTypeId && !a.deleted && a.id > 0) ?? null;
  const seg3d = useSegment3D(segAnnotation?.id ?? null);
  const [autoOpen, setAutoOpen] = useState(false);
  // ---- segmentation files linked to the volume (read-only overlay, see v2/linked.rs) ----
  const linkedFiles = useQuery({ queryKey: ["linked-image", id], queryFn: () => api<LinkedFile[]>(`/api/v2/images/${id}/linked-volumes`) });
  const [linkedView, setLinkedView] = useState<Record<number, LinkedView>>({});
  const [linkedOpacity, setLinkedOpacity] = useState(0.6);
  const [linkedPanel, setLinkedPanel] = useState(true);
  const [importing, setImporting] = useState<LinkedFile | null>(null);
  const allProducts = useQuery({ queryKey: ["products"], queryFn: () => listAll<Product>("/api/v2/products", { fields: "id,name,team" }) });
  const linkedAll = linkedFiles.data ?? [];
  const linked: LinkedPane[] = linkedAll.filter((f) => !linkedView[f.id]?.off).map((f) => ({ id: f.id, hide: linkedView[f.id]?.hidden ?? [] }));
  // Which files are drawn: the one that was opened (`?seg=`), else the newest. Several at once overlap and are not what one wants to look at;
  // the others are in the window, unticked.
  const shownFor = useRef<number | null>(null);
  useEffect(() => {
    setLinkedView({});
    shownFor.current = null;
  }, [id]);
  useEffect(() => {
    const files = linkedFiles.data;
    if (!files || files.length === 0 || shownFor.current === id) return;
    shownFor.current = id;
    const wanted = Number(search.get("seg"));
    const chosen = files.find((f) => f.id === wanted) ?? [...files].sort((a, b) => b.time.localeCompare(a.time))[0];
    setLinkedView(Object.fromEntries(files.map((f) => [f.id, { hidden: [], off: f.id !== chosen.id }])));
  }, [linkedFiles.data, id, search]);
  // the 3D render shows the first linked file that is switched on
  const firstLinked = linkedAll.find((f) => !linkedView[f.id]?.off);
  const renderLinked = firstLinked ? { id: firstLinked.id, name: firstLinked.name, hide: linkedView[firstLinked.id]?.hidden ?? [], colors: firstLinked.segments.map((g) => g.color) } : null;
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

  // what the keys below need from the page, without the listener being replaced at every change
  const [finder, setFinder] = useState(false);
  const live2 = useRef({ id, navigate, images: imageSet.data?.images ?? [], linkedAll, setLinkedView, setFinder, finder, hasSet: imageSetId != null });
  live2.current = { id, navigate, images: imageSet.data?.images ?? [], linkedAll, setLinkedView, setFinder, finder, hasSet: imageSetId != null };
  const linkedWas = useRef<number[]>([]);
  useEffect(() => {
    // Space: a tap switches the mask tools between adding and subtracting; Space held while dragging moves the plane (see Pane)
    let spaceDown = false;
    let spaceDragged = false;
    const spaceKey = (e: KeyboardEvent) => {
      if (e.code !== "Space" || isTypingTarget(e.target)) return;
      if (e.type === "keydown") {
        if (!e.repeat) spaceDragged = false;
        spaceDown = true;
        if (segTypeId != null) e.preventDefault();
      } else if (spaceDown) {
        spaceDown = false;
        if (!spaceDragged && segTypeId != null && editableRef.current) setTool((t) => ({ ...t, erase: !t.erase }));
      }
    };
    const dragged = () => (spaceDragged = true);
    window.addEventListener("keydown", spaceKey);
    window.addEventListener("keyup", spaceKey);
    window.addEventListener(SPACE_DRAG, dragged);
    return () => {
      window.removeEventListener("keydown", spaceKey);
      window.removeEventListener("keyup", spaceKey);
      window.removeEventListener(SPACE_DRAG, dragged);
    };
  }, [segTypeId]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const mod = e.ctrlKey || e.metaKey;
      // Ctrl / Cmd + F (and "/"): find another image of the set
      if (live2.current.hasSet && !live2.current.finder && ((mod && !e.altKey && e.key.toLowerCase() === "f") || (e.key === "/" && !mod && !isTypingTarget(el)))) {
        e.preventDefault();
        live2.current.setFinder(true);
        return;
      }
      if (live2.current.finder) return;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") && isTypingTarget(el)) return;
      if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        const k = e.key.toLowerCase();
        const L = live2.current;
        if (k === "e" || k === "q") {
          const i = L.images.indexOf(L.id);
          const next = i >= 0 ? L.images[i + (k === "e" ? 1 : -1)] : undefined;
          if (next != null) L.navigate(`/images/${next}`);
          e.preventDefault();
          return;
        }
        if (k === "o" && L.linkedAll.length > 0) {
          // the linked segmentation files off (the ones that were on are remembered) and on again
          L.setLinkedView((m) => {
            const on = L.linkedAll.filter((f) => !m[f.id]?.off).map((f) => f.id);
            if (on.length) {
              linkedWas.current = on;
              return { ...m, ...Object.fromEntries(on.map((f) => [f, { hidden: m[f]?.hidden ?? [], off: true }])) };
            }
            const back = linkedWas.current.length ? linkedWas.current : [L.linkedAll[0].id];
            return { ...m, ...Object.fromEntries(back.map((f) => [f, { hidden: m[f]?.hidden ?? [], off: false }])) };
          });
          e.preventDefault();
          return;
        }
      }
      if (segTypeId != null) {
        const k = e.key.toLowerCase();
        const mod = e.ctrlKey || e.metaKey;
        if (e.key === "Escape") setSegTypeId(null);
        else if (mod && k === "z") void (e.shiftKey ? segLive.current.redo() : segLive.current.undo());
        else if (mod && k === "y") void segLive.current.redo();
        else if (!mod && !e.altKey && editableRef.current && (k === "b" || k === "l" || k === "w")) setTool((t) => ({ ...t, tool: k === "b" ? "brush" : k === "l" ? "lasso" : "wand" }));
        else if (!mod && !e.altKey && !e.shiftKey && editableRef.current && (e.code === "Comma" || e.code === "Period")) setTool((t) => ({ ...t, size: resized(t.size, e.code === "Period" ? 1 : -1, t.unit) }));
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
  const [dockEl, setDockEl] = useState<HTMLElement | null>(null);
  const editableRef = useRef(editable);
  editableRef.current = editable;

  if (image.isError) return <p className="error">Image {id} was not found.</p>;
  if (meta.data && !planes) return <p className="muted">This image has no planes to show. <Link to={`/images/${id}`}>Open it</Link></p>;
  return (
    <div className="viewer-shell mpr" data-testid="mpr">
      {finder && imageSetId != null && (
        <ImageFinder
          setId={imageSetId}
          currentId={id}
          onClose={() => setFinder(false)}
          onOpen={(to) => {
            setFinder(false);
            if (to !== id) navigate(`/images/${to}`);
          }}
        />
      )}
      <header className="viewer-bar glass">
        <Link to={image.data?.image_set ? `/sets/${image.data.image_set}` : "/"} className="btn ghost">
          ← Back
        </Link>
        <span className="viewer-title">{image.data?.name ?? "…"}</span>
        <span className="seg3d-dock-slot" ref={setDockEl} />
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
        {hasMasks && (
          <Dropdown
            items={[
              { id: "nrrd", label: "3D Slicer segmentation (.seg.nrrd)" },
              { id: "nifti", label: "NIfTI label map (.nii.gz)" },
            ]}
            onPick={(f) => {
              const a = document.createElement("a");
              a.href = `/api/v2/images/${id}/export-segmentation?format=${f}`;
              a.download = "";
              a.click();
            }}
            title="Download the masks of this volume for 3D Slicer and other programs: one segment per segmentation type, in the volume's own position"
            name="export-masks"
          >
            Export masks
          </Dropdown>
        )}
        <button
          className="btn"
          onClick={() => {
            const m: WheelMode = wheelModeState === "zoom" ? "slices" : "zoom";
            rememberWheelMode(m);
            setWheelModeState(m);
          }}
          title={wheelModeState === "zoom" ? "The mouse wheel zooms; Shift + wheel steps through the slices. Click to let the wheel step through the slices instead." : "The mouse wheel steps through the slices; Ctrl + wheel zooms. Click to let the wheel zoom instead."}
          data-testid="wheel-mode"
        >
          Wheel: {wheelModeState}
        </button>
        {linkedAll.length > 0 && (
          <button className={`btn ${linkedPanel ? "on" : ""}`} onClick={() => setLinkedPanel((o) => !o)} title="Segmentation files linked to this volume (read-only)" data-testid="linked-toggle">
            Segmentation ({linkedAll.length})
          </button>
        )}
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
      <div className={`mpr-grid ${maxed != null ? "maxed" : ""}`}>
        {shape && planes && voxel
          ? ([0, 1, 2] as Plane[]).map((p) => (
              <Pane key={p} imageId={id} plane={p} shapes={p === 0 ? shapes : null} styles={styles} shape={shape} info={planes[p]} voxel={voxel} active={active === p} maxed={maxed === p} hidden={maxed != null && maxed !== p} onMaximize={() => { setActive(p); setMaxed((m) => (m === p ? null : p)); }}  onActivate={() => setActive(p)} onPick={setVoxel} onStep={(d) => step(p, d)} seg={segPane} linked={linked} linkedOpacity={linkedOpacity} />
            ))
          : null}
        <div className={`mpr-info glass ${render3d ? "has-render" : ""}`} hidden={maxed != null} data-testid="mpr-info">
          {render3d ? (
            <Render3D imageId={id} mask={segAnnotation && segType ? { annotationId: segAnnotation.id, color: segType.color_code, version: seg3d.version } : null} linked={renderLinked} onHide={() => setRender3d(false)} />
          ) : voxel && shape ? (
            <Info voxel={voxel} shape={shape} planes={planes ?? []} segmenting={segTypeId != null && editable} onRender3D={() => setRender3d(true)} />
          ) : (
            <span className="muted">Loading…</span>
          )}
          {segError && <p className="error small" role="alert">{segError}</p>}
        </div>
      </div>
      {linkedPanel && linkedAll.length > 0 && <LinkedPanel files={linkedAll} view={linkedView} onView={(fid, v) => setLinkedView((m) => ({ ...m, [fid]: v }))} opacity={linkedOpacity} onOpacity={setLinkedOpacity} voxel={voxel} onImport={readOnly ? undefined : setImporting} onClose={() => setLinkedPanel(false)} />}
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
          dock={dockEl}
          extra={
            readOnly ? null : (
              <button className="btn" onClick={() => setAutoOpen(true)} data-testid="auto-segment" title="Let a program segment the whole volume">
                Auto segment…
              </button>
            )
          }
        />
      )}
      {importing && planes && (
        <ImportSegmentsDialog
          imageId={id}
          file={importing}
          size={{ width: planes[0].width, height: planes[0].height }}
          segTypes={segTypes}
          products={(allProducts.data ?? []).filter((p) => imageSet.data?.product_set.includes(p.id))}
          annotations={annotations.data ?? []}
          onClose={() => setImporting(null)}
          onDone={(typeId) => {
            void qc.invalidateQueries({ queryKey: ["annotation-types"] });
            void qc.invalidateQueries({ queryKey: ["annotations", id] });
            void qc.invalidateQueries({ queryKey: ["annotation-counts"] });
            if (typeId != null) window.setTimeout(() => setSegTypeId(typeId), 300);
          }}
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
      <p className="muted small">Click in a plane to set the crosshair. Page Up / Down steps the slices of the plane you used last, and so does the mouse wheel when the top bar says "Wheel: slices" (Shift + wheel in the other mode). Drag moves the image, a pinch zooms.</p>
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

/** A linked segmentation file as the planes draw it: which one and which of its segments are hidden. */
interface LinkedPane {
  id: number;
  hide: number[];
}

function Pane({ imageId, plane, shapes, styles, shape, info, voxel, active, maxed, hidden, onMaximize, onActivate, onPick, onStep, seg, linked, linkedOpacity }: { imageId: number; plane: Plane; shapes: Shape[] | null; styles: Map<number, TypeStyle>; shape: VolumeShape; info: PlaneInfo; voxel: Voxel; active: boolean; maxed: boolean; hidden: boolean; onMaximize(): void; onActivate(): void; onPick(v: Voxel): void; onStep(delta: number): void; seg: SegPane | null; linked: LinkedPane[]; linkedOpacity: number }) {
  const host = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<OpenSeadragon.Viewer | null>(null);
  const blender = useRef<ZBlender | null>(null);
  const cross = useRef<CrosshairLayer | null>(null);
  const notes = useRef<AnnotationLayer | null>(null);
  const brush = useRef<BrushLayer | null>(null);
  const overlay = useRef<MaskOverlay | null>(null);
  const linkedOverlays = useRef<Map<number, MaskOverlay>>(new Map());
  /** the frame of the image on display: the mask of another frame waits until it is */
  const shownFrame = useRef<number | null>(null);
  const live = useRef({ shape, plane, voxel, onPick, onStep, onActivate, shapes, styles, seg, info, linked });
  live.current = { shape, plane, voxel, onPick, onStep, onActivate, shapes, styles, seg, info, linked };
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
    // the mouse wheel zooms or steps through the slices, as chosen in the top bar
    const el = v.canvas as HTMLElement;
    const stepper = new WheelStepper();
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
      // zoom mode: the wheel zooms and Shift + wheel steps; slices mode: the wheel steps and Ctrl + wheel or a pinch zooms. A track pad swipe
      // moves the image in both (and a pinch zooms), only a wheel is told from it
      const zoomMode = wheelMode() === "zoom";
      const kind = classifyWheel(e, performance.now(), -Infinity);
      if (zoomMode ? !e.shiftKey || e.ctrlKey : kind !== "wheel") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      // a notch of a wheel is 100 or so pixels, finer wheels and line-mode events add up to the same (Shift turns a wheel sideways on a Mac)
      const d = stepper.push({ deltaY: e.deltaY || e.deltaX, deltaMode: e.deltaMode }, performance.now());
      if (d) live.current.onStep(d);
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
    // the pointer that paints: a pen is tracked twice by OpenSeadragon (hovering and touching), its drag events carry the hovering one's position
    let strokeId: number | null = null;
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
      if (space) window.dispatchEvent(new Event(SPACE_DRAG));
      if (!sg?.editable || space || oe?.button === 1 || oe?.ctrlKey || oe?.metaKey || pen.ignores(e.pointerType)) return;
      const at = toPlane(e.position);
      if (!at) return;
      pen.note({ pointerType: e.pointerType ?? "mouse" });
      e.preventDefaultAction = true;
      const { shape: s, plane: pl, voxel: vx } = live.current;
      const frame = frameOf(pl, vx);
      live.current.onPick(voxelAt(s, pl, at[0], at[1], frame)); // the other planes follow the point that is worked on
      const erase = sg.tool.erase !== !!(oe?.shiftKey || oe?.altKey);
      if (sg.tool.tool === "wand") {
        void sg.onWand(pl, frame, at, erase);
        return;
      }
      stroke = { points: [at], erase, frame, lasso: sg.tool.tool === "lasso" };
      strokeId = (oe as PointerEvent | undefined)?.pointerId ?? null;
      if (stroke.lasso) {
        brush.current?.setLasso({ points: stroke.points, erase });
        return;
      }
      const [rx, ry] = radii(sg);
      brush.current?.setStroke({ points: stroke.points, rx, ry, erase });
    });
    on("canvas-drag", (e: PointerEv) => {
      if (stroke && live.current.seg) e.preventDefaultAction = true; // the image does not move under the brush; the points come from the pointer events
    });
    // the stroke follows the pointer that started it, its coalesced events too (a quick pen stroke has no gaps)
    const strokeMove = (ev: PointerEvent) => {
      const sg = live.current.seg;
      if (!stroke || !sg || (strokeId != null && ev.pointerId !== strokeId)) return;
      const r = el.getBoundingClientRect();
      const events = typeof ev.getCoalescedEvents === "function" ? ev.getCoalescedEvents() : [];
      for (const e of events.length ? events : [ev]) {
        const at = toPlane(new OpenSeadragon.Point(e.clientX - r.left, e.clientY - r.top));
        if (at) stroke.points.push(at);
      }
      if (stroke.lasso) {
        brush.current?.setLasso({ points: stroke.points, erase: stroke.erase });
        return;
      }
      const [rx, ry] = radii(sg);
      brush.current?.setStroke({ points: stroke.points, rx, ry, erase: stroke.erase });
    }
    const finish = () => {
      const sg = live.current.seg;
      if (!stroke || !sg) return;
      const done = stroke;
      stroke = null;
      strokeId = null;
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
    };
    on("canvas-release", (e: { originalEvent?: Event }) => {
      const id = (e.originalEvent as PointerEvent | undefined)?.pointerId;
      if (strokeId == null || id == null || id === strokeId) finish();
    });
    const up = (ev: PointerEvent) => {
      if (stroke && (strokeId == null || ev.pointerId === strokeId)) finish();
    };
    // the ring of the brush follows the pointer
    const move = (ev: PointerEvent) => {
      strokeMove(ev);
      const sg = live.current.seg;
      const r = el.getBoundingClientRect();
      const at = toPlane(new OpenSeadragon.Point(ev.clientX - r.left, ev.clientY - r.top));
      pointer.current = at;
      if (!sg?.editable || sg.tool.tool !== "brush" || !at) return brush.current?.setRing(null);
      const [rx, ry] = radii(sg);
      brush.current?.setRing({ at, rx, ry, erase: sg.tool.erase !== (ev.shiftKey || ev.altKey) });
    };
    const leave = () => {
      pointer.current = null;
      brush.current?.setRing(null);
    };
    // Shift or Alt turn + and − around: the ring shows it at once, without the pointer having to move
    const heldKeys = (ev: KeyboardEvent) => {
      if (ev.key !== "Shift" && ev.key !== "Alt") return;
      const sg = live.current.seg;
      const at = pointer.current;
      if (!sg?.editable || sg.tool.tool !== "brush" || !at) return;
      const [rx, ry] = radii(sg);
      brush.current?.setRing({ at, rx, ry, erase: sg.tool.erase !== (ev.shiftKey || ev.altKey) });
    };
    window.addEventListener("keydown", heldKeys);
    window.addEventListener("keyup", heldKeys);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("pointerleave", leave);
    notes.current = plane === 0 ? new AnnotationLayer(v) : null; // below the crosshair
    if (live.current.shapes) notes.current?.setData(live.current.shapes, live.current.styles);
    const c = new CrosshairLayer(v);
    cross.current = c;
    brush.current = new BrushLayer(v);
    shownFrame.current = null;
    const b = new ZBlender(v, info.frames, (f) => loadTileSource(imageId, plane + 1, f), {
      blend: false,
      onBusy: setBusy,
      onReady: () => v.viewport.goHome(true),
      onShown: (f) => {
        shownFrame.current = f;
        overlay.current?.setDisplayed(f);
        linkedOverlays.current.forEach((o) => o.setDisplayed(f));
      },
    });
    blender.current = b;
    b.setPosition(frameOf(plane, live.current.voxel));
    return () => {
      el.removeEventListener("wheel", wheel, { capture: true });
      window.removeEventListener("keydown", heldKeys);
      window.removeEventListener("keyup", heldKeys);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
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
    if (shownFrame.current != null) o.setDisplayed(shownFrame.current);
    return () => {
      o.destroy();
      overlay.current = null;
    };
  }, [annotationId, info.width, info.height, imageId, plane, info.frames]);
  // the linked segmentation files: one read-only overlay each, below the mask being edited
  const linkedKey = linked.map((l) => l.id).join(",");
  useEffect(() => {
    const v = viewerRef.current;
    if (!v) return;
    const made = new Map<number, MaskOverlay>();
    for (const id of linkedKey ? linkedKey.split(",").map(Number) : []) {
      const o = new MaskOverlay(v, info.width, info.height);
      if (shownFrame.current != null) o.setDisplayed(shownFrame.current);
      made.set(id, o);
    }
    linkedOverlays.current = made;
    return () => {
      made.forEach((o) => o.destroy());
      linkedOverlays.current = new Map();
    };
  }, [linkedKey, info.width, info.height, imageId, plane, info.frames]);
  const linkedHides = linked.map((l) => `${l.id}:${l.hide.join(".")}`).join("|");
  useEffect(() => {
    const t = window.setTimeout(() => {
      for (const l of live.current.linked) linkedOverlays.current.get(l.id)?.load(`/api/v2/linked-volumes/${l.id}/slice/${plane}/${frame}?hide=${l.hide.join(",")}&alpha=255&v=${imageId}`, frame);
    }, 30);
    return () => window.clearTimeout(t);
  }, [linkedKey, linkedHides, plane, frame, imageId, info.frames]);
  useEffect(() => {
    linkedOverlays.current.forEach((o) => o.setOpacity(linkedOpacity));
  }, [linkedOpacity, linkedKey, imageId, info.frames, info.width, info.height, plane]);
  const color = seg?.color;
  const version = seg?.version;
  useEffect(() => {
    if (annotationId == null || color == null) return;
    const t = window.setTimeout(() => overlay.current?.load(`/api/v2/segmentation/${annotationId}/slice/${plane}/${frame}?color=${hexDigits(color)}&alpha=255&v=${version}`, frame), 30);
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
  // the pane changed its size (maximized or back): OpenSeadragon only follows window resizes by itself
  useEffect(() => {
    const id = window.requestAnimationFrame(() => {
      const el = host.current;
      const v = viewerRef.current;
      if (!el || !v || el.clientWidth === 0) return;
      window.dispatchEvent(new Event("resize")); // OpenSeadragon measures its container on a window resize
      v.viewport.goHome(true);
    });
    return () => window.cancelAnimationFrame(id);
  }, [maxed, hidden]);
  useEffect(() => {
    const [px, py] = pixelOf(shape, plane, voxel);
    cross.current?.set([px, py], { vertical: PLANE_COLORS[CROSS_PLANES[plane].vertical], horizontal: PLANE_COLORS[CROSS_PLANES[plane].horizontal] });
  }, [shape, plane, voxel]);

  return (
    <div className={`mpr-pane ${active ? "active" : ""}`} hidden={hidden} data-testid={`mpr-${PLANE_NAMES[plane].toLowerCase()}`} style={{ borderColor: PLANE_COLORS[plane] }}>
      <div ref={host} className="osd" />
      <div className="mpr-label" style={{ color: PLANE_COLORS[plane] }}>
        {PLANE_NAMES[plane]} · {frame + 1} / {info.frames}
        <span className="muted small"> {info.frame_descriptors[frame] ?? ""}</span>
      </div>
      <button type="button" className="mpr-max" onClick={onMaximize} aria-pressed={maxed} aria-label={maxed ? `Back to the three planes` : `Maximize the ${PLANE_NAMES[plane].toLowerCase()} plane`} title={maxed ? "Back to the three planes" : "Maximize this plane"} data-testid={`mpr-max-${PLANE_NAMES[plane].toLowerCase()}`}>
        {maxed ? "⤡" : "⤢"}
      </button>
      {busy && <span className="spinner mpr-busy" role="status" aria-label="Loading the slice" />}
      <div className="mpr-steps">
        <button type="button" className="mpr-step" disabled={frame <= 0} onClick={() => onStep(-1)} aria-label={`${PLANE_NAMES[plane]}: previous slice`}>−</button>
        <input className="mpr-slider" type="range" min={0} max={info.frames - 1} value={frame} onChange={(e) => onStep(Number(e.target.value) - frame)} aria-label={`${PLANE_NAMES[plane]} slice`} />
        <button type="button" className="mpr-step" disabled={frame >= info.frames - 1} onClick={() => onStep(1)} aria-label={`${PLANE_NAMES[plane]}: next slice`}>+</button>
      </div>
    </div>
  );
}
