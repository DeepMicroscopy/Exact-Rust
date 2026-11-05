import { describe, expect, it } from "vitest";
import { zoomFactor } from "./zoomStep";

describe("zoom step", () => {
  it("low is the factor the viewer always used", () => {
    expect(zoomFactor("low", true)).toBe(1.25);
    expect(zoomFactor("low", false)).toBeCloseTo(0.8);
  });
  it("medium and high zoom further, and out is the inverse of in", () => {
    expect(zoomFactor("medium", true)).toBe(1.5);
    expect(zoomFactor("high", true)).toBe(2);
    expect(zoomFactor("high", false)).toBe(0.5);
  });
  it("an unknown or missing step counts as low", () => {
    expect(zoomFactor(undefined, true)).toBe(1.25);
    expect(zoomFactor("huge", false)).toBeCloseTo(0.8);
  });
});
