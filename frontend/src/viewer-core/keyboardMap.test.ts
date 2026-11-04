import { describe, expect, it } from "vitest";
import { BINDINGS, resolve } from "./keyboardMap";
import { matchShortcut } from "./shortcuts";

const ev = (key: string, code: string, extra = {}) => ({ key, code, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...extra });

describe("the keyboard help", () => {
  it("shows only keys of the viewer that the viewer reacts to", () => {
    // handled elsewhere: frames by Page Up / Down (ViewerPage), the help, the search, G then P (GlobalShortcuts), the screening keys (ScreeningPanel)
    const elsewhere = new Set(["c:PageUp", "c:PageDown", "k:?", "k:/", "k:p", "k:f", "k:w", "k:i", "k:j", "k:k", "k:l"]);
    for (const [k, v] of Object.entries(BINDINGS.viewer.none)) {
      if (elsewhere.has(k) || v.kind === "help") continue;
      const [type, id] = [k[0], k.slice(2)];
      const named: Record<string, string> = { Space: " ", Comma: ",", Period: "." };
      const e = type === "c" ? ev(id.startsWith("Digit") ? id.slice(5) : (named[id] ?? id), id) : ev(id, `Key${id.toUpperCase()}`);
      expect(matchShortcut(e), k).not.toBeNull();
    }
  });

  it("puts the same character on different keys of the two layouts", () => {
    const find = (layout: "en" | "de", label: string) => resolve(layout, "viewer", "ctrl").flat().find((r) => r.legend === label && r.binding);
    expect(find("en", "Z")?.cap.code).toBe("KeyZ");
    expect(find("de", "Z")?.cap.code).toBe("KeyY"); // Undo is where the German keyboard has its Z
    expect(find("en", "Z")?.binding?.label).toBe("Undo");
  });

  it("finds the question mark and the slash where each layout makes them", () => {
    const en = resolve("en", "viewer", "none").flat();
    const de = resolve("de", "viewer", "none").flat();
    expect(en.find((r) => r.cap.code === "Slash")?.binding?.label).toBe("Search");
    expect(de.find((r) => r.cap.code === "Digit7")?.binding?.label).toBe("Type 7"); // the digit wins on its own key
    expect(de.find((r) => r.cap.code === "Digit7")?.viaShift).toBe(false);
    expect(de.find((r) => r.cap.code === "Minus")?.binding?.label).toBe("Help"); // ß, Shift gives ?
  });

  it("keeps the brush size on comma and period in both layouts", () => {
    for (const l of ["en", "de"] as const) {
      const r = resolve(l, "viewer", "none").flat();
      expect(r.find((x) => x.cap.code === "Comma")?.binding?.label).toBe("Brush −");
      expect(r.find((x) => x.cap.code === "Period")?.binding?.label).toBe("Brush +");
    }
  });
});
