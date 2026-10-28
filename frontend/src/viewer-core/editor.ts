import OpenSeadragon from "openseadragon";
import { AnnotationLayer, EMPTY_OVERLAY, type Overlay } from "./annotationLayer";
import {
  boxBetween,
  boxVector,
  centeredBox,
  clampPoint,
  dist,
  DEBOUNCE_PX,
  distanceToShape,
  handleAt,
  handlesFor,
  hitShape,
  insertVertex,
  isBoxType,
  isPathType,
  minVertices,
  moveVertex,
  movePoints,
  removeVertex,
  resizeBox,
  vectorOf,
  type Box,
  type Handle,
  type Pt,
} from "./geometry";
import { capsule, difference, simplify, split, tidy, union, type Ring } from "./polyops";
import { toShape } from "./shapes";
import { VectorType, type Shape } from "./types";

export interface TypeInfo {
  id: number;
  name: string;
  vectorType: number;
  closed: boolean;
  color: string;
  /** exact number of nodes of a polygon (0: free) */
  nodeCount: number;
  /** default size in image pixels (fixed-size types, one-click mode) */
  width: number | null;
  height: number | null;
}

export type PolyOp = "scissors" | "glue" | "knife";
export type BrushMode = "off" | "add" | "erase";

export type Tool = { kind: "select" } | { kind: "draw"; typeId: number; oneClick: boolean } | { kind: "op"; op: PolyOp };

export interface EditorHost {
  /** annotations that are shown (hidden types left out) */
  shapes(): Shape[];
  type(id: number): TypeInfo | undefined;
  image(): { width: number; height: number };
  onCreate(typeId: number, vector: Record<string, number>): void;
  onUpdate(shape: Shape, vector: Record<string, number>): void;
  onDelete(shape: Shape): void;
  /** a polygon operation produced these rings: the first replaces the shape, the others become annotations of the same type */
  onReplace(shape: Shape, rings: Pt[][]): void;
  /** right click or long press on an annotation (client coordinates) */
  onContext(shape: Shape, clientX: number, clientY: number): void;
  /** something the user should know ("select a polygon first", ...) */
  notify(msg: string): void;
  /** tool, selection or draft changed */
  onState(): void;
}

interface Ev {
  position: OpenSeadragon.Point;
  pointerType?: string;
  quick?: boolean;
  preventDefaultAction: boolean;
}

type Session =
  | { kind: "move"; shape: Shape; start: Pt; moved: boolean }
  | { kind: "handle"; shape: Shape; handle: Handle; moved: boolean; points: Pt[]; box: Box }
  | { kind: "drag"; typeId: number; start: Pt; cur: Pt }
  | { kind: "brush"; shape: Shape; erase: boolean; last: Pt; swept: Ring[]; moved: boolean };

const TOUCH_SLOP = 18;
const MOUSE_SLOP = 7;
const CLOSE_SLOP = 12;
const CLICK_DEBOUNCE_MS = 220;

const NEW_ID = -1;

/** The vector of a shape as the server stores it. */
export function vectorOfShape(s: Shape): Record<string, number> {
  return isBoxType(s.vectorType) ? boxVector(s.bbox) : vectorOf(s.points);
}

/** The outline of a polygon annotation as a ring. */
const ringOf = (s: Shape): Ring => s.points.map((q) => [...q] as Pt);

function reshape(base: Shape, box: Box | null, points: Pt[] | null): Shape {
  const v = box ? boxVector(box) : vectorOf(points ?? base.points);
  return { ...(toShape(base.id, base.typeId, base.vectorType, base.closed, v) as Shape), verified: base.verified };
}

/**
 * Selecting, moving, resizing and drawing of annotations on an OpenSeadragon viewer.
 *
 * Select tool: a click selects the annotation under the pointer (smallest first), a drag that starts on the *selected*
 * annotation or one of its handles edits it, every other drag pans. Draw tool: drag (boxes, lines), click (points, fixed-size
 * boxes, one-click mode) or a series of clicks (polygons, polylines). Mouse, pen and touch use the same pointer events.
 */
