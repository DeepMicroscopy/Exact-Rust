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
 */
export class ZBlender {
  private items = new Map<number, OpenSeadragon.TiledImage>();
  private pending = new Set<number>();
  private pos = 0;
  private dead = false;
  private ready = false;

  constructor(
    private viewer: OpenSeadragon.Viewer,
    private frames: number,
    private load: (frame: number) => Promise<Source>,
    private opts: BlenderOptions,
  ) {}

  get position(): number {
    return this.pos;
  }

  setPosition(v: number): void {
    this.pos = Math.min(Math.max(v, 0), Math.max(this.frames - 1, 0));
    this.update();
  }

  destroy(): void {
    this.dead = true;
    for (const item of this.items.values()) this.viewer.world.removeItem(item);
    this.items.clear();
  }

  private wanted(): number[] {
    const base = Math.floor(this.pos);
    return [base - 1, base, base + 1, base + 2].filter((f) => f >= 0 && f < this.frames);
  }

  private update(): void {
    const wanted = this.wanted();
    // nearest planes first, so that the visible ones are requested before the preloaded ones
    for (const f of [...wanted].sort((a, b) => Math.abs(a - this.pos) - Math.abs(b - this.pos))) this.ensure(f);
    for (const [f, item] of this.items) {
      if (!wanted.includes(f)) {
        this.viewer.world.removeItem(item);
        this.items.delete(f);
      }
    }
    this.applyOpacity();
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
            // higher planes above lower planes
            [...this.items.keys()].sort((a, b) => a - b).forEach((f, i) => this.viewer.world.setItemIndex(this.items.get(f)!, i));
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

  /** Opacity of every loaded plane for the current position. */
  private applyOpacity(): void {
    const base = Math.floor(this.pos);
    const f = this.pos - base;
    const nearest = Math.round(this.pos);
    for (const [frame, item] of this.items) {
      let o = PRELOAD_OPACITY;
      if (!this.opts.blend) {
        o = frame === nearest ? 1 : PRELOAD_OPACITY;
        // the nearest plane may still be loading: show what is there instead of nothing
        if (!this.items.has(nearest) && Math.abs(frame - this.pos) < 1.0001) o = 1;
      } else if (frame === base) {
        o = 1;
      } else if (frame === base + 1) {
        // blend only when the lower plane is there to blend with; otherwise show this one
        o = this.items.has(base) ? Math.max(f, PRELOAD_OPACITY) : 1;
      } else if (frame === base - 1 && !this.items.has(base) && f === 0) {
        o = 1;
      }
      item.setOpacity(o);
    }
  }
}
