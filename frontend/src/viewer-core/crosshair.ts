import OpenSeadragon from "openseadragon";

/** Two lines over a viewer that cross at a point of the image (image pixels); each line has its own colour. */
export class CrosshairLayer {
  private canvas: HTMLCanvasElement;
  private at: [number, number] | null = null;
  private colors: { vertical: string; horizontal: string } = { vertical: "#fff", horizontal: "#fff" };
  private raf = 0;

  constructor(private viewer: OpenSeadragon.Viewer) {
    this.canvas = document.createElement("canvas");
    Object.assign(this.canvas.style, { position: "absolute", inset: "0", pointerEvents: "none" });
    viewer.canvas.appendChild(this.canvas);
    const redraw = () => this.schedule();
    for (const e of ["animation", "open", "resize", "update-viewport"] as const) viewer.addHandler(e, redraw);
  }

  set(at: [number, number] | null, colors?: { vertical: string; horizontal: string }): void {
    this.at = at;
    if (colors) this.colors = colors;
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
    if (!item || !this.at) return;
    const vp = item.imageToViewportCoordinates(this.at[0], this.at[1]);
    const p = this.viewer.viewport.pixelFromPoint(vp, true);
    const gap = 8; // the lines leave the crossing free, so the voxel under it stays visible
    const line = (x0: number, y0: number, x1: number, y1: number, color: string) => {
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(0,0,0,0.5)";
      ctx.stroke();
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = color;
      ctx.stroke();
    };
    line(p.x, 0, p.x, p.y - gap, this.colors.vertical);
    line(p.x, p.y + gap, p.x, h, this.colors.vertical);
    line(0, p.y, p.x - gap, p.y, this.colors.horizontal);
    line(p.x + gap, p.y, w, p.y, this.colors.horizontal);
  }
}
