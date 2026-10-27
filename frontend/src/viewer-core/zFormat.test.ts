import { describe, expect, it } from "vitest";
import { formatZ, positionAt, type ZRange } from "./zFormat";

const range: ZRange = { start: -6, end: 0, unit: "µm", positions: [-6, -4, 0] };

describe("z positions", () => {
  it("interpolates between planes", () => {
    expect(positionAt(range, 0)).toBe(-6);
    expect(positionAt(range, 0.5)).toBe(-5);
    expect(positionAt(range, 1.5)).toBe(-2);
    expect(positionAt(range, 2)).toBe(0);
  });
  it("clamps outside the stack", () => {
    expect(positionAt(range, -3)).toBe(-6);
    expect(positionAt(range, 9)).toBe(0);
  });
  it("formats signed positions with the unit", () => {
    expect(formatZ(-6, "µm")).toBe("−6.0 µm");
    expect(formatZ(1.5, "µm")).toBe("+1.5 µm");
    expect(formatZ(0.01, "µm")).toBe("0.0 µm");
  });
});
