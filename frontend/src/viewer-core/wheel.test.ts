import { describe, expect, it } from "vitest";
import { classifyWheel, pinchFactor, WheelStepper } from "./wheel";

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

describe("WheelStepper", () => {
  const ev = (deltaY: number, deltaMode = 0) => ({ deltaY, deltaMode });

  it("steps one slice per notch and adds fine events up", () => {
    const s = new WheelStepper();
    expect(s.push(ev(100), 0)).toBe(1);
    expect(s.push(ev(-100), 50)).toBe(-1);
    let n = 0;
    for (let i = 0; i < 30; i++) n += s.push(ev(4), 100 + i * 10);
    expect(n).toBe(1);
    expect(s.push(ev(1, 1), 1000)).toBe(1); // line mode: one line is one notch
  });

  it("forgets what is left over after a pause and when the direction turns", () => {
    const s = new WheelStepper();
    let n = 0;
    for (let i = 0; i < 4; i++) n += s.push(ev(30), i * 1500);
    expect(n).toBe(0);
    expect(s.push(ev(60), 6000)).toBe(0);
    expect(s.push(ev(-60), 6050)).toBe(0);
    // the 60 from before the turn are gone: 60 + 40 in the new direction make a notch (not 40, which 60 - 60 + ... would leave)
    expect(s.push(ev(-40), 6100)).toBe(-1);
  });
});
