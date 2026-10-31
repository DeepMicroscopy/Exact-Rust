/**
 * Helpers of the 3D segmentation in the three-plane view. The server (crates/exact-api/src/v2/volmask.rs) works in
 * millimetres from the corner of the displayed volume; a plane image shows `width x height` pixels of a rectangle of
 * the volume, so a brush of a given size in mm is an ellipse of pixels when the plane is not square-pixelled.
 */
import type { Plane } from "./mpr";

export interface PlaneSize {
  width: number;
  height: number;
}

/** Physical size of the volume in mm: along x (left to right), y (front to back), z (bottom to top). */
export type Extent = [number, number, number];

/** Pixels per mm of a plane image, horizontally and vertically. */
export function pixelsPerMm(plane: Plane, size: PlaneSize, ext: Extent): [number, number] {
  const [ex, ey, ez] = ext;
  if (plane === 0) return [size.width / ex, size.height / ey];
  if (plane === 1) return [size.width / ex, size.height / ez];
  return [size.width / ey, size.height / ez];
}

/** Radii in image pixels (horizontal, vertical) of a brush of `diameterMm`. */
export function brushRadii(plane: Plane, size: PlaneSize, ext: Extent, diameterMm: number): [number, number] {
  const [px, py] = pixelsPerMm(plane, size, ext);
  const r = Math.max(diameterMm, 0) / 2;
  return [r * px, r * py];
}

/** Keeps the first and last point and at most `max` points in all, evenly spread along the list. */
export function thin<T>(points: T[], max: number): T[] {
  if (points.length <= max || max < 2) return max < 2 ? points.slice(0, max) : points;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(points[Math.round((i * (points.length - 1)) / (max - 1))]);
  return out;
}

/** Drops points closer than `minDist` pixels to the one before (a hovering pen sends many). The last point is always kept. */
export function dropClose(points: [number, number][], minDist: number): [number, number][] {
  const out: [number, number][] = [];
  for (const p of points) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) >= minDist) out.push(p);
  }
  const last = points[points.length - 1];
  if (last && out[out.length - 1] !== last) out.push(last);
  return out;
}

/** "812 mm³", "12.3 ml" (from 1000 mm³: a ml is a cm³). */
export function formatVolume(mm3: number): string {
  if (!(mm3 > 0)) return "0 mm³";
  if (mm3 < 1000) return `${mm3 < 10 ? mm3.toFixed(1) : Math.round(mm3)} mm³`;
  const ml = mm3 / 1000;
  return `${ml < 100 ? ml.toFixed(1) : Math.round(ml)} ml`;
}

/** The wand tolerance is shown as a percentage of the grey range and sent as 0..255. */
export const toleranceOf = (percent: number): number => Math.round(Math.min(Math.max(percent, 0), 100) * 2.55);

export type SizeUnit = "px" | "mm";

/** Range of the brush size in a unit. */
export const sizeRange = (unit: SizeUnit): { min: number; max: number; step: number } => (unit === "px" ? { min: 1, max: 200, step: 1 } : { min: 0.5, max: 60, step: 0.5 });

/** The brush size after `steps` notches of the wheel (or `[` / `]` keys): about 12 % per step (at least one step of the slider), within the range of the unit. */
export function resized(size: number, steps: number, unit: SizeUnit = "mm"): number {
  const { min, max, step } = sizeRange(unit);
  let v = size * Math.pow(1.12, steps);
  if (Math.abs(v - size) < step) v = size + Math.sign(steps) * step;
  v = Math.round(Math.min(Math.max(v, min), max) / step) * step;
  return Math.round(v * 10) / 10;
}

/** The diameter of the brush in mm: a size in pixels is pixels of the plane drawn in (as wide as the picture shows them). */
export function brushDiameterMm(tool: { size: number; unit: SizeUnit }, plane: Plane, size: PlaneSize, ext: Extent): number {
  if (tool.unit === "mm") return tool.size;
  return tool.size / pixelsPerMm(plane, size, ext)[0];
}

/** `#rrggbb` (as the types store it) as the six digits the slice route asks for. */
export function hexDigits(color: string): string {
  const d = color.replace("#", "").toLowerCase();
  return /^[0-9a-f]{6}$/.test(d) ? d : "ff0000";
}

/** The slices a "copy to next / previous N slices" reaches, as the server takes them (`to` .. `through`). */
export function copyTargets(z: number, n: number, count: number, dir: 1 | -1): { to: number; through: number } | null {
  const lo = dir === 1 ? z + 1 : Math.max(z - count, 0);
  const hi = dir === 1 ? Math.min(z + count, n - 1) : z - 1;
  if (hi < lo || count < 1) return null;
  return { to: lo, through: hi };
}
