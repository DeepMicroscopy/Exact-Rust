/**
 * The shortcuts laid out on a keyboard (English or German), for the help. `shortcutTable.ts` is the list, this is the same
 * information by key. Behaviour is in `shortcuts.ts`, `GlobalShortcuts`, `ScreeningPanel` and `MprPage`; a test checks that the keys
 * of the viewer shown here are keys the viewer reacts to.
 */
export type KbMode = "viewer" | "screening" | "volume" | "lists";
export type KbLayer = "none" | "shift" | "ctrl";
export type KbLayout = "en" | "de";
export type KbKind = "move" | "edit" | "tool" | "view" | "image" | "help";

export interface Binding {
  /** on the key cap */
  label: string;
  /** in the tooltip */
  text: string;
  kind: KbKind;
}

export const MODES: { id: KbMode; title: string }[] = [
  { id: "viewer", title: "Viewer" },
  { id: "screening", title: "Viewer, screening open" },
  { id: "volume", title: "Three planes" },
  { id: "lists", title: "Image sets" },
];

export const LAYERS: { id: KbLayer; title: string }[] = [
  { id: "none", title: "Plain" },
  { id: "shift", title: "Shift" },
  { id: "ctrl", title: "Ctrl / ⌘" },
];

interface Cap {
  /** `KeyboardEvent.code` */
  code: string;
  /** width in key units */
  w?: number;
  /** what is printed on the key, and with Shift, per layout */
  en?: [string, string?];
  de?: [string, string?];
  /** modifier keys and the like: never carry a binding of their own in a layer */
  mod?: boolean;
  /** a gap before the key, in key units */
  gap?: number;
}

const L = (c: string): Cap => ({ code: `Key${c}`, en: [c], de: [c] });
const D = (n: string, enShift: string, deShift: string): Cap => ({ code: `Digit${n}`, en: [n, enShift], de: [n, deShift] });

export const ROWS: Cap[][] = [
  [
    { code: "Escape", w: 1.5, en: ["Esc"], de: ["Esc"], mod: true },
    { code: "Backquote", en: ["`", "~"], de: ["^", "°"], gap: 0 },
    D("1", "!", "!"), D("2", "@", '"'), D("3", "#", "§"), D("4", "$", "$"), D("5", "%", "%"), D("6", "^", "&"), D("7", "&", "/"), D("8", "*", "("), D("9", "(", ")"), D("0", ")", "="),
    { code: "Minus", en: ["-", "_"], de: ["ß", "?"] },
    { code: "Equal", en: ["=", "+"], de: ["´", "`"] },
    { code: "Backspace", w: 1.7, en: ["⌫"], de: ["⌫"] },
  ],
  [
    { code: "Tab", w: 1.5, en: ["Tab"], de: ["Tab"], mod: true },
    L("Q"), L("W"), L("E"), L("R"), L("T"),
    { code: "KeyY", en: ["Y"], de: ["Z"] },
    L("U"), L("I"), L("O"), L("P"),
    { code: "BracketLeft", en: ["[", "{"], de: ["ü"] },
    { code: "BracketRight", en: ["]", "}"], de: ["+", "*"] },
    { code: "Enter", w: 1.7, en: ["Enter"], de: ["Enter"] },
  ],
  [
    { code: "CapsLock", w: 1.8, en: ["Caps"], de: ["Caps"], mod: true },
    L("A"), L("S"), L("D"), L("F"), L("G"), L("H"), L("J"), L("K"), L("L"),
    { code: "Semicolon", en: [";", ":"], de: ["ö"] },
    { code: "Quote", en: ["'", '"'], de: ["ä"] },
    { code: "Backslash", w: 1.4, en: ["\\", "|"], de: ["#", "'"] },
  ],
  [
    { code: "ShiftLeft", w: 1.3, en: ["Shift"], de: ["Shift"], mod: true },
    { code: "IntlBackslash", en: ["<"], de: ["<", ">"] },
    { code: "KeyZ", en: ["Z"], de: ["Y"] },
    L("X"), L("C"), L("V"), L("B"), L("N"), L("M"),
    { code: "Comma", en: [",", "<"], de: [",", ";"] },
    { code: "Period", en: [".", ">"], de: [".", ":"] },
    { code: "Slash", en: ["/", "?"], de: ["-", "_"] },
    { code: "ShiftRight", w: 2.2, en: ["Shift"], de: ["Shift"], mod: true },
  ],
  [
    { code: "ControlLeft", w: 1.3, en: ["Ctrl"], de: ["Strg"], mod: true },
    { code: "AltLeft", w: 1.2, en: ["Alt"], de: ["Alt"], mod: true },
    { code: "MetaLeft", w: 1.3, en: ["⌘"], de: ["⌘"], mod: true },
    { code: "Space", w: 5.4, en: ["Space"], de: ["Space"] },
    { code: "MetaRight", w: 1.3, en: ["⌘"], de: ["⌘"], mod: true },
    { code: "AltRight", w: 1.2, en: ["Alt"], de: ["Alt Gr"], mod: true },
    { code: "ArrowLeft", en: ["←"], de: ["←"], gap: 0.4 },
    { code: "ArrowUp", en: ["↑"], de: ["↑"] },
    { code: "ArrowDown", en: ["↓"], de: ["↓"] },
    { code: "ArrowRight", en: ["→"], de: ["→"] },
  ],
  [
    { code: "Delete", w: 1.4, en: ["Del"], de: ["Entf"] },
    { code: "PageUp", w: 1.4, en: ["PgUp"], de: ["Bild ↑"] },
    { code: "PageDown", w: 1.4, en: ["PgDn"], de: ["Bild ↓"] },
  ],
];

