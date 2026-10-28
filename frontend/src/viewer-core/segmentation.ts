import { getCsrfToken } from "../api/client";
import type { Command } from "./history";

export const TILE = 256;
/** More tiles than this in view: zoomed out too far to show or paint a mask (each tile is a request). */
export const MAX_VIEW_TILES = 80;

export type BrushShape = "circle" | "square";
export type SegTool = "brush" | "eraser" | "wand" | "pan";

type Mask = Uint8Array; // TILE * TILE, 0 / 1, row-major

export interface MaskSource {
  annotationId: number;
  /** size of the plane image in pixels */
  width: number;
  height: number;
  /** MPR plane of a volume: 0 axial, 1 coronal, 2 sagittal */
  plane: number;
  /** slice (axial) or position along the normal of the plane */
  frame: number;
  /** pixel height of the rendered plane and the number of slices along its normal (the server maps voxels with them) */
  ph: number;
  nf: number;
}

const keyOf = (tx: number, ty: number) => `${tx}_${ty}`;
const isEmpty = (m: Mask) => !m.some((v) => v);

/** Tile columns and rows a view of the image (image pixels) covers. */
export function tilesIn(view: [number, number, number, number], width: number, height: number): { tx0: number; tx1: number; ty0: number; ty1: number; count: number } {
  const tx0 = Math.max(0, Math.floor(view[0] / TILE));
  const ty0 = Math.max(0, Math.floor(view[1] / TILE));
  const tx1 = Math.min(Math.ceil(width / TILE) - 1, Math.floor(view[2] / TILE));
  const ty1 = Math.min(Math.ceil(height / TILE) - 1, Math.floor(view[3] / TILE));
  return { tx0, tx1, ty0, ty1, count: Math.max(0, tx1 - tx0 + 1) * Math.max(0, ty1 - ty0 + 1) };
}

/** Sets (or clears) the pixels within `r` of the segment a-b (a round brush) or in the square swept by it. */
export function paintInto(tile: Mask, tx: number, ty: number, a: [number, number], b: [number, number], r: number, shape: BrushShape, value: 0 | 1): boolean {
  const [ox, oy] = [tx * TILE, ty * TILE];
  const x0 = Math.max(ox, Math.floor(Math.min(a[0], b[0]) - r));
  const x1 = Math.min(ox + TILE - 1, Math.ceil(Math.max(a[0], b[0]) + r));
  const y0 = Math.max(oy, Math.floor(Math.min(a[1], b[1]) - r));
  const y1 = Math.min(oy + TILE - 1, Math.ceil(Math.max(a[1], b[1]) + r));
  if (x1 < x0 || y1 < y0) return false;
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const len2 = dx * dx + dy * dy;
  let changed = false;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const [px, py] = [x + 0.5, y + 0.5];
      const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((px - a[0]) * dx + (py - a[1]) * dy) / len2));
      const [cx, cy] = [a[0] + t * dx, a[1] + t * dy];
      const inside = shape === "circle" ? (px - cx) ** 2 + (py - cy) ** 2 <= r * r : Math.abs(px - cx) <= r && Math.abs(py - cy) <= r;
      if (!inside) continue;
      const i = (y - oy) * TILE + (x - ox);
      if (tile[i] !== value) {
        tile[i] = value;
        changed = true;
      }
    }
  }
  return changed;
}

/**
 * Magic wand: the connected pixels whose colour is within `tol` (per channel) of the pixel at (sx, sy). `data` is RGBA like
 * ImageData. Returns the selection as a mask of the same size and its bounding box.
 */
