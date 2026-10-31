import { describe, expect, it } from "vitest";
import { brushDiameterMm, brushRadii, copyTargets, dropClose, formatVolume, hexDigits, pixelsPerMm, resized, thin, toleranceOf } from "./mpr3d";

const ext: [number, number, number] = [40, 30, 100];

describe("mpr3d", () => {
  it("knows how many pixels a mm is on each plane", () => {
    expect(pixelsPerMm(0, { width: 80, height: 60 }, ext)).toEqual([2, 2]);
    // slices 100 mm tall drawn 125 pixels high: coarser than wide
    expect(pixelsPerMm(1, { width: 80, height: 125 }, ext)).toEqual([2, 1.25]);
    expect(pixelsPerMm(2, { width: 60, height: 125 }, ext)).toEqual([2, 1.25]);
  });

  it("turns a diameter in mm into the radii of an ellipse of pixels", () => {
    expect(brushRadii(1, { width: 80, height: 125 }, ext, 10)).toEqual([10, 6.25]);
    expect(brushRadii(0, { width: 80, height: 60 }, ext, -3)).toEqual([0, 0]);
  });

  it("thins a stroke but keeps its ends", () => {
    const pts = Array.from({ length: 10_000 }, (_, i) => i);
    const t = thin(pts, 2000);
    expect(t).toHaveLength(2000);
    expect(t[0]).toBe(0);
    expect(t[1999]).toBe(9999);
    expect(thin([1, 2, 3], 2000)).toEqual([1, 2, 3]);
  });

  it("drops points that did not move", () => {
    const out = dropClose([[0, 0], [0.2, 0], [3, 0], [3.1, 0]], 1);
    expect(out).toEqual([[0, 0], [3, 0], [3.1, 0]]);
    expect(dropClose([[5, 5]], 1)).toEqual([[5, 5]]);
  });

  it("writes volumes the way people read them", () => {
    expect(formatVolume(0)).toBe("0 mm³");
    expect(formatVolume(4.26)).toBe("4.3 mm³");
    expect(formatVolume(812.4)).toBe("812 mm³");
    expect(formatVolume(12_345)).toBe("12.3 ml");
    expect(formatVolume(250_000)).toBe("250 ml");
  });

  it("scales the tolerance to the grey range", () => {
    expect([toleranceOf(0), toleranceOf(10), toleranceOf(100), toleranceOf(250)]).toEqual([0, 26, 255, 255]);
  });

  it("sizes the brush by steps within limits", () => {
    expect(resized(10, 1)).toBeGreaterThan(10);
    expect(resized(10, -1)).toBeLessThan(10);
    expect(resized(59, 5)).toBe(60);
    expect(resized(0.6, -9)).toBe(0.5);
  });

  it("sizes the brush in whole pixels, each step at least one pixel", () => {
    expect(resized(3, 1, "px")).toBe(4);
    expect(resized(3, -1, "px")).toBe(2);
    expect(resized(1, -3, "px")).toBe(1);
    expect(resized(199, 4, "px")).toBe(200);
  });

  it("turns a size in pixels into mm with the pixels of the plane drawn in", () => {
    // axial 400 x 300 pixels for 200 x 150 mm: two pixels per mm; coronal 400 x 100 for 200 x 50 mm
    expect(brushDiameterMm({ size: 10, unit: "px" }, 0, { width: 400, height: 300 }, [200, 150, 50])).toBeCloseTo(5);
    expect(brushDiameterMm({ size: 10, unit: "px" }, 1, { width: 200, height: 100 }, [200, 150, 50])).toBeCloseTo(10);
    expect(brushDiameterMm({ size: 7, unit: "mm" }, 2, { width: 10, height: 10 }, [200, 150, 50])).toBe(7);
  });

  it("takes colours as six digits", () => {
    expect(hexDigits("#AA0FEA")).toBe("aa0fea");
    expect(hexDigits("red")).toBe("ff0000");
  });

  it("finds the slices a copy reaches", () => {
    expect(copyTargets(10, 40, 3, 1)).toEqual({ to: 11, through: 13 });
    expect(copyTargets(10, 40, 3, -1)).toEqual({ to: 7, through: 9 });
    expect(copyTargets(38, 40, 5, 1)).toEqual({ to: 39, through: 39 });
    expect(copyTargets(39, 40, 5, 1)).toBeNull();
    expect(copyTargets(0, 40, 5, -1)).toBeNull();
  });
});
