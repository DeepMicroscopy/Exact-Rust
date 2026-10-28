import OpenSeadragon from "openseadragon";

type Source = OpenSeadragon.Options["tileSources"];

export interface BlenderOptions {
  /** cross-fade between neighbouring planes (microscopy z-stacks); otherwise only the nearest plane is shown */
  blend: boolean;
  /** called once, when the first plane has been added to the viewer */
  onReady?: () => void;
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

  private update(): void {
    const wanted = this.wanted();
    const byDistance = [...wanted].sort((a, b) => Math.abs(a - this.pos) - Math.abs(b - this.pos));
    if (this.opts.blend || this.items.size === 0 || this.ahead > 2) {
      // nearest planes first, so that the visible ones are requested before the preloaded ones (a playing movie loads at once)
      for (const f of byDistance) this.ensure(f);
    } else {
      // A volume slice costs the server a rendering and ~dozens of tiles. While the position keeps moving (slider drag,
      // key held) only the slice it comes to rest on is requested, and its neighbours once it has rested.
      if (this.moveTimer) clearTimeout(this.moveTimer);
      if (this.idleTimer) clearTimeout(this.idleTimer);
      const target = Math.round(this.pos);
      this.moveTimer = setTimeout(() => {
        this.moveTimer = null;
        this.ensure(target);
      }, 70);
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null;
        for (const f of byDistance) this.ensure(f);
      }, 350);
    }
    this.prune();
    this.applyOpacity();
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

  private loaded(frame: number): boolean {
    return this.items.get(frame)?.getFullyLoaded() ?? false;
  }

  /** Opacity of every loaded plane for the current position. */
  private applyOpacity(): void {
    const base = Math.floor(this.pos);
    const f = this.pos - base;
    const nearest = Math.round(this.pos);
    // the plane that carries the picture must be complete before anything changes (or something is shown at all)
    const need = this.opts.blend ? base : nearest;
    const ready = this.loaded(need) || this.giveUp || this.shown.size === 0 || ![...this.shown].some((x) => this.items.has(x));
    if (!ready) {
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
