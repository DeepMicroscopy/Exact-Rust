/**
 * OpenSeadragon 4.1 starts one tile download per animation frame: of everything the view still lacks it picks the best tile and
 * loads that, then waits for the next frame for the next one. A frame of a large view takes tens of milliseconds, so a screen that
 * needs 60 tiles is filled in over seconds (measured: 54 tiles of a slide over 3 s, each answered by the server in 2 ms). This
 * patches `TiledImage._updateViewport` to load the best few missing tiles per frame instead of the single best one.
 *
 * It touches private members of the pinned OpenSeadragon version; when they are not there, nothing is changed.
 */

export interface TileLike {
  loaded?: boolean;
  loading?: boolean;
  context2D?: unknown;
}

export interface TiledImageLike {
  _compareTiles?: (previousBest: TileLike | null, tile: TileLike) => TileLike;
  _loadTile?: (tile: TileLike, time: number) => void;
  _updateViewport?: () => void;
  _tilesLoading: number;
  _needsDraw: boolean;
}

/** Tiles started per frame besides the best one that OpenSeadragon starts itself, and tiles in flight at most (more would only queue in the browser behind tiles of a view that is gone). */
export const PER_FRAME = 8;
export const IN_FLIGHT = 16;

let patched: object | null = null;

/** Returns true when the prototype was patched (once per prototype). */
export function loadTilesInParallel(proto: TiledImageLike | undefined, now: () => number = () => Date.now()): boolean {
  if (!proto || patched === proto) return false;
  const update = proto._updateViewport;
  const compare = proto._compareTiles;
  const load = proto._loadTile;
  if (typeof update !== "function" || typeof compare !== "function" || typeof load !== "function") return false;
  patched = proto;
  proto._updateViewport = function (this: TiledImageLike) {
    const found: TileLike[] = [];
    // every tile that is missing and could be loaded passes through the comparison that picks the best one
    this._compareTiles = (previousBest, tile) => {
      found.push(tile);
      return compare.call(this, previousBest, tile);
    };
    try {
      update.call(this);
    } finally {
      delete this._compareTiles;
    }
    const room = Math.min(PER_FRAME, IN_FLIGHT - this._tilesLoading);
    if (room <= 0 || found.length < 2) return;
    // best first, by the order OpenSeadragon itself uses
    found.sort((a, b) => (a === b ? 0 : compare.call(this, a, b) === a ? -1 : 1));
    const time = now();
    let started = 0;
    for (const tile of found) {
      if (started >= room) break;
      if (tile.loaded || tile.loading || tile.context2D) continue; // the best one is already on its way
      load.call(this, tile, time);
      started++;
    }
    if (started) this._needsDraw = true;
  };
  return true;
}
