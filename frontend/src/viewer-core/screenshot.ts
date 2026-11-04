import type OpenSeadragon from "openseadragon";

/**
 * The view as a PNG: the tiles and everything drawn over them (annotations, masks, pen strokes, overlays) as they are on the screen,
 * with the brightness / gamma of the image adjustments. The overview map and the controls are left out.
 */
export async function takeScreenshot(viewer: OpenSeadragon.Viewer, name: string): Promise<void> {
  const base = viewer.drawer.canvas as HTMLCanvasElement;
  const host = viewer.canvas as HTMLElement;
  const out = document.createElement("canvas");
  out.width = base.width;
  out.height = base.height;
  const ctx = out.getContext("2d");
  if (!ctx) return;
  const rect = host.getBoundingClientRect();
  const sx = base.width / rect.width;
  const sy = base.height / rect.height;
  const filter = base.style.filter;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, out.width, out.height);
  for (const c of host.querySelectorAll("canvas")) {
    if (c.closest(".navigator") || c.style.display === "none" || c.width === 0 || c.height === 0) continue;
    const r = c.getBoundingClientRect();
    ctx.save();
    if (c === base && filter) ctx.filter = filter;
    ctx.drawImage(c, (r.left - rect.left) * sx, (r.top - rect.top) * sy, r.width * sx, r.height * sy);
    ctx.restore();
  }
  const blob = await new Promise<Blob | null>((res) => out.toBlob(res, "image/png"));
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name.replace(/\.[^.]+$/, "")}_screenshot.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
