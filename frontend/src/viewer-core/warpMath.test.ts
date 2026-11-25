import { describe, expect, it } from "vitest";
import { cellsInView, grow, triangleMap, type Warp } from "./warpMath";

const apply = (m: number[], [x, y]: [number, number]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

describe("triangleMap", () => {
  it("takes the corners of one triangle to the corners of the other", () => {
    const s: [[number, number], [number, number], [number, number]] = [[0, 0], [10, 0], [0, 10]];
    const d: [[number, number], [number, number], [number, number]] = [[5, 5], [5, 25], [-15, 5]];
    const m = triangleMap(s, d)!;
    s.forEach((p, i) => {
      const q = apply(m, p);
      expect(q[0]).toBeCloseTo(d[i][0]);
      expect(q[1]).toBeCloseTo(d[i][1]);
    });
  });
  it("is null for a flat triangle", () => {
    expect(triangleMap([[0, 0], [1, 1], [2, 2]], [[0, 0], [1, 0], [2, 0]])).toBeNull();
  });
});

describe("grow", () => {
  it("moves every corner away from the centre", () => {
    const g = grow([[0, 0], [6, 0], [0, 6]], 1);
    expect(g[0][0]).toBeLessThan(0);
    expect(g[1][0]).toBeGreaterThan(6);
    expect(g[2][1]).toBeGreaterThan(6);
  });
});

describe("cellsInView", () => {
  // a 3 x 3 point grid over a 100 x 100 image, moved by (1000, 0): only what is on the screen counts
  const xs = [0, 50, 100];
  const warp: Warp = { xs, ys: xs, dst: xs.map((y) => xs.map((x): [number, number] => [x + 1000, y])) };
  it("finds nothing when the image is off the screen", () => {
    expect(cellsInView(warp, (p) => p, 200, 200).cells).toEqual([]);
  });
  it("finds the cells on the screen and the box of their sources", () => {
    const shift = (p: [number, number]): [number, number] => [p[0] - 1060, p[1]]; // only the right half of the image is in view
    const r = cellsInView(warp, shift, 40, 200);
    expect(r.cells).toEqual([[0, 0], [0, 1], [1, 0], [1, 1]].filter(([, j]) => j === 1));
    expect(r.box).toEqual({ x1: 50, y1: 0, x2: 100, y2: 100 });
  });
});
