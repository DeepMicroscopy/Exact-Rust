import { VectorType, type Shape } from "./types";

type Vec = Record<string, number | undefined | null>;

/** Vertices of an annotation vector (`x1,y1,x2,y2,...`) in order. */
export function vertices(v: Vec): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 1; ; i++) {
    const x = v[`x${i}`];
    const y = v[`y${i}`];
    if (typeof x !== "number" || typeof y !== "number") break;
    out.push([x, y]);
  }
  return out;
}

/** Builds a drawable shape; returns null for annotations without geometry (global, segmentation, empty). */
export function toShape(id: number, typeId: number, vectorType: number, closed: boolean, v: Vec | null): Shape | null {
  if (!v || vectorType === VectorType.Global || vectorType === VectorType.Segmentation) return null;
  const points = vertices(v);
  if (points.length === 0) return null;
  let xs = points.map((p) => p[0]);
  let ys = points.map((p) => p[1]);
  let pts = points;
  if (vectorType === VectorType.BoundingBox || vectorType === VectorType.FixedSizeBoundingBox) {
    if (points.length < 2) return null;
    const [[x1, y1], [x2, y2]] = points;
    pts = [
      [x1, y1],
      [x2, y1],
      [x2, y2],
      [x1, y2],
    ];
    xs = [x1, x2];
    ys = [y1, y2];
  }
  return {
    id,
    typeId,
    vectorType,
    closed: closed || vectorType === VectorType.BoundingBox || vectorType === VectorType.FixedSizeBoundingBox || vectorType === VectorType.Polygon,
    points: pts,
    bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
  };
}
