import OpenSeadragon from "openseadragon";
import type { Box, Handle, Pt } from "./geometry";
import { VectorType, type Shape, type TypeStyle } from "./types";

/** What the editor shows on top of the annotations: the selection with its handles, a shape being dragged, a shape being drawn. */
export interface Overlay {
  selectedId: number | null;
  selectedVertex: number | null;
  /** replaces the committed shape with the same id while it is dragged */
  preview: Shape | null;
  handles: Handle[];
  draft: { points: Pt[]; closed: boolean; cursor: Pt | null; color: string } | null;
  /** outline of the annotation a click would place (fixed-size types, one-click mode) */
  ghost: { box: Box; color: string } | null;
  touch: boolean;
}

export const EMPTY_OVERLAY: Overlay = { selectedId: null, selectedVertex: null, preview: null, handles: [], draft: null, ghost: null, touch: false };

/** Canvas on top of an OpenSeadragon viewer: draws annotations (culled to the viewport) and the editor's overlay. */
export class AnnotationLayer {
  private canvas: HTMLCanvasElement;
  private shapes: Shape[] = [];
  private styles = new Map<number, TypeStyle>();
  private hidden = new Set<number>();
  private overlay: Overlay = EMPTY_OVERLAY;
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

  setOverlay(o: Overlay): void {
    this.overlay = o;
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
    const tl = item.viewerElementToImageCoordinates(new OpenSeadragon.Point(0, 0));
    const br = item.viewerElementToImageCoordinates(new OpenSeadragon.Point(w, h));
    const [vx0, vy0, vx1, vy1] = [tl.x, tl.y, br.x, br.y];
    const o = this.overlay;

    const trace = (s: Shape) => {
      ctx.beginPath();
      if (s.vectorType === VectorType.Point) {
        const [px, py] = toPx(s.points[0][0], s.points[0][1]);
        ctx.arc(px, py, 5, 0, Math.PI * 2);
        return;
      }
      s.points.forEach(([x, y], i) => {
        const [px, py] = toPx(x, y);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      if (s.closed) ctx.closePath();
    };

    for (const committed of this.shapes) {
      if (this.hidden.has(committed.typeId)) continue;
      const s = o.preview && o.preview.id === committed.id ? o.preview : committed;
      const [x0, y0, x1, y1] = s.bbox;
      if (x1 < vx0 || x0 > vx1 || y1 < vy0 || y0 > vy1) continue;
      const color = this.styles.get(s.typeId)?.color ?? "#ffffff";
      const selected = s.id === o.selectedId;
      trace(s);
      ctx.lineWidth = selected ? 3 : 2;
      ctx.setLineDash(s.verified === false ? [7, 4] : []);
      ctx.strokeStyle = color;
      ctx.fillStyle = color + (selected ? "44" : "26");
      if (s.closed || s.vectorType === VectorType.Point) ctx.fill();
      if (selected) {
        ctx.save();
        ctx.shadowColor = "#fff";
        ctx.shadowBlur = 8;
        ctx.stroke();
        ctx.restore();
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // the annotation being dragged may be outside the committed list (a new one is not there yet)
    if (o.preview && !this.shapes.some((s) => s.id === o.preview!.id)) {
      const color = this.styles.get(o.preview.typeId)?.color ?? "#fff";
      trace(o.preview);
      ctx.lineWidth = 2;
      ctx.strokeStyle = color;
      ctx.fillStyle = color + "33";
      if (o.preview.closed) ctx.fill();
      ctx.stroke();
    }

    if (o.ghost) {
      const [a, b] = [toPx(o.ghost.box[0], o.ghost.box[1]), toPx(o.ghost.box[2], o.ghost.box[3])];
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = o.ghost.color;
      ctx.lineWidth = 2;
      ctx.strokeRect(a[0], a[1], b[0] - a[0], b[1] - a[1]);
      ctx.setLineDash([]);
    }

    if (o.draft && o.draft.points.length) {
      ctx.strokeStyle = o.draft.color;
      ctx.fillStyle = o.draft.color + "33";
      ctx.lineWidth = 2;
      ctx.beginPath();
      o.draft.points.forEach(([x, y], i) => {
        const [px, py] = toPx(x, y);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      if (o.draft.cursor) {
        const [px, py] = toPx(o.draft.cursor[0], o.draft.cursor[1]);
        ctx.lineTo(px, py);
      }
      if (o.draft.closed && o.draft.points.length > 2) ctx.fill();
      ctx.stroke();
      for (const [x, y] of o.draft.points) {
        const [px, py] = toPx(x, y);
        ctx.fillStyle = "#fff";
        ctx.fillRect(px - 3, py - 3, 6, 6);
      }
    }

    // handles of the selected annotation
    const size = o.touch ? 14 : 8;
    for (const hd of o.handles) {
      const [px, py] = toPx(hd.at[0], hd.at[1]);
      ctx.beginPath();
      if (hd.kind === "mid") {
        ctx.arc(px, py, size / 3, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(255,255,255,0.55)";
        ctx.fill();
        continue;
      }
      const chosen = hd.kind === "vertex" && hd.index === o.selectedVertex;
      ctx.rect(px - size / 2, py - size / 2, size, size);
      ctx.fillStyle = chosen ? "#c8501e" : "#fff";
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "#111";
      ctx.stroke();
    }
  }
}
