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


/** After this long without a wheel event what has been added up so far is forgotten. */
export const STEP_IDLE_MS = 250;

/**
 * Turns wheel events into whole slices: a notch of a wheel (about 100 pixels) is one slice, finer events add up. What is left over
 * is forgotten after a pause and when the direction turns, so that two small scrolls long apart do not add up to a slice nobody asked for.
 */
export class WheelStepper {
  private rest = 0;
  private last = -Infinity;

  push(e: Pick<WheelEvent, "deltaY" | "deltaMode">, now: number): number {
    const dy = e.deltaMode === 0 ? e.deltaY : Math.sign(e.deltaY) * 100;
    if (now - this.last > STEP_IDLE_MS || Math.sign(dy) * Math.sign(this.rest) < 0) this.rest = 0;
    this.last = now;
    this.rest += dy;
    const d = Math.trunc(this.rest / 100);
    this.rest -= d * 100;
    return d === 0 ? 0 : d;
  }
}
