import { describe, expect, it } from "vitest";
import { affineOf, invertAffine, cropRegistrationPoints, mappedRegion, overlayPlacement, type Affine } from "./overlay";

describe("registration overlay", () => {
  it("reads the matrix and inverts it", () => {
    const m = affineOf({ t_00: 0, t_01: -2, t_02: 100, t_10: 2, t_11: 0, t_12: 50, t_20: 0, t_21: 0, t_22: 1 })!;
    const inv = invertAffine(m)!;
    // (3, 4) -> (-2*4 + 100, 2*3 + 50) = (92, 56) and back
    const [x, y] = [m[0] * 3 + m[1] * 4 + m[2], m[3] * 3 + m[4] * 4 + m[5]];
    expect([x, y]).toEqual([92, 56]);
    expect(inv[0] * x + inv[1] * y + inv[2]).toBeCloseTo(3);
    expect(inv[3] * x + inv[4] * y + inv[5]).toBeCloseTo(4);
    expect(invertAffine([0, 0, 1, 0, 0, 1])).toBeNull();
    expect(affineOf({ t_00: 1 })).toBeNull();
  });

  it("places a shifted and scaled image by its rectangle", () => {
    // overlay 1000 x 500 px, scale 2, shift (200, 100); the current image is 4000 px wide
    const p = overlayPlacement([2, 0, 200, 0, 2, 100], 1000, 500, 4000);
    expect(p.x).toBeCloseTo(0.05);
    expect(p.y).toBeCloseTo(0.025);
    expect(p.width).toBeCloseTo(0.5);
    expect(p.degrees).toBeCloseTo(0);
  });

  it("rotates about the centre of the image", () => {
    // 90 degrees clockwise on screen (y down): (x, y) -> (-y + 1000, x); the overlay is 400 x 200
    const m: Affine = [0, -1, 1000, 1, 0, 0];
    const p = overlayPlacement(m, 400, 200, 1000);
    expect(p.degrees).toBeCloseTo(90);
    // the centre (200, 100) lands at (900, 200); the unrotated rectangle is centred there
    expect(p.x * 1000 + (p.width * 1000) / 2).toBeCloseTo(900);
    expect(p.y * 1000 + (p.width * 1000 * 0.5) / 2).toBeCloseTo(200);
  });
});

describe("region of a registered image", () => {
  it("is the bounding box of the mapped corners, kept inside the image", () => {
    // a shift by (10, 20) and a doubling of the scale
    const m: Affine = [2, 0, 10, 0, 2, 20];
    expect(mappedRegion(m, { x: 5, y: 5, w: 10, h: 10 }, 1000, 1000)).toEqual({ x: 20, y: 30, w: 20, h: 20 });
    expect(mappedRegion(m, { x: 5, y: 5, w: 10, h: 10 }, 30, 1000)).toEqual({ x: 20, y: 30, w: 10, h: 20 });
    // a quarter turn: the box stays a box
    const turn: Affine = [0, -1, 100, 1, 0, 0];
    expect(mappedRegion(turn, { x: 10, y: 20, w: 30, h: 40 }, 1000, 1000)).toEqual({ x: 40, y: 10, w: 40, h: 30 });
  });

  it("is null when the region lies outside the other image", () => {
    expect(mappedRegion([1, 0, 5000, 0, 1, 0], { x: 0, y: 0, w: 10, h: 10 }, 1000, 1000)).toBeNull();
  });
});

describe("registration of two crops", () => {
  it("moves the registration of the images to the origins of the crops", () => {
    const m: Affine = [0.5, 0, 100, 0, 0.5, 50]; // pixels of the other image -> pixels of this one
    const pts = cropRegistrationPoints(m, { x: 400, y: 200, w: 40, h: 20 }, { x: 290, y: 140 });
    expect(pts).toHaveLength(4);
    // (0, 0) of the other crop is (400, 200) in its image = (300, 150) in this image = (10, 10) in the crop of this one
    expect(pts[0]).toEqual({ source: [0, 0], target: [10, 10] });
    expect(pts[3]).toEqual({ source: [40, 20], target: [30, 20] });
  });
});
