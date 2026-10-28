// Pure geometry of annotation editing: hit tests, handles, moving / resizing, vectors. Everything is in image pixels.
import { VectorType, type Shape } from "./types";

export type Pt = [number, number];
export type Box = [number, number, number, number]; // x1, y1, x2, y2 with x1 < x2 and y1 < y2
export type Bounds = { width: number; height: number };

export type Handle =
  | { kind: "corner"; id: "nw" | "ne" | "se" | "sw"; at: Pt }
  | { kind: "edge"; id: "n" | "e" | "s" | "w"; at: Pt }
  | { kind: "vertex"; index: number; at: Pt }
  | { kind: "mid"; index: number; at: Pt }; // between vertex `index` and the next one: dragging inserts a vertex

export const isBoxType = (t: number) => t === VectorType.BoundingBox || t === VectorType.FixedSizeBoundingBox;
export const isPathType = (t: number) => t === VectorType.Polygon || t === VectorType.MultiLine;

// ---- vectors ---------------------------------------------------------------------------------------------------

/** `{x1, y1, x2, y2, ...}` for the vertex list; values are integers as the server stores them. */
export function vectorOf(points: Pt[]): Record<string, number> {
  const v: Record<string, number> = {};
  points.forEach(([x, y], i) => {
    v[`x${i + 1}`] = Math.round(x);
    v[`y${i + 1}`] = Math.round(y);
  });
  return v;
}

/** The two-corner vector of a box. */
export const boxVector = ([x1, y1, x2, y2]: Box) => vectorOf([[x1, y1], [x2, y2]]);

/** Box between two corners in any order; at least one pixel wide and high (the server rejects less). */
export function boxBetween(a: Pt, b: Pt): Box {
  let [x1, x2] = a[0] <= b[0] ? [a[0], b[0]] : [b[0], a[0]];
  let [y1, y2] = a[1] <= b[1] ? [a[1], b[1]] : [b[1], a[1]];
  x1 = Math.round(x1);
  x2 = Math.round(x2);
  y1 = Math.round(y1);
  y2 = Math.round(y2);
  if (x2 - x1 < 1) x2 = x1 + 1;
  if (y2 - y1 < 1) y2 = y1 + 1;
  return [x1, y1, x2, y2];
}

/** Size of a type in pixels: `size_unit` is px, mm or um (µm); the resolution `mpp` is µm per pixel. */
export function sizeInPixels(value: number, unit: string, mpp: number): number {
  if (unit === "mm") return mpp > 0 ? (value * 1000) / mpp : value;
  if (unit === "um") return mpp > 0 ? value / mpp : value;
  return value;
}

/** Box of the given size centred on `c`, moved into the image when it would stick out. */
export function centeredBox(c: Pt, w: number, h: number, bounds: Bounds): Box {
  const bw = Math.min(Math.max(1, Math.round(w)), bounds.width);
  const bh = Math.min(Math.max(1, Math.round(h)), bounds.height);
  let x1 = Math.round(c[0] - bw / 2);
  let y1 = Math.round(c[1] - bh / 2);
  x1 = Math.min(Math.max(0, x1), bounds.width - bw);
  y1 = Math.min(Math.max(0, y1), bounds.height - bh);
  return [x1, y1, x1 + bw, y1 + bh];
}

export const clampPoint = (p: Pt, b: Bounds): Pt => [Math.min(Math.max(0, p[0]), b.width), Math.min(Math.max(0, p[1]), b.height)];

export const boxOfPoints = (pts: Pt[]): Box => {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};

export const boxArea = (b: Box) => (b[2] - b[0]) * (b[3] - b[1]);

// ---- hit tests -------------------------------------------------------------------------------------------------

export const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return dist(p, a);
  const t = Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return dist(p, [a[0] + t * dx, a[1] + t * dy]);
}

