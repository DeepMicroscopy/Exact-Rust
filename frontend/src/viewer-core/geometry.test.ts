import { describe, expect, it } from "vitest";
import {
  boxBetween,
  clampPoint,
  centeredBox,
  handleAt,
  handlesFor,
  hitShape,
  insertVertex,
  minVertices,
  movePoints,
  removeVertex,
  resizeBox,
  sizeInPixels,
  vectorOf,
} from "./geometry";
import { toShape } from "./shapes";
import { VectorType } from "./types";

const bbox = (id: number, x1: number, y1: number, x2: number, y2: number) => toShape(id, 1, VectorType.BoundingBox, true, { x1, y1, x2, y2 })!;
const poly = toShape(9, 1, VectorType.Polygon, true, { x1: 0, y1: 0, x2: 100, y2: 0, x3: 100, y3: 100, x4: 0, y4: 100 })!;

describe("vectors", () => {
  it("numbers vertices from 1 and rounds to integers", () => {
    expect(vectorOf([[1.4, 2.6], [10, 20]])).toEqual({ x1: 1, y1: 3, x2: 10, y2: 20 });
  });
  it("boxes are ordered and at least one pixel in each direction", () => {
    expect(boxBetween([50, 40], [10, 5])).toEqual([10, 5, 50, 40]);
    expect(boxBetween([10, 10], [10, 10])).toEqual([10, 10, 11, 11]);
  });
  it("converts type sizes to pixels with the resolution", () => {
    expect(sizeInPixels(50, "px", 0.25)).toBe(50);
    expect(sizeInPixels(2.25, "mm", 0.25)).toBeCloseTo(9000);
    expect(sizeInPixels(100, "um", 0.5)).toBe(200);
    expect(sizeInPixels(3, "mm", 0)).toBe(3); // no resolution known: the number is taken as pixels
  });
  it("a centred box moves into the image instead of sticking out", () => {
    expect(centeredBox([100, 100], 50, 40, { width: 1000, height: 1000 })).toEqual([75, 80, 125, 120]);
    expect(centeredBox([5, 5], 50, 50, { width: 1000, height: 1000 })).toEqual([0, 0, 50, 50]);
    expect(centeredBox([995, 995], 50, 50, { width: 1000, height: 1000 })).toEqual([950, 950, 1000, 1000]);
    expect(centeredBox([10, 10], 5000, 5000, { width: 100, height: 80 })).toEqual([0, 0, 100, 80]);
  });
});

describe("hit tests", () => {
  it("a small annotation inside a large one stays selectable", () => {
    const big = bbox(1, 0, 0, 1000, 1000);
    const small = bbox(2, 100, 100, 150, 150);
    expect(hitShape([big, small], [120, 120], 3)?.id).toBe(2);
    expect(hitShape([small, big], [120, 120], 3)?.id).toBe(2);
    expect(hitShape([big, small], [500, 500], 3)?.id).toBe(1);
  });
  it("finds nothing outside the tolerance", () => {
    expect(hitShape([bbox(1, 0, 0, 10, 10)], [50, 50], 3)).toBeNull();
    expect(hitShape([bbox(1, 0, 0, 10, 10)], [12, 5], 3)?.id).toBe(1);
  });
  it("points and open lines are hit near them", () => {
    const pt = toShape(3, 1, VectorType.Point, false, { x1: 40, y1: 40 })!;
    expect(hitShape([pt], [42, 41], 4)?.id).toBe(3);
    const line = toShape(4, 1, VectorType.Line, false, { x1: 0, y1: 0, x2: 100, y2: 0 })!;
    expect(hitShape([line], [50, 3], 4)?.id).toBe(4);
    expect(hitShape([line], [50, 30], 4)).toBeNull();
  });
});

