/** How far the + / − keys (and the buttons of the zoom slider) zoom with one press: a personal setting in three steps. */
export type ZoomStep = "low" | "medium" | "high";

/** Zoom factor of one press for each step ("low" is what the viewer always did: 1.25). */
export const ZOOM_STEP_FACTOR: Record<ZoomStep, number> = { low: 1.25, medium: 1.5, high: 2 };

/** The factor for a press that zooms in (`zoomIn`) or out with the chosen step; an unknown step counts as "low". */
export function zoomFactor(step: string | undefined, zoomIn: boolean): number {
  const f = ZOOM_STEP_FACTOR[step as ZoomStep] ?? ZOOM_STEP_FACTOR.low;
  return zoomIn ? f : 1 / f;
}