export type Bindings = Record<string, Binding>;

const b = (label: string, text: string, kind: KbKind): Binding => ({ label, text, kind });
/** the bound digits: `c:Digit1` ... */
const digits = (label: (n: number) => string, text: (n: number) => string, kind: KbKind): Bindings => Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`c:Digit${n}`, b(label(n), text(n), kind)]));

const everywhere: Bindings = {
  "k:?": b("Help", "Show the list of shortcuts", "help"),
  "k:/": b("Search", "Go to the search field of the page", "help"),
  "k:g": b("G·P", "G then P: open the preferences", "help"),
  "k:p": b("(G) P", "after G: open the preferences", "help"),
};

const viewerNone: Bindings = {
  ...everywhere,
  ...digits((n) => `Type ${n}`, (n) => `Choose annotation type ${n} (a selected annotation changes to it)`, "edit"),
  "k:c": b("Draw", "Switch between selecting and drawing", "tool"),
  "k:a": b("1-click", "One-click mode: every click places an annotation of the fixed size", "tool"),
  "k:v": b("Finish", "Finish the annotation", "edit"),
  "c:Enter": b("Finish", "Finish the annotation", "edit"),
  "c:Escape": b("Cancel", "Cancel", "edit"),
  "c:Delete": b("Delete", "Delete the selection", "edit"),
  "c:Backspace": b("Delete", "Delete the selection", "edit"),
  "k:x": b("Delete", "Delete the selection", "edit"),
  "k:d": b("Knife", "Polygon: split along a line", "tool"),
  "k:y": b("Show", "Show / hide the annotations", "view"),
  "k:o": b("Overlay", "Overlay image on / off", "view"),
  "k:h": b("Map", "Hide / show the overview map", "view"),
  "k:e": b("Next", "Next image of the set", "image"),
  "k:q": b("Prev", "Previous image of the set", "image"),
  "c:Space": b("Play", "Play / pause a movie", "view"),
  "c:ArrowLeft": b("Move", "Move the view", "move"),
  "c:ArrowRight": b("Move", "Move the view", "move"),
  "c:ArrowUp": b("Move", "Move the view", "move"),
  "c:ArrowDown": b("Move", "Move the view", "move"),
  "k:=": b("Zoom +", "Zoom in", "move"),
  "k:+": b("Zoom +", "Zoom in", "move"),
  "k:-": b("Zoom −", "Zoom out", "move"),
  "c:Digit0": b("Fit", "Fit the slide in the window", "move"),
  "c:Comma": b("Brush −", "Smaller brush", "tool"),
  "c:Period": b("Brush +", "Larger brush", "tool"),
  "c:PageUp": b("Frame +", "Next frame", "move"),
  "c:PageDown": b("Frame −", "Previous frame", "move"),
};

const viewerShift: Bindings = {
  ...digits((n) => `Global ${n}`, (n) => `Set type ${n} for the whole image (global annotation)`, "edit"),
  "k:e": b("Frame +", "Next frame (stacks, time series)", "move"),
  "k:q": b("Frame −", "Previous frame (stacks, time series)", "move"),
  "c:ArrowUp": b("Zoom +", "Zoom in", "move"),
  "c:ArrowDown": b("Zoom −", "Zoom out", "move"),
  "k:?": b("Help", "Show the list of shortcuts", "help"),
  "k:/": b("Search", "Go to the search field of the page", "help"),
};

