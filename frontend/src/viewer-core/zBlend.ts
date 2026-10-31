import OpenSeadragon from "openseadragon";

type Source = OpenSeadragon.Options["tileSources"];

export interface BlenderOptions {
  /** cross-fade between neighbouring planes (microscopy z-stacks); otherwise only the nearest plane is shown */
  blend: boolean;
  /** called once, when the first plane has been added to the viewer */
  onReady?: () => void;
  /** true while the plane to show is still loading (the previous one stays on display meanwhile) */
  onBusy?: (busy: boolean) => void;
  /** the plane that is on display now (called whenever the display is settled on a plane: a mask for that plane may be shown with it) */
  onShown?: (frame: number) => void;
}

/**
 * Share (0..1) of the viewer's area that the tiles drawn for `item` cover, on a coarse grid. A plane whose tiles cover
 * the whole view may be shown (sharpening as finer tiles arrive) although it is not fully loaded: OpenSeadragon draws
 * coarse tiles first.
 */
export function coverageOf(item: OpenSeadragon.TiledImage, width: number, height: number): number {
  const [cols, rows] = [24, 14];
  const hit = new Uint8Array(cols * rows);
  const drawn = (item as unknown as { lastDrawn?: { position?: { x: number; y: number }; size?: { x: number; y: number } }[] }).lastDrawn ?? [];
  for (const t of drawn) {
    if (!t.position || !t.size) continue;
    const [x0, x1] = [Math.max(0, Math.floor(((t.position.x) / width) * cols)), Math.min(cols - 1, Math.floor(((t.position.x + t.size.x) / width) * cols))];
    const [y0, y1] = [Math.max(0, Math.floor((t.position.y / height) * rows)), Math.min(rows - 1, Math.floor(((t.position.y + t.size.y) / height) * rows))];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) hit[y * cols + x] = 1;
  }
  return hit.reduce((a, b) => a + b, 0) / hit.length;
}

/** Opacity of planes that are loaded but not visible: not 0, so that their tiles keep loading ahead of the user. */
const PRELOAD_OPACITY = 0.001;

/**
 * Shows one plane of a stack at a (fractional) position in an OpenSeadragon viewer.
 *
 * Every plane is its own tiled image with identical geometry. For a position between plane `k` and `k + 1` plane `k`
 * is drawn opaque and plane `k + 1` on top of it with the opacity of the fractional part, which is a linear
 * cross-fade of the two focus planes. Neighbouring planes are loaded ahead of time (`k - 1 ... k + 2`) and planes far
 * away are dropped again, so memory stays bounded for stacks of any size.
 *
 * What is shown changes only when the plane to show has its tiles: until then the plane on display stays, so stepping
 * through a stack does not flash empty or half-drawn planes.
 */
export class ZBlender {
  private items = new Map<number, OpenSeadragon.TiledImage>();
  private pending = new Set<number>();
  private pos = 0;
  private dead = false;
  private ready = false;
  /** the planes on display (opacity above the preload level), kept until the plane to show is fully loaded */
  private shown = new Set<number>();
  private waiting: ReturnType<typeof setTimeout> | null = null;
  private giveUp = false;
  private settle: ReturnType<typeof setTimeout> | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private moveTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** how many planes after the current one are loaded ahead (more while a movie plays) */
  ahead = 2;

  constructor(
    private viewer: OpenSeadragon.Viewer,
    private frames: number,
    private load: (frame: number) => Promise<Source>,
    private opts: BlenderOptions,
  ) {
    this.ahead = opts.blend ? 2 : 1;
  }

  get position(): number {
    return this.pos;
  }

  setPosition(v: number): void {
    this.pos = Math.min(Math.max(v, 0), Math.max(this.frames - 1, 0));
    this.update();
  }

  destroy(): void {
    this.dead = true;
    this.setBusy(false);
    if (this.poll) clearInterval(this.poll);
    if (this.waiting) clearTimeout(this.waiting);
    if (this.settle) clearTimeout(this.settle);
    if (this.moveTimer) clearTimeout(this.moveTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    for (const item of this.items.values()) this.viewer.world.removeItem(item);
    this.items.clear();
  }

  private wanted(): number[] {
    const base = Math.floor(this.pos);
    const out: number[] = [base - 1];
    for (let i = 0; i <= this.ahead; i++) out.push(base + i);
    return out.filter((f) => f >= 0 && f < this.frames);
  }

  /** The planes the position needs: one, or two while it lies between two planes of a focus stack. */
  private needed(): number[] {
    if (!this.opts.blend) return [Math.round(this.pos)];
    const base = Math.floor(this.pos);
    return this.pos - base > 0 && base + 1 < this.frames ? [base, base + 1] : [base];
  }

  private update(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.moveTimer) clearTimeout(this.moveTimer);
    const now = this.needed();
    if (this.ahead > 2 || this.items.size === 0) {
      // a playing movie (and the first plane) loads everything at once, nearest first
      for (const f of [...this.wanted()].sort((x, y) => Math.abs(x - this.pos) - Math.abs(y - this.pos))) this.ensure(f);
    } else {
      // A plane costs the server a rendering or a read of the file and the viewer dozens of tile requests: while the
      // position keeps moving (slider drag, key held) only the plane it comes to rest on is requested.
      this.moveTimer = setTimeout(() => {
        this.moveTimer = null;
        for (const f of now) this.ensure(f);
      }, 70);
    }
    this.prune();
    this.applyOpacity();
  }