export class AnnotationEditor {
  tool: Tool = { kind: "select" };
  selectedId: number | null = null;
  selectedVertex: number | null = null;
  private session: Session | null = null;
  private draft: { typeId: number; points: Pt[]; op?: PolyOp } | null = null;
  brushMode: BrushMode = "off";
  /** radius of the brush in screen pixels */
  brushRadius = 18;
  private brushPreview: Ring[] | null = null;
  private preview: Shape | null = null;
  private hover: Pt | null = null;
  private mods = { shift: false, alt: false };
  private longPressedUntil = 0;
  private touch = false;
  private consumedPress = false;
  private lastCreate = { t: 0, at: [0, 0] as [number, number] };
  private cleanup: (() => void)[] = [];

  constructor(
    private viewer: OpenSeadragon.Viewer,
    private layer: AnnotationLayer,
    private host: EditorHost,
  ) {
    const on = <T>(name: string, fn: (e: T) => void) => {
      const h = fn as unknown as OpenSeadragon.EventHandler<OpenSeadragon.ViewerEvent>;
      viewer.addHandler(name as keyof OpenSeadragon.ViewerEventMap, h);
      this.cleanup.push(() => viewer.removeHandler(name as keyof OpenSeadragon.ViewerEventMap, h));
    };
    on<Ev>("canvas-press", (e) => this.press(e));
    on<Ev>("canvas-drag", (e) => this.drag(e));
    on<Ev>("canvas-release", (e) => this.release(e));
    on<Ev>("canvas-click", (e) => this.click(e));
    on<Ev>("canvas-double-click", (e) => this.doubleClick(e));
    on<unknown>("canvas-pinch", () => this.abortSession());
    on<{ scroll: number; preventDefaultAction: boolean }>("canvas-scroll", (e) => {
      if (this.brushActive()) {
        e.preventDefaultAction = true; // the wheel sizes the brush while it is on
        this.brushRadius = Math.min(120, Math.max(4, this.brushRadius * (e.scroll > 0 ? 1.12 : 1 / 1.12)));
        this.refresh();
      }
    });
    const el = viewer.canvas as HTMLElement;
    const move = (ev: PointerEvent) => this.pointerMoved(ev);
    el.addEventListener("pointermove", move);
    this.cleanup.push(() => el.removeEventListener("pointermove", move));
    // right click, and a long press on touch screens, open the menu of the annotation under the pointer
    const ctx = (ev: MouseEvent) => {
      ev.preventDefault();
      if (performance.now() < this.longPressedUntil) return; // the long press has opened it already
      this.openContext(ev.clientX, ev.clientY, (ev as PointerEvent).pointerType);
    };
    let press: { timer: number; x: number; y: number } | null = null;
    const stop = () => {
      if (press) window.clearTimeout(press.timer);
      press = null;
    };
    const down = (ev: PointerEvent) => {
      stop();
      if (ev.pointerType !== "touch") return;
      const [x, y] = [ev.clientX, ev.clientY];
      press = {
        x,
        y,
        timer: window.setTimeout(() => {
          press = null;
          this.longPressedUntil = performance.now() + 800;
          this.abortSession();
          this.openContext(x, y, "touch");
        }, 550),
      };
    };
    const slide = (ev: PointerEvent) => {
      if (press && Math.hypot(ev.clientX - press.x, ev.clientY - press.y) > 10) stop();
    };
    el.addEventListener("contextmenu", ctx);
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", slide);
    el.addEventListener("pointerup", stop);
    el.addEventListener("pointercancel", stop);
    this.cleanup.push(() => {
      stop();
      el.removeEventListener("contextmenu", ctx);
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", slide);
      el.removeEventListener("pointerup", stop);
      el.removeEventListener("pointercancel", stop);
    });
  }

  destroy(): void {
    this.cleanup.forEach((c) => c());
  }

  // ---- state the toolbox shows ---------------------------------------------------------------------------------

  get selected(): Shape | null {
    return this.host.shapes().find((s) => s.id === this.selectedId) ?? null;
  }

  /** The selected annotation as it looks now: the preview while it is dragged, else the saved shape. */
  get shown(): Shape | null {
    return this.preview && this.preview.id === this.selectedId ? this.preview : this.selected;
  }