describe("handles", () => {
  it("a bounding box has corners and edges, a fixed size box none", () => {
    expect(handlesFor(bbox(1, 0, 0, 10, 10))).toHaveLength(8);
    expect(handlesFor(toShape(2, 1, VectorType.FixedSizeBoundingBox, true, { x1: 0, y1: 0, x2: 10, y2: 10 })!)).toEqual([]);
  });
  it("a polygon has a vertex handle per vertex and a midpoint handle per edge", () => {
    const h = handlesFor(poly);
    expect(h.filter((x) => x.kind === "vertex")).toHaveLength(4);
    expect(h.filter((x) => x.kind === "mid")).toHaveLength(4);
  });
  it("the vertex wins over the midpoint at equal distance, corners over edges", () => {
    expect(handleAt(handlesFor(poly), [1, 1], 20)).toMatchObject({ kind: "vertex", index: 0 });
    expect(handleAt(handlesFor(bbox(1, 0, 0, 100, 100)), [49, 0], 5)).toMatchObject({ kind: "edge", id: "n" });
    expect(handleAt(handlesFor(bbox(1, 0, 0, 100, 100)), [200, 200], 5)).toBeNull();
  });
});

describe("editing", () => {
  const b = { width: 1000, height: 800 };
  it("resizes by a corner or an edge, also through the opposite side", () => {
    const box: [number, number, number, number] = [100, 100, 200, 200];
    expect(resizeBox(box, { kind: "corner", id: "se", at: [200, 200] }, [300, 250], b)).toEqual([100, 100, 300, 250]);
    expect(resizeBox(box, { kind: "edge", id: "w", at: [100, 150] }, [50, 777], b)).toEqual([50, 100, 200, 200]); // an edge never moves the other axis
    expect(resizeBox(box, { kind: "corner", id: "nw", at: [100, 100] }, [300, 300], b)).toEqual([200, 200, 300, 300]);
    expect(resizeBox(box, { kind: "corner", id: "se", at: [200, 200] }, [5000, 5000], b)).toEqual([100, 100, 1000, 800]);
  });
  it("moving keeps the shape inside the image and keeps its size", () => {
    const pts: [number, number][] = [[10, 10], [60, 10], [60, 40]];
    expect(movePoints(pts, 5, 5, b)).toEqual([[15, 15], [65, 15], [65, 45]]);
    expect(movePoints(pts, -100, -100, b)).toEqual([[0, 0], [50, 0], [50, 30]]);
    expect(movePoints(pts, 5000, 5000, b)).toEqual([[950, 770], [1000, 770], [1000, 800]]);
  });
  it("inserts and removes vertices, a polygon keeps three", () => {
    const sq: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10]];
    expect(insertVertex(sq, 0, [5, 0])).toEqual([[0, 0], [5, 0], [10, 0], [10, 10], [0, 10]]);
    expect(removeVertex(sq, 1, minVertices(VectorType.Polygon))).toHaveLength(3);
    expect(removeVertex(sq.slice(0, 3), 1, minVertices(VectorType.Polygon))).toHaveLength(3);
    expect(removeVertex(sq.slice(0, 2), 1, minVertices(VectorType.MultiLine))).toHaveLength(2);
  });
});

describe("annotations outside the image (free bounds)", () => {
  const held = { width: 1000, height: 800 };
  const free = { width: 1000, height: 800, free: true };
  it("holds a point at the edge unless the bounds are free", () => {
    expect(clampPoint([-40, 900], held)).toEqual([0, 800]);
    expect(clampPoint([-40, 900], free)).toEqual([-40, 900]);
  });
  it("moves a shape beyond the edge only when free", () => {
    const pts: [number, number][] = [[10, 10], [60, 40]];
    expect(movePoints(pts, -50, 0, held)).toEqual([[0, 10], [50, 40]]);
    expect(movePoints(pts, -50, 0, free)).toEqual([[-40, 10], [10, 40]]);
  });
  it("lets a box reach negative coordinates when a corner is dragged out", () => {
    const b: [number, number, number, number] = [100, 100, 200, 200];
    const h = { kind: "corner", id: "nw", at: [100, 100] } as Parameters<typeof resizeBox>[1];
    expect(resizeBox(b, h, [-30, -20], held)).toEqual([0, 0, 200, 200]);
    expect(resizeBox(b, h, [-30, -20], free)).toEqual([-30, -20, 200, 200]);
  });
  it("centres a fixed-size box on a point at the edge only when free", () => {
    expect(centeredBox([5, 5], 50, 50, held)).toEqual([0, 0, 50, 50]);
    expect(centeredBox([5, 5], 50, 50, free)).toEqual([-20, -20, 30, 30]);
  });
});
