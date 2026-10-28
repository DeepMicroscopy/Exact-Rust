/**
 * Pen (Apple Pencil, Surface pen, ...) versus finger. As soon as a pen has been used, fingers only move and zoom the image
 * (a resting palm or a second hand does not draw) while the pen draws and edits, unless "Pen only" is switched off. A pen
 * that hovers above the screen reports pointer moves with no buttons and no pressure; the editor shows where it points.
 */
import { useSyncExternalStore } from "react";

const KEY = "exact.penOnly";
const read = (): boolean => {
  try {
    return localStorage.getItem(KEY) !== "0";
  } catch {
    return true;
  }
};

const listeners = new Set<() => void>();
let state = { seen: false, only: read() };
const set = (next: Partial<typeof state>) => {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
};

export const pen = {
  /** a pen has been used in this session */
  get seen() {
    return state.seen;
  },
  get only() {
    return state.only;
  },
  setOnly(on: boolean): void {
    try {
      localStorage.setItem(KEY, on ? "1" : "0");
    } catch {
      /* private window */
    }
    set({ only: on });
  },
  /** call with every pointer event; remembers that a pen is in use */
  note(ev: Pick<PointerEvent, "pointerType">): void {
    if (ev.pointerType === "pen" && !state.seen) set({ seen: true });
  },
  /** whether a touch (finger) pointer must leave drawing and editing alone */
  ignores(pointerType: string | undefined): boolean {
    return state.seen && state.only && pointerType === "touch";
  },
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

/** A pen above the screen: pointer moves of a pen with no button down and no pressure. */
export const isHovering = (ev: Pick<PointerEvent, "pointerType" | "buttons" | "pressure">): boolean => ev.pointerType === "pen" && ev.buttons === 0 && ev.pressure === 0;

export function usePen(): { seen: boolean; only: boolean } {
  return useSyncExternalStore(
    pen.subscribe,
    () => state,
    () => state,
  );
}
