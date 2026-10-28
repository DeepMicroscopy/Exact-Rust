import { describe, expect, it } from "vitest";
import { pasteVector } from "./clipboard";
import { VectorType } from "./types";

const bounds = { width: 1000, height: 800 };

describe("pasting annotations", () => {
  it("shifts a polygon and keeps its frame", () => {
    const v = pasteVector({ typeId: 1, vectorType: VectorType.Polygon, vector: { x1: 10, y1: 10, x2: 50, y2: 10, x3: 30, y3: 40, frame: 3 } }, bounds, { shift: [20, 30] });
    expect(v).toEqual({ frame: 3, x1: 30, y1: 40, x2: 70, y2: 40, x3: 50, y3: 70 });
  });

  it("keeps a box inside the image when shifted over the edge", () => {
    const v = pasteVector({ typeId: 1, vectorType: VectorType.BoundingBox, vector: { x1: 900, y1: 700, x2: 980, y2: 780 } }, bounds, { shift: [50, 50] });
    expect(v).toEqual({ x1: 920, y1: 720, x2: 1000, y2: 800 });
  });

  it("maps through a registration: scale 2 and a shift turn a box into the box around the corners", () => {
    const v = pasteVector({ typeId: 1, vectorType: VectorType.BoundingBox, vector: { x1: 10, y1: 20, x2: 30, y2: 40 } }, bounds, { map: [2, 0, 100, 0, 2, 50] });
    expect(v).toEqual({ x1: 120, y1: 90, x2: 160, y2: 130 });
  });

  it("a rotation by 90 degrees gives the bounding box of the rotated corners", () => {
    // (x, y) -> (-y + 500, x)
    const v = pasteVector({ typeId: 1, vectorType: VectorType.BoundingBox, vector: { x1: 100, y1: 100, x2: 200, y2: 150 } }, bounds, { map: [0, -1, 500, 1, 0, 0] });
    expect(v).toEqual({ x1: 350, y1: 100, x2: 400, y2: 200 });
  });

  it("a fixed-size box keeps the size of its type around the mapped centre", () => {
    const v = pasteVector({ typeId: 1, vectorType: VectorType.FixedSizeBoundingBox, vector: { x1: 100, y1: 100, x2: 150, y2: 150 } }, bounds, { map: [2, 0, 0, 0, 2, 0], size: [50, 50] });
    expect(v).toEqual({ x1: 225, y1: 225, x2: 275, y2: 275 });
  });

  it("points are moved and clamped", () => {
    const v = pasteVector({ typeId: 2, vectorType: VectorType.Point, vector: { x1: 990, y1: 5 } }, bounds, { shift: [30, -20] });
    expect(v).toEqual({ x1: 1000, y1: 0 });
  });
});