  /**
   * The neighbouring planes are loaded only once the plane to show is complete: their tiles would otherwise queue
   * in front of it in the viewer's request queue and delay what the user waits for.
   */
  private preloadSoon(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.dead || !this.needed().every((f) => this.loaded(f))) return;
      for (const f of [...this.wanted()].sort((x, y) => Math.abs(x - this.pos) - Math.abs(y - this.pos))) this.ensure(f);
    }, 120);
  }

  /**
   * Drops the planes that are out of range, but only once a plane in range is there: an empty world makes OpenSeadragon
   * treat the next plane as the first image and reset the view to the whole image, which must not happen when the user
   * jumps along the stack at a zoomed-in position.
   */
  private prune(): void {
    const wanted = this.wanted();
    if (!wanted.some((f) => this.items.has(f))) return;
    for (const [f, item] of this.items) {
      if (!wanted.includes(f) && !this.shown.has(f)) {
        this.viewer.world.removeItem(item);
        this.items.delete(f);
      }
    }
  }

  private ensure(frame: number): void {
    if (this.dead || this.items.has(frame) || this.pending.has(frame)) return;
    this.pending.add(frame);
    this.load(frame)
      .then((tileSource) => {
        if (this.dead) return;
        this.viewer.addTiledImage({
          tileSource: tileSource as OpenSeadragon.TileSourceOptions,
          opacity: PRELOAD_OPACITY,
          success: (ev: unknown) => {
            const e = ev as { item: OpenSeadragon.TiledImage };
            this.pending.delete(frame);
            if (this.dead || !this.wanted().includes(frame)) {
              this.viewer.world.removeItem(e.item); // the position moved on while the plane was loading
              return;
            }
            this.items.set(frame, e.item);
            e.item.addHandler("fully-loaded-change", () => this.applyOpacity());
            // higher planes above lower planes
            [...this.items.keys()].sort((a, b) => a - b).forEach((f, i) => this.viewer.world.setItemIndex(this.items.get(f)!, i));
            this.prune();
            this.applyOpacity();
            if (!this.ready) {
              this.ready = true;
              this.opts.onReady?.();
            }
          },
          error: () => this.pending.delete(frame),
        });
      })
      .catch(() => this.pending.delete(frame));
  }

  private busy = false;
  private setBusy(b: boolean): void {
    if (b === this.busy) return;
    this.busy = b;
    this.opts.onBusy?.(b);
  }

  private loaded(frame: number): boolean {
    return this.items.get(frame)?.getFullyLoaded() ?? false;
  }

  /** Complete, or drawn over the whole view with the tiles that are there (the finer ones follow). */
  private showable(frame: number): boolean {
    const item = this.items.get(frame);
    if (!item) return false;
    if (item.getFullyLoaded()) return true;
    const el = this.viewer.canvas as HTMLElement;
    return coverageOf(item, el.clientWidth, el.clientHeight) >= 0.97;
  }

  /** Opacity of every loaded plane for the current position. */
  private applyOpacity(): void {
    const base = Math.floor(this.pos);
    const f = this.pos - base;
    const nearest = Math.round(this.pos);
    // the plane that carries the picture must be complete before anything changes (or something is shown at all)
    const need = this.opts.blend ? base : nearest;
    const ready = this.showable(need) || this.giveUp || this.shown.size === 0 || ![...this.shown].some((x) => this.items.has(x));
    this.setBusy(!ready);
    if (!ready) {
      if (!this.poll)
        this.poll = setInterval(() => {
          if (this.dead) return;
          this.applyOpacity();
        }, 60);
      if (!this.waiting)
        this.waiting = setTimeout(() => {
          this.waiting = null;
          this.giveUp = true; // a tile that never arrives must not freeze the view
          this.applyOpacity();
        }, 4000);
      return;
    }
    if (this.waiting) clearTimeout(this.waiting);
    this.waiting = null;
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
    this.giveUp = false;
    const next = new Map<number, number>();
    for (const frame of this.items.keys()) {
      let o = PRELOAD_OPACITY;
      if (!this.opts.blend) {
        o = frame === nearest ? 1 : PRELOAD_OPACITY;
        // the nearest plane is not there: show what is there instead of nothing
        if (!this.items.has(nearest) && Math.abs(frame - this.pos) < 1.0001) o = 1;
      } else if (frame === base) {
        o = 1;
      } else if (frame === base + 1) {
        // blend only when the lower plane is there to blend with; otherwise show this one
        o = this.items.has(base) ? Math.max(f, PRELOAD_OPACITY) : 1;
      } else if (frame === base - 1 && !this.items.has(base) && f === 0) {
        o = 1;
      }
      next.set(frame, o);
    }
    // planes that leave the display stay for a moment under the new ones (tiles fade in over a few frames)
    const leaving = [...this.shown].filter((x) => this.items.has(x) && (next.get(x) ?? 0) <= PRELOAD_OPACITY);
    for (const [frame, item] of this.items) item.setOpacity(leaving.includes(frame) ? 1 : (next.get(frame) ?? PRELOAD_OPACITY));
    this.shown = new Set([...next].filter(([, o]) => o > PRELOAD_OPACITY).map(([x]) => x));
    const top = this.items.has(need) ? need : [...next].find(([, o]) => o >= 1)?.[0];
    if (top != null) this.opts.onShown?.(top);
    this.preloadSoon();
    if (this.settle) clearTimeout(this.settle);
    if (leaving.length) {
      this.settle = setTimeout(() => {
        this.settle = null;
        for (const x of leaving) if (!this.shown.has(x)) this.items.get(x)?.setOpacity(PRELOAD_OPACITY);
        this.prune();
      }, 180);
    }
  }
}
