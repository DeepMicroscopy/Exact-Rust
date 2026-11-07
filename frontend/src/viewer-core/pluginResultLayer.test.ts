import { describe, expect, it } from "vitest";
import { countAbove, type Detections } from "./pluginResultLayer";

const d: Detections = {
  id: 1,
  name: "Mitotic Figures",
  default_threshold: 0.5,
  boxes: [
    [0, 0, 10, 10, 0.9, 1],
    [20, 20, 30, 30, 0.5, 1],
    [40, 40, 50, 50, 0.2, 1],
  ],
  polygons: [{ t: 2, s: 0.7, p: [0, 0, 10, 0, 10, 10] }],
  types: {},
  truncated: false,
};

describe("countAbove", () => {
  it("counts the detections that reach the threshold, boxes and polygons", () => {
    expect(countAbove(d, 0)).toBe(4);
    expect(countAbove(d, 0.5)).toBe(3);
    expect(countAbove(d, 0.8)).toBe(1);
    expect(countAbove(d, 1)).toBe(0);
  });
});
