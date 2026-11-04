/**
 * What the mouse or the trackpad (and a touch screen) does in the viewer, for the help. Behaviour is in `editor.ts` (select and draw
 * tools, `legacyNavigation`), `gestures.ts` (wheel, pinch, swipe) and `MprPage`; this is what the user is told. The two variants are the
 * two settings of Preferences → Slide navigation.
 */
export type PointerKind = "mouse" | "trackpad";
export type PointerMode = "select" | "draw" | "volume";
/** The part of the device a gesture uses (highlighted in the picture). */
export type Part = "left" | "wheel" | "middle" | "tap" | "drag" | "swipe2" | "pinch";

export interface Gesture {
  part: Part;
  /** what is held or where: shown before the action */
  how: string;
  text: string;
}

export const POINTER_MODES: { id: PointerMode; title: string }[] = [
  { id: "select", title: "Viewer: selecting" },
  { id: "draw", title: "Viewer: drawing (C)" },
  { id: "volume", title: "Three planes" },
];

export const POINTER_GESTURES_TEXT: Record<PointerKind, Record<PointerMode, Gesture[]>> = {
  mouse: {
    select: [
      { part: "left", how: "Click on the background", text: "Zoom in about the pointer (Shift: zoom out)" },
      { part: "left", how: "Click on an annotation", text: "Select it (Shift, Ctrl or ⌘: add it to or take it from the selection)" },
      { part: "drag", how: "Drag on the background", text: "Move the slide" },
      { part: "drag", how: "Drag a selected annotation", text: "Move it; drag a handle to reshape it" },
      { part: "drag", how: "Ctrl or ⌘ + drag", text: "Frame annotations to select them" },
      { part: "wheel", how: "Wheel", text: "Zoom" },
      { part: "middle", how: "Middle button + drag, or Space + drag", text: "Move the slide" },
    ],
    draw: [
      { part: "left", how: "Click", text: "Place a point, a corner of a polygon, or a one-click box" },
      { part: "drag", how: "Drag", text: "Draw a box or a line; for a polygon outline it freehand" },
      { part: "left", how: "Double click", text: "Finish the polygon" },
      { part: "drag", how: "Ctrl or ⌘ + drag (also Shift, Space, middle button)", text: "Move the slide while drawing" },
      { part: "wheel", how: "Wheel", text: "Zoom" },
    ],
    volume: [
      { part: "left", how: "Click in a plane", text: "Put the crosshair there; the other planes follow" },
      { part: "drag", how: "Drag with a mask tool", text: "Paint (Shift or Alt: the opposite of add / subtract)" },
      { part: "wheel", how: "Wheel", text: "Zoom (or step through the slices, as set in the top bar)" },
      { part: "wheel", how: "Shift + wheel", text: "Step through the slices (with the other setting: Ctrl + wheel zooms)" },
      { part: "wheel", how: "Alt + wheel", text: "Brush size" },
      { part: "drag", how: "Space + drag, or middle button + drag", text: "Move the plane" },
      { part: "left", how: "Ctrl or ⌘ + click", text: "Move the crosshair without painting" },
    ],
  },
  trackpad: {
    select: [
      { part: "tap", how: "Tap or click an annotation", text: "Select it (Shift, Ctrl or ⌘: add it to or take it from the selection)" },
      { part: "tap", how: "Tap the background", text: "Select nothing" },
      { part: "drag", how: "Click and drag on the background", text: "Frame annotations to select them" },
      { part: "drag", how: "Drag a selected annotation", text: "Move it; drag a handle to reshape it" },
      { part: "swipe2", how: "Two fingers, swipe", text: "Move the slide" },
      { part: "pinch", how: "Two fingers, pinch", text: "Zoom" },
      { part: "drag", how: "On a touch screen: one finger", text: "Move the slide (a pen selects and draws)" },
    ],
    draw: [
      { part: "tap", how: "Tap or click", text: "Place a point, a corner of a polygon, or a one-click box" },
      { part: "drag", how: "Click and drag", text: "Draw a box or a line; for a polygon outline it freehand" },
      { part: "tap", how: "Double tap", text: "Finish the polygon" },
      { part: "swipe2", how: "Two fingers, swipe", text: "Move the slide while drawing" },
      { part: "drag", how: "Ctrl or ⌘ + drag (also Shift, Space)", text: "Move the slide while drawing" },
      { part: "pinch", how: "Two fingers, pinch", text: "Zoom" },
      { part: "drag", how: "On a touch screen: one finger", text: "Move the slide (the pen draws)" },
    ],
    volume: [
      { part: "tap", how: "Tap or click in a plane", text: "Put the crosshair there; the other planes follow" },
      { part: "drag", how: "Drag with a mask tool", text: "Paint (Shift or Alt: the opposite of add / subtract)" },
      { part: "swipe2", how: "Two fingers, swipe", text: "Move the plane" },
      { part: "pinch", how: "Two fingers, pinch", text: "Zoom" },
      { part: "drag", how: "Space + drag", text: "Move the plane with the mouse or pen" },
      { part: "tap", how: "Ctrl or ⌘ + click", text: "Move the crosshair without painting" },
    ],
  },
};