export function wandSelect(data: Uint8ClampedArray, w: number, h: number, sx: number, sy: number, tol: number): { mask: Uint8Array; box: [number, number, number, number] } | null {
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return null;
  const mask = new Uint8Array(w * h);
  const s = (sy * w + sx) * 4;
  const [r0, g0, b0] = [data[s], data[s + 1], data[s + 2]];
  const near = (i: number) => Math.abs(data[i] - r0) <= tol && Math.abs(data[i + 1] - g0) <= tol && Math.abs(data[i + 2] - b0) <= tol;
  const stack = new Int32Array(w * h);
  let top = 0;
  stack[top++] = sy * w + sx;
  mask[sy * w + sx] = 1;
  let box: [number, number, number, number] = [sx, sy, sx, sy];
  while (top > 0) {
    const p = stack[--top];
    const [x, y] = [p % w, (p / w) | 0];
    if (x < box[0]) box[0] = x;
    if (y < box[1]) box[1] = y;
    if (x > box[2]) box[2] = x;
    if (y > box[3]) box[3] = y;
    for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]] as const) {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const q = ny * w + nx;
      if (mask[q] || !near(q * 4)) continue;
      mask[q] = 1;
      stack[top++] = q;
    }
  }
  box = [box[0], box[1], box[2], box[3]];
  return { mask, box };
}

interface Stroke {
  before: Map<string, Mask | null>;
  waiting: Promise<void>[];
}

/** The mask of one segmentation annotation on one slice or plane: loads, shows, paints and saves its 256 x 256 tiles. */
export class MaskLayer {
  /** a loaded tile; `null` = known to be empty */
  private tiles = new Map<string, Mask | null>();
  private loading = new Map<string, Promise<void>>();
  private bitmaps = new Map<string, HTMLCanvasElement>();
  private saving = new Map<string, Promise<void>>();
  private stroke: Stroke | null = null;
  private queue: (() => void)[] = [];
  private active = 0;
  private dead = false;
  visible = true;
  opacity = 0.55;
  /** the view covers more tiles than are loaded and shown */
  tooMany = false;
  /** what the editor shows at the pointer: the brush */
  cursor: { at: [number, number]; r: number; shape: BrushShape; erase: boolean } | null = null;
  private rgb: [number, number, number];
  /** axial slices: the tiles that exist (the others are empty and are not asked for); null until the list has arrived */
  private index: Set<string> | null = null;

  constructor(
    readonly src: MaskSource,
    color: string,
    private redraw: () => void,
  ) {
    const v = parseInt(color.replace("#", ""), 16);
    this.rgb = [(v >> 16) & 255, (v >> 8) & 255, v & 255];
    if (src.plane === 0) {
      fetch(`/api/v2/segmentation/${src.annotationId}/tiles?frame=${src.frame}`, { credentials: "same-origin" })
        .then((r) => (r.ok ? r.json() : { tiles: [] }))
        .then((j: { tiles: [number, number][] }) => {
          if (this.dead) return;
          this.index = new Set(j.tiles.map(([x, y]) => keyOf(x, y)));
          this.redraw();
        })
        .catch(() => {
          if (!this.dead) this.index = new Set();
        });
    }
  }

  setColor(color: string): void {
    const v = parseInt(color.replace("#", ""), 16);
    this.rgb = [(v >> 16) & 255, (v >> 8) & 255, v & 255];
    this.bitmaps.clear();
    this.redraw();
  }

  destroy(): void {
    this.dead = true;
    this.queue = [];
  }

  refresh(): void {
    this.redraw();
  }

  private url(tx: number, ty: number): string {
    const s = this.src;
    return `/api/v2/segmentation/${s.annotationId}/tiles/${s.plane}/${tx}/${ty}?frame=${s.frame}&ph=${s.ph}&nf=${s.nf}`;
  }

  /** Starts loading what the view needs; false when it needs too many tiles. */
  ensure(view: [number, number, number, number]): boolean {
    const t = tilesIn(view, this.src.width, this.src.height);
    if (this.src.plane === 0) {
      if (!this.index) return false; // the list of tiles is on its way
      const here = [...this.index].filter((k) => {
        const [tx, ty] = k.split("_").map(Number);
        return tx >= t.tx0 && tx <= t.tx1 && ty >= t.ty0 && ty <= t.ty1;
      });
      this.tooMany = here.length > MAX_VIEW_TILES * 4;
      if (this.tooMany) return false;
      for (const k of here) {
        const [tx, ty] = k.split("_").map(Number);
        void this.load(tx, ty);
      }
      return true;
    }
    this.tooMany = t.count > MAX_VIEW_TILES;
    if (this.tooMany) return false;
    for (let ty = t.ty0; ty <= t.ty1; ty++) for (let tx = t.tx0; tx <= t.tx1; tx++) void this.load(tx, ty);
    return true;
  }

