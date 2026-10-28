import { beforeEach, describe, expect, it } from "vitest";
import { isHovering, pen } from "./pen";

describe("pen", () => {
  beforeEach(() => {
    pen.setOnly(true);
  });
  it("lets fingers draw until a pen was seen, then only move the image", () => {
    expect(pen.ignores("touch")).toBe(false);
    pen.note({ pointerType: "mouse" });
    expect(pen.seen).toBe(false);
    pen.note({ pointerType: "pen" });
    expect(pen.seen).toBe(true);
    expect(pen.ignores("touch")).toBe(true);
    expect(pen.ignores("pen")).toBe(false);
    expect(pen.ignores("mouse")).toBe(false);
  });
  it("can be switched off", () => {
    pen.note({ pointerType: "pen" });
    pen.setOnly(false);
    expect(pen.ignores("touch")).toBe(false);
  });
  it("tells a hovering pen from one touching", () => {
    expect(isHovering({ pointerType: "pen", buttons: 0, pressure: 0 })).toBe(true);
    expect(isHovering({ pointerType: "pen", buttons: 1, pressure: 0.4 })).toBe(false);
    expect(isHovering({ pointerType: "mouse", buttons: 0, pressure: 0 })).toBe(false);
  });
});
