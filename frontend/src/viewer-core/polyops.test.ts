import { describe, expect, it } from "vitest";
import { capsule, difference, ringArea, simplify, split, stroke, tidy, union } from "./polyops";
import type { Pt } from "./geometry";

const sq = (x: number, y: number, s: number): Pt[] => [[x, y], [x + s, y], [x + s, y + s], [x, y + s]];

describe("polygon operations", () => {
  it("unites overlapping polygons into one", () => {
    const r = union(sq(0, 0, 100), [sq(50, 50, 100)]);
    expect(r.rings).toHaveLength(1);
    expect(ringArea(r.rings[0])).toBeCloseTo(100 * 100 + 100 * 100 - 50 * 50);
  });
  it("keeps separate polygons separate", () => {
    expect(union(sq(0, 0, 10), [sq(100, 100, 10)]).rings).toHaveLength(2);
  });
  it("subtracting a corner leaves one polygon", () => {
    const r = difference(sq(0, 0, 100), [sq(60, 60, 100)]);
    expect(r.rings).toHaveLength(1);
    expect(ringArea(r.rings[0])).toBeCloseTo(100 * 100 - 40 * 40);
  });
  it("subtracting a band through the middle makes two", () => {
    const r = difference(sq(0, 0, 100), [[[40, -10], [60, -10], [60, 110], [40, 110]]]);
    expect(r.rings).toHaveLength(2);
    expect(ringArea(r.rings[0])).toBeCloseTo(40 * 100);
  });
  it("a hole is dropped and reported (EXACT polygons have none)", () => {
    const r = difference(sq(0, 0, 100), [sq(30, 30, 20)]);
    expect(r.droppedHoles).toBe(true);
    expect(r.rings).toHaveLength(1);
    expect(ringArea(r.rings[0])).toBeCloseTo(100 * 100); // the outline stays
  });
  it("the knife splits along a line that crosses the polygon, and does nothing for one that does not", () => {
    const halves = split(sq(0, 0, 100), [[50, -20], [50, 120]]);
    expect(halves.rings).toHaveLength(2);
    expect(ringArea(halves.rings[0]) + ringArea(halves.rings[1])).toBeGreaterThan(9850);
    expect(split(sq(0, 0, 100), [[50, -20], [50, 40]]).rings).toHaveLength(1);
  });
  it("a brush stroke covers a disc plus a band", () => {
    const [ring] = stroke([[0, 0], [100, 0]], 10);
    expect(ringArea(ring)).toBeGreaterThan(Math.PI * 100 * 0.95 + 2 * 10 * 100 * 0.97);
    expect(ringArea(capsule([0, 0], [100, 0], 10))).toBeCloseTo(ringArea(ring), -1);
    expect(stroke([[5, 5]], 10)).toHaveLength(1);
  });
  it("painting over a polygon with a brush adds area to it", () => {
    const brush = stroke([[90, 50], [160, 50]], 15);
    const r = union(sq(0, 0, 100), brush);
    expect(r.rings).toHaveLength(1);
    expect(ringArea(r.rings[0])).toBeGreaterThan(100 * 100 + 1000);
  });
  it("simplifies a ring without losing its shape and keeps three vertices", () => {
    const dense: Pt[] = [];
    for (let i = 0; i <= 50; i++) dense.push([i * 2, 0]);
    dense.push([100, 100], [0, 100]);
    expect(simplify(dense, 0.5)).toHaveLength(4);
    expect(simplify([[0, 0], [10, 0], [0, 10]], 100)).toHaveLength(3);
  });
  it("tidy rounds and drops repeated vertices and a repeated closing vertex", () => {
    expect(tidy([[0.2, 0], [0.4, 0.1], [10, 0], [10, 10], [0, 0]])).toEqual([[0, 0], [10, 0], [10, 10]]);
  });
});
