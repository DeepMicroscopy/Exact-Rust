// Boolean operations on annotation polygons (brush, scissors, glue, knife). Pure functions on rings of image pixels.
import polygonClipping, { type MultiPolygon, type Polygon } from "polygon-clipping";
import type { Pt } from "./geometry";

export type Ring = Pt[];

export interface OpResult {
  /** outer rings of the result, largest first */
  rings: Ring[];
  /** the result had holes; EXACT polygons have none, so they were dropped */
  droppedHoles: boolean;
}

const closed = (r: Ring): Polygon => [[...r, r[0]]];

export function ringArea(r: Ring): number {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]);
  return Math.abs(a / 2);
}

/** Outer rings of a clipping result: closing vertex removed, specks and slivers left out, largest first. */
function outer(multi: MultiPolygon): OpResult {
  let droppedHoles = false;
  const rings: Ring[] = [];
  for (const poly of multi) {
    if (poly.length > 1) droppedHoles = true;
    const ring = poly[0].slice(0, -1) as Ring;
    if (ring.length >= 3 && ringArea(ring) >= 1) rings.push(ring);
  }
  rings.sort((a, b) => ringArea(b) - ringArea(a));
  return { rings, droppedHoles };
}

/** Convex outline of the stroke of a round brush of radius `r` along a -> b (a "capsule"). */
export function capsule(a: Pt, b: Pt, r: number, arc = 10): Ring {
  const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
  const out: Ring = [];
  for (let i = 0; i <= arc; i++) {
    const t = ang - Math.PI / 2 + (Math.PI * i) / arc; // half circle around b, facing away from a
    out.push([b[0] + r * Math.cos(t), b[1] + r * Math.sin(t)]);
  }
  for (let i = 0; i <= arc; i++) {
    const t = ang + Math.PI / 2 + (Math.PI * i) / arc; // half circle around a
    out.push([a[0] + r * Math.cos(t), a[1] + r * Math.sin(t)]);
  }
  return out;
}

export const disc = (c: Pt, r: number, n = 24): Ring => Array.from({ length: n }, (_, i) => [c[0] + r * Math.cos((2 * Math.PI * i) / n), c[1] + r * Math.sin((2 * Math.PI * i) / n)] as Pt);

/** The area swept by a brush of radius `r` along `path` (one point: a disc). */
export function stroke(path: Pt[], r: number): Ring[] {
  if (path.length === 0) return [];
  if (path.length === 1) return [disc(path[0], r)];
  let acc: MultiPolygon = [];
  for (let i = 1; i < path.length; i++) {
    const seg = closed(capsule(path[i - 1], path[i], r));
    acc = acc.length ? polygonClipping.union(acc, seg) : [seg];
  }
  return outer(acc).rings;
}

const multiOf = (rings: Ring[]): MultiPolygon => rings.map(closed);

export function union(a: Ring, b: Ring[]): OpResult {
  return outer(polygonClipping.union(closed(a), ...multiOf(b)));
}

export function difference(a: Ring, b: Ring[]): OpResult {
  if (b.length === 0) return { rings: [a], droppedHoles: false };
  return outer(polygonClipping.difference(closed(a), multiOf(b)));
}

/** Cuts the polygon along a polyline; the pieces are returned largest first (one piece: the line did not cut through). */
export function split(a: Ring, line: Pt[], width = 1): OpResult {
  const blade = stroke(line, width / 2);
  return difference(a, blade);
}

/** Douglas-Peucker on a closed ring; keeps at least three vertices. */
export function simplify(ring: Ring, tol: number): Ring {
  if (ring.length <= 3) return ring;
  const keep = new Array(ring.length).fill(false);
  // the two points farthest apart anchor the ring
  let [i0, i1, best] = [0, 1, -1];
  for (let i = 0; i < ring.length; i++) for (let j = i + 1; j < ring.length; j++) {
    const d = Math.hypot(ring[i][0] - ring[j][0], ring[i][1] - ring[j][1]);
    if (d > best) [i0, i1, best] = [i, j, d];
  }
  keep[i0] = keep[i1] = true;
  const dpSeg = (idx: number[]) => {
    if (idx.length < 3) return;
    const [a, b] = [ring[idx[0]], ring[idx[idx.length - 1]]];
    let [maxD, at] = [-1, 0];
    for (let k = 1; k < idx.length - 1; k++) {
      const p = ring[idx[k]];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const d = Math.abs((b[0] - a[0]) * (a[1] - p[1]) - (a[0] - p[0]) * (b[1] - a[1])) / len;
      if (d > maxD) [maxD, at] = [d, k];
    }
    if (maxD > tol) {
      keep[idx[at]] = true;
      dpSeg(idx.slice(0, at + 1));
      dpSeg(idx.slice(at));
    }
  };
  const n = ring.length;
  const walk = (from: number, to: number) => {
    const idx: number[] = [];
    for (let i = from; ; i = (i + 1) % n) {
      idx.push(i);
      if (i === to) break;
    }
    return idx;
  };
  dpSeg(walk(i0, i1));
  dpSeg(walk(i1, i0));
  const out = ring.filter((_, i) => keep[i]);
  return out.length >= 3 ? out : ring;
}

/** Integer vertices without repeated neighbours (what the server stores). */
export function tidy(ring: Ring): Ring {
  const r = ring.map(([x, y]) => [Math.round(x), Math.round(y)] as Pt);
  return r.filter((p, i) => i === 0 || p[0] !== r[i - 1][0] || p[1] !== r[i - 1][1]).filter((p, i, a) => !(i === a.length - 1 && a.length > 1 && p[0] === a[0][0] && p[1] === a[0][1]));
}
