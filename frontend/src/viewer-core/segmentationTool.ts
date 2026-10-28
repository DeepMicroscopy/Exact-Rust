import OpenSeadragon from "openseadragon";
import type { Command } from "./history";
import { wandSelect, type MaskSet, type ToolState } from "./segmentation";

/** Paints on the editable mask of the set with the pointer (mouse, pen, touch): brush, eraser, magic wand. */
export class SegmentationTool {
  state: ToolState = { tool: "brush", size: 24, shape: "circle", tolerance: 24 };
  enabled = false;
  private last: [number, number] | null = null;
  private erase = false;
  private stroking = false;
  private cleanup: (() => void)[] = [];

  constructor(
    private viewer: OpenSeadragon.Viewer,
    private masks: MaskSet,
    private onCommand: (c: Command) => void,
    private notify: (m: string) => void,
    private onState: () => void,
  ) {
    const on = (name: string, fn: (e: never) => void) => {
      const h = fn as unknown as OpenSeadragon.EventHandler<OpenSeadragon.ViewerEvent>;
      viewer.addHandler(name as keyof OpenSeadragon.ViewerEventMap, h);
      this.cleanup.push(() => viewer.removeHandler(name as keyof OpenSeadragon.ViewerEventMap, h));
    };
    type Ev = { position: OpenSeadragon.Point; preventDefaultAction: boolean; originalEvent?: MouseEvent };
    on("canvas-press", (e: Ev) => this.press(e));
    on("canvas-drag", (e: Ev) => this.drag(e));
    on("canvas-release", () => void this.release());
    on("canvas-scroll", (e: { scroll: number; preventDefaultAction: boolean; originalEvent?: WheelEvent }) => {
      if (this.live() && e.originalEvent?.altKey) {
        e.preventDefaultAction = true; // Alt + wheel sizes the brush
        this.setState({ size: Math.round(Math.min(600, Math.max(2, this.state.size * (e.scroll > 0 ? 1.15 : 1 / 1.15)))) });
      }
    });
    const el = viewer.canvas as HTMLElement;
    const move = (ev: PointerEvent) => this.moved(ev);
    const leave = () => {
      const l = this.masks.editable;
      if (l) {
        l.cursor = null;
        l.refresh();
      }
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerleave", leave);
    this.cleanup.push(() => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerleave", leave);
    });
  }

  destroy(): void {
    this.cleanup.forEach((c) => c());
  }

  setState(p: Partial<ToolState>): void {
    this.state = { ...this.state, ...p };
    this.onState();
  }

  private live(): boolean {
    return this.enabled && !!this.masks.editable && this.state.tool !== "pan";
  }

  private toImage(pos: OpenSeadragon.Point): [number, number] | null {
    if (!this.viewer.world.getItemCount()) return null;
    const p = this.viewer.world.getItemAt(0).viewerElementToImageCoordinates(pos);
    return [p.x, p.y];
  }

  /** Screen pixels per image pixel. */
  private zoom(): number {
    return this.viewer.world.getItemAt(0).viewportToImageZoom(this.viewer.viewport.getZoom(true));
  }

  private radius(): number {
    return Math.max(0.5, this.state.size / 2);
  }

  private press(e: { position: OpenSeadragon.Point; preventDefaultAction: boolean; originalEvent?: MouseEvent }): void {
    if (!this.live()) return;
    const layer = this.masks.editable;
    const p = this.toImage(e.position);
    if (!layer || !p) return;
    if (layer.tooMany) {
      this.notify("Zoom in to paint: the mask is not shown at this zoom.");
      return;
    }
    e.preventDefaultAction = true;
    this.erase = this.state.tool === "eraser" || !!e.originalEvent?.altKey;
    if (this.state.tool === "wand") {
      void this.wand(e.position, p);
      return;
    }
    layer.beginStroke();
    this.stroking = true;
    this.last = p;
    layer.paint(p, p, this.radius(), this.state.shape, this.erase ? 0 : 1);
  }

  private drag(e: { position: OpenSeadragon.Point; preventDefaultAction: boolean }): void {
    if (!this.stroking) return;
    e.preventDefaultAction = true;
    const layer = this.masks.editable;
    const p = this.toImage(e.position);
    if (!layer || !p || !this.last) return;
    layer.paint(this.last, p, this.radius(), this.state.shape, this.erase ? 0 : 1);
    layer.cursor = { at: p, r: this.radius(), shape: this.state.shape, erase: this.erase };
    layer.refresh();
    this.last = p;
  }

  private async release(): Promise<void> {
    if (!this.stroking) return;
    this.stroking = false;
    this.last = null;
    const layer = this.masks.editable;
    if (!layer) return;
    try {
      const cmd = await layer.endStroke(this.erase ? "erase mask" : "paint mask");
      if (cmd) this.onCommand(cmd);
    } catch (err) {
      this.notify(err instanceof Error ? err.message : String(err));
    }
  }

  private moved(ev: PointerEvent): void {
    const layer = this.masks.editable;
    if (!layer || !this.enabled || this.state.tool === "pan" || !this.viewer.world.getItemCount()) {
      if (layer) layer.cursor = null;
      return;
    }
    const r = (this.viewer.canvas as HTMLElement).getBoundingClientRect();
    const p = this.toImage(new OpenSeadragon.Point(ev.clientX - r.left, ev.clientY - r.top));
    if (!p) return;
    const wand = this.state.tool === "wand";
    layer.cursor = wand ? null : { at: p, r: this.radius(), shape: this.state.shape, erase: this.state.tool === "eraser" || ev.altKey };
    layer.refresh();
    (this.viewer.canvas as HTMLElement).style.cursor = wand ? "crosshair" : "none";
  }

  /** Magic wand: takes the colours the viewer shows, grows a region from the pointer, adds (or with Alt removes) it. */
  private async wand(pos: OpenSeadragon.Point, at: [number, number]): Promise<void> {
    const layer = this.masks.editable;
    const canvas = (this.viewer.drawer as unknown as { canvas?: HTMLCanvasElement }).canvas;
    if (!layer || !canvas) return;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    const item = this.viewer.world.getItemAt(0);
    const dpr = canvas.width / ((this.viewer.canvas as HTMLElement).clientWidth || canvas.width);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const sel = wandSelect(img.data, canvas.width, canvas.height, Math.round(pos.x * dpr), Math.round(pos.y * dpr), this.state.tolerance);
    if (!sel) return;
    const origin = item.imageToViewerElementCoordinates(new OpenSeadragon.Point(0, 0));
    const z = this.zoom();
    const toDev = (ix: number, iy: number): [number, number] => [Math.floor((origin.x + (ix + 0.5) * z) * dpr), Math.floor((origin.y + (iy + 0.5) * z) * dpr)];
    const [bx0, by0, bx1, by1] = sel.box;
    const box: [number, number, number, number] = [(bx0 / dpr - origin.x) / z - 1, (by0 / dpr - origin.y) / z - 1, (bx1 / dpr - origin.x) / z + 1, (by1 / dpr - origin.y) / z + 1];
    const erase = this.erase;
    layer.beginStroke();
    layer.fillWhere(
      box,
      (x, y) => {
        const [u, v] = toDev(x, y);
        return u >= 0 && v >= 0 && u < canvas.width && v < canvas.height && sel.mask[v * canvas.width + u] === 1;
      },
      erase ? 0 : 1,
    );
    void at;
    try {
      const cmd = await layer.endStroke(erase ? "erase mask" : "magic wand");
      if (cmd) this.onCommand(cmd);
    } catch (err) {
      this.notify(err instanceof Error ? err.message : String(err));
    }
  }
}
