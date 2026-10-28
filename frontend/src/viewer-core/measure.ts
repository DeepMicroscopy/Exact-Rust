import { VectorType, type Shape } from "./types";

export interface Measure {
  /** area in square pixels (boxes, polygons) */
  areaPx2: number | null;
  /** length in pixels (lines, polylines) */
  lengthPx: number | null;
  width: number;
  height: number;
}

/** Area of a simple polygon by the shoelace formula. */
export function polygonArea(pts: [number, number][]): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]);
  return Math.abs(a / 2);
}

export function pathLength(pts: [number, number][]): number {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return l;
}

export function measureShape(s: Shape): Measure {
  const [x1, y1, x2, y2] = s.bbox;
  const base = { width: x2 - x1, height: y2 - y1 };
  switch (s.vectorType) {
    case VectorType.BoundingBox:
    case VectorType.FixedSizeBoundingBox:
      return { ...base, areaPx2: base.width * base.height, lengthPx: null };
    case VectorType.Polygon:
      return { ...base, areaPx2: polygonArea(s.points), lengthPx: null };
    case VectorType.Line:
    case VectorType.MultiLine:
      return { ...base, areaPx2: null, lengthPx: pathLength(s.points) };
  }
  return { ...base, areaPx2: null, lengthPx: null };
}

const group = (n: number) => Math.round(n).toLocaleString("en-US");

/** Area in the unit that reads well: mm² for larger areas, µm² for small ones; pixels when the resolution is unknown. `mpp`: µm per pixel. */
export function formatArea(px2: number, mpp: number): string {
  if (!(mpp > 0)) return `${group(px2)} px²`;
  const um2 = px2 * mpp * mpp;
  if (um2 >= 1e5) return `${(um2 / 1e6).toFixed(um2 >= 1e8 ? 1 : um2 >= 1e7 ? 2 : 3)} mm²`;
  return `${group(um2)} µm²`;
}

export function formatLength(px: number, mpp: number): string {
  if (!(mpp > 0)) return `${group(px)} px`;
  const um = px * mpp;
  return um >= 1000 ? `${(um / 1000).toFixed(2)} mm` : `${Math.round(um)} µm`;
}
