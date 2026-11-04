/**
 * Keyboard shortcuts of the viewer. The table is the one of the old UI (docs/old-ui-shortcuts.md) minus what was dropped:
 * the heatmap, R (finish, also OpenSeadragon's rotate) and F (verify image, also its flip). Matching is a pure function of
 * the key event, so it is tested without a browser.
 */
export type Action =
  | { type: "finish" }
  | { type: "cancel" }
  | { type: "delete" }
  | { type: "digit"; n: number; shift: boolean } // 1..9: annotation type (selected annotation: change class); shift: global type
  | { type: "toggleDrawing" } // C (old: annotation mode): between selecting and drawing the current type
  | { type: "toggleAnnotations" } // Y
  | { type: "toggleOneClick" } // A (new): every click places an annotation of the type's size
  | { type: "polyOp"; op: "knife" } // D: split the selected polygon along a line
  | { type: "play" } // Space: play / pause a movie
  | { type: "selectAll" } // Ctrl+A
  | { type: "copy" } // Ctrl+C
  | { type: "paste" } // Ctrl+V
  | { type: "undo" }
  | { type: "redo" }
  | { type: "nextImage" } // E
  | { type: "prevImage" } // Q
  | { type: "nextFrame" } // Shift+E
  | { type: "prevFrame" } // Shift+Q
  | { type: "pan"; dx: number; dy: number }
  | { type: "zoom"; factor: number }
  | { type: "home" }
  | { type: "overlay" } // O: the registered overlay image on / off
  | { type: "overview" } // H: hide / show the overview map
  | { type: "brushSize"; dir: 1 | -1 }; // , and . (the same keys on English and German keyboards)

type KeyLike = Pick<KeyboardEvent, "key" | "code" | "shiftKey" | "ctrlKey" | "metaKey" | "altKey">;

export function matchShortcut(e: KeyLike): Action | null {
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (e.altKey) return null;
  if (mod) {
    if (k === "z") return e.shiftKey ? { type: "redo" } : { type: "undo" };
    if (k === "y") return { type: "redo" };
    if (k === "a") return { type: "selectAll" };
    if (k === "c") return { type: "copy" };
    if (k === "v") return { type: "paste" };
    return null;
  }
  // by position: "," and "." are on the same keys of English and German keyboards, "[" and "]" are not
  if (!e.shiftKey && e.code === "Comma") return { type: "brushSize", dir: -1 };
  if (!e.shiftKey && e.code === "Period") return { type: "brushSize", dir: 1 };
  const digit = /^Digit([1-9])$|^Numpad([1-9])$/.exec(e.code ?? "");
  if (digit) return { type: "digit", n: Number(digit[1] ?? digit[2]), shift: e.shiftKey };
  switch (k) {
    case "Enter":
    case "v":
      return e.shiftKey ? null : { type: "finish" };
    case "Escape":
      return { type: "cancel" };
    case " ":
      return e.shiftKey ? null : { type: "play" };
    case "Delete":
    case "Backspace":
    case "x":
      return { type: "delete" };
    case "c":
      return { type: "toggleDrawing" };
    case "y":
      return { type: "toggleAnnotations" };
    case "a":
      return { type: "toggleOneClick" };
    case "d":
      return { type: "polyOp", op: "knife" };
    case "e":
      return e.shiftKey ? { type: "nextFrame" } : { type: "nextImage" };
    case "q":
      return e.shiftKey ? { type: "prevFrame" } : { type: "prevImage" };
    case "ArrowLeft":
      return { type: "pan", dx: -1, dy: 0 };
    case "ArrowRight":
      return { type: "pan", dx: 1, dy: 0 };
    case "ArrowUp":
      return e.shiftKey ? { type: "zoom", factor: 1.25 } : { type: "pan", dx: 0, dy: -1 };
    case "ArrowDown":
      return e.shiftKey ? { type: "zoom", factor: 0.8 } : { type: "pan", dx: 0, dy: 1 };
    case "=":
    case "+":
      return { type: "zoom", factor: 1.25 };
    case "-":
      return { type: "zoom", factor: 0.8 };
    case "0":
      return { type: "home" };
    case "o":
      return { type: "overlay" };
    case "h":
      return { type: "overview" };
  }
  return null;
}

/** Keys that must reach text fields untouched. */
export function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
  if (el.tagName === "INPUT") return !["range", "checkbox", "radio", "button"].includes((el as HTMLInputElement).type);
  return false;
}
