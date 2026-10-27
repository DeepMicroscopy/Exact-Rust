import type OpenSeadragon from "openseadragon";

interface Dzi {
  Image: { xmlns: string; Url: string; Format: string; Overlap: number; TileSize: number; Size: { Width: number; Height: number } };
}

/**
 * Tile source for OpenSeadragon from the server's DeepZoom descriptor. `z` selects the plane (single-file volumes:
 * 1 axial, 2 coronal, 3 sagittal) or the file of a multi-file z-stack, `frame` the frame.
 */
export async function loadTileSource(imageId: number, z: number, frame: number): Promise<OpenSeadragon.Options["tileSources"]> {
  const base = `/api/v2/images/${imageId}/${z}/${frame}`;
  const res = await fetch(`${base}/tile`, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`Cannot open image (${res.status})`);
  const xml = new DOMParser().parseFromString(await res.text(), "application/xml");
  const img = xml.documentElement;
  const size = img.getElementsByTagName("Size")[0];
  const dzi: Dzi = {
    Image: {
      xmlns: "http://schemas.microsoft.com/deepzoom/2008",
      Url: `${base}/tile_files/`,
      Format: img.getAttribute("Format") ?? "jpeg",
      Overlap: Number(img.getAttribute("Overlap") ?? 1),
      TileSize: Number(img.getAttribute("TileSize") ?? 254),
      Size: { Width: Number(size.getAttribute("Width")), Height: Number(size.getAttribute("Height")) },
    },
  };
  return dzi as unknown as OpenSeadragon.Options["tileSources"];
}
