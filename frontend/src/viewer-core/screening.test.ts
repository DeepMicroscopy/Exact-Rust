import { describe, expect, it } from "vitest";
import { coverage, createMode, keyMove, moved, overlapOf, starts, tileAt } from "./screening";

describe("screening windows", () => {
  it("steps by the part of the window that is new, and ends at the border", () => {
    expect(starts(1000, 100, 0.8)).toEqual([0, 20, 40, 60, 80, 100, 120, 140, 160, 180, 200, 220, 240, 260, 280, 300, 320, 340, 360, 380, 400, 420, 440, 460, 480, 500, 520, 540, 560, 580, 600, 620, 640, 660, 680, 700, 720, 740, 760, 780, 800, 820, 840, 860, 880, 900]);
    expect(starts(250, 100, 0)).toEqual([0, 100, 150]);
    expect(starts(80, 100, 0.8)).toEqual([0]);
  });

  it("builds rows of overlapping windows and finds the overlap again", () => {
    const m = createMode(1000, 600, 400, 300, 0.5);
    expect(m.x_steps * m.y_steps).toBe(Object.keys(m.screening_tiles).length);
    expect(m.screening_tiles["1"].x_min - m.screening_tiles["0"].x_min).toBe(200);
    expect(Object.values(m.screening_tiles).every((t) => t.x_max <= 1000 && t.y_max <= 600)).toBe(true);
    expect(overlapOf(m)).toBeCloseTo(0.5, 2);
  });

  it("moves along rows and columns and stays at the border", () => {
    const m = createMode(1000, 600, 400, 300, 0.5);
    expect(moved(m, 0, "left")).toBe(0);
    expect(moved(m, 0, "up")).toBe(0);
    expect(moved(m, 0, "right")).toBe(1);
    expect(moved(m, 0, "down")).toBe(m.x_steps);
    const last = m.x_steps * m.y_steps - 1;
    expect(moved(m, last, "right")).toBe(last);
    expect(moved(m, last, "down")).toBe(last);
  });

  it("uses the keys of the old EXACT", () => {
    expect(keyMove({ key: "a" })).toEqual({ dir: "left", mark: true });
    expect(keyMove({ key: "W" })).toEqual({ dir: "up", mark: true });
    expect(keyMove({ key: "l" })).toEqual({ dir: "right", mark: false });
    expect(keyMove({ key: "k" })).toEqual({ dir: "down", mark: false });
    expect(keyMove({ key: "e" })).toBeNull();
  });

  it("finds the window of a point and measures the covered area", () => {
    const m = createMode(1000, 600, 500, 300, 0);
    expect(tileAt(m, 700, 100)).toBe(1);
    expect(tileAt(m, 10, 400)).toBe(m.x_steps);
    expect(coverage(m, 1000, 600)).toBe(0);
    m.screening_tiles["0"].Screened = true;
    expect(coverage(m, 1000, 600)).toBeCloseTo(0.25, 1);
  });
});
