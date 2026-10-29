/**
 * Pointer log for devices that cannot be inspected from outside (an iPad with a pen): open an image with `?pointerdebug` in the URL
 * and the last events of the browser and of OpenSeadragon show at the bottom left, to be photographed or screenshotted after a
 * drag. Nothing is installed without the parameter.
 */
import type OpenSeadragon from "openseadragon";

const ptr = (e: PointerEvent) => `${e.pointerType} #${e.pointerId} b${e.buttons} p${e.pressure.toFixed(2)}`;

export function installPointerDebug(viewer: OpenSeadragon.Viewer): () => void {
  if (!new URLSearchParams(window.location.search).has("pointerdebug")) return () => {};
  const box = document.createElement("pre");
  box.style.cssText = "position:fixed;left:6px;bottom:6px;z-index:99999;margin:0;padding:6px 8px;max-width:70vw;max-height:45vh;overflow:hidden;font:11px/1.25 ui-monospace,monospace;color:#cfc;background:rgba(0,0,0,.78);border-radius:6px;pointer-events:none;white-space:pre-wrap";
  document.body.appendChild(box);
  const lines: { text: string; n: number }[] = [];
  const log = (text: string) => {
    const last = lines[lines.length - 1];
    if (last && last.text === text) last.n++;
    else lines.push({ text, n: 1 });
    if (lines.length > 28) lines.shift();
    box.textContent = lines.map((l) => (l.n > 1 ? `${l.text} x${l.n}` : l.text)).join("\n");
  };
  const target = (e: Event) => {
    const t = e.target as HTMLElement | null;
    return t ? `${t.tagName.toLowerCase()}${t.className && typeof t.className === "string" ? "." + t.className.split(" ")[0] : ""}` : "?";
  };
  const w = window as unknown as { __ptrlog?: (s: string) => void };
  w.__ptrlog = log;
  const pe = (e: Event) => log(`${e.type} ${ptr(e as PointerEvent)} ${target(e)}${e.defaultPrevented ? " (prevented)" : ""}`);
  const types = ["pointerdown", "pointermove", "pointerup", "pointercancel", "gotpointercapture", "lostpointercapture"];
  types.forEach((t) => window.addEventListener(t, pe, true));
  const te = (e: Event) => log(`${e.type} touches=${(e as TouchEvent).touches.length}${(e as TouchEvent).touches[0] ? ` type=${(e as unknown as { touches: { touchType?: string }[] }).touches[0].touchType ?? "?"}` : ""}${e.cancelable ? "" : " (not cancelable)"}`);
  const touches = ["touchstart", "touchend", "touchcancel"];
  touches.forEach((t) => window.addEventListener(t, te, true));
  const osd = ["canvas-press", "canvas-drag", "canvas-release", "canvas-click", "canvas-pinch", "canvas-nonprimary-press"] as const;
  const handlers = osd.map((name) => {
    const h = (e: unknown) => {
      const x = e as { pointerType?: string; quick?: boolean; position?: { x: number; y: number } };
      log(`OSD ${name} ${x.pointerType ?? ""}${x.quick !== undefined ? ` quick=${x.quick}` : ""}${x.position ? ` @${Math.round(x.position.x)},${Math.round(x.position.y)}` : ""}`);
    };
    (viewer as unknown as { addHandler: (n: string, f: (e: unknown) => void) => void }).addHandler(name, h);
    return [name, h] as const;
  });
  log(`pointer log on; touch-action of the canvas: ${getComputedStyle(viewer.canvas as HTMLElement).touchAction}`);
  return () => {
    types.forEach((t) => window.removeEventListener(t, pe, true));
    touches.forEach((t) => window.removeEventListener(t, te, true));
    handlers.forEach(([n, h]) => (viewer as unknown as { removeHandler: (n: string, f: (e: unknown) => void) => void }).removeHandler(n, h));
    delete w.__ptrlog;
    box.remove();
  };
}
