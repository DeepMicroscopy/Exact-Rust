import { describe, expect, it } from "vitest";
import { affineOf, invertAffine, overlayPlacement, type Affine } from "./overlay";

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