  private load(tx: number, ty: number): Promise<void> {
    const k = keyOf(tx, ty);
    if (this.tiles.has(k)) return Promise.resolve();
    if (this.index && !this.index.has(k)) {
      this.tiles.set(k, null); // not stored: empty
      return Promise.resolve();
    }
    const running = this.loading.get(k);
    if (running) return running;
    const p = new Promise<void>((resolve) => {
      const run = () => {
        this.active++;
        fetch(this.url(tx, ty), { credentials: "same-origin" })
          .then(async (r) => {
            if (this.dead) return;
            if (r.status === 200) this.tiles.set(k, await decodeTile(await r.blob()));
            else if (r.status === 204) this.tiles.set(k, null);
            else this.tiles.set(k, null); // an error: shown as empty; painting it saves a whole tile, so the user would see
          })
          .catch(() => {
            if (!this.dead) this.tiles.set(k, null);
          })
          .finally(() => {
            this.active--;
            this.loading.delete(k);
            resolve();
            this.bitmaps.delete(k);
            if (!this.dead) this.redraw();
            this.next();
          });
      };
      this.queue.push(run);
      this.next();
    });
    this.loading.set(k, p);
    return p;
  }

  private next(): void {
    while (this.active < 4 && this.queue.length) this.queue.shift()?.();
  }

