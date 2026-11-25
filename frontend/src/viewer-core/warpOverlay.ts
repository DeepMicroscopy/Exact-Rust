import OpenSeadragon from "openseadragon";
import { loadTileSource } from "./tileSource";
import { cellsInView, grow, triangleMap, type Warp } from "./warpMath";

export type { Warp } from "./warpMath";
type P = [number, number];

/**
 * The single registered image shown on top of the current one, bent through a `Warp`. A second, invisible viewer renders the part
 * of the other image that the view needs; every frame its picture is drawn through the grid, triangle by triangle, onto a canvas
 * that lies over the current image. Same interface as `RegistrationOverlay`.
 */
export class WarpedOverlay {
  private gone = false;
  private opacity: number;
  private readonly canvas = document.createElement("canvas");
  private readonly host = document.createElement("div");
  private hidden: OpenSeadragon.Viewer | null = null;
  private item: OpenSeadragon.TiledImage | null = null;
  private frame = 0;
  private readonly redraw = () => {
    if (this.frame || this.gone) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  };

  constructor(
    private readonly viewer: OpenSeadragon.Viewer,
    imageId: number,
    private readonly other: { width: number; height: number },
    private readonly warp: Warp,
    /** width of the current image: one viewport unit of `viewer` */
    private readonly currentWidth: number,
    opacity: number,
    onError: (e: Error) => void,
    private readonly onLoading: (loading: boolean) => void = () => {},
  ) {
    this.opacity = opacity;
    onLoading(true);
    // lies over the picture of the current image and under everything that is added to the viewer later (annotations, ...)
    this.canvas.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none";
    this.canvas.dataset.testid = "warped-overlay";
    this.canvas.style.opacity = String(opacity);
    const base = viewer.drawer.canvas as HTMLCanvasElement;
    base.parentNode?.insertBefore(this.canvas, base.nextSibling);
    // the invisible viewer is as large as the visible one; it has to be laid out for OpenSeadragon, but is out of sight
    this.host.style.cssText = "position:fixed;left:-20000px;top:0;pointer-events:none";
    document.body.appendChild(this.host);
    this.fitHost();
    loadTileSource(imageId, 0, 0)
      .then((tileSource) => {
        if (this.gone) return;
        const hidden = new OpenSeadragon.Viewer({ element: this.host, prefixUrl: "", showNavigationControl: false, showNavigator: false, animationTime: 0, mouseNavEnabled: false, immediateRender: false, maxZoomPixelRatio: 8, minZoomImageRatio: 0.001, visibilityRatio: 0 });
        this.hidden = hidden;
        hidden.addTiledImage({
          tileSource: tileSource as OpenSeadragon.TileSourceOptions,
          success: (ev: unknown) => {
            if (this.gone) return;
            this.item = (ev as { item: OpenSeadragon.TiledImage }).item;
            hidden.addHandler("update-viewport", this.redraw);
            this.redraw();
          },
          error: () => {
            onLoading(false);
            onError(new Error("Cannot load the overlay image"));
          },
        });
      })
      .catch((e: Error) => {
        onLoading(false);
        onError(e);
      });
    viewer.addHandler("update-viewport", this.redraw);
    viewer.addHandler("resize", this.onResize);
  }

  private readonly onResize = () => {
    this.fitHost();
    this.redraw();
  };

  private fitHost() {
    const el = this.viewer.element;
    this.host.style.width = `${el.clientWidth}px`;
    this.host.style.height = `${el.clientHeight}px`;
    (this.hidden as unknown as { forceResize?: () => void } | null)?.forceResize?.();
  }

  setOpacity(v: number) {
    this.opacity = v;
    this.canvas.style.opacity = String(v);
    this.redraw();
  }

