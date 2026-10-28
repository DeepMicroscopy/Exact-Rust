import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import OpenSeadragon from "openseadragon";
import { api, listAll } from "../api/client";
import { ANNOTATION_FIELDS } from "../api/annotations";
import type { Annotation, AnnotationType, ImageSummary } from "../api/types";
import { useAnnotationActions } from "../hooks/useAnnotationActions";
import { AnnotationLayer } from "../viewer-core/annotationLayer";
import { AnnotationEditor, type EditorHost, type Tool, type TypeInfo } from "../viewer-core/editor";
import { buildPalette, canConvert, isDrawable, oneClickCapable, type PaletteEntry } from "../viewer-core/palette";
import { isTypingTarget, matchShortcut } from "../viewer-core/shortcuts";
import { toShape } from "../viewer-core/shapes";
import { loadTileSource } from "../viewer-core/tileSource";
import { ZBlender } from "../viewer-core/zBlend";
import type { ZRange } from "../viewer-core/zFormat";
import { RepairBanner } from "../components/RepairBanner";
import { TimeSlider, ZSlider } from "../components/FrameControls";
import { Toolbox } from "../components/Toolbox";
import { VectorType, type Shape, type TypeStyle } from "../viewer-core/types";

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

/** An editor host that always asks the latest one (the editor lives as long as the viewer, the host changes with the data). */
function hostProxy(ref: { current: EditorHost }): EditorHost {
  return {
    shapes: () => ref.current.shapes(),
    type: (id) => ref.current.type(id),
    image: () => ref.current.image(),
    onCreate: (t, v) => ref.current.onCreate(t, v),
    onUpdate: (s, v) => ref.current.onUpdate(s, v),
    onDelete: (s) => ref.current.onDelete(s),
    onState: () => ref.current.onState(),
  };
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
    queryFn: () => api<ImageSummary>(`/api/v2/images/${id}?fields=id,name,width,height,frames,depth,image_set,mpp`),
  });
  const meta = useQuery({ queryKey: ["image-meta", id], queryFn: () => api<Meta>(`/api/v2/images/${id}/metadata`) });
  const types = useQuery({
    queryKey: ["annotation-types"],
    queryFn: () => listAll<AnnotationType>("/api/v2/annotation-types", { fields: "id,name,vector_type,color_code,closed,node_count,default_width,default_height,size_unit,sort_order,product" }),
  });
  const imageSetId = image.data?.image_set;
  const imageSet = useQuery({
    queryKey: ["image-set", imageSetId],
    enabled: imageSetId != null,
    queryFn: () => api<{ id: number; images: number[]; product_set: number[]; main_annotation_type: number | null }>(`/api/v2/image-sets/${imageSetId}?fields=id,images,product_set,main_annotation_type`),
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
  const [showAnnotations, setShowAnnotations] = useState(true);
  const [toast, setToast] = useState<string | null>(null);
  const [sideOpen, setSideOpen] = useState(() => window.innerWidth >= 760);
  const [toolsOpen, setToolsOpen] = useState(() => window.innerWidth >= 760); // phones view first: the tools open on demand
  const notify = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 5000);
  }, []);

  const mpp = image.data?.mpp ?? 0;
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
      if (s) out.push({ ...s, verified: a.verified_by_user !== false });
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
      image: () => ({ width: hostState.current.image?.width ?? 1, height: hostState.current.image?.height ?? 1 }),
      onCreate: (tid, v) => void hostState.current.actions.create(tid, v),
      onUpdate: (s, v) => void hostState.current.actions.update(s.id, v),
      onDelete: (s) => void hostState.current.actions.remove(s.id),
      onState: () => setTick((n) => n + 1),
    }),
    [],
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
      editor.destroy();
      layer.destroy();
      viewer.destroy();
      viewerRef.current = null;
      layerRef.current = null;
      editorRef.current = null;
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

  // ---- keyboard ---------------------------------------------------------------------------------------------------
  const imageIds = imageSet.data?.images ?? [];
  const step = useCallback(
    (delta: number) => {
      const i = imageIds.indexOf(id);
      const next = imageIds[i + delta];
      if (i >= 0 && next != null) navigate(`/images/${next}`);
    },
    [imageIds, id, navigate],
  );
  const startDrawing = useCallback((typeId: number) => {
    setCurrentTypeId(typeId);
    setDrawing(true);
    const e = info(typeId);
    if (e && !oneClickCapable(e.vectorType)) setOneClick(false);
  }, [info]);
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
  const digit = useCallback(
    (n: number, shift: boolean) => {
      if (shift) {
        const g = globals[n - 1];
        if (g) toggleGlobal(g.id);
        return;
      }
      const e = drawable.find((x) => x.key === n);
      if (!e) return;
      const sel = editorRef.current?.selected;
      if (sel && !drawing) {
        if (canConvert(sel.vectorType, e.vectorType)) void actions.changeType(sel.id, e.id);
        else notify(`${e.name} cannot replace the type of this annotation (different shape).`);
      } else startDrawing(e.id);
    },
    [globals, drawable, drawing, actions, toggleGlobal, startDrawing, notify],
  );

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (isTypingTarget(ev.target)) return;
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
          ed?.cancel();
          syncFromEditor();
          return;
        case "delete":
          if (ed?.selected) {
            ev.preventDefault();
            ed.deleteSelection();
          }
          return;
        case "digit":
          ev.preventDefault();
          digit(a.n, a.shift);
          return;
        case "toggleDrawing":
          if (drawing) setDrawing(false);
          else if (currentTypeId != null) setDrawing(true);
          return;
        case "toggleAnnotations":
          setShowAnnotations((v) => !v);
          return;
        case "toggleOneClick": {
          const e = drawable.find((x) => x.id === currentTypeId);
          if (e && oneClickCapable(e.vectorType)) {
            setOneClick((v) => !v);
            setDrawing(true);
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
  }, [kind, frames, animateTo, actions, digit, drawing, currentTypeId, drawable, step, syncFromEditor]);

  useEffect(() => layerRef.current?.setData(shapes, styles), [shapes, styles]);
  useEffect(() => layerRef.current?.setHiddenTypes(hiddenAll), [hiddenAll]);
  useEffect(() => editorRef.current?.sync(), [shapes, hiddenAll]);

  // the editor's tool follows the toolbox state
  useEffect(() => {
    const tool: Tool = drawing && currentTypeId != null ? { kind: "draw", typeId: currentTypeId, oneClick } : { kind: "select" };
    editorRef.current?.setTool(tool);
  }, [drawing, currentTypeId, oneClick]);

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
        <button className="side-toggle btn glass" onClick={() => setSideOpen((o) => !o)} aria-expanded={sideOpen} title="Annotation types">
          ☰
        </button>
        <aside className={`viewer-side glass ${sideOpen ? "" : "closed"}`}>
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
          selected={editorRef.current?.selected ?? null}
          selectedType={editorRef.current?.selected ? (info(editorRef.current.selected.typeId) as PaletteEntry | undefined) ?? null : null}
          verified={editorRef.current?.selected ? (annotations.data ?? []).find((a) => a.id === editorRef.current?.selectedId)?.verified_by_user !== false : false}
          selectedVertex={editorRef.current?.selectedVertex ?? null}
          draftPoints={editorRef.current?.draftPoints ?? 0}
          canUndo={history.canUndo}
          canRedo={history.canRedo}
          annotationsShown={showAnnotations}
          imageMpp={mpp}
          on={{
            select: () => setDrawing(false),
            draw: startDrawing,
            oneClick: (v) => setOneClick(v),
            finish: () => void editorRef.current?.finish(),
            cancel: () => {
              editorRef.current?.cancel();
              syncFromEditor();
            },
            remove: () => editorRef.current?.deleteSelection(),
            removeVertex: () => editorRef.current?.deleteSelection(),
            verify: (v) => editorRef.current?.selectedId != null && void actions.verify(editorRef.current.selectedId, v),
            changeType: (tid) => editorRef.current?.selectedId != null && void actions.changeType(editorRef.current.selectedId, tid),
            toggleGlobal,
            undo: () => void actions.undo(),
            redo: () => void actions.redo(),
            toggleAnnotations: () => setShowAnnotations((v) => !v),
          }}
        />
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
      {multiFrame && kind === "timeseries" && <TimeSlider frames={frames} value={pos} onChange={onSlider} labels={labels} />}
    </div>
  );
}