export function pointInPolygon(p: Pt, pts: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Distance of `p` to the outline of the shape (0 inside closed shapes, so that the whole area is clickable). */
export function distanceToShape(s: Shape, p: Pt): number {
  if (s.vectorType === VectorType.Point) return dist(p, s.points[0]);
  const pts = s.points;
  if (s.closed && pointInPolygon(p, pts)) return 0;
  let best = Infinity;
  const n = s.closed ? pts.length : pts.length - 1;
  for (let i = 0; i < n; i++) best = Math.min(best, distToSegment(p, pts[i], pts[(i + 1) % pts.length]));
  return best;
}

/**
 * The shape under `p`: those within `tol` image pixels, the one with the smallest bounding box wins (a small
 * annotation inside a large one stays selectable). Hidden types are skipped by the caller.
 */
export function hitShape(shapes: Shape[], p: Pt, tol: number): Shape | null {
  let best: Shape | null = null;
  let bestKey = Infinity;
  for (const s of shapes) {
    const d = distanceToShape(s, p);
    if (d > tol) continue;
    const key = boxArea(s.bbox) + d * 1e-6; // closer wins among equal sizes
    if (key <= bestKey) {
      best = s;
      bestKey = key;
    }
  }
  return best;
}

// ---- handles and editing ---------------------------------------------------------------------------------------

/** Where the editing handles of a shape are: box corners and edges, polygon / line vertices and edge midpoints. */
export function handlesFor(s: Shape): Handle[] {
  const [x1, y1, x2, y2] = s.bbox;
  if (s.vectorType === VectorType.BoundingBox) {
    const [mx, my] = [(x1 + x2) / 2, (y1 + y2) / 2];
    return [
      { kind: "corner", id: "nw", at: [x1, y1] },
      { kind: "corner", id: "ne", at: [x2, y1] },
      { kind: "corner", id: "se", at: [x2, y2] },
      { kind: "corner", id: "sw", at: [x1, y2] },
      { kind: "edge", id: "n", at: [mx, y1] },
      { kind: "edge", id: "e", at: [x2, my] },
      { kind: "edge", id: "s", at: [mx, y2] },
      { kind: "edge", id: "w", at: [x1, my] },
    ];
  }
  if (s.vectorType === VectorType.Line || isPathType(s.vectorType)) {
    const out: Handle[] = s.points.map((at, index) => ({ kind: "vertex", index, at }));
    if (isPathType(s.vectorType)) {
      const n = s.closed ? s.points.length : s.points.length - 1;
      for (let i = 0; i < n; i++) {
        const [a, b] = [s.points[i], s.points[(i + 1) % s.points.length]];
        out.push({ kind: "mid", index: i, at: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] });
      }
    }
    return out;
  }
  return []; // points and fixed-size boxes only move
}

export function handleAt(handles: Handle[], p: Pt, tol: number): Handle | null {
  // vertices before midpoints, corners before edges: the more specific handle wins when they overlap
  const order = (h: Handle) => (h.kind === "vertex" || h.kind === "corner" ? 0 : 1);
  let best: Handle | null = null;
  let bd = Infinity;
  for (const h of handles) {
    const d = dist(p, h.at);
    if (d <= tol && (d < bd - 1e-9 || (Math.abs(d - bd) < 1e-9 && best && order(h) < order(best)))) {
      best = h;
      bd = d;
    }
  }
  return best;
}

/** Box after dragging a corner or edge handle to `to`; the box may be dragged through itself (corners swap). */
export function resizeBox(box: Box, h: Extract<Handle, { kind: "corner" | "edge" }>, to: Pt, b: Bounds): Box {
  const [tx, ty] = clampPoint(to, b);
  let [x1, y1, x2, y2] = box;
  const id = h.id;
  const moveX = id.includes("w") ? "x1" : id.includes("e") ? "x2" : null;
  const moveY = id.includes("n") ? "y1" : id.includes("s") ? "y2" : null;
  if (moveX === "x1") x1 = tx;
  if (moveX === "x2") x2 = tx;
  if (moveY === "y1") y1 = ty;
  if (moveY === "y2") y2 = ty;
  return boxBetween([x1, y1], [x2, y2]);
}

/** The points shifted by (dx, dy), limited so that the whole shape stays inside the image. */
export function movePoints(points: Pt[], dx: number, dy: number, b: Bounds): Pt[] {
  const [x1, y1, x2, y2] = boxOfPoints(points);
  const sx = Math.min(Math.max(dx, -x1), b.width - x2);
  const sy = Math.min(Math.max(dy, -y1), b.height - y2);
  return points.map(([x, y]) => [Math.round(x + sx), Math.round(y + sy)]);
}

export const moveVertex = (points: Pt[], i: number, to: Pt, b: Bounds): Pt[] =>
  points.map((p, k) => (k === i ? ([Math.round(clampPoint(to, b)[0]), Math.round(clampPoint(to, b)[1])] as Pt) : p));

export const insertVertex = (points: Pt[], after: number, at: Pt): Pt[] => [...points.slice(0, after + 1), [Math.round(at[0]), Math.round(at[1])], ...points.slice(after + 1)];

/** Without vertex `i`, or the same points when that would leave fewer than `min`. */
export const removeVertex = (points: Pt[], i: number, min: number): Pt[] => (points.length <= min ? points : points.filter((_, k) => k !== i));

/** Minimum number of vertices of a path type. */
export const minVertices = (t: number) => (t === VectorType.Polygon ? 3 : 2);

/** Two clicks closer than this many screen pixels in a row are one click (one-click mode debounce). */
export const DEBOUNCE_PX = 4;