  private bitmap(k: string, m: Mask): HTMLCanvasElement {
    let c = this.bitmaps.get(k);
    if (c) return c;
    c = document.createElement("canvas");
    c.width = c.height = TILE;
    const ctx = c.getContext("2d");
    if (ctx) {
      const img = ctx.createImageData(TILE, TILE);
      for (let i = 0; i < m.length; i++) {
        if (!m[i]) continue;
        img.data[i * 4] = this.rgb[0];
        img.data[i * 4 + 1] = this.rgb[1];
        img.data[i * 4 + 2] = this.rgb[2];
        img.data[i * 4 + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
    }
    this.bitmaps.set(k, c);
    return c;
  }

  draw(ctx: CanvasRenderingContext2D, toPx: (x: number, y: number) => [number, number], view: [number, number, number, number]): void {
    if (!this.visible) return;
    if (!this.ensure(view)) return;
    const t = tilesIn(view, this.src.width, this.src.height);
    ctx.save();
    ctx.globalAlpha = this.opacity;
    ctx.imageSmoothingEnabled = false;
    for (let ty = t.ty0; ty <= t.ty1; ty++) {
      for (let tx = t.tx0; tx <= t.tx1; tx++) {
        const k = keyOf(tx, ty);
        const m = this.tiles.get(k);
        if (!m) continue;
        const [x0, y0] = toPx(tx * TILE, ty * TILE);
        const [x1, y1] = toPx((tx + 1) * TILE, (ty + 1) * TILE);
        ctx.drawImage(this.bitmap(k, m), x0, y0, x1 - x0, y1 - y0);
      }
    }
    ctx.restore();
    const c = this.cursor;
    if (c) {
      const [cx, cy] = toPx(c.at[0], c.at[1]);
      const [rx, ry] = toPx(c.at[0] + c.r, c.at[1] + c.r);
      ctx.save();
      ctx.lineWidth = 2;
      ctx.setLineDash(c.erase ? [5, 4] : []);
      ctx.strokeStyle = c.erase ? "#ff6a5a" : "#ffffff";
      ctx.fillStyle = c.erase ? "rgba(255,106,90,0.15)" : "rgba(255,255,255,0.12)";
      ctx.beginPath();
      if (c.shape === "circle") ctx.ellipse(cx, cy, Math.abs(rx - cx), Math.abs(ry - cy), 0, 0, Math.PI * 2);
      else ctx.rect(cx - Math.abs(rx - cx), cy - Math.abs(ry - cy), 2 * Math.abs(rx - cx), 2 * Math.abs(ry - cy));
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }

  // ---- painting --------------------------------------------------------------------------------------------------

  beginStroke(): void {
    this.stroke = { before: new Map(), waiting: [] };
  }

  /** Runs `fn` on the tile once it is loaded; the first change of a tile in a stroke remembers how it looked before. */
  private withTile(tx: number, ty: number, fn: (tile: Mask) => boolean): void {
    const k = keyOf(tx, ty);
    const st = this.stroke; // the stroke this belongs to, also when the tile arrives after the stroke has ended
    const apply = () => {
      let tile = this.tiles.get(k) ?? null;
      const was = tile ? tile.slice() : null;
      const fresh = !tile;
      if (!tile) tile = new Uint8Array(TILE * TILE);
      if (fn(tile)) {
        if (st && !st.before.has(k)) st.before.set(k, was);
        this.tiles.set(k, tile);
        this.bitmaps.delete(k);
        this.dirty.add(k);
        this.redraw();
      } else if (fresh) this.tiles.set(k, null);
    };
    if (this.tiles.has(k)) apply();
    else {
      const loaded = this.load(tx, ty).then(apply);
      st?.waiting.push(loaded);
    }
  }

  private dirty = new Set<string>();

  /** Paints (value 1) or erases (value 0) along a-b. */
  paint(a: [number, number], b: [number, number], r: number, shape: BrushShape, value: 0 | 1): void {
    const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0]) - r));
    const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1]) - r));
    const x1 = Math.min(this.src.width - 1, Math.ceil(Math.max(a[0], b[0]) + r));
    const y1 = Math.min(this.src.height - 1, Math.ceil(Math.max(a[1], b[1]) + r));
    for (let ty = Math.floor(y0 / TILE); ty <= Math.floor(y1 / TILE); ty++) {
      for (let tx = Math.floor(x0 / TILE); tx <= Math.floor(x1 / TILE); tx++) {
        this.withTile(tx, ty, (tile) => paintInto(tile, tx, ty, a, b, r, shape, value));
      }
    }
  }

  /** Sets or clears every pixel of the box (image pixels) for which `pick(x, y)` is true. */
  fillWhere(box: [number, number, number, number], pick: (x: number, y: number) => boolean, value: 0 | 1): void {
    const [x0, y0] = [Math.max(0, Math.floor(box[0])), Math.max(0, Math.floor(box[1]))];
    const [x1, y1] = [Math.min(this.src.width - 1, Math.ceil(box[2])), Math.min(this.src.height - 1, Math.ceil(box[3]))];
    for (let ty = Math.floor(y0 / TILE); ty <= Math.floor(y1 / TILE); ty++) {
      for (let tx = Math.floor(x0 / TILE); tx <= Math.floor(x1 / TILE); tx++) {
        this.withTile(tx, ty, (tile) => {
          let changed = false;
          for (let y = Math.max(y0, ty * TILE); y <= Math.min(y1, ty * TILE + TILE - 1); y++) {
            for (let x = Math.max(x0, tx * TILE); x <= Math.min(x1, tx * TILE + TILE - 1); x++) {
              if (!pick(x, y)) continue;
              const i = (y - ty * TILE) * TILE + (x - tx * TILE);
              if (tile[i] !== value) {
                tile[i] = value;
                changed = true;
              }
            }
          }
          return changed;
        });
      }
    }
  }

  /** Ends the stroke: saves what changed and answers the undo step (null when nothing changed). */
  async endStroke(label: string): Promise<Command | null> {
    const st = this.stroke;
    this.stroke = null;
    if (!st) return null;
    await Promise.all(st.waiting);
    if (!st.before.size) return null;
    const keys = [...st.before.keys()];
    const after = new Map(keys.map((k) => [k, (this.tiles.get(k) ?? null) as Mask | null]));
    const copy = (m: Mask | null) => (m ? m.slice() : null);
    const before = new Map([...st.before].map(([k, m]) => [k, copy(m)]));
    const afterCopy = new Map([...after].map(([k, m]) => [k, copy(m)]));
    await this.save(keys);
    return {
      label,
      undo: () => this.restore(before),
      redo: () => this.restore(afterCopy),
    };
  }

  private async restore(state: Map<string, Mask | null>): Promise<void> {
    for (const [k, m] of state) {
      this.tiles.set(k, m ? m.slice() : null);
      this.bitmaps.delete(k);
    }
    this.redraw();
    await this.save([...state.keys()]);
  }

  /** Saves tiles: an empty axial tile is deleted, the other planes are written through (an empty tile clears the rows). */
  private async save(keys: string[]): Promise<void> {
    this.dirty.clear();
    await Promise.all(keys.map((k) => this.saveOne(k)));
  }

  private saveOne(k: string): Promise<void> {
    const [tx, ty] = k.split("_").map(Number);
    const run = async () => {
      const m = this.tiles.get(k) ?? null;
      const headers: Record<string, string> = {};
      const csrf = getCsrfToken();
      if (csrf) headers["x-csrf-token"] = csrf;
      if ((!m || isEmpty(m)) && this.src.plane === 0) {
        await fetch(this.url(tx, ty), { method: "DELETE", headers, credentials: "same-origin" });
        this.index?.delete(k);
        return;
      }
      const body = await encodeTile(m ?? new Uint8Array(TILE * TILE));
      const r = await fetch(this.url(tx, ty), { method: "PUT", headers: { ...headers, "content-type": "image/png" }, body, credentials: "same-origin" });
      if (!r.ok) throw new Error(`Could not save the mask (${r.status})`);
      this.index?.add(k);
    };
    const prev = this.saving.get(k) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(run);
    this.saving.set(k, next);
    return next;
  }
}

