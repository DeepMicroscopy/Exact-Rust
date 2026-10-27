import { describe, expect, it } from "vitest";
import { toShape, vertices } from "./shapes";
import { VectorType } from "./types";

describe("shapes", () => {
  it("reads ordered vertices", () => {
    expect(vertices({ x1: 1, y1: 2, x2: 3, y2: 4 })).toEqual([[1, 2], [3, 4]]);
  });

  it("turns a bounding box into a closed rectangle with bbox", () => {
    const s = toShape(1, 1, VectorType.BoundingBox, false, { x1: 10, y1: 20, x2: 30, y2: 40 })!;
    expect(s.closed).toBe(true);
    expect(s.points).toHaveLength(4);
    expect(s.bbox).toEqual([10, 20, 30, 40]);
  });

  it("keeps a point as a single vertex", () => {
    const s = toShape(2, 1, VectorType.Point, false, { x1: 5, y1: 6 })!;
    expect(s.points).toEqual([[5, 6]]);
    expect(s.bbox).toEqual([5, 6, 5, 6]);
  });

  it("skips global and empty annotations", () => {
    expect(toShape(3, 1, VectorType.Global, false, null)).toBeNull();
    expect(toShape(4, 1, VectorType.Polygon, false, {})).toBeNull();
  });
});
