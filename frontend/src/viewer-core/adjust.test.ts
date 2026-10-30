import { describe, expect, it } from "vitest";
import { cssFilter, isNeutral, NEUTRAL, parseAdjust } from "./adjust";

describe("adjust", () => {
  it("changes nothing by default", () => {
    expect(cssFilter(NEUTRAL)).toBe("");
    expect(isNeutral(NEUTRAL)).toBe(true);
  });
  it("lists only what was changed", () => {
    const f = cssFilter({ ...NEUTRAL, brightness: 120, contrast: 80, invert: true });
    expect(f).toBe("brightness(1.2) contrast(0.8) invert(1)");
  });
  it("applies the gamma curve first, through the SVG filter", () => {
    expect(cssFilter({ ...NEUTRAL, gamma: 1.5, saturation: 150 })).toMatch(/^url\(#exact-gamma\) saturate\(1\.5\)$/);
  });
  it("takes back only what is stored and sane", () => {
    expect(parseAdjust(null)).toEqual(NEUTRAL);
    expect(parseAdjust("not json")).toEqual(NEUTRAL);
    const a = parseAdjust(JSON.stringify({ brightness: 5000, gamma: "x", hue: -30, invert: "yes", grayscale: true }));
    expect(a).toMatchObject({ brightness: 300, gamma: 1, hue: -30, invert: false, grayscale: true });
  });
});