  private draw() {
    const hidden = this.hidden;
    const item = this.item;
    if (this.gone || !hidden || !item) return;
    const ctx = this.canvas.getContext("2d");
    const base = this.viewer.drawer.canvas as HTMLCanvasElement;
    if (!ctx) return;
    if (this.canvas.width !== base.width || this.canvas.height !== base.height) {
      this.canvas.width = base.width;
      this.canvas.height = base.height;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (this.opacity <= 0) {
      this.onLoading(false); // nothing is drawn, so nothing is loaded
      return;
    }
    const el = this.viewer.element;
    const k = base.width / (el.clientWidth || 1);
    // current image pixels -> pixels of the canvas, from where three points of the viewport are on the screen
    const vp = this.viewer.viewport;
    const o = vp.pixelFromPoint(new OpenSeadragon.Point(0, 0), true);
    const ex = vp.pixelFromPoint(new OpenSeadragon.Point(1, 0), true);
    const ey = vp.pixelFromPoint(new OpenSeadragon.Point(0, 1), true);
    const cw = this.currentWidth;
    const toScreen = ([x, y]: P): P => [(o.x + ((ex.x - o.x) * x) / cw + ((ey.x - o.x) * y) / cw) * k, (o.y + ((ex.y - o.y) * x) / cw + ((ey.y - o.y) * y) / cw) * k];
    const { cells, box } = cellsInView(this.warp, toScreen, this.canvas.width, this.canvas.height);
    if (!cells.length || !box) {
      this.onLoading(false);
      return;
    }
    // the invisible viewer shows the box of the other image that these cells come from, drawn now (not in its next frame)
    const ow = this.other.width;
    const margin = 0.5 / Math.max(el.clientWidth, 1);
    hidden.viewport.fitBounds(new OpenSeadragon.Rect(box.x1 / ow - margin, box.y1 / ow - margin, (box.x2 - box.x1) / ow + 2 * margin, (box.y2 - box.y1) / ow + 2 * margin), true);
    (hidden as unknown as { imageLoader: { clear(): void } }).imageLoader.clear();
    hidden.drawer.clear();
    hidden.world.draw();
    const tex = hidden.drawer.canvas as HTMLCanvasElement;
    const hk = tex.width / (this.host.clientWidth || 1);
    const hv = hidden.viewport;
    const ho = hv.pixelFromPoint(new OpenSeadragon.Point(0, 0), true);
    const hx = hv.pixelFromPoint(new OpenSeadragon.Point(1, 0), true);
    const hy = hv.pixelFromPoint(new OpenSeadragon.Point(0, 1), true);
    // other image pixels -> pixels of the texture
    const toTex = ([x, y]: P): P => [(ho.x + ((hx.x - ho.x) * x) / ow + ((hy.x - ho.x) * y) / ow) * hk, (ho.y + ((hx.y - ho.y) * x) / ow + ((hy.y - ho.y) * y) / ow) * hk];
    const w = this.warp;
    for (const [i, j] of cells) {
      const s = [
        [w.xs[j], w.ys[i]],
        [w.xs[j + 1], w.ys[i]],
        [w.xs[j], w.ys[i + 1]],
        [w.xs[j + 1], w.ys[i + 1]],
      ] as P[];
      const d = [w.dst[i][j], w.dst[i][j + 1], w.dst[i + 1][j], w.dst[i + 1][j + 1]].map(toScreen) as P[];
      const t = s.map(toTex) as P[];
      for (const idx of [
        [0, 1, 2],
        [1, 3, 2],
      ]) {
        const tri = idx.map((n) => d[n]) as [P, P, P];
        const src = idx.map((n) => t[n]) as [P, P, P];
        const m = triangleMap(src, tri);
        if (!m) continue;
        const g = grow(tri, 0.6);
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(g[0][0], g[0][1]);
        ctx.lineTo(g[1][0], g[1][1]);
        ctx.lineTo(g[2][0], g[2][1]);
        ctx.closePath();
        ctx.clip();
        ctx.setTransform(...m);
        const x1 = Math.max(0, Math.floor(Math.min(...src.map((p) => p[0]))) - 2);
        const y1 = Math.max(0, Math.floor(Math.min(...src.map((p) => p[1]))) - 2);
        const x2 = Math.min(tex.width, Math.ceil(Math.max(...src.map((p) => p[0]))) + 2);
        const y2 = Math.min(tex.height, Math.ceil(Math.max(...src.map((p) => p[1]))) + 2);
        if (x2 > x1 && y2 > y1) ctx.drawImage(tex, x1, y1, x2 - x1, y2 - y1, x1, y1, x2 - x1, y2 - y1);
        ctx.restore();
      }
    }
    if (item.getFullyLoaded()) this.onLoading(false);
  }

  destroy() {
    this.gone = true;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.viewer.removeHandler("update-viewport", this.redraw);
    this.viewer.removeHandler("resize", this.onResize);
    this.canvas.remove();
    this.hidden?.destroy();
    this.hidden = null;
    this.host.remove();
  }
}
