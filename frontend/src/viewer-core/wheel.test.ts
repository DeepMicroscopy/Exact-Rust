import { describe, expect, it } from "vitest";
import { classifyWheel, pinchFactor } from "./wheel";

const ev = (o: Partial<Parameters<typeof classifyWheel>[0]>) => ({ deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: false, altKey: false, ...o });

describe("classifyWheel", () => {
  it("takes Ctrl + wheel as a pinch", () => {
    expect(classifyWheel(ev({ ctrlKey: true, deltaY: -3.5 }), 0, -Infinity)).toBe("pinch");
  });
  it("keeps zooming with the steps of a mouse wheel", () => {
    expect(classifyWheel(ev({ deltaY: 100 }), 0, -Infinity)).toBe("wheel");
    expect(classifyWheel(ev({ deltaY: 3, deltaMode: 1 }), 0, -Infinity)).toBe("wheel");
  });
  it("moves with sideways or fractional deltas, and stays moving through a swipe", () => {
    expect(classifyWheel(ev({ deltaX: 4, deltaY: 10 }), 0, -Infinity)).toBe("swipe");
    expect(classifyWheel(ev({ deltaY: 7.5 }), 0, -Infinity)).toBe("swipe");
    expect(classifyWheel(ev({ deltaY: 6 }), 300, 0)).toBe("swipe");
    expect(classifyWheel(ev({ deltaY: 6 }), 2000, 0)).toBe("wheel");
  });
});

describe("pinchFactor", () => {
  it("zooms in when the fingers spread (negative delta) and is bounded", () => {
    expect(pinchFactor(-10)).toBeGreaterThan(1);
    expect(pinchFactor(10)).toBeLessThan(1);
    expect(pinchFactor(-1000)).toBeCloseTo(Math.exp(0.6));
  });
});
