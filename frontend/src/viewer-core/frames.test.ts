import { describe, expect, it } from "vitest";
import { keepFrame, visibleOnFrame, withFrame } from "./frames";

describe("annotation frames", () => {
  it("shows an annotation on its own frame only", () => {
    expect(visibleOnFrame({ frame: 3 }, false, 3)).toBe(true);
    expect(visibleOnFrame({ frame: 3 }, false, 4)).toBe(false);
  });
  it("shows annotations of multi frame types on every frame, and ones without a frame everywhere", () => {
    expect(visibleOnFrame({ frame: 3 }, true, 9)).toBe(true);
    expect(visibleOnFrame({}, false, 9)).toBe(true);
    expect(visibleOnFrame(null, false, 9)).toBe(true);
  });
  it("stamps new vectors with the frame and leaves vectors of single images alone", () => {
    expect(withFrame({ x1: 1, y1: 2 }, 5)).toEqual({ x1: 1, y1: 2, frame: 5 });
    expect(withFrame({ x1: 1 }, null)).toEqual({ x1: 1 });
  });
  it("keeps the frame of an annotation that is edited", () => {
    expect(keepFrame({ x1: 9 }, { frame: 4 })).toEqual({ x1: 9, frame: 4 });
    expect(keepFrame({ x1: 9 }, { })).toEqual({ x1: 9 });
    expect(keepFrame({ x1: 9, frame: 2 }, { frame: 4 })).toEqual({ x1: 9, frame: 2 });
  });
});