  get drafting(): boolean {
    return !!this.draft;
  }

  get draftPoints(): number {
    return this.draft?.points.length ?? 0;
  }

  setTool(tool: Tool): void {
    this.cancelDraft();
    this.abortSession();
    if (tool.kind === "op") {
      const sel = this.selected;
      const info = sel && this.host.type(sel.typeId);
      if (!sel || sel.vectorType !== VectorType.Polygon) {
        this.host.notify("Select a polygon first.");
        tool = { kind: "select" };
      } else if (info && info.nodeCount > 0) {
        this.host.notify("This type has a fixed number of nodes; its polygons cannot be reshaped.");
        tool = { kind: "select" };
      }
    }
    this.tool = tool;
    if (tool.kind === "draw") this.selectedId = this.selectedVertex = null;
    this.refresh();
  }

  /** Whether the brush paints on a drag: switched on in the toolbox (touch) or by Shift / Alt (see `press`). */
  brushActive(): boolean {
    const sel = this.selected;
    return this.brushMode !== "off" && this.tool.kind === "select" && !!sel && this.canReshape(sel);
  }

  setBrush(mode: BrushMode): void {
    this.brushMode = mode;
    this.refresh();
  }

  private canReshape(s: Shape): boolean {
    const info = this.host.type(s.typeId);
    return s.vectorType === VectorType.Polygon && !(info && info.nodeCount > 0);
  }

  select(id: number | null): void {
    this.selectedId = id;
    this.selectedVertex = null;
    this.refresh();
  }

  /** Re-checks the selection after the annotations changed (deleted or moved by somebody else). */
  sync(): void {
    if (this.selectedId !== null && !this.host.shapes().some((s) => s.id === this.selectedId)) this.selectedId = this.selectedVertex = null;
    this.refresh();
  }

  /** Enter / V: completes a polygon or polyline in progress. */
  finish(): boolean {
    const d = this.draft;
    if (!d) return false;
    if (d.op) return this.finishOp(d.op, d.points);
    const info = this.host.type(d.typeId);
    const pts = d.points.filter((p, i) => i === 0 || dist(p, d.points[i - 1]) > 0.5); // a double click adds the point twice
    if (!info || pts.length < minVertices(info.vectorType)) return false;
    this.draft = null;
    this.create(d.typeId, vectorOf(pts));
    this.refresh();
    return true;
  }

  /** Escape: draft, then drag, then selection, then the draw tool. */
  cancel(): void {
    if (this.draft || this.session) {
      this.cancelDraft();
      this.abortSession();
      if (this.tool.kind === "op") this.tool = { kind: "select" };
    } else if (this.tool.kind === "op") {
      this.tool = { kind: "select" };
    } else if (this.brushMode !== "off") {
      this.brushMode = "off";
    } else if (this.selectedId !== null) {
      this.select(null);
      return;
    } else if (this.tool.kind === "draw") {
      this.tool = { kind: "select" };
    }
    this.refresh();
  }

  /** Delete: the selected vertex of a polygon, else the selected annotation. */
  deleteSelection(): void {
    const s = this.selected;
    if (!s) return;
    if (this.selectedVertex !== null && isPathType(s.vectorType)) {
      this.removeVertexOf(s, this.selectedVertex);
      return;
    }
    this.host.onDelete(s);
    this.select(null);
  }

  // ---- geometry helpers ----------------------------------------------------------------------------------------

  private item(): OpenSeadragon.TiledImage | null {
    return this.viewer.world.getItemCount() ? this.viewer.world.getItemAt(0) : null;
  }

  private toImage(pos: OpenSeadragon.Point): Pt | null {
    const item = this.item();
    if (!item) return null;
    const p = item.viewerElementToImageCoordinates(pos);
    return [p.x, p.y];
  }

  /** Screen pixels per image pixel. */
  private zoom(): number {
    const item = this.item();
    return item ? item.viewportToImageZoom(this.viewer.viewport.getZoom(true)) : 1;
  }

  private tol(pointer?: string): number {
    return ((pointer === "touch" ? TOUCH_SLOP : MOUSE_SLOP) / this.zoom()) || MOUSE_SLOP;
  }

