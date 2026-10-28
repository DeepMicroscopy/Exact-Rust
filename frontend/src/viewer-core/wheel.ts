/** Which kind of gesture a wheel event is (pure, so it is tested without a browser; see gestures.ts). */

export type WheelLike = Pick<WheelEvent, "deltaX" | "deltaY" | "deltaMode" | "ctrlKey" | "altKey">;

/** How long after a clear track pad event further events still count as one (a swipe pauses and fades out). */
export const HOLD_MS = 600;

export type WheelKind = "pinch" | "swipe" | "wheel";

/**
 * Decides what one wheel event is. A track pad reports pixels, sideways movement and fractional values; a wheel
 * reports vertical steps only. `lastSwipe` is the time of the last event taken for a swipe.
 */
export function classifyWheel(e: WheelLike, now: number, lastSwipe: number): WheelKind {
  if (e.ctrlKey) return "pinch";
  if (e.deltaMode !== 0) return "wheel";
  const clear = e.deltaX !== 0 || !Number.isInteger(e.deltaY);
  if (clear || now - lastSwipe < HOLD_MS) return "swipe";
  return "wheel";
}

/** Zoom factor of a pinch wheel event (Chrome, Firefox, Edge send the change of the pinch as deltaY). */
export const pinchFactor = (deltaY: number): number => Math.exp(-Math.max(-60, Math.min(60, deltaY)) * 0.01);

