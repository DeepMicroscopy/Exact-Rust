import type { AnnotationType } from "../api/types";
import type { TypeInfo } from "./editor";
import { sizeInPixels } from "./geometry";
import { VectorType } from "./types";

export interface PaletteEntry extends TypeInfo {
  /** digit that selects the type (1..9), by position in the image set's list */
  key: number | null;
  sizeLabel: string | null;
}

/** Types that can be drawn in the viewer. Segmentation has its own tool, global types are image labels. */
export const isDrawable = (vt: number) => vt !== VectorType.Global && vt !== VectorType.Segmentation;

/** An annotation can change its type within the same vector type, and between bounding box and fixed-size box (as on the server). */
export function canConvert(from: number, to: number): boolean {
  if (from === to) return true;
  const box = (t: number) => t === VectorType.BoundingBox || t === VectorType.FixedSizeBoundingBox;
  return box(from) && box(to);
}

/** The types of the image set in the order of the digit keys; `mpp` (µm per pixel) converts mm / µm sizes to pixels. */
export function buildPalette(types: AnnotationType[], mpp: number): PaletteEntry[] {
  const sorted = [...types].filter((t) => t.vector_type !== VectorType.Segmentation).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.id - b.id);
  let n = 0;
  return sorted.map((t) => {
    const hasSize = t.default_width != null && t.default_height != null;
    const unit = t.size_unit ?? "px";
    const w = hasSize ? sizeInPixels(t.default_width!, unit, mpp) : null;
    const h = hasSize ? sizeInPixels(t.default_height!, unit, mpp) : null;
    const globalType = t.vector_type === VectorType.Global;
    return {
      id: t.id,
      name: t.name,
      vectorType: t.vector_type,
      closed: t.closed,
      color: t.color_code,
      nodeCount: t.node_count ?? 0,
      width: w,
      height: h,
      key: !globalType && ++n <= 9 ? n : null,
      sizeLabel: hasSize ? `${t.default_width} × ${t.default_height} ${unit === "um" ? "µm" : unit}` : null,
    };
  });
}

/** One line telling how to draw with the type. */
export function hintFor(e: PaletteEntry, oneClick: boolean): string {
  switch (e.vectorType) {
    case VectorType.BoundingBox:
      return oneClick ? `Click to place a box (${e.sizeLabel ?? "default size"})` : "Drag to draw a box";
    case VectorType.FixedSizeBoundingBox:
      return `Click to place a box (${e.sizeLabel ?? "fixed size"})`;
    case VectorType.Point:
      return "Click to place a point";
    case VectorType.Line:
      return "Drag to draw a line";
    case VectorType.MultiLine:
      return "Click to add points · Enter or double-click to finish";
    case VectorType.Polygon:
      return e.nodeCount > 0 ? `Click ${e.nodeCount} points` : "Click to add points · click the first point, Enter or double-click to close";
  }
  return "";
}

/** Whether one click can place an annotation of the type (one-click mode). */
export const oneClickCapable = (vt: number) => vt === VectorType.BoundingBox || vt === VectorType.FixedSizeBoundingBox || vt === VectorType.Point;