  private isTouch(e: Ev): boolean {
    return (e.pointerType ?? "mouse") === "touch";
  }

  private editableHandles(s: Shape): Handle[] {
    const info = this.host.type(s.typeId);
    const fixedNodes = !!info && info.nodeCount > 0 && s.vectorType === VectorType.Polygon;
    return handlesFor(s).filter((h) => !(fixedNodes && h.kind === "mid"));
  }

  // ---- pointer events ------------------------------------------------------------------------------------------

  private press(e: Ev): void {
    this.touch = this.isTouch(e);
    this.consumedPress = false;
    const p = this.toImage(e.position);
    if (!p) return;
    const t = this.tol(e.pointerType);
    if (this.tool.kind === "draw") {
      const info = this.host.type(this.tool.typeId);
      if (info && this.dragDrawn(info) && !this.tool.oneClick) {
        this.session = { kind: "drag", typeId: info.id, start: clampPoint(p, this.host.image()), cur: p };
        e.preventDefaultAction = true;
        this.consumedPress = true;
      }
      return;
    }
    if (this.tool.kind !== "select") return;
    const sel = this.selected;
    if (!sel) return;
    const oe = (e as unknown as { originalEvent?: MouseEvent }).originalEvent;
    const mode = oe?.altKey ? "erase" : oe?.shiftKey ? "add" : this.brushMode;
    if (mode !== "off" && this.canReshape(sel)) {
      const p0 = clampPoint(p, this.host.image());
      this.session = { kind: "brush", shape: sel, erase: mode === "erase", last: p0, swept: [], moved: false };
      this.brushStroke(this.session, p0);
      e.preventDefaultAction = true;
      this.consumedPress = true;
      return;
    }
    const h = handleAt(this.editableHandles(sel), p, t);
    if (h) {
      this.session = { kind: "handle", shape: sel, handle: h, moved: false, points: sel.points.map((q) => [...q] as Pt), box: sel.bbox };
      e.preventDefaultAction = true;
      this.consumedPress = true;
      return;
    }
    const under = hitShape(this.host.shapes(), p, t);
    if (under && under.id === sel.id && distanceToShape(sel, p) <= t) {
      this.session = { kind: "move", shape: sel, start: p, moved: false };
      e.preventDefaultAction = true;
      this.consumedPress = true;
    }
  }

  private drag(e: Ev): void {
    const s = this.session;
    if (!s) return;
    e.preventDefaultAction = true;
    const p = this.toImage(e.position);
    if (!p) return;
    const bounds = this.host.image();
    if (s.kind === "brush") {
      this.brushStroke(s, clampPoint(p, bounds));
      this.hover = p;
      return;
    }
    if (s.kind === "drag") {
      s.cur = clampPoint(p, bounds);
      const info = this.host.type(s.typeId);
      const shape =
        info?.vectorType === VectorType.Line
          ? toShape(NEW_ID, s.typeId, VectorType.Line, false, vectorOf([s.start, s.cur]))
          : toShape(NEW_ID, s.typeId, info?.vectorType ?? VectorType.BoundingBox, true, boxVector(boxBetween(s.start, s.cur)));
      this.preview = shape;
    } else if (s.kind === "move") {
      const [dx, dy] = [p[0] - s.start[0], p[1] - s.start[1]];
      if (!s.moved && Math.hypot(dx, dy) * this.zoom() < 3) return;
      s.moved = true;
      const base = isBoxType(s.shape.vectorType) ? ([[s.shape.bbox[0], s.shape.bbox[1]], [s.shape.bbox[2], s.shape.bbox[3]]] as Pt[]) : s.shape.points;
      const moved = movePoints(base, dx, dy, bounds);
      this.preview = isBoxType(s.shape.vectorType) ? reshape(s.shape, [moved[0][0], moved[0][1], moved[1][0], moved[1][1]], null) : reshape(s.shape, null, moved);
    } else {
      const h = s.handle;
      if (!s.moved && dist(p, h.at) * this.zoom() < 3) return;
      if (!s.moved && h.kind === "mid") {
        s.points = insertVertex(s.points, h.index, p);
        s.handle = { kind: "vertex", index: h.index + 1, at: p };
        this.selectedVertex = h.index + 1;
      }
      s.moved = true;
      const cur = s.handle;
      if (cur.kind === "corner" || cur.kind === "edge") {
        s.box = resizeBox(s.shape.bbox, cur, p, bounds);
        this.preview = reshape(s.shape, s.box, null);
      } else if (cur.kind === "vertex") {
        s.points = moveVertex(s.points, cur.index, p, bounds);
        this.preview = reshape(s.shape, null, s.points);
      }
    }
    this.refresh();
  }

