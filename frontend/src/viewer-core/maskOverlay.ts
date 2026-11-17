import OpenSeadragon from "openseadragon";
import { darker } from "./shade";

/**
 * The mask of a segmentation annotation on one plane image of a volume: the PNG of `slice/{plane}/{frame}` (the colour of the
 * type, transparent elsewhere) laid over the plane as an OpenSeadragon overlay. A new slice is loaded in the background and
 * swapped in when it is ready, so the mask does not blink while the slices are stepped.
 */
export class MaskOverlay {
  private img: HTMLElement;
  private stripes: boolean;
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
    /** a colour (#rrggbb): the mask is drawn in stripes of this colour and a darker one, not solid (the masks that are shown but not painted) */
    stripeColor?: string,
  ) {
    this.stripes = !!stripeColor;
    if (stripeColor) {
      const div = document.createElement("div");
      // the PNG gives the shape (its alpha), the gradient the colours; the stripes keep their size on screen
      Object.assign(div.style, { background: `repeating-linear-gradient(135deg, ${stripeColor} 0, ${stripeColor} 4px, ${darker(stripeColor)} 4px, ${darker(stripeColor)} 8px)`, maskSize: "100% 100%", maskRepeat: "no-repeat" });
      div.style.setProperty("-webkit-mask-size", "100% 100%");
      div.style.setProperty("-webkit-mask-repeat", "no-repeat");
      div.setAttribute("data-striped", "1");
      this.img = div;
    } else {
      this.img = document.createElement("img");
      (this.img as HTMLImageElement).alt = "";
      this.img.setAttribute("data-striped", "0");
    }
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
    if (this.stripes) {
      this.img.style.maskImage = `url("${r.url}")`;
      this.img.style.setProperty("-webkit-mask-image", `url("${r.url}")`);
    } else (this.img as HTMLImageElement).src = r.url;
    this.img.setAttribute("data-url", r.url);
    this.onShown();
  }

  destroy(): void {
    this.loading = null;
    this.viewer.removeOverlay(this.img);
  }
}

