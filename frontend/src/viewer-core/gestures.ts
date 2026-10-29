/**
 * Track pad gestures. OpenSeadragon zooms on every wheel event, which makes a two-finger swipe on a track pad zoom
 * instead of move. Here a pinch (browsers send it as a wheel event with Ctrl held; Safari as gesture events) zooms about
 * the fingers, and a two-finger swipe moves the image. A mouse wheel keeps zooming. Touch screens are left to
 * OpenSeadragon (pinch and drag).
 */
import OpenSeadragon from "openseadragon";
import { classifyWheel, pinchFactor } from "./wheel";

/**
 * Gesture settings for mouse and pen. OpenSeadragon moves the image with the pointer at once only where flicking is on (touch), and lets it
 * glide after the pointer (a spring of `animationTime`) for mouse and pen, which feels late and inexact with a pen. Flicking is switched on
 * for the direct movement and made unreachable (a speed no hand reaches), so that the image does not fly on after the pointer is lifted.
 * A quick pen tap must not zoom either (OpenSeadragon's default for a pen).
 */
export const POINTER_GESTURES = { clickToZoom: false, flickEnabled: true, flickMinSpeed: 1e9 };

/**
 * Installs the gestures on the viewer. `keepWheel(e)` tells events the tools use themselves (the brush size on Alt +
 * wheel); returns the function that removes them again.
 */
export function installGestures(viewer: OpenSeadragon.Viewer, keepWheel: (e: WheelEvent) => boolean): () => void {
  const el = viewer.canvas as HTMLElement;
  let lastSwipe = -Infinity;
  const zoomAt = (factor: number, clientX: number, clientY: number) => {
    const r = el.getBoundingClientRect();
    const ref = viewer.viewport.pointFromPixel(new OpenSeadragon.Point(clientX - r.left, clientY - r.top), true);
    viewer.viewport.zoomBy(factor, ref, true);
    viewer.viewport.applyConstraints(true);
  };
  const onWheel = (e: WheelEvent) => {
    if (!viewer.world.getItemCount()) return;
    const kind = classifyWheel(e, performance.now(), lastSwipe);
    if (kind === "wheel") return;
    if (kind === "pinch") {
      e.preventDefault();
      e.stopImmediatePropagation();
      zoomAt(pinchFactor(e.deltaY), e.clientX, e.clientY);
      return;
    }
    if (keepWheel(e)) return;
    lastSwipe = performance.now();
    e.preventDefault();
    e.stopImmediatePropagation();
    const d = viewer.viewport.deltaPointsFromPixels(new OpenSeadragon.Point(e.deltaX, e.deltaY), true);
    viewer.viewport.panBy(d, true);
    viewer.viewport.applyConstraints(true);
  };
  // capture phase on the canvas: runs before OpenSeadragon's own wheel handler
  el.addEventListener("wheel", onWheel, { passive: false, capture: true });

  // Safari reports a pinch on a track pad as gesture events instead
  type Gesture = Event & { scale: number; clientX: number; clientY: number };
  let last = 1;
  const start = (e: Event) => {
    e.preventDefault();
    last = 1;
  };
  const change = (e: Event) => {
    const g = e as Gesture;
    e.preventDefault();
    if (g.scale > 0) zoomAt(g.scale / last, g.clientX, g.clientY);
    last = g.scale;
  };
  el.addEventListener("gesturestart", start);
  el.addEventListener("gesturechange", change);
  return () => {
    el.removeEventListener("wheel", onWheel, { capture: true });
    el.removeEventListener("gesturestart", start);
    el.removeEventListener("gesturechange", change);
  };
}
