import { describe, expect, it } from "vitest";
import type { AnnotationType } from "../api/types";
import { buildPalette, canConvert, hintFor, oneClickCapable } from "./palette";
import { VectorType } from "./types";

const t = (id: number, vector_type: number, extra: Partial<AnnotationType> = {}): AnnotationType => ({ id, name: `t${id}`, vector_type, color_code: "#fff", closed: true, ...extra });

describe("palette", () => {
  it("numbers the drawable types by sort order, global types get no key, segmentation is left out", () => {
    const p = buildPalette([t(5, 1, { sort_order: 2 }), t(6, 7), t(7, 8), t(8, 2, { sort_order: 1 }), t(9, 6, { sort_order: 2 })], 0.25);
    expect(p.map((e) => [e.id, e.key])).toEqual([[6, null], [8, 1], [5, 2], [9, 3]]);
  });
  it("converts type sizes to pixels with the image resolution", () => {
    const [e] = buildPalette([t(1, VectorType.FixedSizeBoundingBox, { default_width: 2.25, default_height: 2.25, size_unit: "mm" })], 0.25);
    expect(e.width).toBeCloseTo(9000);
    expect(e.sizeLabel).toBe("2.25 × 2.25 mm");
    const [px] = buildPalette([t(2, 1, { default_width: 50, default_height: 40 })], 0.25);
    expect([px.width, px.height]).toEqual([50, 40]);
  });
  it("types convert within a vector type and between the two box types", () => {
    expect(canConvert(1, 6)).toBe(true);
    expect(canConvert(6, 1)).toBe(true);
    expect(canConvert(5, 5)).toBe(true);
    expect(canConvert(5, 1)).toBe(false);
    expect(canConvert(2, 3)).toBe(false);
  });
  it("one-click mode is for boxes and points; hints say how to draw", () => {
    expect([1, 6, 2].every(oneClickCapable)).toBe(true);
    expect([3, 4, 5].some(oneClickCapable)).toBe(false);
    const [box] = buildPalette([t(1, 1, { default_width: 50, default_height: 50 })], 0);
    expect(hintFor(box, false)).toMatch(/Drag/);
    expect(hintFor(box, true)).toMatch(/Click to place a box \(50 × 50 px\)/);
  });
});
