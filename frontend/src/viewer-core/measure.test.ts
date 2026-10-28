import { describe, expect, it } from "vitest";
import { formatArea, formatLength, measureShape, pathLength, polygonArea } from "./measure";
import { toShape } from "./shapes";
import { VectorType } from "./types";

describe("measure", () => {
  it("area of boxes and polygons, length of lines", () => {
    const box = toShape(1, 1, VectorType.BoundingBox, true, { x1: 10, y1: 10, x2: 110, y2: 60 })!;
    expect(measureShape(box)).toMatchObject({ areaPx2: 5000, width: 100, height: 50, lengthPx: null });
    const tri = toShape(2, 1, VectorType.Polygon, true, { x1: 0, y1: 0, x2: 100, y2: 0, x3: 0, y3: 50 })!;
    expect(measureShape(tri).areaPx2).toBe(2500);
    const line = toShape(3, 1, VectorType.Line, false, { x1: 0, y1: 0, x2: 30, y2: 40 })!;
    expect(measureShape(line)).toMatchObject({ lengthPx: 50, areaPx2: null });
    expect(measureShape(toShape(4, 1, VectorType.Point, false, { x1: 5, y1: 5 })!)).toMatchObject({ areaPx2: null, lengthPx: null });
  });
  it("polygon area does not depend on the winding", () => {
    expect(polygonArea([[0, 0], [10, 0], [10, 10], [0, 10]])).toBe(100);
    expect(polygonArea([[0, 10], [10, 10], [10, 0], [0, 0]])).toBe(100);
    expect(polygonArea([[0, 0], [10, 0], [10, 10], [0, 10], [5, 5]])).toBe(75); // a notch
    expect(pathLength([[0, 0], [3, 4], [3, 14]])).toBe(15);
  });
  it("formats areas in the unit that reads well", () => {
    expect(formatArea(1234567, 0)).toBe("1,234,567 px²"); // resolution unknown
    expect(formatArea(10000, 0.25)).toBe("625 µm²"); // 100 x 100 px at 0.25 µm/px = 25 x 25 µm
    expect(formatArea(4e6, 0.25)).toBe("0.250 mm²");
    expect(formatArea(1.6e9, 0.25)).toBe("100.0 mm²");
    expect(formatArea(1.6e8, 0.25)).toBe("10.00 mm²");
  });
  it("formats lengths", () => {
    expect(formatLength(100, 0.25)).toBe("25 µm");
    expect(formatLength(8000, 0.25)).toBe("2.00 mm");
    expect(formatLength(100, 0)).toBe("100 px");
  });
});
