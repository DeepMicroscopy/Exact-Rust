import OpenSeadragon from "openseadragon";

/**
 * The mask of a segmentation annotation on one plane image of a volume: the PNG of `slice/{plane}/{frame}` (the colour of the
 * type, transparent elsewhere) laid over the plane as an OpenSeadragon overlay. A new slice is loaded in the background and
 * swapped in when it is ready, so the mask does not blink while the slices are stepped.
 */
export class MaskOverlay {
  private img: HTMLImageElement;
  private wanted = "";
  private loading: HTMLImageElement | null = null;

  constructor(
    private viewer: OpenSeadragon.Viewer,
    width: number,
    height: number,
    private onShown: () => void = () => undefined,
  ) {
    this.img = document.createElement("img");
    this.img.alt = "";
    this.img.setAttribute("data-testid", "mask-overlay");
    Object.assign(this.img.style, { pointerEvents: "none", imageRendering: "pixelated", width: "100%", height: "100%", display: "block" });
    viewer.addOverlay(this.img, new OpenSeadragon.Rect(0, 0, 1, height / width));
  }

  setOpacity(o: number): void {
    this.img.style.opacity = String(o);
  }

  /** Shows the mask at `url` as soon as it has loaded (the same url twice does nothing). */
  load(url: string): void {
    if (url === this.wanted) return;
    this.wanted = url;
    const next = new Image();
    this.loading = next;
    next.onload = () => {
      if (this.loading !== next) return; // a newer slice was asked for meanwhile
      this.img.src = url;
      this.img.setAttribute("data-url", url);
      this.onShown();
    };
    next.onerror = () => {
      if (this.loading === next) this.onShown();
    };
    next.src = url;
  }

  destroy(): void {
    this.loading = null;
    this.viewer.removeOverlay(this.img);
  }
}
