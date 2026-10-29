import { isTypingTarget } from "./shortcuts";
import { isHovering, pen } from "./pen";
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
import { capsule, difference, simplify, simplifyPath, split, tidy, union, type Ring } from "./polyops";
import { formatArea, formatLength, measureShape } from "./measure";
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
  image(): { width: number; height: number; mpp: number };
  onCreate(typeId: number, vector: Record<string, number>): void;
  onUpdate(shape: Shape, vector: Record<string, number>): void;
  onDelete(shape: Shape): void;
  /** a polygon operation produced these rings: the first replaces the shape, the others become annotations of the same type */
  onReplace(shape: Shape, rings: Pt[][]): void;
  /** the annotations of a multi-selection were moved together */
  onUpdateMany(items: { shape: Shape; vector: Record<string, number> }[]): void;
  /** Delete on a multi-selection */
  onDeleteMany(shapes: Shape[]): void;
  /** right click or long press on one of several selected annotations */
  onContextMany(shapes: Shape[], clientX: number, clientY: number): void;
  /** right click or long press on an annotation (client coordinates) */
  onContext(shape: Shape, clientX: number, clientY: number): void;
  /** the type the pen annotates with when no tool is chosen (the toolbox's "Annotate with"), null when there is none */
  penType(): number | null;
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
  | { kind: "drag"; typeId: number; start: Pt; cur: Pt; auto?: boolean }
  // the pen as a brush: paints (Add) or erases (Subtract); the first polygon the brush touches is the one the stroke is about, unless one was selected
  | { kind: "penbrush"; target: Shape | null; locked: boolean; typeId: number | null; erase: boolean; start: Pt; last: Pt; moved: boolean; swept: Ring[] }
  | { kind: "brush"; shape: Shape; erase: boolean; last: Pt; swept: Ring[]; moved: boolean }
  | { kind: "groupmove"; shapes: Shape[]; start: Pt; moved: boolean }
  | { kind: "marquee"; start: Pt; cur: Pt; additive: boolean }
  | { kind: "hold" } // a press while clicking points or boxes: nothing is dragged, and the image is not moved either
  | { kind: "stroke"; from: Pt; screen: { x: number; y: number }; active: boolean; first: number }; // freehand outline of a polygon / polyline

const TOUCH_SLOP = 18;
const MOUSE_SLOP = 7;
const CLOSE_SLOP = 12;
const CLICK_DEBOUNCE_MS = 220;
const PEN_TAP_SLOP = 10; // screen pixels a pen may wander during a tap
const PEN_TAP_MAX_MS = 3000;
const STROKE_START = 9; // screen pixels a pen or mouse must travel before a press becomes a freehand stroke (below: a tap)
const STROKE_STEP = 3; // a point of the stroke every so many screen pixels
const STROKE_TOL = 1.2; // the stroke is simplified to within this many screen pixels on lifting
const STROKE_CLOSE = 28; // lifting this close to the start closes the outline

const NEW_ID = -1;

/** The vector of a shape as the server stores it. */
export function vectorOfShape(s: Shape): Record<string, number> {
  return isBoxType(s.vectorType) ? boxVector(s.bbox) : vectorOf(s.points);
}

/** The shape shifted by (dx, dy). */
function shiftedShape(s: Shape, dx: number, dy: number, bounds: { width: number; height: number }): Shape {
  if (isBoxType(s.vectorType)) {
    const [x0, y0, x1, y1] = s.bbox;
    return reshape(s, [x0 + dx, y0 + dy, x1 + dx, y1 + dy], null);
  }
  return reshape(s, null, movePoints(s.points, dx, dy, bounds));
}

/** The outline of a polygon annotation as a ring. */
const ringOf = (s: Shape): Ring => s.points.map((q) => [...q] as Pt);

