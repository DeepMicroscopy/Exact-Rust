"""Helpers shared by the plugins."""
import sys


def open_slide(path, exact_dir):
    if exact_dir:
        if exact_dir not in sys.path:
            sys.path.insert(0, exact_dir)
        from util.slide_server import getSlideHandler  # EXACT's own reader selection: reads every format EXACT does

        return getSlideHandler(path)
    import openslide

    return openslide.OpenSlide(path)


def render(slide, box, edge):
    """The region `box` = (x, y, w, h) of the slide (level 0 pixels) as a PIL image with its longer side `edge` pixels (or its
    own size when that is smaller). Returns the image and the slide pixels per image pixel (x, y)."""
    from PIL import Image

    x, y, w, h = box
    want = min(edge / max(w, h), 1.0)
    level = 0
    for i, down in enumerate(slide.level_downsamples):  # the coarsest level that still has enough pixels
        if down <= 1.0 / want:
            level = i
    down = slide.level_downsamples[level]
    region = slide.read_region((int(x), int(y)), level, (max(1, round(w / down)), max(1, round(h / down))))
    rgb = Image.new("RGB", region.size, (255, 255, 255))
    rgb.paste(region, mask=region.split()[3] if region.mode == "RGBA" else None)
    size = (max(1, round(w * want)), max(1, round(h * want)))
    if rgb.size != size:
        rgb = rgb.resize(size, Image.LANCZOS)
    return rgb, (w / size[0], h / size[1])


def tissue_box(slide, margin=0.03):
    """Where the tissue is, as (x, y, w, h) in slide pixels: a scan is mostly glass, and registering the whole of it leaves the
    tissue a few hundred pixels of the overview. Found on a coarse overview as everything that is darker than the glass
    (255 - grey > 6 holds for H&E and for very pale IHC); the whole slide when nothing is found."""
    import numpy as np
    from PIL import ImageFilter

    w, h = slide.dimensions
    coarse, (sx, sy) = render(slide, (0, 0, w, h), 1024)
    grey = np.asarray(coarse.convert("L").filter(ImageFilter.MedianFilter(3)), dtype=np.int16)
    ys, xs = np.where(255 - grey > 6)
    if len(xs) < 50:
        return 0, 0, w, h
    x0, x1, y0, y1 = xs.min() * sx, (xs.max() + 1) * sx, ys.min() * sy, (ys.max() + 1) * sy
    mx, my = (x1 - x0) * margin, (y1 - y0) * margin
    x0, y0 = max(0, x0 - mx), max(0, y0 - my)
    x1, y1 = min(w, x1 + mx), min(h, y1 + my)
    return x0, y0, x1 - x0, y1 - y0
