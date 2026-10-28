import { isBoxType } from "./geometry";
import type { Affine } from "./overlay";
import { VectorType } from "./types";

/** An annotation on the clipboard: its type and vector as the server stores them. */
export interface ClipItem {
  typeId: number;
  vectorType: number;
  vector: Record<string, number>;
}

export interface Clip {
  /** the image the annotations were copied from */
  imageId: number;
  items: ClipItem[];
}

let clip: Clip | null = null;

/** Copy and paste between images (also of other image sets) go through this one place; it lives as long as the page. */
export const clipboard = {
  get: (): Clip | null => clip,
  set: (c: Clip | null) => {
    clip = c;
  },
};

type Bounds = { width: number; height: number };

const pairs = (v: Record<string, number>): [number, number][] => {
  const out: [number, number][] = [];
  for (let n = 1; `x${n}` in v && `y${n}` in v; n++) out.push([v[`x${n}`], v[`y${n}`]]);
  return out;
};

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/**
 * The vector of a pasted annotation: its points moved by `map` (a registration from the image it was copied from to this
 * one) or by `shift` (same image: a visible offset, or an image without registration: same position). Boxes become the
 * box around the moved corners; fixed-size boxes keep the size of their type around the moved centre (`size`).
 */
export function pasteVector(item: ClipItem, bounds: Bounds, how: { map?: Affine | null; shift?: [number, number]; size?: [number, number] | null }): Record<string, number> {
  const move = (x: number, y: number): [number, number] => {
    if (how.map) {
      const [a, b, tx, c, d, ty] = how.map;
      return [a * x + b * y + tx, c * x + d * y + ty];
    }
    const [dx, dy] = how.shift ?? [0, 0];
    return [x + dx, y + dy];
  };
  const pts = pairs(item.vector).map(([x, y]) => move(x, y));
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(item.vector)) if (!/^[xy]\d+$/.test(k)) out[k] = v; // frame and the like
  if (isBoxType(item.vectorType)) {
    const xs = pts.map((q) => q[0]);
    const ys = pts.map((q) => q[1]);
    let [x0, y0, x1, y1] = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    if (item.vectorType === VectorType.FixedSizeBoundingBox && how.size) {
      const [cx, cy] = [(x0 + x1) / 2, (y0 + y1) / 2];
      const [w, h] = how.size;
      [x0, y0, x1, y1] = [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2];
    }
    const [w, h] = [x1 - x0, y1 - y0];
    // keep the size, move the box back inside the image
    const nx = clamp(x0, 0, Math.max(0, bounds.width - w));
    const ny = clamp(y0, 0, Math.max(0, bounds.height - h));
    return { ...out, x1: Math.round(nx), y1: Math.round(ny), x2: Math.round(nx + w), y2: Math.round(ny + h) };
  }
  pts.forEach(([x, y], i) => {
    out[`x${i + 1}`] = Math.round(clamp(x, 0, bounds.width));
    out[`y${i + 1}`] = Math.round(clamp(y, 0, bounds.height));
  });
  return out;
}
