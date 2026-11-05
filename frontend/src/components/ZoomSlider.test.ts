import { describe, expect, it } from "vitest";
import { formatZoom, posToZoom, zoomToPos } from "./ZoomSlider";

describe("zoom slider", () => {
  it("maps the zoom range logarithmically onto the slider and back", () => {
    expect(zoomToPos(0.01, 0.01, 4)).toBe(0);
    expect(zoomToPos(4, 0.01, 4)).toBe(1000);
    expect(zoomToPos(0.2, 0.01, 4)).toBe(Math.round((Math.log(20) / Math.log(400)) * 1000));
    for (const z of [0.01, 0.05, 0.3, 1, 4]) expect(posToZoom(zoomToPos(z, 0.01, 4), 0.01, 4)).toBeCloseTo(z, 1);
  });
  it("stays on the slider for a zoom outside the range or a range that is not known yet", () => {
    expect(zoomToPos(100, 0.01, 4)).toBe(1000);
    expect(zoomToPos(0.0001, 0.01, 4)).toBe(0);
    expect(zoomToPos(1, 0, 0)).toBe(0);
  });
  it("shows the zoom in percent with the digits that matter", () => {
    expect(formatZoom(1)).toBe("100 %");
    expect(formatZoom(0.375)).toBe("38 %");
    expect(formatZoom(0.035)).toBe("3.5 %");
    expect(formatZoom(0.0042)).toBe("0.42 %");
  });
});
