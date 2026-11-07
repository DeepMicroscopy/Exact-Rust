import OpenSeadragon from "openseadragon";

/** The detections of one result entry, as `GET /api/v2/plugin-result-entries/{id}/detections` gives them. */
export interface Detections {
  id: number;
  name: string;
  default_threshold: number;
  /** `[x1, y1, x2, y2, score, annotation type]` in image pixels */
  boxes: number[][];
  polygons: { t: number; s: number; p: number[] }[];
  types: Record<string, { name: string; color: string | null }>;
  truncated: boolean;
}

export interface ResultLayerData {
  id: number;
  data: Detections;
  /** only detections with at least this score are drawn */
  threshold: number;
}

const FALLBACK = "#ff4d6d";

/** How many detections of an entry reach the threshold. */
export function countAbove(d: Detections, threshold: number): number {
  let n = 0;
  for (const b of d.boxes) if (b[4] >= threshold) n++;
  for (const p of d.polygons) if (p.s >= threshold) n++;
  return n;
}

/**
 * Canvas on top of an OpenSeadragon viewer that draws the detections of plugin results above their threshold. Boxes are culled to the
 * viewport and drawn with one stroke per colour, so that tens of thousands of detections stay fast; a box smaller than a few pixels is
 * drawn as a small square so that it can still be seen when the whole slide is in view.
 */
export class PluginResultLayer {
  private canvas: HTMLCanvasElement;
  private layers: ResultLayerData[] = [];
  private raf = 0;

  constructor(private viewer: OpenSeadragon.Viewer) {
    this.canvas = document.createElement("canvas");
    Object.assign(this.canvas.style, { position: "absolute", inset: "0", pointerEvents: "none" });
    viewer.canvas.appendChild(this.canvas);
    const redraw = () => this.schedule();
    viewer.addHandler("animation", redraw);
    viewer.addHandler("open", redraw);
    viewer.addHandler("resize", redraw);
    viewer.addHandler("update-viewport", () => {
      cancelAnimationFrame(this.raf);
      this.draw();
    });
  }

  setLayers(layers: ResultLayerData[]): void {
    this.layers = layers;
    this.schedule();
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.canvas.remove();
  }

  private schedule(): void {
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => this.draw());
  }

  private draw(): void {
    const el = this.viewer.canvas as HTMLElement;
    const dpr = window.devicePixelRatio || 1;
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (this.canvas.width !== w * dpr || this.canvas.height !== h * dpr) {
      this.canvas.width = w * dpr;
      this.canvas.height = h * dpr;
      this.canvas.style.width = `${w}px`;
      this.canvas.style.height = `${h}px`;
    }
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const item = this.viewer.world.getItemCount() ? this.viewer.world.getItemAt(0) : null;
    if (!item || !this.layers.length) return;

    // image pixels to screen pixels is a scale and a shift (the viewer neither rotates nor flips)
    const a = this.viewer.viewport.pixelFromPoint(item.imageToViewportCoordinates(0, 0), true);
    const b = this.viewer.viewport.pixelFromPoint(item.imageToViewportCoordinates(1000, 0), true);
    const k = (b.x - a.x) / 1000;
    if (!(k > 0)) return;
    const [ox, oy] = [a.x, a.y];
    const [vx0, vy0, vx1, vy1] = [(0 - ox) / k, (0 - oy) / k, (w - ox) / k, (h - oy) / k];

    for (const layer of this.layers) {
      const color = (t: number) => layer.data.types[String(t)]?.color || FALLBACK;
      // one path per colour: the dark rim underneath keeps the boxes readable on any stain
      const paths = new Map<string, Path2D>();
      const path = (c: string) => {
        let p = paths.get(c);
        if (!p) paths.set(c, (p = new Path2D()));
        return p;
      };
      for (const [x1, y1, x2, y2, s, t] of layer.data.boxes) {
        if (s < layer.threshold || x2 < vx0 || x1 > vx1 || y2 < vy0 || y1 > vy1) continue;
        let [px, py, pw, ph] = [ox + x1 * k, oy + y1 * k, (x2 - x1) * k, (y2 - y1) * k];
        if (pw < 6) [px, pw] = [px + pw / 2 - 3, 6];
        if (ph < 6) [py, ph] = [py + ph / 2 - 3, 6];
        path(color(t)).rect(px, py, pw, ph);
      }
      for (const poly of layer.data.polygons) {
        if (poly.s < layer.threshold) continue;
        const p = path(color(poly.t));
        for (let i = 0; i + 1 < poly.p.length; i += 2) {
          const [px, py] = [ox + poly.p[i] * k, oy + poly.p[i + 1] * k];
          if (i === 0) p.moveTo(px, py);
          else p.lineTo(px, py);
        }
        p.closePath();
      }
      ctx.lineJoin = "round";
      for (const [c, p] of paths) {
        ctx.lineWidth = 4;
        ctx.strokeStyle = "rgba(0,0,0,0.55)";
        ctx.stroke(p);
        ctx.lineWidth = 2;
        ctx.strokeStyle = c;
        ctx.stroke(p);
      }
    }
  }
}
