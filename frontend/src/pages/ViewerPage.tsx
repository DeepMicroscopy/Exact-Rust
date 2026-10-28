import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import OpenSeadragon from "openseadragon";
import { api, listAll } from "../api/client";
import type { Page } from "../api/client";
import { ANNOTATION_FIELDS, createAnnotation } from "../api/annotations";
import type { Annotation, AnnotationType, ImageSummary, Registration } from "../api/types";
import { useAnnotationActions } from "../hooks/useAnnotationActions";
import { AnnotationLayer } from "../viewer-core/annotationLayer";
import { installGestures } from "../viewer-core/gestures";
import { AnnotationEditor, vectorOfShape, type EditorHost, type PolyOp, type Tool, type TypeInfo } from "../viewer-core/editor";
import { buildPalette, canConvert, isDrawable, oneClickCapable, type PaletteEntry } from "../viewer-core/palette";
import { isTypingTarget, matchShortcut } from "../viewer-core/shortcuts";
import { toShape } from "../viewer-core/shapes";
import { MaskSet, type ToolState } from "../viewer-core/segmentation";
import { SegmentationTool } from "../viewer-core/segmentationTool";
import { clipboard, pasteVector } from "../viewer-core/clipboard";
import { affineOf, invertAffine, type Affine } from "../viewer-core/overlay";
import { loadTileSource } from "../viewer-core/tileSource";
import { OverlayControl } from "../components/OverlayControl";
import { ZBlender } from "../viewer-core/zBlend";
import type { ZRange } from "../viewer-core/zFormat";
import { RepairBanner } from "../components/RepairBanner";
import { TimeSlider, ZSlider } from "../components/FrameControls";
import { Toolbox } from "../components/Toolbox";
import { AnnotationInfo } from "../components/AnnotationInfo";
import { ConfirmDelete } from "../components/ConfirmDelete";
import { ConfirmResize } from "../components/ConfirmResize";
import { boxVector, centeredBox, isBoxType } from "../viewer-core/geometry";
import { ContextMenu } from "../components/ContextMenu";
import { CropDialog } from "../components/CropDialog";
import { VectorType, type Shape, type TypeStyle } from "../viewer-core/types";

const PLANES = ["Axial", "Coronal", "Sagittal"];

type FrameKind = "none" | "zstack" | "volume" | "timeseries";

interface Meta {
  frames: number;
  issues?: string[];
  frame_kind?: FrameKind;
  frame_labels?: string[];
  /** frames per second of a movie, when the file says */
  frame_rate?: number | null;
  z_range?: ZRange | null;
  planes: { plane: number; name: string; frames: number; frame_descriptors: string[] }[] | null;
}

/** The map from the pixels of image `from` to those of image `to`, through a registration in either direction. */
async function registrationMap(from: number, to: number): Promise<Affine | null> {
  const direct = await api<Page<Registration>>(`/api/v2/registrations?source_image=${from}&target_image=${to}&limit=1`).catch(() => null);
  const m = direct?.items[0]?.transformation_matrix;
  if (m) return affineOf(m);
  const back = await api<Page<Registration>>(`/api/v2/registrations?source_image=${to}&target_image=${from}&limit=1`).catch(() => null);
  const b = back?.items[0]?.transformation_matrix && affineOf(back.items[0].transformation_matrix);
  return b ? invertAffine(b) : null;
}

/** An editor host that always asks the latest one (the editor lives as long as the viewer, the host changes with the data). */
function hostProxy(ref: { current: EditorHost }): EditorHost {
  return {
    shapes: () => ref.current.shapes(),
    type: (id) => ref.current.type(id),
    image: () => ref.current.image(),
    onCreate: (t, v) => ref.current.onCreate(t, v),
    onUpdate: (s, v) => ref.current.onUpdate(s, v),
    onDelete: (s) => ref.current.onDelete(s),
    onReplace: (s, r) => ref.current.onReplace(s, r),
    onContext: (s, x, y) => ref.current.onContext(s, x, y),
    onUpdateMany: (i) => ref.current.onUpdateMany(i),
    onDeleteMany: (s) => ref.current.onDeleteMany(s),
    onContextMany: (s, x, y) => ref.current.onContextMany(s, x, y),
    notify: (m) => ref.current.notify(m),
    onState: () => ref.current.onState(),
  };
}

const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

