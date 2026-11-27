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


# a region of more pixels than this (at the level it is read from) is read in pieces: 25 MP is 100 MB as RGBA
BIG_REGION = 25_000_000
PIECE = 2048


def read_scaled(slide, level, x, y, w, h, size):
    """The region at (`x`, `y`) (level 0 pixels), `w` x `h` pixels of `level`, as a PIL RGB image of `size`.

    A slide with no pyramid (or one whose levels are missing) offers only level 0, and a region of it read in one piece is tens of
    gigabytes (65 GB were seen). Big regions are read in pieces of 2048 x 2048 and each piece is reduced into the image at once, so that
    memory stays at the size of the result plus one piece."""
    from PIL import Image

    def rgb_of(region):
        rgb = Image.new("RGB", region.size, (255, 255, 255))
        rgb.paste(region, mask=region.split()[3] if region.mode == "RGBA" else None)
        return rgb

    down = slide.level_downsamples[level]
    if w * h <= BIG_REGION:
        rgb = rgb_of(slide.read_region((int(x), int(y)), level, (w, h)))
        return rgb if rgb.size == tuple(size) else rgb.resize(tuple(size), Image.LANCZOS)
    out = Image.new("RGB", tuple(size), (255, 255, 255))
    fx, fy = w / size[0], h / size[1]  # level pixels per pixel of the result
    # pieces are cut at pixels of the result, so that each one is reduced to a whole number of them
    step_x, step_y = max(1, int(PIECE / max(fx, 1.0))), max(1, int(PIECE / max(fy, 1.0)))
    for oy0 in range(0, size[1], step_y):
        oy1 = min(size[1], oy0 + step_y)
        ty0, ty1 = round(oy0 * fy), min(h, round(oy1 * fy))
        for ox0 in range(0, size[0], step_x):
            ox1 = min(size[0], ox0 + step_x)
            tx0, tx1 = round(ox0 * fx), min(w, round(ox1 * fx))
            if tx1 <= tx0 or ty1 <= ty0:
                continue
            piece = rgb_of(slide.read_region((int(x + tx0 * down), int(y + ty0 * down)), level, (tx1 - tx0, ty1 - ty0)))
            out.paste(piece.resize((ox1 - ox0, oy1 - oy0), Image.LANCZOS), (ox0, oy0))
    return out


def render(slide, box, edge):
    """The region `box` = (x, y, w, h) of the slide (level 0 pixels) as a PIL image with its longer side `edge` pixels (or its
    own size when that is smaller). Returns the image and the slide pixels per image pixel (x, y)."""
    x, y, w, h = box
    want = min(edge / max(w, h), 1.0)
    level = 0
    for i, down in enumerate(slide.level_downsamples):  # the coarsest level that still has enough pixels
        if down <= 1.0 / want:
            level = i
    down = slide.level_downsamples[level]
    size = (max(1, round(w * want)), max(1, round(h * want)))
    rgb = read_scaled(slide, level, x, y, max(1, round(w / down)), max(1, round(h / down)), size)
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
