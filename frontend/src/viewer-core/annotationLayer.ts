import OpenSeadragon from "openseadragon";
import { VectorType, type Shape, type TypeStyle } from "./types";

/** Canvas overlay that draws annotation shapes on top of an OpenSeadragon viewer, culling to the viewport. */
export class AnnotationLayer {
  private canvas: HTMLCanvasElement;
  private shapes: Shape[] = [];
  private styles = new Map<number, TypeStyle>();
  private hidden = new Set<number>();
  private raf = 0;

  constructor(private viewer: OpenSeadragon.Viewer) {
    this.canvas = document.createElement("canvas");
    Object.assign(this.canvas.style, { position: "absolute", inset: "0", pointerEvents: "none" });
    viewer.canvas.appendChild(this.canvas);
    const redraw = () => this.schedule();
    viewer.addHandler("animation", redraw);
    viewer.addHandler("open", redraw);
    viewer.addHandler("resize", redraw);
    viewer.addHandler("update-viewport", redraw);
  }

  setData(shapes: Shape[], styles: Map<number, TypeStyle>): void {
    this.shapes = shapes;
    this.styles = styles;
    this.schedule();
  }

  setHiddenTypes(hidden: Set<number>): void {
    this.hidden = hidden;
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
    const item = this.viewer.world.getItemCount() ? this.viewer.world.getItemAt(0) : null;
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
    if (!item) return;

    const toPx = (x: number, y: number) => {
      const vp = item.imageToViewportCoordinates(x, y);
      const p = this.viewer.viewport.pixelFromPoint(vp, true);
      return [p.x, p.y] as const;
    };
    // visible region in image pixels for culling
    const [ax, ay] = [0, 0];
    const tl = item.viewerElementToImageCoordinates(new OpenSeadragon.Point(ax, ay));
    const br = item.viewerElementToImageCoordinates(new OpenSeadragon.Point(w, h));
    const [vx0, vy0, vx1, vy1] = [tl.x, tl.y, br.x, br.y];

    ctx.lineWidth = 2;
    for (const s of this.shapes) {
      if (this.hidden.has(s.typeId)) continue;
      const [x0, y0, x1, y1] = s.bbox;
      if (x1 < vx0 || x0 > vx1 || y1 < vy0 || y0 > vy1) continue;
      const color = this.styles.get(s.typeId)?.color ?? "#ffffff";
      ctx.strokeStyle = color;
      ctx.fillStyle = color + "33";
      if (s.vectorType === VectorType.Point) {
        const [px, py] = toPx(s.points[0][0], s.points[0][1]);
        ctx.beginPath();
        ctx.arc(px, py, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        continue;
      }
      ctx.beginPath();
      s.points.forEach(([x, y], i) => {
        const [px, py] = toPx(x, y);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      if (s.closed) {
        ctx.closePath();
        ctx.fill();
      }
      ctx.stroke();
    }
  }
}