async function decodeTile(blob: Blob): Promise<Mask> {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement("canvas");
  c.width = bmp.width;
  c.height = bmp.height;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  const out = new Uint8Array(TILE * TILE);
  if (ctx) {
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, Math.min(TILE, bmp.width), Math.min(TILE, bmp.height));
    for (let y = 0; y < d.height; y++) for (let x = 0; x < d.width; x++) out[y * TILE + x] = d.data[(y * d.width + x) * 4] > 127 ? 1 : 0;
  }
  return out;
}

function encodeTile(m: Mask): Promise<Blob> {
  const c = document.createElement("canvas");
  c.width = c.height = TILE;
  const ctx = c.getContext("2d");
  const img = ctx?.createImageData(TILE, TILE);
  if (!ctx || !img) return Promise.reject(new Error("no canvas"));
  for (let i = 0; i < m.length; i++) {
    img.data[i * 4] = m[i] ? 255 : 0; // the server reads the red channel
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("png"))), "image/png"));
}

/** The masks of an image (one per segmentation annotation): all are shown, one can be painted. */
export class MaskSet {
  layers = new Map<number, MaskLayer>();
  active: number | null = null;

  constructor(private redraw: () => void) {}

  /** Makes the set match the segmentation annotations: `wanted` = annotation id -> colour. */
  sync(wanted: Map<number, string>, source: (annotationId: number) => MaskSource): void {
    for (const [id, l] of this.layers) {
      if (!wanted.has(id)) {
        l.destroy();
        this.layers.delete(id);
      }
    }
    for (const [id, color] of wanted) {
      const have = this.layers.get(id);
      const src = source(id);
      if (have && have.src.plane === src.plane && have.src.frame === src.frame && have.src.width === src.width && have.src.height === src.height) {
        have.setColor(color);
        continue;
      }
      have?.destroy();
      const l = new MaskLayer(src, color, this.redraw);
      this.layers.set(id, l);
    }
    this.redraw();
  }

  get editable(): MaskLayer | null {
    return this.active != null ? (this.layers.get(this.active) ?? null) : null;
  }

  draw(ctx: CanvasRenderingContext2D, toPx: (x: number, y: number) => [number, number], view: [number, number, number, number]): void {
    for (const l of this.layers.values()) l.draw(ctx, toPx, view);
  }

  destroy(): void {
    this.layers.forEach((l) => l.destroy());
    this.layers.clear();
  }
}

export interface ToolState {
  tool: SegTool;
  size: number;
  shape: BrushShape;
  tolerance: number;
}
