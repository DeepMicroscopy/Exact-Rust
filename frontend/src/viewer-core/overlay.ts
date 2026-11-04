import OpenSeadragon from "openseadragon";
import { loadTileSource } from "./tileSource";

/** Affine map `[a, b, tx, c, d, ty]` of the registration matrix: x' = a x + b y + tx, y' = c x + d y + ty. */
export type Affine = [number, number, number, number, number, number];

export function affineOf(m: Record<string, number>): Affine | null {
  const k = ["t_00", "t_01", "t_02", "t_10", "t_11", "t_12"].map((n) => m[n]);
  return k.every((v) => Number.isFinite(v)) ? (k as Affine) : null;
}

/** Inverse of the affine map, null if it is singular. */
export function invertAffine([a, b, tx, c, d, ty]: Affine): Affine | null {
  const det = a * d - b * c;
  if (!det || !Number.isFinite(det)) return null;
  const [ia, ib, ic, id] = [d / det, -b / det, -c / det, a / det];
  return [ia, ib, -(ia * tx + ib * ty), ic, id, -(ic * tx + id * ty)];
}

/** The region (image pixels) of the image that `m` maps onto `r` of the other: the bounding box of the mapped corners, kept inside `w` x `h`; null when nothing of it is left. */
export function mappedRegion(m: Affine, r: { x: number; y: number; w: number; h: number }, w: number, h: number): { x: number; y: number; w: number; h: number } | null {
  const [a, b, tx, c, d, ty] = m;
  const pts = [
    [r.x, r.y],
    [r.x + r.w, r.y],
    [r.x, r.y + r.h],
    [r.x + r.w, r.y + r.h],
  ].map(([x, y]) => [a * x + b * y + tx, c * x + d * y + ty]);
  const x1 = Math.max(0, Math.floor(Math.min(...pts.map((p) => p[0]))));
  const y1 = Math.max(0, Math.floor(Math.min(...pts.map((p) => p[1]))));
  const x2 = Math.min(w, Math.ceil(Math.max(...pts.map((p) => p[0]))));
  const y2 = Math.min(h, Math.ceil(Math.max(...pts.map((p) => p[1]))));
  return x2 - x1 >= 1 && y2 - y1 >= 1 ? { x: x1, y: y1, w: x2 - x1, h: y2 - y1 } : null;
}

/**
 * Where an image of `ow` x `oh` pixels goes in the viewport of the current image (`cw` pixels wide = 1 viewport unit)
 * when `m` maps its pixels to the pixels of the current image. OpenSeadragon places an image by a rectangle and a rotation
 * about the rectangle's centre, so the map is reduced to scale, rotation and the image of the centre; a shear or an
 * unequal scale is averaged out (a registration is close to a similarity).
 */
export function overlayPlacement(m: Affine, ow: number, oh: number, cw: number): { x: number; y: number; width: number; degrees: number } {
  const [a, b, tx, c, d, ty] = m;
  const s = Math.sqrt(Math.abs(a * d - b * c));
  const centre = [a * (ow / 2) + b * (oh / 2) + tx, c * (ow / 2) + d * (oh / 2) + ty];
  return {
    x: (centre[0] - (ow * s) / 2) / cw,
    y: (centre[1] - (oh * s) / 2) / cw,
    width: (ow * s) / cw,
    degrees: (Math.atan2(c - b, a + d) * 180) / Math.PI,
  };
}

/** The single registered image shown on top of the current one. */
export class RegistrationOverlay {
  private item: OpenSeadragon.TiledImage | null = null;
  private gone = false;
  private readonly keepOnTop = () => {
    const w = this.viewer.world;
    if (this.item && w.getIndexOfItem(this.item) !== w.getItemCount() - 1 && w.getIndexOfItem(this.item) >= 0) w.setItemIndex(this.item, w.getItemCount() - 1);
  };

  constructor(
    private readonly viewer: OpenSeadragon.Viewer,
    imageId: number,
    placement: ReturnType<typeof overlayPlacement>,
    opacity: number,
    onError: (e: Error) => void,
    /** true until the overlay has been drawn completely for the first time */
    onLoading: (loading: boolean) => void = () => {},
  ) {
    onLoading(true);
    loadTileSource(imageId, 0, 0)
      .then((tileSource) => {
        if (this.gone) return;
        viewer.addTiledImage({
          tileSource: tileSource as OpenSeadragon.TileSourceOptions,
          ...placement,
          opacity,
          success: (ev: unknown) => {
            const e = ev as { item: OpenSeadragon.TiledImage };
            if (this.gone) viewer.world.removeItem(e.item);
            else {
              this.item = e.item;
              this.keepOnTop();
              const done = (e2: { fullyLoaded: boolean }) => {
                if (!e2.fullyLoaded) return;
                this.item?.removeHandler("fully-loaded-change", done);
                onLoading(false);
              };
              if (e.item.getFullyLoaded()) onLoading(false);
              else e.item.addHandler("fully-loaded-change", done as (ev: unknown) => void);
            }
          },
          error: () => {
            onLoading(false);
            onError(new Error("Cannot load the overlay image"));
          },
        });
      })
      .catch((e: Error) => {
        onLoading(false);
        onError(e);
      });
    viewer.world.addHandler("add-item", this.keepOnTop);
  }

  setOpacity(v: number) {
    this.item?.setOpacity(v);
  }

  destroy() {
    this.gone = true;
    this.viewer.world.removeHandler("add-item", this.keepOnTop);
    if (this.item) this.viewer.world.removeItem(this.item);
    this.item = null;
  }
}