function reshape(base: Shape, box: Box | null, points: Pt[] | null): Shape {
  const v = box ? boxVector(box) : vectorOf(points ?? base.points);
  return toShape(base.id, base.typeId, base.vectorType, base.closed, v) as Shape;
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
  /** two or more annotations selected together (then `selectedId` is null) */
  group: number[] = [];
  /** touch: a tap adds or removes an annotation, a drag draws a rubber band (instead of Ctrl / Shift) */
  multiMode = false;
  /** Space is held: a drag moves the image instead of drawing a selection frame */
  private spaceDown = false;
  private previews: Shape[] = [];
  /** where a pen hovers above the screen (image pixels), null when it does not */
  private penAt: Pt | null = null;
  private penHover = false;
  /** the segmentation tool owns the pointer */
  suspended = false;
  private session: Session | null = null;
  private draft: { typeId: number; points: Pt[]; op?: PolyOp } | null = null;
  brushMode: BrushMode = "off";
  /** radius of the brush in screen pixels */
  brushRadius = 18;
  /** what the pen's brush does: paint onto polygons (and make new ones) or erase from them */
  penMode: "add" | "erase" = "add";
  private brushPreview: Ring[] | null = null;
  private preview: Shape | null = null;
  private hover: Pt | null = null;
  private mods = { shift: false, alt: false };
  private longPressedUntil = 0;
  private touch = false;
  /** where and when a pen went down: a deliberate tap (pen held on the spot a moment) still counts as a click */
  private penPress: { x: number; y: number; t: number } | null = null;
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
    const gone = () => {
      if (this.penAt) {
        this.penAt = null;
        this.penHover = false;
        this.refresh();
      }
    };
    const noteDown = (ev: PointerEvent) => pen.note(ev);
    const space = (ev: KeyboardEvent) => {
      if (ev.code === "Space" && !isTypingTarget(ev.target)) this.spaceDown = ev.type === "keydown";
    };
    const blur = () => (this.spaceDown = false);
    // middle button: OpenSeadragon only moves the image with the primary button
    let mid: { x: number; y: number } | null = null;
    const midDown = (ev: PointerEvent) => {
      if (ev.button !== 1) return;
      ev.preventDefault();
      mid = { x: ev.clientX, y: ev.clientY };
      el.setPointerCapture(ev.pointerId);
    };
    const midMove = (ev: PointerEvent) => {
      if (!mid) return;
      const d = viewer.viewport.deltaPointsFromPixels(new OpenSeadragon.Point(mid.x - ev.clientX, mid.y - ev.clientY), true);
      viewer.viewport.panBy(d, true);
      viewer.viewport.applyConstraints(true);
      mid = { x: ev.clientX, y: ev.clientY };
    };
    const midUp = () => (mid = null);
    window.addEventListener("keydown", space);
    window.addEventListener("keyup", space);
    window.addEventListener("blur", blur);
    el.addEventListener("pointerdown", midDown);
    el.addEventListener("pointermove", midMove);
    el.addEventListener("pointerup", midUp);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerdown", noteDown, true);
    el.addEventListener("pointerleave", gone);
    this.cleanup.push(() => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerdown", noteDown, true);
      el.removeEventListener("pointerleave", gone);
      window.removeEventListener("keydown", space);
      window.removeEventListener("keyup", space);
      window.removeEventListener("blur", blur);
      el.removeEventListener("pointerdown", midDown);
      el.removeEventListener("pointermove", midMove);
      el.removeEventListener("pointerup", midUp);
    });
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

  /** The annotations of the multi-selection. */
  get groupShapes(): Shape[] {
    const ids = new Set(this.group);
    return this.host.shapes().filter((s) => ids.has(s.id));
  }

  /** What is selected: the group, or the single annotation. */
  get selection(): Shape[] {
    return this.group.length > 1 ? this.groupShapes : this.selected ? [this.selected] : [];
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
    if (tool.kind === "draw") {
      this.selectedId = this.selectedVertex = null;
      this.group = [];
    }
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
    this.group = [];
    this.refresh();
  }

  /** Selects these annotations together (one or none: a plain selection). */
  selectGroup(ids: number[]): void {
    const u = [...new Set(ids)];
    if (u.length <= 1) {
      this.select(u[0] ?? null);
      return;
    }
    this.group = u;
    this.selectedId = this.selectedVertex = null;
    if (this.tool.kind !== "select") this.tool = { kind: "select" };
    this.refresh();
  }

  selectAll(): void {
    this.selectGroup(this.host.shapes().map((s) => s.id));
  }

  setMultiMode(on: boolean): void {
    this.multiMode = on;
    this.refresh();
  }

  /** Adds the annotation to the selection, or takes it out when it is in already. */
  private toggle(id: number): void {
    const now = this.group.length > 1 ? this.group : this.selectedId !== null ? [this.selectedId] : [];
    this.selectGroup(now.includes(id) ? now.filter((x) => x !== id) : [...now, id]);
  }

  /** Re-checks the selection after the annotations changed (deleted or moved by somebody else). */
  sync(): void {
    if (this.selectedId !== null && !this.host.shapes().some((s) => s.id === this.selectedId)) this.selectedId = this.selectedVertex = null;
    if (this.group.length) {
      const here = new Set(this.host.shapes().map((s) => s.id));
      const left = this.group.filter((i) => here.has(i));
      if (left.length !== this.group.length) {
        this.selectGroup(left);
        return;
      }
    }
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
    } else if (this.selectedId !== null || this.group.length) {
      this.select(null);
      return;
    } else if (this.tool.kind === "draw") {
      this.tool = { kind: "select" };
    }
    this.refresh();
  }

  /** Delete: the selected vertex of a polygon, else the selected annotation. */
  deleteSelection(): void {
    if (this.group.length > 1) {
      this.host.onDeleteMany(this.groupShapes);
      this.select(null);
      return;
    }
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

  /** The device of an event: OpenSeadragon's click and double-click events carry none of their own, only the original event does. */
  private kind(e: Ev): string | undefined {
    return e.pointerType ?? (e as unknown as { originalEvent?: { pointerType?: string } }).originalEvent?.pointerType;
  }

  /**
   * Where the pointer of this event is, in canvas pixels. From the browser's own event rather than OpenSeadragon's `position`: for a
   * drag OpenSeadragon reports the first pointer it tracks of that device type, and an iPad's Apple Pencil is tracked twice (hovering
   * and touching have different ids), so the position of the hovering one, stale, was reported for the whole stroke.
   */
  private at(e: Ev): OpenSeadragon.Point {
    const oe = (e as unknown as { originalEvent?: { clientX?: number; clientY?: number } }).originalEvent;
    if (typeof oe?.clientX !== "number" || typeof oe.clientY !== "number") return e.position;
    const r = (this.viewer.canvas as HTMLElement).getBoundingClientRect();
    return new OpenSeadragon.Point(oe.clientX - r.left, oe.clientY - r.top);
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
    return this.kind(e) === "touch";
  }

  private editableHandles(s: Shape): Handle[] {
    const info = this.host.type(s.typeId);
    const fixedNodes = !!info && info.nodeCount > 0 && s.vectorType === VectorType.Polygon;
    return handlesFor(s).filter((h) => !(fixedNodes && h.kind === "mid"));
  }

  // ---- pointer events ------------------------------------------------------------------------------------------

  private press(e: Ev): void {
    if (this.suspended || pen.ignores(this.kind(e))) return; // fingers move the image once a pen is in use
    this.touch = this.isTouch(e);
    this.consumedPress = false;
    const at = this.at(e);
    this.penPress = this.kind(e) === "pen" ? { x: at.x, y: at.y, t: performance.now() } : null;
    const p = this.toImage(this.at(e));
    if (!p) return;
    const t = this.tol(this.kind(e));
    if (this.kind(e) === "pen") {
      const plan = this.penPlan();
      if (plan?.kind === "brush") {
        const q = clampPoint(p, this.host.image());
        this.session = { kind: "penbrush", target: plan.locked, locked: !!plan.locked, typeId: plan.typeId, erase: this.penMode === "erase", start: q, last: q, moved: false, swept: [] };
        e.preventDefaultAction = true;
        return; // a tap that does not move is no stroke: the click selects
      }
      if (plan?.kind === "drag") {
        this.session = { kind: "drag", typeId: plan.typeId, start: clampPoint(p, this.host.image()), cur: p, auto: true };
        e.preventDefaultAction = true;
        this.consumedPress = true;
        return;
      }
    }
    if (this.tool.kind === "draw") {
      const info = this.host.type(this.tool.typeId);
      if (info && this.dragDrawn(info) && !this.tool.oneClick) {
        this.session = { kind: "drag", typeId: info.id, start: clampPoint(p, this.host.image()), cur: p };
        e.preventDefaultAction = true;
        this.consumedPress = true;
      } else this.holdPress(e, info ? this.freehand(info) : false);
      return;
    }
    if (this.tool.kind === "op") {
      this.holdPress(e, true);
      return;
    }
    if (this.tool.kind !== "select") return;
    const oe = (e as unknown as { originalEvent?: MouseEvent }).originalEvent;
    const mod = !!(oe?.ctrlKey || oe?.metaKey);
    if (this.group.length > 1) {
      const under = hitShape(this.groupShapes, p, t);
      if (under && !mod && !oe?.shiftKey && !this.multiMode) {
        this.session = { kind: "groupmove", shapes: this.groupShapes, start: p, moved: false };
        e.preventDefaultAction = true;
        this.consumedPress = true;
        return;
      }
    }
    if (mod || this.multiMode) {
      this.session = { kind: "marquee", start: p, cur: p, additive: true };
      e.preventDefaultAction = true;
      this.consumedPress = true;
      return;
    }
    const sel = this.selected;
    if (!sel) {
      this.startMarquee(e, p, !!oe?.shiftKey);
      return;
    }
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
      return;
    }
    this.startMarquee(e, p, !!oe?.shiftKey);
  }

  /** Whether a drag outlines the shape of the type freehand (polygons of any number of corners, polylines). */
  private freehand(info: TypeInfo): boolean {
    return (info.vectorType === VectorType.Polygon && info.nodeCount === 0) || info.vectorType === VectorType.MultiLine;
  }

  /**
   * Drawing by clicks (polygon corners, one-click boxes, points): a drag is not a click, and must not move the image (a pen set down
   * on a point always wanders a little). Where the shape can be outlined (`stroke`), a drag of more than a few pixels draws the outline
   * freehand, as one does with a pen. The image moves with Shift + drag, Space + drag, the middle button, a track pad swipe, and with a
   * finger on a touch screen.
   */
  private holdPress(e: Ev, stroke: boolean): void {
    const oe = (e as unknown as { originalEvent?: MouseEvent }).originalEvent;
    if (this.isTouch(e) || oe?.shiftKey || this.spaceDown || oe?.button === 1) return;
    const p = this.toImage(this.at(e));
    const at = this.at(e);
    this.session = stroke && p ? { kind: "stroke", from: clampPoint(p, this.host.image()), screen: { x: at.x, y: at.y }, active: false, first: 0 } : { kind: "hold" };
    e.preventDefaultAction = true;
  }

  /** A freehand stroke grows the draft: from the press point on, a point every few screen pixels. */
  private strokeMove(s: Extract<Session, { kind: "stroke" }>, e: Ev): void {
    const at = this.at(e);
    const p = this.toImage(at);
    if (!p) return;
    if (!s.active) {
      if (Math.hypot(at.x - s.screen.x, at.y - s.screen.y) < STROKE_START) return;
      const op = this.tool.kind === "op" ? this.tool.op : undefined;
      const info = this.tool.kind === "draw" ? this.host.type(this.tool.typeId) : null;
      const sel = this.selected;
      if (op) {
        if (!sel) return;
        if (!this.draft) this.draft = { typeId: sel.typeId, points: [], op };
      } else if (info) {
        if (!this.draft || this.draft.typeId !== info.id) this.draft = { typeId: info.id, points: [] };
      } else return;
      s.active = true;
      s.first = this.draft.points.length;
      this.draft.points.push(s.from);
    }
    const d = this.draft;
    if (!d) return;
    const q = clampPoint(p, this.host.image());
    if (dist(q, d.points[d.points.length - 1]) * this.zoom() >= STROKE_STEP) d.points.push(q);
    this.hover = q;
    this.refresh();
  }

  /**
   * Lifting the pen ends a stroke: it is simplified to what the eye sees. An outline that returns to where it started is closed and
   * saved; so is the knife's line. Anything else stays a draft that the next stroke, a click, Enter or the Finish button goes on with.
   */
  private strokeEnd(s: Extract<Session, { kind: "stroke" }>): void {
    if (!s.active) return; // a tap: the click that follows places a point
    this.consumedPress = true; // ...and a stroke is no click
    const d = this.draft;
    if (!d) return;
    const tol = STROKE_TOL / this.zoom();
    const mine = simplifyPath(d.points.slice(s.first), tol);
    d.points.splice(s.first, d.points.length - s.first, ...mine);
    const closes = d.points.length >= 4 && dist(d.points[d.points.length - 1], d.points[0]) * this.zoom() <= STROKE_CLOSE;
    const info = d.op ? null : this.host.type(d.typeId);
    const outline = d.op ? d.op !== "knife" : info?.vectorType === VectorType.Polygon;
    if (d.op === "knife") {
      this.finish();
    } else if (outline && closes) {
      d.points.pop(); // the last point only said "here is the start again"
      this.finish();
    }
    this.refresh();
  }

  /**
   * A press on nothing that can be edited starts the selection frame (a plain click inside it selects what is under
   * the pointer). The image is moved with Space + drag, the middle button, a track pad swipe or on a touch screen, where
   * a finger always moves the image.
   */
  private startMarquee(e: Ev, p: Pt, additive: boolean): void {
    if (this.isTouch(e) || this.spaceDown || (e as unknown as { originalEvent?: MouseEvent }).originalEvent?.button === 1) return;
    this.session = { kind: "marquee", start: p, cur: p, additive };
    e.preventDefaultAction = true;
    this.consumedPress = true;
  }

  private drag(e: Ev): void {
    if (this.suspended) return;
    const s = this.session;
    if (!s) return;
    e.preventDefaultAction = true;
    if (s.kind === "hold") return;
    if (s.kind === "stroke") {
      this.strokeMove(s, e);
      return;
    }
    if (s.kind === "penbrush") {
      this.penBrushMove(s, this.toImage(this.at(e)));
      return;
    }
    const p = this.toImage(this.at(e));
    if (!p) return;
    const bounds = this.host.image();
    if (s.kind === "brush") {
      this.brushStroke(s, clampPoint(p, bounds));
      this.hover = p;
      return;
    }
    if (s.kind === "marquee") {
      s.cur = clampPoint(p, bounds);
      this.refresh();
      return;
    }
    if (s.kind === "groupmove") {
      const [dx0, dy0] = [p[0] - s.start[0], p[1] - s.start[1]];
      if (!s.moved && Math.hypot(dx0, dy0) * this.zoom() < 3) return;
      s.moved = true;
      // the group keeps its shape at the edge of the image: one shift for all
      const [minx, miny, maxx, maxy] = [Math.min(...s.shapes.map((q) => q.bbox[0])), Math.min(...s.shapes.map((q) => q.bbox[1])), Math.max(...s.shapes.map((q) => q.bbox[2])), Math.max(...s.shapes.map((q) => q.bbox[3]))];
      const dx = Math.min(Math.max(dx0, -minx), bounds.width - maxx);
      const dy = Math.min(Math.max(dy0, -miny), bounds.height - maxy);
      this.previews = s.shapes.map((q) => shiftedShape(q, dx, dy, bounds));
      this.refresh();
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
    if (this.suspended) return;
    const s = this.session;
    this.session = null;
    const keep = this.preview;
    this.preview = null;
    const keepMany = this.previews;
    this.previews = [];
    if (!s) return;
    if (s.kind === "stroke") {
      this.strokeEnd(s);
      return;
    }
    if (s.kind === "penbrush") {
      this.penBrushEnd(s);
      return;
    }
    if (s.kind === "marquee") {
      const tiny = dist(s.start, s.cur) * this.zoom() < 4;
      if (tiny) {
        const hit = hitShape(this.host.shapes(), s.start, this.tol(this.touch ? "touch" : "mouse"));
        if (hit && s.additive) this.toggle(hit.id);
        else if (s.additive) this.refresh();
        else this.select(hit?.id ?? null);
        return;
      }
      const [x0, y0, x1, y1] = boxBetween(s.start, s.cur);
      const inside = this.host.shapes().filter((q) => q.bbox[2] >= x0 && q.bbox[0] <= x1 && q.bbox[3] >= y0 && q.bbox[1] <= y1);
      const now = this.group.length > 1 ? this.group : this.selectedId !== null ? [this.selectedId] : [];
      // a frame selects what it touches (one annotation: that one, several: a group); Shift / Ctrl / ⌘ adds to the selection
      this.selectGroup([...(s.additive ? now : []), ...inside.map((q) => q.id)]);
      return;
    }
    if (s.kind === "groupmove") {
      if (s.moved && keepMany.length) this.host.onUpdateMany(keepMany.map((q, i) => ({ shape: s.shapes[i], vector: vectorOfShape(q) })));
      this.refresh();
      return;
    }
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
        else if (s.auto) this.consumedPress = false; // the pen only tapped: that selects (or deselects) as usual
      } else if (s.auto) this.consumedPress = false;
    } else if (s.kind === "handle" && !s.moved && s.handle.kind === "vertex" && isPathType(s.shape.vectorType)) {
      this.selectedVertex = s.handle.index; // a click on a vertex selects it (Delete removes it)
    } else if ((s.kind === "move" || s.kind === "handle") && keep && s.moved) {
      this.host.onUpdate(s.shape, vectorOfShape(keep));
    }
    void e;
    this.refresh();
  }

  /**
   * OpenSeadragon calls a press that lasts longer than 300 ms no click. A finger taps quickly, but a pen is set down on the point it
   * means (a polygon vertex, a box position) and often rests there: such a tap, with the pen where it went down, is a click.
   */
  private slowPenTap(e: Ev): boolean {
    const pp = this.penPress;
    if (this.kind(e) !== "pen" || !pp) return false;
    const at = this.at(e);
    return Math.hypot(at.x - pp.x, at.y - pp.y) <= PEN_TAP_SLOP && performance.now() - pp.t <= PEN_TAP_MAX_MS;
  }

  private click(e: Ev): void {
    if (this.suspended) return;
    if (this.consumedPress) {
      this.consumedPress = false;
      return;
    }
    if (e.quick === false && !this.slowPenTap(e)) return;
    if (pen.ignores(this.kind(e)) && this.tool.kind !== "select") return; // a finger may still tap to select
    const p = this.toImage(this.at(e));
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
      const hit = hitShape(this.host.shapes(), p, this.tol(this.kind(e)));
      const oe = (e as unknown as { originalEvent?: MouseEvent }).originalEvent;
      if (hit && (oe?.shiftKey || oe?.ctrlKey || oe?.metaKey)) this.toggle(hit.id);
      else this.select(hit?.id ?? null);
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
    if (this.debounced(this.at(e))) return;
    this.placeByClick(info, at);
    e.preventDefaultAction = true;
  }

  private doubleClick(e: Ev): void {
    if (this.suspended) return;
    e.preventDefaultAction = true; // never zoom on a double click
    if (this.draft) {
      this.finish();
      return;
    }
    if (this.tool.kind !== "select") return;
    const s = this.selected;
    const p = this.toImage(this.at(e));
    if (s && p && isPathType(s.vectorType)) {
      const h = handleAt(this.editableHandles(s), p, this.tol(this.kind(e)));
      if (h?.kind === "vertex") this.removeVertexOf(s, h.index);
    }
  }

  private pointerMoved(ev: PointerEvent): void {
    pen.note(ev);
    this.touch = ev.pointerType === "touch";
    const hovering = isHovering(ev);
    if (hovering !== this.penHover) {
      this.penHover = hovering;
      this.refresh();
    }
    const el = this.viewer.canvas as HTMLElement;
    const r = el.getBoundingClientRect();
    const p = this.toImage(new OpenSeadragon.Point(ev.clientX - r.left, ev.clientY - r.top));
    this.hover = p;
    this.penAt = hovering ? p : null;
    this.mods = { shift: ev.shiftKey, alt: ev.altKey };
    let cursor = "";
    if (this.tool.kind === "draw") cursor = "crosshair";
    else if (p) {
      const sel = this.selected;
      const t = this.tol(ev.pointerType);
      const h = sel ? handleAt(this.editableHandles(sel), p, t) : null;
      if (h) cursor = h.kind === "vertex" || h.kind === "mid" ? "pointer" : h.id === "n" || h.id === "s" ? "ns-resize" : h.id === "e" || h.id === "w" ? "ew-resize" : h.id === "nw" || h.id === "se" ? "nwse-resize" : "nesw-resize";
      else if (sel && hitShape(this.host.shapes(), p, t)?.id === sel.id) cursor = "move";
      else if (this.group.length > 1 && hitShape(this.groupShapes, p, t)) cursor = "move";
      else if (hitShape(this.host.shapes(), p, t)) cursor = "pointer";
    }
    el.style.cursor = cursor;
    if ((this.tool.kind === "draw" && !this.session) || hovering) this.refresh();
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
    if (this.group.length > 1 && this.group.includes(hit.id)) {
      this.host.onContextMany(this.groupShapes, clientX, clientY);
      return;
    }
    this.select(hit.id);
    this.host.onContext(hit, clientX, clientY);
  }

  /**
   * What the pen does on the next press. The pen annotates by itself, without the "Annotate with" tool being switched on (and the tool
   * stays what it was when the pen is lifted):
   *  - a polygon is selected: the brush works on that one only (a polygon type of any number of corners)
   *  - another annotation is selected: the pen edits it (null: the ordinary select logic)
   *  - nothing is selected: the "Annotate with" type decides: a polygon type brushes (the first polygon touched is the one meant, else a
   *    new one is made), a box or line type draws by dragging; anything else is left to the select tool
   * An explicitly chosen drawing type is used the same way; polygon types brush instead of outlining.
   */
  private penPlan(): { kind: "brush"; locked: Shape | null; typeId: number | null } | { kind: "drag"; typeId: number } | null {
    if (this.suspended) return null;
    const t = this.tool;
    if (t.kind === "op") return null;
    const brushable = (info: TypeInfo | undefined | null) => !!info && info.vectorType === VectorType.Polygon && info.nodeCount === 0;
    if (t.kind === "draw") {
      const info = this.host.type(t.typeId);
      return info && brushable(info) ? { kind: "brush", locked: null, typeId: info.id } : null;
    }
    const sel = this.selected;
    if (sel) return this.canReshape(sel) ? { kind: "brush", locked: sel, typeId: sel.typeId } : null;
    const tid = this.host.penType();
    const info = tid != null ? this.host.type(tid) : null;
    if (!info) return null;
    if (brushable(info)) return { kind: "brush", locked: null, typeId: info.id };
    if (this.dragDrawn(info)) return { kind: "drag", typeId: info.id };
    return null;
  }

  /** Whether the pen's brush is what the pen does now (the round buttons for mode and size are shown while this is so). */
  get penBrush(): boolean {
    return this.penPlan()?.kind === "brush";
  }

  togglePenMode(): void {
    this.penMode = this.penMode === "add" ? "erase" : "add";
    this.refresh();
  }

  /** The first polygon the brush touches is the one the stroke is about (none until then). */
  private penTarget(s: Extract<Session, { kind: "penbrush" }>, at: Pt): void {
    if (s.target || s.locked) return;
    const polygons = this.host.shapes().filter((q) => q.vectorType === VectorType.Polygon && this.canReshape(q));
    s.target = hitShape(polygons, at, this.brushRadius / this.zoom());
  }

  private penBrushMove(s: Extract<Session, { kind: "penbrush" }>, p: Pt | null): void {
    if (!p) return;
    const q = clampPoint(p, this.host.image());
    if (!s.moved) {
      if (dist(s.start, q) * this.zoom() < STROKE_START) return; // set down (a tap may wander a little), not yet stroking
      s.moved = true;
      s.last = s.start;
      this.penTarget(s, s.start);
    }
    s.swept = union(capsule(s.last, q, this.brushRadius / this.zoom()), s.swept).rings;
    s.last = q;
    this.penTarget(s, q);
    this.hover = q;
    if (s.target) {
      const base = ringOf(s.target);
      const res = s.erase ? difference(base, s.swept) : union(base, s.swept);
      this.brushPreview = res.rings;
      this.preview = res.rings[0] ? reshape(s.target, null, res.rings[0]) : null;
    } else if (!s.erase && s.typeId != null && s.swept[0]) {
      this.brushPreview = s.swept;
      this.preview = toShape(NEW_ID, s.typeId, VectorType.Polygon, true, vectorOf(s.swept[0])) as Shape;
    } else {
      this.brushPreview = null;
      this.preview = null;
    }
    this.refresh();
  }

  private penBrushEnd(s: Extract<Session, { kind: "penbrush" }>): void {
    this.brushPreview = null;
    if (!s.moved) {
      this.refresh();
      return; // a tap
    }
    this.consumedPress = true;
    if (s.target) {
      const res = s.erase ? difference(ringOf(s.target), s.swept) : union(ringOf(s.target), s.swept);
      this.applyRings(s.target, res);
    } else if (!s.erase && s.typeId != null) {
      const tol = 1 / this.zoom();
      const b = this.host.image();
      for (const ring of s.swept) {
        const r = tidy(simplify(ring.map((q) => clampPoint(q, b)), tol));
        if (r.length >= 3) this.create(s.typeId, vectorOf(r));
      }
    }
    this.refresh();
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
    (window as unknown as { __ptrlog?: (s: string) => void }).__ptrlog?.(`editor: session aborted (${this.session ? this.session.kind : "none"})`);
    this.session = null;
    this.preview = null;
    this.previews = [];
    this.refresh();
  }

  // ---- what is drawn -------------------------------------------------------------------------------------------

  refresh(): void {
    const sel = this.selected;
    const shown = this.preview && this.preview.id === this.selectedId ? this.preview : sel;
    const o: Overlay = { ...EMPTY_OVERLAY, touch: this.touch, pen: this.penAt };
    o.selectedId = this.selectedId;
    o.selectedVertex = this.selectedVertex;
    o.preview = this.preview;
    o.group = this.group;
    o.previews = this.previews;
    if (this.session?.kind === "marquee") o.marquee = boxBetween(this.session.start, this.session.cur);
    if (this.preview) {
      // what the shape measures while it is edited, shown in the middle of what is visible of it
      const m = measureShape(this.preview);
      const mpp = this.host.image().mpp;
      const text = m.areaPx2 != null ? formatArea(m.areaPx2, mpp) : m.lengthPx != null ? formatLength(m.lengthPx, mpp) : null;
      if (text) o.label = { text, box: this.preview.bbox };
    }
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
    const ps = this.session?.kind === "penbrush" ? this.session : null;
    const extraType = ps ? (ps.target?.typeId ?? ps.typeId) : sel?.typeId;
    if (this.brushPreview && this.brushPreview.length > 1 && extraType != null) o.extra = { rings: this.brushPreview.slice(1), color: this.host.type(extraType)?.color ?? "#fff" };
    if (sel && this.tool.kind === "select" && this.canReshape(sel) && this.hover && (this.brushMode !== "off" || this.mods.shift || this.mods.alt)) {
      const erase = this.session?.kind === "brush" ? this.session.erase : this.mods.alt || (this.brushMode === "erase" && !this.mods.shift);
      o.brush = { at: this.hover, r: this.brushRadius / this.zoom(), erase };
    }
    if ((this.penHover || ps) && this.hover && this.penPlan()?.kind === "brush") {
      // the pen is a brush: its ring shows where and how big; the crosshair of a hovering pen would only add to it
      o.brush = { at: this.hover, r: this.brushRadius / this.zoom(), erase: ps ? ps.erase : this.penMode === "erase" };
      o.pen = null;
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
