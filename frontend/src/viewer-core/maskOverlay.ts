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
  /** the mask that has loaded but waits for the image of its frame to be on display */
  private ready: { url: string; frame: number } | null = null;
  private displayed: number | null = null;

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

  /**
   * Shows the mask at `url` (the mask of plane `frame`) once it has loaded and the image of that frame is on display: the mask
   * comes from a small PNG and is there long before the tiles of the image, and must not run ahead of them. The mask on display
   * stays until then. The same url twice does nothing.
   */
  load(url: string, frame: number): void {
    if (url === this.wanted) return;
    this.wanted = url;
    this.ready = null;
    const next = new Image();
    this.loading = next;
    next.onload = () => {
      if (this.loading !== next) return; // a newer slice was asked for meanwhile
      this.ready = { url, frame };
      this.show();
    };
    next.onerror = () => {
      if (this.loading === next) this.onShown();
    };
    next.src = url;
  }

  /** The image of `frame` is on display now. */
  setDisplayed(frame: number): void {
    this.displayed = frame;
    this.show();
  }

  private show(): void {
    const r = this.ready;
    if (!r || (this.displayed != null && r.frame !== this.displayed)) return;
    this.ready = null;
    this.img.src = r.url;
    this.img.setAttribute("data-url", r.url);
    this.onShown();
  }

  destroy(): void {
    this.loading = null;
    this.viewer.removeOverlay(this.img);
  }
}