const viewerCtrl: Bindings = {
  "k:z": b("Undo", "Undo (with Shift: redo)", "edit"),
  "k:y": b("Redo", "Redo", "edit"),
  "k:a": b("Select all", "Select all annotations", "edit"),
  "k:c": b("Copy", "Copy the selected annotations", "edit"),
  "k:v": b("Paste", "Paste the copied annotations", "edit"),
  "k:f": b("Find", "Find another image of the set (Ctrl/Cmd + F)", "image"),
};

const screeningNone: Bindings = {
  ...viewerNone,
  "k:w": b("Up ✓", "Screening: step up and count the window you leave as screened", "move"),
  "k:a": b("Left ✓", "Screening: step left and count the window you leave as screened", "move"),
  "k:s": b("Down ✓", "Screening: step down and count the window you leave as screened", "move"),
  "k:d": b("Right ✓", "Screening: step right and count the window you leave as screened", "move"),
  "k:i": b("Up", "Screening: step up without counting", "move"),
  "k:j": b("Left", "Screening: step left without counting", "move"),
  "k:k": b("Down", "Screening: step down without counting", "move"),
  "k:l": b("Right", "Screening: step right without counting", "move"),
};

const volumeNone: Bindings = {
  ...everywhere,
  "c:PageUp": b("Slice +", "Next slice of the active plane", "move"),
  "c:PageDown": b("Slice −", "Previous slice of the active plane", "move"),
  "c:ArrowUp": b("Slice +", "Next slice of the active plane", "move"),
  "c:ArrowDown": b("Slice −", "Previous slice of the active plane", "move"),
  "k:e": b("Next", "Next image of the set", "image"),
  "k:q": b("Prev", "Previous image of the set", "image"),
  "k:o": b("Linked", "Linked segmentation files on / off", "view"),
  "k:b": b("Brush", "Mask tools: brush", "tool"),
  "k:l": b("Lasso", "Mask tools: lasso", "tool"),
  "k:w": b("Wand", "Mask tools: wand", "tool"),
  "c:Space": b("Add/Sub", "Mask tools: switch between adding and subtracting (hold Space and drag to move a plane)", "tool"),
  "c:Comma": b("Brush −", "Mask tools: smaller brush", "tool"),
  "c:Period": b("Brush +", "Mask tools: larger brush", "tool"),
  "c:Escape": b("Close", "Mask tools: close", "edit"),
  "k:g": b("G·P", "G then P: open the preferences", "help"),
};

const volumeShift: Bindings = {
  "c:ShiftLeft": b("Invert", "Mask tools: held, does the opposite of add / subtract", "tool"),
  "c:ShiftRight": b("Invert", "Mask tools: held, does the opposite of add / subtract", "tool"),
  "k:?": b("Help", "Show the list of shortcuts", "help"),
};

const volumeCtrl: Bindings = {
  "k:z": b("Undo", "Mask tools: undo (with Shift: redo)", "edit"),
  "k:y": b("Redo", "Mask tools: redo", "edit"),
  "k:f": b("Find", "Find another image of the set (Ctrl/Cmd + F)", "image"),
};

const listsNone: Bindings = { ...everywhere, "c:Escape": b("Close", "Close a dialog or a menu; in a search field: clear it", "edit") };
const listsCtrl: Bindings = { "k:f": b("Search", "Go to the search field of the page", "help") };

export const BINDINGS: Record<KbMode, Record<KbLayer, Bindings>> = {
  viewer: { none: viewerNone, shift: viewerShift, ctrl: viewerCtrl },
  screening: { none: screeningNone, shift: viewerShift, ctrl: viewerCtrl },
  volume: { none: volumeNone, shift: volumeShift, ctrl: volumeCtrl },
  lists: { none: listsNone, shift: { "k:?": b("Help", "Show the list of shortcuts", "help") }, ctrl: listsCtrl },
};

export interface Resolved {
  cap: Cap;
  legend: string;
  shifted?: string;
  binding: Binding | null;
  /** the binding is for the character this key gives with Shift (the "?" of the English slash key) */
  viaShift: boolean;
}

/** What each key of the layout does in a mode with the chosen modifier held. */
export function resolve(layout: KbLayout, mode: KbMode, layer: KbLayer): Resolved[][] {
  const table = BINDINGS[mode][layer];
  return ROWS.map((row) =>
    row.map((cap) => {
      const [legend, shifted] = cap[layout] ?? cap.en ?? [cap.code];
      let binding: Binding | null = table[`c:${cap.code}`] ?? null;
      let viaShift = false;
      if (!binding && !cap.mod) {
        binding = table[`k:${legend.toLowerCase()}`] ?? null;
        if (!binding && shifted) {
          binding = table[`k:${shifted.toLowerCase()}`] ?? null;
          viaShift = !!binding;
        }
      }
      return { cap, legend, shifted, binding, viaShift };
    }),
  );
}
