import OpenSeadragon from "openseadragon";

/**
 * What the pointer does in a plane while the 3D mask tools are on: the ring of the brush under the pointer and, while a
 * stroke is dragged, a cheap preview of it. Positions are image pixels of the plane; the radii are in image pixels too,
 * horizontal and vertical (a plane whose pixels are not square in mm shows the brush as an ellipse).
 */
export class BrushLayer {
  private canvas: HTMLCanvasElement;
  private ring: { at: [number, number]; rx: number; ry: number; erase: boolean } | null = null;
  private stroke: { points: [number, number][]; rx: number; ry: number; erase: boolean } | null = null;
  private raf = 0;

  constructor(private viewer: OpenSeadragon.Viewer) {
    this.canvas = document.createElement("canvas");
    Object.assign(this.canvas.style, { position: "absolute", inset: "0", pointerEvents: "none" });
    viewer.canvas.appendChild(this.canvas);
    const redraw = () => this.schedule();
    for (const e of ["animation", "open", "resize", "update-viewport"] as const) viewer.addHandler(e, redraw);
  }

  setRing(ring: { at: [number, number]; rx: number; ry: number; erase: boolean } | null): void {
    this.ring = ring;
    this.schedule();
  }

  setStroke(stroke: { points: [number, number][]; rx: number; ry: number; erase: boolean } | null): void {
    this.stroke = stroke;
    this.schedule();
  }

  get stroking(): boolean {
    return this.stroke != null;
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
    const [w, h] = [el.clientWidth, el.clientHeight];
    const dpr = window.devicePixelRatio || 1;
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
    if (!item) return;
    // screen pixels per image pixel
    const zoom = item.viewportToImageZoom(this.viewer.viewport.getZoom(true));
    const screen = (p: [number, number]) => this.viewer.viewport.pixelFromPoint(item.imageToViewportCoordinates(p[0], p[1]), true);
    const ellipse = (at: [number, number], rx: number, ry: number) => {
      const c = screen(at);
      ctx.beginPath();
      ctx.ellipse(c.x, c.y, Math.max(rx * zoom, 1), Math.max(ry * zoom, 1), 0, 0, Math.PI * 2);
    };
    if (this.stroke) {
      const { points, rx, ry, erase } = this.stroke;
      ctx.fillStyle = erase ? "rgba(255,255,255,0.28)" : "rgba(255,230,90,0.38)";
      // a stamp at every point, and between the points one per half radius so that a fast stroke has no gaps
      let last: [number, number] | null = null;
      const step = Math.max(Math.min(rx, ry) * 0.5, 0.5);
      for (const p of points) {
        if (last) {
          const n = Math.floor(Math.hypot(p[0] - last[0], p[1] - last[1]) / step);
          for (let i = 1; i < n; i++) {
            ellipse([last[0] + ((p[0] - last[0]) * i) / n, last[1] + ((p[1] - last[1]) * i) / n], rx, ry);
            ctx.fill();
          }
        }
        ellipse(p, rx, ry);
        ctx.fill();
        last = p;
      }
    }
    if (this.ring) {
      ellipse(this.ring.at, this.ring.rx, this.ring.ry);
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(0,0,0,0.55)";
      ctx.stroke();
      ctx.lineWidth = 1.3;
      ctx.setLineDash(this.ring.erase ? [4, 3] : []);
      ctx.strokeStyle = this.ring.erase ? "#ffffff" : "#ffe65a";
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
}
