import OpenSeadragon from "openseadragon";
import { loadTilesInParallel, type TiledImageLike } from "./tileLoading";

// imported for its effect by every page that makes a viewer: tiles are fetched several per frame instead of one
loadTilesInParallel((OpenSeadragon as unknown as { TiledImage?: { prototype: TiledImageLike } }).TiledImage?.prototype);
