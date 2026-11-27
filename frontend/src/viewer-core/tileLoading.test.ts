import { describe, expect, it } from "vitest";
import { IN_FLIGHT, loadTilesInParallel, PER_FRAME, type TileLike, type TiledImageLike } from "./tileLoading";

type T = TileLike & { id: number; visibility: number };

/** A TiledImage with the behaviour of OpenSeadragon 4.1: it offers every missing tile to `_compareTiles` and loads the best one. */
function fake(n: number, loadingAlready = 0) {
  const tiles: T[] = Array.from({ length: n }, (_, id) => ({ id, visibility: id }));
  const loaded: number[] = [];
  const proto: TiledImageLike & { tiles: T[] } = {
    tiles,
    _tilesLoading: 0,
    _needsDraw: false,
    _compareTiles(previous, tile) {
      return !previous || (tile as T).visibility > (previous as T).visibility ? tile : previous;
    },
    _loadTile(tile) {
      tile.loading = true;
      loaded.push((tile as T).id);
    },
    _updateViewport() {
      this._tilesLoading = loadingAlready;
      let best: TileLike | null = null;
      for (const t of tiles) if (!t.loading && !t.loaded) best = this._compareTiles!(best, t);
      if (best) this._loadTile!(best, 0);
    },
  };
  return { proto, loaded };
}

describe("loadTilesInParallel", () => {
  it("starts the best few missing tiles per frame, best first, none twice", () => {
    const { proto, loaded } = fake(30);
    expect(loadTilesInParallel(proto)).toBe(true);
    proto._updateViewport!();
    // the best one (highest visibility = 29) and then the next ones in order
    expect(loaded).toHaveLength(1 + PER_FRAME); // OpenSeadragon's own pick and PER_FRAME more
    expect(loaded[0]).toBe(29);
    expect(loaded).toEqual([29, 28, 27, 26, 25, 24, 23, 22, 21]);
    expect(new Set(loaded).size).toBe(loaded.length);
    expect(proto._needsDraw).toBe(true);
    // the next frame goes on where this one stopped
    proto._updateViewport!();
    expect(loaded).toHaveLength(2 * (1 + PER_FRAME));
  });

  it("stays below the number of tiles in flight", () => {
    const { proto, loaded } = fake(30, IN_FLIGHT - 2);
    loadTilesInParallel(proto);
    proto._updateViewport!();
    expect(loaded).toHaveLength(1 + 2); // the best one OpenSeadragon starts anyway, plus the 2 that fit
    const full = fake(30, IN_FLIGHT);
    loadTilesInParallel(full.proto);
    full.proto._updateViewport!();
    expect(full.loaded).toHaveLength(1); // only OpenSeadragon's own pick
  });

  it("leaves the prototype alone when it is not OpenSeadragon 4.1, and is applied once", () => {
    expect(loadTilesInParallel(undefined)).toBe(false);
    expect(loadTilesInParallel({ _tilesLoading: 0, _needsDraw: false })).toBe(false);
    const { proto } = fake(3);
    expect(loadTilesInParallel(proto)).toBe(true);
    expect(loadTilesInParallel(proto)).toBe(false);
  });
});