  private release(e: Ev): void {
    const s = this.session;
    this.session = null;
    const keep = this.preview;
    this.preview = null;
    if (!s) return;
    this.brushPreview = null;
    if (s.kind === "brush") {
      if (s.moved || s.swept.length) this.applyRings(s.shape, s.erase ? difference(ringOf(s.shape), s.swept) : union(ringOf(s.shape), s.swept));
      this.refresh();
      return;
    }
    if (s.kind === "drag") {
      const info = this.host.type(s.typeId);
      if (keep && info) {
        const tiny = dist(s.start, s.cur) * this.zoom() < 4;
        if (!tiny) this.create(s.typeId, vectorOfShape(keep));
      }
    } else if (s.kind === "handle" && !s.moved && s.handle.kind === "vertex" && isPathType(s.shape.vectorType)) {
      this.selectedVertex = s.handle.index; // a click on a vertex selects it (Delete removes it)
    } else if ((s.kind === "move" || s.kind === "handle") && keep && s.moved) {
      this.host.onUpdate(s.shape, vectorOfShape(keep));
    }
    void e;
    this.refresh();
  }

  private click(e: Ev): void {
    if (this.consumedPress) {
      this.consumedPress = false;
      return;
    }
    if (e.quick === false) return;
    const p = this.toImage(e.position);
    if (!p) return;
    if (this.tool.kind === "op") {
      const sel = this.selected;
      if (!sel) return;
      if (!this.draft) this.draft = { typeId: sel.typeId, points: [], op: this.tool.op };
      this.draft.points.push(clampPoint(p, this.host.image()));
      e.preventDefaultAction = true;
      this.refresh();
      return;
    }
    if (this.tool.kind === "select") {
      const hit = hitShape(this.host.shapes(), p, this.tol(e.pointerType));
      this.select(hit?.id ?? null);
      e.preventDefaultAction = true;
      return;
    }
    const info = this.host.type(this.tool.typeId);
    if (!info) return;
    const at = clampPoint(p, this.host.image());
    if (isPathType(info.vectorType)) {
      this.addPathPoint(info, at, e);
      e.preventDefaultAction = true;
      return;
    }
    if (this.dragDrawn(info) && !this.tool.oneClick) return; // boxes and lines are drawn by dragging
    if (this.debounced(e.position)) return;
    this.placeByClick(info, at);
    e.preventDefaultAction = true;
  }

  private doubleClick(e: Ev): void {
    e.preventDefaultAction = true; // never zoom on a double click
    if (this.draft) {
      this.finish();
      return;
    }
    if (this.tool.kind !== "select") return;
    const s = this.selected;
    const p = this.toImage(e.position);
    if (s && p && isPathType(s.vectorType)) {
      const h = handleAt(this.editableHandles(s), p, this.tol(e.pointerType));
      if (h?.kind === "vertex") this.removeVertexOf(s, h.index);
    }
  }

