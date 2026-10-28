import { describe, expect, it } from "vitest";
import { paintInto, tilesIn, TILE, wandSelect } from "./segmentation";

const count = (m: Uint8Array) => m.reduce((a, b) => a + b, 0);

describe("mask painting", () => {
  it("a round brush stamps a disc, a square brush a square", () => {
    const m = new Uint8Array(TILE * TILE);
    expect(paintInto(m, 0, 0, [50, 50], [50, 50], 5, "circle", 1)).toBe(true);
    const disc = count(m);
    expect(disc).toBeGreaterThan(70);
    expect(disc).toBeLessThan(85); // pi * 25
    expect(m[50 * TILE + 50]).toBe(1);
    expect(m[50 * TILE + 56]).toBe(0);
    const q = new Uint8Array(TILE * TILE);
    paintInto(q, 0, 0, [50, 50], [50, 50], 5, "square", 1);
    expect(count(q)).toBe(100);
  });

  it("a stroke is the area swept along the segment", () => {
    const m = new Uint8Array(TILE * TILE);
    paintInto(m, 0, 0, [20, 20], [100, 20], 3, "circle", 1);
    expect(m[20 * TILE + 60]).toBe(1);
    expect(m[20 * TILE + 105]).toBe(0);
    expect(m[26 * TILE + 60]).toBe(0);
  });

  it("erasing clears and reports whether anything changed", () => {
    const m = new Uint8Array(TILE * TILE);
    paintInto(m, 0, 0, [50, 50], [50, 50], 5, "circle", 1);
    expect(paintInto(m, 0, 0, [50, 50], [50, 50], 8, "circle", 0)).toBe(true);
    expect(count(m)).toBe(0);
    expect(paintInto(m, 0, 0, [50, 50], [50, 50], 8, "circle", 0)).toBe(false);
  });

  it("paints only the part inside the tile (neighbours get their share)", () => {
    const left = new Uint8Array(TILE * TILE);
    const right = new Uint8Array(TILE * TILE);
    paintInto(left, 0, 0, [TILE, 10], [TILE, 10], 4, "square", 1);
    paintInto(right, 1, 0, [TILE, 10], [TILE, 10], 4, "square", 1);
    expect(left[10 * TILE + TILE - 1]).toBe(1);
    expect(right[10 * TILE]).toBe(1);
    expect(count(left) + count(right)).toBe(64);
  });

  it("finds the tiles of a view", () => {
    expect(tilesIn([0, 0, 255, 255], 1000, 1000)).toMatchObject({ tx0: 0, tx1: 0, ty0: 0, ty1: 0, count: 1 });
    expect(tilesIn([200, 200, 600, 300], 1000, 1000)).toMatchObject({ tx0: 0, tx1: 2, ty0: 0, ty1: 1, count: 6 });
    expect(tilesIn([-500, -500, 5000, 5000], 600, 300)).toMatchObject({ tx0: 0, tx1: 2, ty0: 0, ty1: 1 });
  });
});

describe("magic wand", () => {
  // 6 x 4 image: left half dark, right half bright, one dark pixel inside the bright area (not connected)
  const w = 6;
  const h = 4;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(x < 3 ? [20, 20, 20, 255] : [230, 230, 230, 255], (y * w + x) * 4);
  data.set([20, 20, 20, 255], (1 * w + 5) * 4);

  it("grows over connected pixels of similar colour only", () => {
    const r = wandSelect(data, w, h, 0, 0, 30);
    expect(r).not.toBeNull();
    expect(count(r!.mask)).toBe(12);
    expect(r!.box).toEqual([0, 0, 2, 3]);
    expect(r!.mask[1 * w + 5]).toBe(0); // the dark pixel on the other side is not connected
  });

  it("a higher tolerance reaches over the edge", () => {
    expect(count(wandSelect(data, w, h, 0, 0, 250)!.mask)).toBe(w * h);
    expect(wandSelect(data, w, h, 9, 9, 10)).toBeNull();
  });
});
