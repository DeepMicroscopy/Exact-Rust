import { describe, expect, it } from "vitest";
import { matchShortcut } from "./shortcuts";

const key = (key: string, extra: Partial<Parameters<typeof matchShortcut>[0]> = {}) =>
  matchShortcut({ key, code: extra.code ?? (key.length === 1 && /\d/.test(key) ? `Digit${key}` : `Key${key.toUpperCase()}`), shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...extra });

describe("shortcuts of the old UI", () => {
  it("finish: Enter and V (R is gone), cancel: Escape, delete: Delete, Backspace, X", () => {
    expect(key("Enter")).toEqual({ type: "finish" });
    expect(key("v")).toEqual({ type: "finish" });
    expect(key("r")).toBeNull();
    expect(key("f")).toBeNull(); // verify image is gone, so is OpenSeadragon's flip (its keys are switched off)
    expect(key("Escape")).toEqual({ type: "cancel" });
    for (const k of ["Delete", "Backspace", "x", "X"]) expect(key(k)).toEqual({ type: "delete" });
  });
  it("digits choose the annotation type, with Shift the global one, also on the numpad", () => {
    expect(key("3")).toEqual({ type: "digit", n: 3, shift: false });
    expect(key("!", { code: "Digit1", shiftKey: true })).toEqual({ type: "digit", n: 1, shift: true });
    expect(matchShortcut({ key: "7", code: "Numpad7", shiftKey: false, ctrlKey: false, metaKey: false, altKey: false })).toEqual({ type: "digit", n: 7, shift: false });
    expect(key("0")).toEqual({ type: "home" });
  });
  it("C, Y, A toggle drawing, annotations, one-click mode", () => {
    expect(key("c")).toEqual({ type: "toggleDrawing" });
    expect(key("Y")).toEqual({ type: "toggleAnnotations" });
    expect(key("a")).toEqual({ type: "toggleOneClick" });
  });
  it("D is the knife; S and G (scissors, glue of the old UI) are free", () => {
    expect(key("d")).toEqual({ type: "polyOp", op: "knife" });
    expect(key("s")).toBeNull();
    expect(key("g")).toBeNull();
    expect(key("s", { ctrlKey: true })).toBeNull(); // Ctrl+S belongs to the browser
  });
  it("Ctrl/Cmd+Z undoes only with the modifier (the old Z fall-through to the heatmap is gone)", () => {
    expect(key("z")).toBeNull();
    expect(key("z", { ctrlKey: true })).toEqual({ type: "undo" });
    expect(key("z", { metaKey: true })).toEqual({ type: "undo" });
    expect(key("z", { ctrlKey: true, shiftKey: true })).toEqual({ type: "redo" });
    expect(key("y", { ctrlKey: true })).toEqual({ type: "redo" });
  });
  it("E / Q move through images, with Shift through frames", () => {
    expect(key("e")).toEqual({ type: "nextImage" });
    expect(key("q")).toEqual({ type: "prevImage" });
    expect(key("E", { shiftKey: true })).toEqual({ type: "nextFrame" });
    expect(key("Q", { shiftKey: true })).toEqual({ type: "prevFrame" });
  });
  it("the navigation keys OpenSeadragon had are kept: arrows, Shift+arrows, + -, 0", () => {
    expect(key("ArrowLeft")).toEqual({ type: "pan", dx: -1, dy: 0 });
    expect(key("ArrowUp", { shiftKey: true })).toEqual({ type: "zoom", factor: 1.25 });
    expect(key("-")).toEqual({ type: "zoom", factor: 0.8 });
    expect(key("=")).toEqual({ type: "zoom", factor: 1.25 });
  });
  it("Space plays and pauses", () => {
    expect(key(" ", { code: "Space" })).toEqual({ type: "play" });
  });
  it("Alt combinations belong to the browser", () => {
    expect(key("c", { altKey: true })).toBeNull();
  });

  it("Ctrl/Cmd+A, C and V select all, copy and paste", () => {
    expect(key("a", { ctrlKey: true })).toEqual({ type: "selectAll" });
    expect(key("c", { metaKey: true })).toEqual({ type: "copy" });
    expect(key("v", { ctrlKey: true })).toEqual({ type: "paste" });
    expect(key("c")).toEqual({ type: "toggleDrawing" }); // plain C is still the draw toggle
  });

  it("O and H switch the overlay and the overview", () => {
    expect(key("o")).toEqual({ type: "overlay" });
    expect(key("h")).toEqual({ type: "overview" });
  });

  it("the brush size is on , and . by position, so that English and German keyboards agree", () => {
    expect(key(",", { code: "Comma" })).toEqual({ type: "brushSize", dir: -1 });
    expect(key(".", { code: "Period" })).toEqual({ type: "brushSize", dir: 1 });
    expect(key(";", { code: "Comma", shiftKey: true })).toBeNull(); // Shift + , is ";" on both
    expect(key("[", { code: "BracketLeft" })).toBeNull();
  });
});