  private pointerMoved(ev: PointerEvent): void {
    this.touch = ev.pointerType === "touch";
    const el = this.viewer.canvas as HTMLElement;
    const r = el.getBoundingClientRect();
    const p = this.toImage(new OpenSeadragon.Point(ev.clientX - r.left, ev.clientY - r.top));
    this.hover = p;
    this.mods = { shift: ev.shiftKey, alt: ev.altKey };
    let cursor = "";
    if (this.tool.kind === "draw") cursor = "crosshair";
    else if (p) {
      const sel = this.selected;
      const t = this.tol(ev.pointerType);
      const h = sel ? handleAt(this.editableHandles(sel), p, t) : null;
      if (h) cursor = h.kind === "vertex" || h.kind === "mid" ? "pointer" : h.id === "n" || h.id === "s" ? "ns-resize" : h.id === "e" || h.id === "w" ? "ew-resize" : h.id === "nw" || h.id === "se" ? "nwse-resize" : "nesw-resize";
      else if (sel && hitShape(this.host.shapes(), p, t)?.id === sel.id) cursor = "move";
      else if (hitShape(this.host.shapes(), p, t)) cursor = "pointer";
    }
    el.style.cursor = cursor;
    if (this.tool.kind === "draw" && !this.session) this.refresh();
  }

  // ---- actions -------------------------------------------------------------------------------------------------

  private openContext(clientX: number, clientY: number, pointer?: string): void {
    const r = (this.viewer.canvas as HTMLElement).getBoundingClientRect();
    const p = this.toImage(new OpenSeadragon.Point(clientX - r.left, clientY - r.top));
    if (!p) return;
    const hit = hitShape(this.host.shapes(), p, this.tol(pointer));
    if (!hit) return;
    this.cancelDraft();
    this.abortSession();
    if (this.tool.kind !== "select") this.tool = { kind: "select" };
    this.select(hit.id);
    this.host.onContext(hit, clientX, clientY);
  }

  /** Paints one more piece of the brush stroke and shows what the polygon would look like. */
  private brushStroke(s: Extract<Session, { kind: "brush" }>, to: Pt): void {
    const r = this.brushRadius / this.zoom();
    if (dist(s.last, to) > 0) s.moved = true;
    s.swept = union(capsule(s.last, to, r), s.swept).rings;
    s.last = to;
    const base = ringOf(s.shape);
    const res = s.erase ? difference(base, s.swept) : union(base, s.swept);
    this.brushPreview = res.rings;
    this.preview = res.rings[0] ? reshape(s.shape, null, res.rings[0]) : null;
    this.refresh();
  }

  /** Result of a polygon operation: simplified to about a screen pixel, inside the image, handed to the host. */
  private applyRings(shape: Shape, res: { rings: Ring[]; droppedHoles: boolean }): void {
    const tol = 1 / this.zoom();
    const b = this.host.image();
    const rings = res.rings.map((r) => tidy(simplify(r.map((q) => clampPoint(q, b)), tol))).filter((r) => r.length >= 3);
    if (!rings.length) {
      this.host.notify("Nothing would be left of the polygon; delete it instead.");
      return;
    }
    if (res.droppedHoles) this.host.notify("Annotations cannot have holes: the outline was kept.");
    this.host.onReplace(shape, rings);
  }

  /** Scissors (cut the drawn area away), glue (add the drawn area), knife (split along the drawn line) on the selected polygon. */
  private finishOp(op: PolyOp, points: Pt[]): boolean {
    const target = this.selected;
    const pts = points.filter((p, i) => i === 0 || dist(p, points[i - 1]) > 0.5);
    if (!target || pts.length < (op === "knife" ? 2 : 3)) return false;
    const base = ringOf(target);
    let res: { rings: Ring[]; droppedHoles: boolean };
    if (op === "scissors") res = difference(base, [pts]);
    else if (op === "glue") res = union(base, [pts]);
    else {
      res = split(base, pts, Math.max(1, 1 / this.zoom()));
      if (res.rings.length < 2) {
        this.host.notify("The line did not cut through the polygon.");
        this.draft = null;
        this.tool = { kind: "select" };
        this.refresh();
        return true;
      }
    }
    this.draft = null;
    this.tool = { kind: "select" };
    this.applyRings(target, res);
    this.refresh();
    return true;
  }

  private dragDrawn(info: TypeInfo): boolean {
    return info.vectorType === VectorType.BoundingBox || info.vectorType === VectorType.Line;
  }

  private debounced(pos: OpenSeadragon.Point): boolean {
    const now = performance.now();
    const same = Math.hypot(pos.x - this.lastCreate.at[0], pos.y - this.lastCreate.at[1]) < DEBOUNCE_PX;
    if (same && now - this.lastCreate.t < CLICK_DEBOUNCE_MS) return true;
    this.lastCreate = { t: now, at: [pos.x, pos.y] };
    return false;
  }