export function ViewerPage() {
  const { imageId } = useParams();
  const [search] = useSearchParams();
  const id = Number(imageId);
  const navigate = useNavigate();
  const host = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<OpenSeadragon.Viewer | null>(null);
  const layerRef = useRef<AnnotationLayer | null>(null);
  const blenderRef = useRef<ZBlender | null>(null);
  const [pos, setPosState] = useState(0); // (fractional) frame position
  const posRef = useRef(0);
  const frameFor = useRef<number | null>(null);
  const anim = useRef(0);
  const [plane, setPlane] = useState(0);
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const image = useQuery({
    queryKey: ["image", id],
    queryFn: () => api<ImageSummary>(`/api/v2/images/${id}?fields=id,name,width,height,frames,depth,image_set,mpp,crop_source,crop_x,crop_y,crop_frame`),
  });
  const failed = image.isError || !!error;
  const meta = useQuery({ queryKey: ["image-meta", id], queryFn: () => api<Meta>(`/api/v2/images/${id}/metadata`) });
  const types = useQuery({
    queryKey: ["annotation-types"],
    queryFn: () => listAll<AnnotationType>("/api/v2/annotation-types", { fields: "id,name,vector_type,color_code,closed,node_count,default_width,default_height,size_unit,sort_order,product" }),
  });
  const imageSetId = image.data?.image_set;
  const imageSet = useQuery({
    queryKey: ["image-set", imageSetId],
    enabled: imageSetId != null,
    queryFn: () => api<{ id: number; images: number[]; product_set: number[]; main_annotation_type: number | null; team: number | null }>(`/api/v2/image-sets/${imageSetId}?fields=id,images,product_set,main_annotation_type,team`),
  });
  const annotations = useQuery({
    queryKey: ["annotations", id],
    queryFn: () => listAll<Annotation>("/api/v2/annotations", { image: id, deleted: false, fields: ANNOTATION_FIELDS }),
  });

  // ---- annotation editing ---------------------------------------------------------------------------------------
  const editorRef = useRef<AnnotationEditor | null>(null);
  const [, setTick] = useState(0); // the editor owns tool, selection and draft; this re-renders the toolbox when they change
  const [drawing, setDrawing] = useState(false);
  const [oneClick, setOneClick] = useState(false);
  const [currentTypeId, setCurrentTypeId] = useState<number | null>(null);
  const [polyOp, setPolyOp] = useState<PolyOp | null>(null);
  const [menu, setMenu] = useState<{ shape: Shape; x: number; y: number } | null>(null);
  const qc = useQueryClient();
  const [segTypeId, setSegTypeId] = useState<number | null>(null);
  const [planeDims, setPlaneDims] = useState<{ w: number; h: number } | null>(null);
  const [maskOpacity, setMaskOpacity] = useState(0.55);
  const masksRef = useRef<MaskSet | null>(null);
  const segToolRef = useRef<SegmentationTool | null>(null);
  const [groupMenu, setGroupMenu] = useState<{ shapes: Shape[]; x: number; y: number } | null>(null);
  const [groupDelete, setGroupDelete] = useState<Shape[] | null>(null);
  const [dialog, setDialog] = useState<{ kind: "info" | "crop" | "delete" | "resize"; shape: Shape; typeId?: number } | null>(null);
  const [cropped, setCropped] = useState<{ id: number } | null>(null);
  const [playing, setPlaying] = useState(false);
  const [fpsOverride, setFpsOverride] = useState<number | null>(null);
  const [showAnnotations, setShowAnnotations] = useState(true);
  const [toast, setToast] = useState<string | null>(null);
  const [sideOpen, setSideOpen] = useState(() => window.innerWidth >= 760);
  const [sideFolded, setSideFolded] = useState(() => {
    try {
      return localStorage.getItem("exact.side.folded") === "1";
    } catch {
      return false;
    }
  });
  const [toolsOpen, setToolsOpen] = useState(() => window.innerWidth >= 760); // phones view first: the tools open on demand
  const notify = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 5000);
  }, []);

  const mpp = image.data?.mpp ?? 0;
  const original = useQuery({
    queryKey: ["image-name", image.data?.crop_source],
    enabled: image.data?.crop_source != null,
    queryFn: () => api<{ id: number; name: string }>(`/api/v2/images/${image.data!.crop_source}?fields=id,name`),
  });
  const [cursor, setCursor] = useState<[number, number] | null>(null);
  const allEntries = useMemo(() => buildPalette(types.data ?? [], mpp), [types.data, mpp]);
  const palette: PaletteEntry[] = useMemo(() => {
    const products = new Set(imageSet.data?.product_set ?? []);
    const own = (types.data ?? []).filter((t) => t.product != null && products.has(t.product));
    return buildPalette(own, mpp);
  }, [types.data, imageSet.data, mpp]);
  const drawable = useMemo(() => palette.filter((e) => isDrawable(e.vectorType)), [palette]);
  const globals = useMemo(() => palette.filter((e) => e.vectorType === VectorType.Global), [palette]);
  const info = useCallback((tid: number): TypeInfo | undefined => palette.find((e) => e.id === tid) ?? allEntries.find((e) => e.id === tid), [palette, allEntries]);

  useEffect(() => {
    if (currentTypeId == null || !drawable.some((e) => e.id === currentTypeId)) {
      const main = imageSet.data?.main_annotation_type;
      setCurrentTypeId((drawable.find((e) => e.id === main) ?? drawable[0])?.id ?? null);
    }
  }, [drawable, currentTypeId, imageSet.data]);

  const created = useCallback((a: Annotation) => void a, []);
  const actions = useAnnotationActions(id, notify, created);
  const history = actions.history;
  useEffect(() => history.subscribe(() => setTick((n) => n + 1)), [history]);
  useEffect(() => history.clear(), [id, history]);

  const hiddenAll = useMemo(() => (showAnnotations ? hidden : new Set((types.data ?? []).map((t) => t.id))), [showAnnotations, hidden, types.data]);

  const styles = useMemo(() => {
    const m = new Map<number, TypeStyle>();
    types.data?.forEach((t) => m.set(t.id, { color: t.color_code, vectorType: t.vector_type, closed: t.closed }));
    return m;
  }, [types.data]);

  const shapes = useMemo(() => {
    const out: Shape[] = [];
    for (const a of annotations.data ?? []) {
      if (a.deleted) continue;
      const t = styles.get(a.annotation_type);
      if (!t) continue;
      const s = toShape(a.id, a.annotation_type, t.vectorType, t.closed, a.vector);
      if (s) out.push(s);
    }
    return out;
  }, [annotations.data, styles]);

  // the editor reads the current data through this object, so it does not have to be rebuilt when the data changes
  const hostState = useRef({ shapes, info, hiddenAll, image: image.data, actions });
  hostState.current = { shapes, info, hiddenAll, image: image.data, actions };
  const editorHost: EditorHost = useMemo(
    () => ({
      shapes: () => hostState.current.shapes.filter((s) => s.id > 0 && !hostState.current.hiddenAll.has(s.typeId)),
      type: (tid) => hostState.current.info(tid),
      image: () => ({ width: hostState.current.image?.width ?? 1, height: hostState.current.image?.height ?? 1, mpp: hostState.current.image?.mpp ?? 0 }),
      onCreate: (tid, v) => void hostState.current.actions.create(tid, v),
      onUpdate: (s, v) => void hostState.current.actions.update(s.id, v),
      onDelete: (s) => void hostState.current.actions.remove(s.id),
      onReplace: (s, rings) => void hostState.current.actions.replace(s.id, rings),
      onContext: (shape, x, y) => setMenu({ shape, x, y }),
      onUpdateMany: (items) => void hostState.current.actions.updateMany(items.map((i) => ({ id: i.shape.id, vector: i.vector }))),
      onDeleteMany: (shapes) => void hostState.current.actions.removeMany(shapes.map((q) => q.id)),
      onContextMany: (shapes, x, y) => setGroupMenu({ shapes, x, y }),
      notify: (m) => notify(m),
      onState: () => setTick((n) => n + 1),
    }),
    [notify],
  );
  const editorHostRef = useRef(editorHost);
  editorHostRef.current = editorHost;

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
      setPlaying(false);
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
    // keys go through viewer-core/shortcuts; OpenSeadragon's own (R rotates, F flips, J / K, ...) would collide with them
    viewer.addHandler("canvas-key", (e) => {
      e.preventDefaultAction = true;
    });
    viewerRef.current = viewer;
    (window as unknown as { __viewer?: OpenSeadragon.Viewer; __osd?: typeof OpenSeadragon }).__viewer = viewer; // used by the e2e tests
    (window as unknown as { __osd?: typeof OpenSeadragon }).__osd = OpenSeadragon;
    const layer = new AnnotationLayer(viewer);
    layerRef.current = layer;
    const editor = new AnnotationEditor(viewer, layer, hostProxy(editorHostRef));
    editorRef.current = editor;
    const removeGestures = installGestures(viewer, (e) => e.altKey || editor.brushActive());
    const masks = new MaskSet(() => layer.invalidate());
    layer.setMasks(masks);
    masksRef.current = masks;
    (window as unknown as { __masks?: MaskSet }).__masks = masks; // used by the e2e tests
    const segTool = new SegmentationTool(
      viewer,
      masks,
      (c) => hostState.current.actions.history.push(c),
      (m) => notify(m),
      () => setTick((n) => n + 1),
    );
    segToolRef.current = segTool;
    // pixel under the pointer (and, for a crop, in the original)
    let moveRaf = 0;
    const onMove = (ev: PointerEvent) => {
      cancelAnimationFrame(moveRaf);
      moveRaf = requestAnimationFrame(() => {
        const item = viewer.world.getItemCount() ? viewer.world.getItemAt(0) : null;
        const r = (viewer.canvas as HTMLElement).getBoundingClientRect();
        if (!item) return;
        const p = item.viewerElementToImageCoordinates(new OpenSeadragon.Point(ev.clientX - r.left, ev.clientY - r.top));
        setCursor([Math.round(p.x), Math.round(p.y)]);
      });
    };
    const onLeave = () => setCursor(null);
    (viewer.canvas as HTMLElement).addEventListener("pointermove", onMove);
    (viewer.canvas as HTMLElement).addEventListener("pointerleave", onLeave);
    (window as unknown as { __editor?: AnnotationEditor }).__editor = editor; // used by the e2e tests
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
      cancelAnimationFrame(moveRaf);
      removeGestures();
      segTool.destroy();
      masks.destroy();
      editor.destroy();
      layer.destroy();
      viewer.destroy();
      masksRef.current = null;
      segToolRef.current = null;
      viewerRef.current = null;
      layerRef.current = null;
      editorRef.current = null;
    };
  }, []);

  // nothing of the previous image may stay on the canvas while another one loads or when it cannot be opened
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    viewer.world.removeAll();
    viewer.forceRedraw();
    setError(null);
  }, [id, image.isError]);

  // the stack of planes: one tiled image per plane, cross-faded for focus planes
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !image.data || !meta.data) return;
    setError(null);
    const blender = new ZBlender(viewer, frames, (f) => loadTileSource(id, z, f), {
      blend,
      onReady: () => {
        viewer.viewport.goHome(true);
        const first = viewer.world.getItemAt(0);
        if (first) setPlaneDims({ w: Math.round(first.source.dimensions.x), h: Math.round(first.source.dimensions.y) });
        // opened from a crop: show where it lies in this image
        const region = search.get("region")?.split(",").map(Number);
        const item = viewer.world.getItemAt(0);
        if (region?.length === 4 && region.every(Number.isFinite) && item) {
          const [rx, ry, rw, rh] = region;
          const pad = Math.max(rw, rh) * 0.35;
          viewer.viewport.fitBounds(item.imageToViewportRectangle(rx - pad, ry - pad, rw + 2 * pad, rh + 2 * pad), true);
          layerRef.current?.setMark([rx, ry, rx + rw, ry + rh]);
        } else layerRef.current?.setMark(null);
      },
    });
    blenderRef.current = blender;
    const wanted = Number(search.get("frame"));
    if (search.get("frame") && Number.isFinite(wanted) && frameFor.current !== id) posRef.current = wanted; // opened from a crop: its frame
    frameFor.current = id;
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

  // ---- segmentation masks --------------------------------------------------------------------------------------------
  const segTypes = useMemo(
    () => (types.data ?? []).filter((t) => t.vector_type === VectorType.Segmentation && (!imageSet.data || imageSet.data.product_set.includes(t.product as number))).map((t) => ({ id: t.id, name: t.name, color: t.color_code })),
    [types.data, imageSet.data],
  );
  const segFrame = frames > 1 && kind !== "none" ? Math.round(pos) : 0;
  const planeIndex = hasPlanes ? plane : 0;
  const planeFrames = hasPlanes ? (meta.data?.planes?.[plane]?.frames ?? 1) : 0;
  // one mask layer per segmentation annotation of the image, for the slice or plane that is shown
  useEffect(() => {
    const masks = masksRef.current;
    if (!masks || !planeDims) return;
    const wanted = new Map<number, string>();
    for (const a of annotations.data ?? []) {
      if (a.deleted || a.id <= 0) continue;
      const t = (types.data ?? []).find((x) => x.id === a.annotation_type);
      if (t?.vector_type === VectorType.Segmentation) wanted.set(a.id, t.color_code);
    }
    masks.sync(wanted, (annotationId) => ({ annotationId, width: planeDims.w, height: planeDims.h, plane: planeIndex, frame: segFrame, ph: planeDims.h, nf: planeFrames }));
    for (const [aid, layer] of masks.layers) {
      const a = (annotations.data ?? []).find((x) => x.id === aid);
      layer.visible = showAnnotations && !(a && hidden.has(a.annotation_type));
      layer.opacity = maskOpacity;
    }
    layerRef.current?.invalidate();
  }, [annotations.data, types.data, planeDims, planeIndex, segFrame, planeFrames, showAnnotations, hidden, maskOpacity]);
  useEffect(() => setPlaneDims(null), [id, z]);

  // the mask of the chosen type is the one that is painted (it is created with the first stroke's tool)
  const segCreating = useRef(false);
  useEffect(() => {
    const masks = masksRef.current;
    const tool = segToolRef.current;
    const ed = editorRef.current;
    if (!masks || !tool || !ed) return;
    const a = segTypeId == null ? null : (annotations.data ?? []).find((x) => x.annotation_type === segTypeId && !x.deleted && x.id > 0);
    masks.active = a?.id ?? null;
    tool.enabled = segTypeId != null;
    ed.suspended = segTypeId != null;
    if (segTypeId != null) {
      ed.select(null);
      (viewerRef.current?.canvas as HTMLElement | undefined)?.style.removeProperty("cursor");
    }
    if (segTypeId != null && annotations.data && !a && image.data && !segCreating.current) {
      segCreating.current = true;
      createAnnotation({ image: id, annotation_type: segTypeId, vector: { tile_size: 256, width: planeDims?.w ?? image.data.width, height: planeDims?.h ?? image.data.height }, unique_identifier: crypto.randomUUID() })
        .then(() => qc.invalidateQueries({ queryKey: ["annotations", id] }))
        .catch((e: Error) => notify(`Could not create the mask: ${e.message}`))
        .finally(() => {
          segCreating.current = false;
        });
    }
    setTick((n) => n + 1);
  }, [segTypeId, annotations.data, id, image.data, planeDims, qc, notify]);
  useEffect(() => setSegTypeId(null), [id]);

  // ---- playing a movie ----------------------------------------------------------------------------------------------
  const nativeFps = meta.data?.frame_rate ?? null;
  const fps = fpsOverride ?? nativeFps ?? 10;
  const togglePlay = useCallback(() => {
    setPlaying((p) => {
      if (!p && Math.round(posRef.current) >= frames - 1) setPos(0); // at the end: start again
      return !p;
    });
  }, [frames, setPos]);
  useEffect(() => {
    if (blenderRef.current) blenderRef.current.ahead = playing ? 6 : 2; // load further ahead while playing
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    let acc = 0;
    const tick = (now: number) => {
      acc += now - last;
      last = now;
      const ms = 1000 / fps;
      if (acc >= ms) {
        const steps = Math.min(Math.floor(acc / ms), 3); // a slow machine drops frames instead of falling behind
        acc = 0;
        const next = Math.round(posRef.current) + steps;
        if (next >= frames - 1) {
          setPos(frames - 1);
          setPlaying(false);
          return;
        }
        setPos(next);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, fps, frames, setPos]);
  useEffect(() => setPlaying(false), [id]);

  // ---- keyboard ---------------------------------------------------------------------------------------------------
  const menuOpen = useRef(false);
  menuOpen.current = !!menu || !!groupMenu || !!groupDelete || !!dialog;
  const imageIds = imageSet.data?.images ?? [];
  const step = useCallback(
    (delta: number) => {
      const i = imageIds.indexOf(id);
      const next = imageIds[i + delta];
      if (i >= 0 && next != null) navigate(`/images/${next}`);
    },
    [imageIds, id, navigate],
  );
  /** The tools are exclusive: select, select several, or annotate (shapes or masks). */
  const exitMulti = useCallback(() => {
    if (editorRef.current?.multiMode) editorRef.current.setMultiMode(false);
  }, []);
  const startDrawing = useCallback((typeId: number) => {
    exitMulti();
    setSegTypeId(null);
    setCurrentTypeId(typeId);
    setDrawing(true);
    const e = info(typeId);
    if (e && !oneClickCapable(e.vectorType)) setOneClick(false);
  }, [info, exitMulti]);
  const toggleGlobal = useCallback(
    (typeId: number) => {
      const existing = (annotations.data ?? []).find((a) => a.annotation_type === typeId && !a.deleted && a.id > 0);
      if (existing) void actions.remove(existing.id);
      else void actions.create(typeId, null);
    },
    [annotations.data, actions],
  );
  const syncFromEditor = useCallback(() => {
    // Escape may end the draw tool inside the editor
    const ed = editorRef.current;
    if (ed && ed.tool.kind === "select") setDrawing(false);
  }, []);
  /** Class change; a change to a fixed-size type that would change the size asks first. */
  const requestChangeType = useCallback(
    (shapeId: number, typeId: number) => {
      const shape = shapes.find((x) => x.id === shapeId);
      const target = info(typeId);
      if (shape && target && target.vectorType === VectorType.FixedSizeBoundingBox && isBoxType(shape.vectorType) && target.width && target.height) {
        const [w, h] = [Math.round(shape.bbox[2] - shape.bbox[0]), Math.round(shape.bbox[3] - shape.bbox[1])];
        if (Math.abs(w - target.width) >= 1 || Math.abs(h - target.height) >= 1) {
          setDialog({ kind: "resize", shape, typeId });
          return;
        }
      }
      void actions.changeType(shapeId, typeId);
    },
    [shapes, info, actions],
  );

  // ---- several annotations at once ---------------------------------------------------------------------------------
  const pasteCount = useRef(0);
  /** Types that all of these annotations can change to (compatible shapes). */
  const classesFor = useCallback((group: Shape[]) => palette.filter((e) => e.vectorType !== VectorType.Global && group.every((q) => canConvert(q.vectorType, e.vectorType))), [palette]);
  const changeGroup = useCallback(
    (group: Shape[], typeId: number) => {
      const target = info(typeId);
      const bounds = { width: image.data?.width ?? 1, height: image.data?.height ?? 1 };
      void actions.history.group(`change type of ${group.length} annotations`, async () => {
        let resized = 0;
        await Promise.all(
          group.map((q) => {
            let vector;
            if (target && target.vectorType === VectorType.FixedSizeBoundingBox && isBoxType(q.vectorType) && target.width && target.height) {
              const [w, h] = [Math.round(q.bbox[2] - q.bbox[0]), Math.round(q.bbox[3] - q.bbox[1])];
              if (Math.abs(w - target.width) >= 1 || Math.abs(h - target.height) >= 1) {
                resized++;
                vector = boxVector(centeredBox([(q.bbox[0] + q.bbox[2]) / 2, (q.bbox[1] + q.bbox[3]) / 2], target.width, target.height, bounds));
              }
            }
            return actions.changeType(q.id, typeId, vector);
          }),
        );
        if (resized) notify(`${resized} annotation${resized === 1 ? " was" : "s were"} resized to the size of ${target?.name}.`);
      });
    },
    [actions, info, image.data?.width, image.data?.height, notify],
  );
  const copySelection = useCallback(() => {
    const sel = editorRef.current?.selection ?? [];
    if (!sel.length) {
      notify("Select annotations first.");
      return;
    }
    clipboard.set({
      imageId: id,
      items: sel.map((q) => ({ typeId: q.typeId, vectorType: q.vectorType, vector: ((annotations.data ?? []).find((a) => a.id === q.id)?.vector as Record<string, number> | null | undefined) ?? vectorOfShape(q) })),
    });
    pasteCount.current = 0;
    notify(`Copied ${sel.length} annotation${sel.length === 1 ? "" : "s"}.`);
    setTick((n) => n + 1);
  }, [annotations.data, id, notify]);
  const pasteClipboard = useCallback(async () => {
    const c = clipboard.get();
    if (!c || !image.data) {
      notify("Nothing copied yet.");
      return;
    }
    const bounds = { width: image.data.width, height: image.data.height };
    const usable = c.items.filter((it) => info(it.typeId));
    if (usable.length < c.items.length) notify(`${c.items.length - usable.length} annotation(s) have a type this image set does not offer and are left out.`);
    if (!usable.length) return;
    let map: Affine | null = null;
    let shift: [number, number] = [0, 0];
    if (c.imageId === id) {
      const zoom = viewerRef.current?.world.getItemCount() ? viewerRef.current.world.getItemAt(0).viewportToImageZoom(viewerRef.current.viewport.getZoom(true)) : 1;
      pasteCount.current++;
      const d = (24 * pasteCount.current) / Math.max(zoom, 1e-6);
      shift = [d, d];
    } else {
      map = await registrationMap(c.imageId, id);
      if (!map) notify("These two images are not registered: the annotations are pasted at the same position.");
      else notify("Pasted through the registration.");
    }
    const items = usable.map((it) => {
      const t = info(it.typeId);
      return { typeId: it.typeId, vector: pasteVector(it, bounds, { map, shift, size: t?.width && t.height ? [t.width, t.height] : null }) };
    });
    const ids = await actions.createMany(items);
    if (ids.length) setTimeout(() => editorRef.current?.selectGroup(ids), 0);
  }, [id, image.data, info, actions, notify]);

  const digit = useCallback(
    (n: number, shift: boolean) => {
      if (shift) {
        const g = globals[n - 1];
        if (g) toggleGlobal(g.id);
        return;
      }
      const e = drawable.find((x) => x.key === n);
      if (!e) return;
      const grp = editorRef.current?.group ?? [];
      if (grp.length > 1 && !drawing) {
        const members = editorRef.current?.groupShapes ?? [];
        if (members.every((q) => canConvert(q.vectorType, e.vectorType))) changeGroup(members, e.id);
        else notify(`${e.name} cannot replace the type of all selected annotations (different shapes).`);
        return;
      }
      const sel = editorRef.current?.selected;
      if (sel && !drawing) {
        if (canConvert(sel.vectorType, e.vectorType)) requestChangeType(sel.id, e.id);
        else notify(`${e.name} cannot replace the type of this annotation (different shape).`);
      } else startDrawing(e.id);
    },
    [globals, drawable, drawing, requestChangeType, changeGroup, toggleGlobal, startDrawing, notify],
  );

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (isTypingTarget(ev.target) || menuOpen.current) return;
      if (kind !== "none" && frames > 1 && (ev.key === "PageUp" || ev.key === "PageDown")) {
        ev.preventDefault();
        const target = Math.round(posRef.current) + (ev.key === "PageUp" ? 1 : -1);
        animateTo(Math.min(Math.max(target, 0), frames - 1));
        return;
      }
      const a = matchShortcut(ev);
      if (!a) return;
      const ed = editorRef.current;
      const viewer = viewerRef.current;
      switch (a.type) {
        case "finish":
          if (ed?.finish()) ev.preventDefault();
          return;
        case "cancel":
          if (segTypeId != null) {
            setSegTypeId(null);
            return;
          }
          ed?.cancel();
          syncFromEditor();
          return;
        case "selectAll":
          ev.preventDefault();
          ed?.selectAll();
          return;
        case "copy":
          if ((ed?.selection.length ?? 0) > 0) {
            ev.preventDefault();
            copySelection();
          }
          return;
        case "paste":
          ev.preventDefault();
          void pasteClipboard();
          return;
        case "delete":
          if (ed && ed.selection.length) {
            ev.preventDefault();
            ed.deleteSelection();
          }
          return;
        case "digit":
          ev.preventDefault();
          digit(a.n, a.shift);
          return;
        case "play":
          if (kind === "timeseries" && frames > 1) {
            ev.preventDefault();
            togglePlay();
          }
          return;
        case "toggleDrawing":
          if (drawing || segTypeId != null) {
            setDrawing(false);
            setSegTypeId(null);
          } else if (currentTypeId != null) startDrawing(currentTypeId);
          return;
        case "toggleAnnotations":
          setShowAnnotations((v) => !v);
          return;
        case "polyOp":
          setDrawing(false);
          setPolyOp((cur) => (cur === a.op ? null : a.op));
          return;
        case "toggleOneClick": {
          const e = drawable.find((x) => x.id === currentTypeId);
          if (e && oneClickCapable(e.vectorType) && currentTypeId != null) {
            setOneClick((v) => !v);
            startDrawing(currentTypeId);
          }
          return;
        }
        case "undo":
          ev.preventDefault();
          void actions.undo();
          return;
        case "redo":
          ev.preventDefault();
          void actions.redo();
          return;
        case "nextImage":
          step(1);
          return;
        case "prevImage":
          step(-1);
          return;
        case "nextFrame":
        case "prevFrame":
          if (frames > 1) animateTo(Math.min(Math.max(Math.round(posRef.current) + (a.type === "nextFrame" ? 1 : -1), 0), frames - 1));
          return;
        case "pan": {
          if (!viewer) return;
          const b = viewer.viewport.getBounds(true);
          viewer.viewport.panBy(new OpenSeadragon.Point(a.dx * b.width * 0.15, a.dy * b.height * 0.15));
          ev.preventDefault();
          return;
        }
        case "zoom":
          viewer?.viewport.zoomBy(a.factor);
          return;
        case "home":
          viewer?.viewport.goHome();
          return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [kind, frames, animateTo, actions, digit, drawing, currentTypeId, drawable, step, syncFromEditor, togglePlay, copySelection, pasteClipboard, segTypeId]);

  useEffect(() => layerRef.current?.setData(shapes, styles), [shapes, styles]);
  useEffect(() => layerRef.current?.setHiddenTypes(hiddenAll), [hiddenAll]);
  useEffect(() => editorRef.current?.sync(), [shapes, hiddenAll]);

  // the editor's tool follows the toolbox state
  useEffect(() => {
    const tool: Tool = polyOp ? { kind: "op", op: polyOp } : drawing && currentTypeId != null ? { kind: "draw", typeId: currentTypeId, oneClick } : { kind: "select" };
    editorRef.current?.setTool(tool);
  }, [drawing, currentTypeId, oneClick, polyOp]);
  // the editor ends an operation by itself (finished, cancelled, refused): follow it
  useEffect(() => {
    const t = editorRef.current?.tool;
    if (polyOp && t && t.kind !== "op") setPolyOp(null);
  });

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
        {image.data?.crop_source != null && image.data.crop_x != null && image.data.crop_y != null && (
          <span className="origin" title="This image is a crop. Its pixel (0, 0) is the original's pixel (x, y).">
            Crop of{" "}
            <Link to={`/images/${image.data.crop_source}?region=${image.data.crop_x},${image.data.crop_y},${image.data.width},${image.data.height}`}>{original.data?.name ?? `image ${image.data.crop_source}`}</Link> at ({image.data.crop_x.toLocaleString("en-US")}, {image.data.crop_y.toLocaleString("en-US")})
            {" "}
            <Link className="btn" to={`/images/${image.data.crop_source}?region=${image.data.crop_x},${image.data.crop_y},${image.data.width},${image.data.height}${image.data.crop_frame ? `&frame=${image.data.crop_frame}` : ""}`}>
              Show in original
            </Link>
          </span>
        )}
        {cursor && (
          <span className="cursor-pos muted small" title="Pixel under the pointer">
            x {cursor[0].toLocaleString("en-US")} · y {cursor[1].toLocaleString("en-US")}
            {image.data?.crop_source != null && image.data.crop_x != null && image.data.crop_y != null && (
              <> · original {(cursor[0] + image.data.crop_x).toLocaleString("en-US")}, {(cursor[1] + (image.data.crop_y ?? 0)).toLocaleString("en-US")}</>
            )}
          </span>
        )}
        <span className="spacer" />
        {image.data && <OverlayControl key={id} viewerRef={viewerRef} imageId={id} width={image.data.width} />}
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
        <div ref={host} className={`osd ${failed ? "osd-hidden" : ""}`} />
        {failed && (
          <div className="viewer-error glass" role="alert" data-testid="viewer-error">
            <strong>{image.isError ? `Image ${id} was not found.` : error}</strong>
            {image.isError && <p className="muted small">It does not exist, was deleted, or you may not see it.</p>}
            <Link to="/" className="btn">
              Image sets
            </Link>
          </div>
        )}
        {meta.data && <RepairBanner imageId={id} damaged={!!meta.data.issues?.includes("damaged_pyramid")} />}
        <button className="side-toggle btn glass" onClick={() => setSideOpen((o) => !o)} aria-expanded={sideOpen} title="Annotation types">
          ☰
        </button>
        <aside className={`viewer-side glass ${sideOpen ? "" : "closed"}`}>
          <button
            className="sidebar-title fold"
            aria-expanded={!sideFolded}
            onClick={() => {
              setSideFolded((f) => {
                try {
                  localStorage.setItem("exact.side.folded", f ? "0" : "1");
                } catch {
                  /* private mode */
                }
                return !f;
              });
            }}
          >
            Annotation types <span aria-hidden>{sideFolded ? "▸" : "▾"}</span>
          </button>
          {!sideFolded && <>
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
          </>}
        </aside>
        <button className="tools-toggle btn glass" onClick={() => setToolsOpen((o) => !o)} aria-expanded={toolsOpen} title="Annotation tools">
          {toolsOpen ? "✕" : "✎"}
        </button>
        {toolsOpen && (
        <Toolbox
          palette={drawable}
          globals={globals.map((entry) => ({ entry, set: (annotations.data ?? []).some((a) => a.annotation_type === entry.id && !a.deleted) }))}
          drawing={drawing}
          oneClick={oneClick}
          currentTypeId={currentTypeId}
          selected={editorRef.current?.shown ?? null}
          selectedType={editorRef.current?.selected ? (info(editorRef.current.selected.typeId) as PaletteEntry | undefined) ?? null : null}
          selectedVertex={editorRef.current?.selectedVertex ?? null}
          draftPoints={editorRef.current?.draftPoints ?? 0}
          polyOp={polyOp}
          brushMode={editorRef.current?.brushMode ?? "off"}
          brushRadius={editorRef.current?.brushRadius ?? 18}
          reshapable={!!editorRef.current?.selected && editorRef.current.selected.vectorType === VectorType.Polygon && !((editorRef.current.selected && info(editorRef.current.selected.typeId)?.nodeCount) || 0)}
          segTypes={segTypes}
          seg={segTypeId == null ? null : { typeId: segTypeId, state: segToolRef.current?.state ?? ({ tool: "brush", size: 24, shape: "circle", tolerance: 24 } as ToolState), opacity: maskOpacity, tooMany: [...(masksRef.current?.layers.values() ?? [])].some((l) => l.tooMany), ready: !!masksRef.current?.editable }}
          group={editorRef.current && editorRef.current.group.length > 1 ? { count: editorRef.current.group.length, classes: classesFor(editorRef.current.groupShapes) } : null}
          multiMode={editorRef.current?.multiMode ?? false}
          canPaste={!!clipboard.get()}
          canUndo={history.canUndo}
          canRedo={history.canRedo}
          annotationsShown={showAnnotations}
          imageMpp={mpp}
          on={{
            select: () => {
              exitMulti();
              setDrawing(false);
              setPolyOp(null);
              setSegTypeId(null);
            },
            segment: (tid) => {
              exitMulti();
              setDrawing(false);
              setPolyOp(null);
              setSegTypeId(tid);
            },
            segState: (p) => segToolRef.current?.setState(p),
            maskOpacity: setMaskOpacity,
            polyOp: (op) => {
              setDrawing(false);
              setPolyOp((cur) => (cur === op ? null : op));
            },
            brush: (m) => editorRef.current?.setBrush(m),
            brushRadius: (r) => {
              if (editorRef.current) editorRef.current.brushRadius = r;
              editorRef.current?.refresh();
            },
            draw: startDrawing,
            oneClick: (v) => setOneClick(v),
            finish: () => void editorRef.current?.finish(),
            cancel: () => {
              editorRef.current?.cancel();
              syncFromEditor();
            },
            remove: () => editorRef.current?.deleteSelection(),
            toggleMulti: () => {
              const ed = editorRef.current;
              if (!ed) return;
              if (!ed.multiMode) {
                setDrawing(false);
                setPolyOp(null);
                setSegTypeId(null);
              }
              ed.setMultiMode(!ed.multiMode);
            },
            changeGroupType: (tid) => editorRef.current && changeGroup(editorRef.current.groupShapes, tid),
            copy: copySelection,
            paste: () => void pasteClipboard(),
            removeVertex: () => editorRef.current?.deleteSelection(),
            changeType: (tid) => editorRef.current?.selectedId != null && requestChangeType(editorRef.current.selectedId, tid),
            toggleGlobal,
            undo: () => void actions.undo(),
            redo: () => void actions.redo(),
            toggleAnnotations: () => setShowAnnotations((v) => !v),
          }}
        />
        )}
        {menu && (
          <ContextMenu
            model={{
              x: menu.x,
              y: menu.y,
              typeId: menu.shape.typeId,
              classes: palette.filter((e) => canConvert(menu.shape.vectorType, e.vectorType) && e.vectorType !== VectorType.Global),
              canCrop: [VectorType.BoundingBox, VectorType.FixedSizeBoundingBox, VectorType.Polygon].includes(menu.shape.vectorType as 1),
              cropWhy: "Only boxes and polygons can be cropped.",
            }}
            onClose={() => setMenu(null)}
            onInfo={() => {
              setDialog({ kind: "info", shape: menu.shape });
              setMenu(null);
            }}
            onClass={(tid) => {
              requestChangeType(menu.shape.id, tid);
              setMenu(null);
            }}
            onCrop={() => {
              setDialog({ kind: "crop", shape: menu.shape });
              setMenu(null);
            }}
            onDelete={() => {
              setDialog({ kind: "delete", shape: menu.shape });
              setMenu(null);
            }}
          />
        )}
        {groupMenu && (
          <ContextMenu
            model={{ x: groupMenu.x, y: groupMenu.y, typeId: -1, count: groupMenu.shapes.length, classes: classesFor(groupMenu.shapes), canCrop: false, cropWhy: "" }}
            onClose={() => setGroupMenu(null)}
            onInfo={() => undefined}
            onClass={(tid) => {
              changeGroup(groupMenu.shapes, tid);
              setGroupMenu(null);
            }}
            onCrop={() => undefined}
            onCopy={() => {
              copySelection();
              setGroupMenu(null);
            }}
            onDelete={() => {
              setGroupDelete(groupMenu.shapes);
              setGroupMenu(null);
            }}
          />
        )}
        {groupDelete && (
          <ConfirmDelete
            what={`Delete these ${groupDelete.length} annotations?`}
            onConfirm={() => {
              editorRef.current?.select(null);
              void actions.removeMany(groupDelete.map((q) => q.id));
            }}
            onClose={() => setGroupDelete(null)}
          />
        )}
        {dialog?.kind === "info" && <AnnotationInfo shape={dialog.shape} typeName={info(dialog.shape.typeId)?.name ?? `type ${dialog.shape.typeId}`} typeColor={info(dialog.shape.typeId)?.color} mpp={mpp} onClose={() => setDialog(null)} />}
        {dialog?.kind === "resize" && dialog.typeId != null && (() => {
          const target = info(dialog.typeId);
          const [w, h] = [Math.round(dialog.shape.bbox[2] - dialog.shape.bbox[0]), Math.round(dialog.shape.bbox[3] - dialog.shape.bbox[1])];
          const to: [number, number] = [Math.round(target?.width ?? w), Math.round(target?.height ?? h)];
          return (
            <ConfirmResize
              typeName={target?.name ?? `type ${dialog.typeId}`}
              from={[w, h]}
              to={to}
              sizeLabel={(target as PaletteEntry | undefined)?.sizeLabel ?? null}
              onConfirm={() => {
                const c: [number, number] = [(dialog.shape.bbox[0] + dialog.shape.bbox[2]) / 2, (dialog.shape.bbox[1] + dialog.shape.bbox[3]) / 2];
                void actions.changeType(dialog.shape.id, dialog.typeId!, boxVector(centeredBox(c, to[0], to[1], { width: image.data?.width ?? 1, height: image.data?.height ?? 1 })));
              }}
              onClose={() => setDialog(null)}
            />
          );
        })()}
        {dialog?.kind === "delete" && (
          <ConfirmDelete
            what={`Delete this ${info(dialog.shape.typeId)?.name ?? "annotation"} (ID ${dialog.shape.id})?`}
            onConfirm={() => {
              if (editorRef.current?.selectedId === dialog.shape.id) editorRef.current.select(null);
              void actions.remove(dialog.shape.id);
            }}
            onClose={() => setDialog(null)}
          />
        )}
        {dialog?.kind === "crop" && image.data && (
          <CropDialog
            imageId={id}
            region={(() => {
              const [x1, y1, x2, y2] = dialog.shape.bbox;
              const x = Math.max(0, Math.floor(x1));
              const y = Math.max(0, Math.floor(y1));
              return { x, y, w: Math.max(1, Math.min(image.data.width, Math.ceil(x2)) - x), h: Math.max(1, Math.min(image.data.height, Math.ceil(y2)) - y) };
            })()}
            frame={frames > 1 && kind !== "none" ? Math.round(posRef.current) : 0}
            source={{ team: imageSet.data?.team ?? null, products: imageSet.data?.product_set ?? [] }}
            mpp={mpp}
            onClose={() => setDialog(null)}
            onDone={(newId) => {
              setDialog(null);
              setCropped({ id: newId });
            }}
          />
        )}
        {cropped && (
          <div className="toast glass ok" role="status">
            Cropped image created.{" "}
            <Link to={`/images/${cropped.id}`} className="btn">
              Open it
            </Link>{" "}
            <button className="btn ghost" onClick={() => setCropped(null)}>
              ✕
            </button>
          </div>
        )}
        {toast && (
          <div className="toast glass" role="status" onClick={() => setToast(null)}>
            {toast}
          </div>
        )}
        {multiFrame && (kind === "zstack" || kind === "volume") && (
          <ZSlider frames={frames} value={pos} onChange={onSlider} labels={labels} zRange={kind === "zstack" ? zRange : null} blend={blend} />
        )}
      </div>
      {multiFrame && kind === "timeseries" && (
        <TimeSlider
          frames={frames}
          value={pos}
          onChange={onSlider}
          labels={labels}
          playback={{
            playing,
            onPlay: togglePlay,
            fps,
            nativeFps,
            onFps: setFpsOverride,
          }}
        />
      )}
    </div>
  );
}
