/**
 * The keys of the application as the help (`?`) shows them. Behaviour lives in `shortcuts.ts` (viewer), `GlobalShortcuts` (everywhere),
 * the pages and `MprPage` (three planes); this table is what is told to the user, so a change of a key is made in both places.
 */
export type Scope = "everywhere" | "lists" | "viewer" | "volume";

export interface Shortcut {
  keys: string;
  text: string;
  scope: Scope;
}

export const SCOPE_TITLE: Record<Scope, string> = {
  everywhere: "Everywhere",
  lists: "Image sets and images",
  viewer: "Viewer (one image)",
  volume: "Three planes (volumes)",
};

export const SHORTCUTS: Shortcut[] = [
  { scope: "everywhere", keys: "?", text: "Show this list" },
  { scope: "everywhere", keys: "G then P", text: "Open the preferences" },
  { scope: "everywhere", keys: "/  or  Ctrl/Cmd + F", text: "Go to the search field of the page (Esc inside it clears it)" },

  { scope: "lists", keys: "Esc", text: "Close a dialog or a menu" },

  { scope: "viewer", keys: "E / Q", text: "Next / previous image of the set" },
  { scope: "viewer", keys: "/  or  Ctrl/Cmd + F", text: "Find another image of the set by name (Up / Down, Enter opens)" },
  { scope: "viewer", keys: "Shift + E / Shift + Q, Page Up / Page Down", text: "Next / previous frame (stacks, time series)" },
  { scope: "viewer", keys: "Space", text: "Play / pause a movie" },
  { scope: "viewer", keys: "Arrows, + / −, Shift + ↑ / ↓, 0", text: "Move, zoom in / out, fit the slide" },
  { scope: "viewer", keys: "1 … 9", text: "Choose the annotation type (selected annotation: change its type)" },
  { scope: "viewer", keys: "Shift + 1 … 9", text: "Set the type of the whole image (global annotation)" },
  { scope: "viewer", keys: "C", text: "Switch between selecting and drawing" },
  { scope: "viewer", keys: "A", text: "One-click mode: every click places an annotation of the fixed size" },
  { scope: "viewer", keys: "Enter  or  V", text: "Finish the annotation" },
  { scope: "viewer", keys: "Esc", text: "Cancel" },
  { scope: "viewer", keys: "Delete, Backspace  or  X", text: "Delete the selection" },
  { scope: "viewer", keys: "D", text: "Polygon: split along a line (knife)" },
  { scope: "viewer", keys: ", / .", text: "Smaller / larger brush (polygon brush, pen brush, mask tool)" },
  { scope: "viewer", keys: "Y", text: "Show / hide the annotations" },
  { scope: "viewer", keys: "O", text: "Overlay image on / off (when one is chosen)" },
  { scope: "viewer", keys: "H", text: "Hide / show the overview map" },
  { scope: "viewer", keys: "W A S D", text: "Screening mode: step up / left / down / right and count the window you leave as screened (they replace the tool keys while the panel is open)" },
  { scope: "viewer", keys: "I J K L", text: "Screening mode: step up / left / down / right without counting" },
  { scope: "viewer", keys: "Ctrl/Cmd + Z, Ctrl/Cmd + Y (or + Shift + Z)", text: "Undo / redo" },
  { scope: "viewer", keys: "Ctrl/Cmd + drag", text: "While drawing: move the slide (a click with it places nothing). While selecting: frame annotations to select them" },
  { scope: "viewer", keys: "Ctrl/Cmd + A / C / V", text: "Select all / copy / paste annotations" },

  { scope: "volume", keys: "↑ / ↓", text: "Next / previous slice of the axial plane (of the maximized plane, when one is)" },
  { scope: "volume", keys: "Shift + ↑ / ↓", text: "Next / previous slice of the coronal plane" },
  { scope: "volume", keys: "Alt + ↑ / ↓", text: "Next / previous slice of the sagittal plane" },
  { scope: "volume", keys: "Page Up / Page Down", text: "Next / previous slice of the plane used last" },
  { scope: "volume", keys: "E / Q", text: "Next / previous image of the set" },
  { scope: "volume", keys: "/  or  Ctrl/Cmd + F", text: "Find another image of the set by name" },
  { scope: "volume", keys: "O", text: "Linked segmentation files on / off" },
  { scope: "volume", keys: "B / L / W", text: "Mask tools: brush / lasso / wand" },
  { scope: "volume", keys: "Space", text: "Mask tools: switch between adding and subtracting (hold Space and drag to move the plane)" },
  { scope: "volume", keys: ", / .", text: "Mask tools: smaller / larger brush" },
  { scope: "volume", keys: "Shift or Alt (held)", text: "Mask tools: do the opposite of the chosen add / subtract" },
  { scope: "volume", keys: "Ctrl/Cmd + Z, Ctrl/Cmd + Y", text: "Mask tools: undo / redo" },
  { scope: "volume", keys: "Esc", text: "Mask tools: close" },
];

/** What the page shows first: the keys of the page, then the rest. */
export function scopeOf(pathname: string): Scope {
  if (/^\/images\/\d+\/planes/.test(pathname)) return "volume";
  if (/^\/images\//.test(pathname)) return "viewer";
  return "lists";
}
