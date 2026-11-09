import { describe, expect, it } from "vitest";
import { darker } from "./shade";

describe("darker", () => {
  it("halves every channel", () => {
    expect(darker("#cc3366")).toBe("#661a33");
    expect(darker("#ffffff", 0.25)).toBe("#404040");
  });
  it("keeps black black and copes with bad input", () => {
    expect(darker("#000000")).toBe("#000000");
    expect(darker("nonsense")).toBe("#000000");
  });
});