  /** One click, one annotation: boxes of the type's default size, points. */
  private placeByClick(info: TypeInfo, at: Pt): void {
    if (info.vectorType === VectorType.Point) {
      this.create(info.id, vectorOf([at]));
    } else if (isBoxType(info.vectorType)) {
      const [w, h] = [info.width ?? 50, info.height ?? 50];
      this.create(info.id, boxVector(centeredBox(at, w, h, this.host.image())));
    }
  }

  private addPathPoint(info: TypeInfo, at: Pt, e: Ev): void {
    if (!this.draft || this.draft.typeId !== info.id) this.draft = { typeId: info.id, points: [] };
    const pts = this.draft.points;
    if (info.vectorType === VectorType.Polygon && pts.length >= 3 && dist(at, pts[0]) * this.zoom() <= (this.isTouch(e) ? TOUCH_SLOP : CLOSE_SLOP)) {
      this.finish();
      return;
    }
    pts.push(at);
    if (info.vectorType === VectorType.Polygon && info.nodeCount > 0 && pts.length >= info.nodeCount) {
      this.finish();
      return;
    }
    this.refresh();
  }

  private create(typeId: number, vector: Record<string, number>): void {
    this.host.onCreate(typeId, vector);
  }

  private removeVertexOf(s: Shape, index: number): void {
    const info = this.host.type(s.typeId);
    if (info && info.nodeCount > 0 && s.vectorType === VectorType.Polygon) return; // the type fixes the number of nodes
    const pts = removeVertex(s.points, index, minVertices(s.vectorType));
    if (pts.length === s.points.length) return;
    this.selectedVertex = null;
    this.host.onUpdate(s, vectorOf(pts));
  }

  private cancelDraft(): void {
    this.draft = null;
  }

  private abortSession(): void {
    this.session = null;
    this.preview = null;
    this.refresh();
  }

  // ---- what is drawn -------------------------------------------------------------------------------------------

  refresh(): void {
    const sel = this.selected;
    const shown = this.preview && this.preview.id === this.selectedId ? this.preview : sel;
    const o: Overlay = { ...EMPTY_OVERLAY, touch: this.touch };
    o.selectedId = this.selectedId;
    o.selectedVertex = this.selectedVertex;
    o.preview = this.preview;
    if (shown && this.tool.kind === "select" && this.session?.kind !== "brush") o.handles = this.editableHandles(shown);
    if (this.draft) {
      const info = this.host.type(this.draft.typeId);
      const op = this.draft.op;
      o.draft = {
        points: this.draft.points,
        closed: op ? op !== "knife" : info?.vectorType === VectorType.Polygon,
        cursor: this.hover,
        color: op === "scissors" ? "#ff5a5a" : op === "glue" ? "#5adc7a" : op === "knife" ? "#ffffff" : (info?.color ?? "#fff"),
      };
    }
    if (this.brushPreview && this.brushPreview.length > 1 && sel) o.extra = { rings: this.brushPreview.slice(1), color: this.host.type(sel.typeId)?.color ?? "#fff" };
    if (sel && this.tool.kind === "select" && this.canReshape(sel) && this.hover && (this.brushMode !== "off" || this.mods.shift || this.mods.alt)) {
      const erase = this.session?.kind === "brush" ? this.session.erase : this.mods.alt || (this.brushMode === "erase" && !this.mods.shift);
      o.brush = { at: this.hover, r: this.brushRadius / this.zoom(), erase };
    }
    if (this.tool.kind === "draw" && !this.draft && !this.session && this.hover) {
      const info = this.host.type(this.tool.typeId);
      const sized = info && isBoxType(info.vectorType) && (info.vectorType === VectorType.FixedSizeBoundingBox || this.tool.oneClick);
      if (info && sized) o.ghost = { box: centeredBox(this.hover, info.width ?? 50, info.height ?? 50, this.host.image()), color: info.color };
    }
    this.layer.setOverlay(o);
    this.host.onState();
  }
}
