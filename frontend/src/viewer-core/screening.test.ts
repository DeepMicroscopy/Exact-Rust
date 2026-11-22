import { describe, expect, it } from "vitest";
import { coverage, createMode, fitView, freeBox, keyMove, moved, overlapOf, starts, tileAt } from "./screening";

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
    expect(moved(m, m.x_steps - 1, "right")).toBe(m.x_steps);
    expect(moved(m, m.x_steps, "left")).toBe(m.x_steps - 1);
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

describe("the part of the viewer that is not covered", () => {
  const view = { left: 0, top: 0, right: 1000, bottom: 600 };
  it("is the whole viewer without covers, and ignores covers outside of it", () => {
    expect(freeBox(view, [])).toEqual(view);
    expect(freeBox(view, [{ left: 1100, top: 0, right: 1200, bottom: 50 }])).toEqual(view);
  });
  it("loses the side of a cover that costs least", () => {
    // a panel at the right edge: the window is seen to the left of it
    expect(freeBox(view, [{ left: 700, top: 20, right: 990, bottom: 300 }])).toEqual({ left: 0, top: 0, right: 700, bottom: 600 });
    // a small chip in a corner costs a strip at the top
    expect(freeBox(view, [{ left: 900, top: 8, right: 990, bottom: 48 }])).toEqual({ left: 0, top: 48, right: 1000, bottom: 600 });
  });
  it("takes care of several covers", () => {
    const f = freeBox(view, [
      { left: 0, top: 0, right: 270, bottom: 600 },
      { left: 700, top: 0, right: 1000, bottom: 300 },
      { left: 400, top: 540, right: 600, bottom: 590 },
    ]);
    expect(f.left).toBe(270);
    expect(f.right).toBe(700);
    expect(f.bottom).toBe(540);
  });
});

describe("fitting a window into the free part", () => {
  it("shows the whole window, centred in the free box, as large as fits", () => {
    const free = { left: 0, top: 0, right: 700, bottom: 600 };
    const b = fitView({ x: 0.2, y: 0.1, width: 0.1, height: 0.1 }, 1000, 600, free);
    // 700 / 0.1 = 7000 px per unit is the limit by width, 600 / 0.1 = 6000 by height: height decides
    expect(b.width).toBeCloseTo(1000 / 6000);
    expect(b.height).toBeCloseTo(0.1);
    // the window's centre lies at the centre of the free box (350, 300) on screen
    expect(b.x + 350 / 6000).toBeCloseTo(0.25);
    expect(b.y + 300 / 6000).toBeCloseTo(0.15);
  });
});
