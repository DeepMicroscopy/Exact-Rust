"""Classical refinement of an affine registration of two slides (numpy, OpenCV; no torch).

A feature based alignment (DeeperHistReg, SIFT) gets two sections of one block roughly on top of each other, typically a few
pixels of an overview off, which is hundreds of pixels at full resolution. This module takes such a matrix and improves it in two
stages, both on the slides themselves and not on the overview the first estimate was made on:

1. **Pyramid.** From a coarse to a fine resolution (a few hundred pixels to a few thousand across the tissue): the source is
   warped into the target's frame with the current matrix, both are turned into *structure images* (gradient magnitude of the optical
   density: the same for a dark nucleus whatever the stain, so H&E against an immunostain still correlates), and the enhanced
   correlation coefficient (ECC, Evangelidis and Psarakis 2008) finds the affine correction that makes them agree best. Each level starts
   from the result of the one before, so the capture range of the coarse levels carries the fine ones.
2. **Tiles.** At the finest level the tissue is cut into overlapping tiles; the shift of each tile is measured by phase correlation,
   the shifts are the correspondences of a robust (RANSAC) affine fit, and the fit corrects the matrix. This is repeated a few times,
   each recursion measuring on a source warped by the improved matrix, until the shifts stop shrinking. Unlike the global ECC it does
   not care if a part of the sections differs (a fold, a missing piece): those tiles are outliers.

Every step is accepted only if it makes the two images agree better, so a refinement can fail to improve, but not make things worse.
Matrices are 3x3 (row major), source slide pixels (level 0) to target slide pixels.
"""
from dataclasses import dataclass, field

import cv2
import numpy as np

cv2.setNumThreads(max(1, cv2.getNumThreads()))


@dataclass
class Options:
    coarse_edge: int = 512  # longer side (px) of the tissue box at the first pyramid level
    work_edge: int = 4096  # ... and at the finest level, where the tiles are measured
    tile: int = 192  # side (px) of a tile at the finest level
    rounds: int = 3  # tile recursions
    min_cc: float = 0.05  # a level whose images correlate less than this after the step is not trusted
    max_shift: float = 0.35  # largest accepted correction of one pyramid step, as a fraction of the box
    max_deform: float = 0.25  # largest accepted change of scale or shear of the linear part in one step (coarse levels)
    fine_scale: float = 4.0  # slide pixels per pixel at the finest patch level (the patch stage goes 16, 8, ... down to this)
    patch: int = 320  # side (px) of a patch
    patch_grid: int = 10  # patches are picked one per cell of a grid of this many cells per side, where the tissue is richest


@dataclass
class Report:
    """What the refinement did, for the log and for the registration error."""
    steps: list = field(default_factory=list)
    error: float = 0.0  # median distance (target slide pixels) between what the tiles show and where the matrix puts it
    inliers: int = 0
    refined: bool = False

    def add(self, text):
        self.steps.append(text)


# ---------------------------------------------------------------------------------------------------------------------------------
# images
# ---------------------------------------------------------------------------------------------------------------------------------

def estimate_tissue(rgb):
    """What separates tissue from glass on a slide, from an overview of the whole of it: the colour of the glass (the brightest 5 % of the
    picture: a scan's background is rarely white) and the distance from it that tissue is beyond, found by Otsu's method so that
    the very pale tissue of an immunostain is found as well as dark H&E; never below 5 grey levels (noise). Estimated once per slide: on a
    patch that lies inside the tissue, the brightest pixels are tissue."""
    g = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    bright = g >= np.percentile(g[::3, ::3], 95)
    glass = np.median(rgb[bright].astype(np.float32), axis=0)
    dist = np.linalg.norm(rgb.astype(np.float32) - glass, axis=2)
    d8 = np.clip(cv2.GaussianBlur(dist, (0, 0), 1.0) * 8, 0, 255).astype(np.uint8)
    t, _ = cv2.threshold(d8, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    return glass, max(t / 8.0, 5.0)


def tissue_mask(rgb, tissue=None):
    """Where there is tissue (not glass): where the colour is further from the glass's than the threshold. `tissue` is what
    `estimate_tissue` found for the slide; without it the picture itself is taken as an overview of the slide."""
    glass, thr = tissue or estimate_tissue(rgb)
    dist = np.linalg.norm(rgb.astype(np.float32) - np.asarray(glass, np.float32), axis=2)
    m = (cv2.GaussianBlur(dist, (0, 0), 1.0) > thr).astype(np.uint8)
    m = cv2.medianBlur(m * 255, 5)
    # faint tissue (an immunostain) comes out in patches: close them, a piece of tissue is one region
    k = max(5, min(m.shape) // 50) | 1
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    return m > 0


def structure(rgb, sigma=1.2, tissue=None):
    """The picture the two slides are compared on: gradient magnitude of the blurred optical density, scaled to 0..1 by its 99th
    percentile over the tissue. Polarity free, so unlike intensities it agrees between stains. Returns it and the tissue mask."""
    g = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY).astype(np.float32) / 255.0
    od = -np.log(np.clip(g, 1.0 / 255.0, 1.0))
    s = cv2.GaussianBlur(od, (0, 0), sigma)
    gx, gy = cv2.Sobel(s, cv2.CV_32F, 1, 0, ksize=3), cv2.Sobel(s, cv2.CV_32F, 0, 1, ksize=3)
    mag = np.sqrt(gx * gx + gy * gy)
    m = tissue_mask(rgb, tissue)
    top = np.percentile(mag[m], 99) if m.sum() > 100 else mag.max()
    return np.clip(mag / (top + 1e-6), 0.0, 1.0).astype(np.float32), m


def ncc(a, b, mask):
    """Normalised cross correlation of two images over a mask (-1..1)."""
    if mask.sum() < 50:
        return -1.0
    x, y = a[mask].astype(np.float64), b[mask].astype(np.float64)
    x, y = x - x.mean(), y - y.mean()
    d = np.sqrt((x * x).sum() * (y * y).sum())
    return float((x * y).sum() / d) if d > 0 else -1.0


# ---------------------------------------------------------------------------------------------------------------------------------
# slides
# ---------------------------------------------------------------------------------------------------------------------------------

class SlideReader:
    """Reads regions of an OpenSlide-like slide (`dimensions`, `level_downsamples`, `read_region`) at a chosen scale."""

    def __init__(self, slide):
        self.slide = slide
        self.size = tuple(int(v) for v in slide.dimensions)
        self._tissue = None

    @property
    def tissue(self):
        """What separates tissue from glass on this slide (`estimate_tissue` of an overview), found once."""
        if self._tissue is None:
            w, h = self.size
            rgb, _ = self.render((0, 0, w, h), max(max(w, h) / 1500, 1.0))
            self._tissue = estimate_tissue(rgb)
        return self._tissue

    def render(self, box, scale):
        """The region `box` = (x, y, w, h) (slide pixels) as an RGB uint8 array, `scale` slide pixels per image pixel. Returns the
        array and the exact scale (x, y), which differs slightly from `scale` by the rounding of the size."""
        from PIL import Image

        x, y, w, h = box
        level = 0
        for i, down in enumerate(self.slide.level_downsamples):  # the coarsest level that still has the resolution
            if down <= scale:
                level = i
        down = self.slide.level_downsamples[level]
        region = self.slide.read_region((int(x), int(y)), level, (max(1, round(w / down)), max(1, round(h / down))))
        rgb = Image.new("RGB", region.size, (255, 255, 255))
        rgb.paste(region, mask=region.split()[3] if region.mode == "RGBA" else None)
        size = (max(1, round(w / scale)), max(1, round(h / scale)))
        if rgb.size != size:
            rgb = rgb.resize(size, Image.LANCZOS)
        return np.asarray(rgb), (w / size[0], h / size[1])


class ArrayReader:
    """The same for an RGB array that is the whole slide (tests, and anything already in memory)."""

    def __init__(self, img):
        self.img = img
        self.size = (img.shape[1], img.shape[0])
        self.tissue = estimate_tissue(cv2.resize(img, None, fx=min(1.0, 1500 / max(img.shape[:2])), fy=min(1.0, 1500 / max(img.shape[:2])), interpolation=cv2.INTER_AREA))

    def render(self, box, scale):
        x, y, w, h = box
        x0, y0 = int(round(x)), int(round(y))
        crop = np.full((int(round(h)), int(round(w)), 3), 255, np.uint8)
        sx0, sy0 = max(0, x0), max(0, y0)
        sx1, sy1 = min(self.size[0], x0 + crop.shape[1]), min(self.size[1], y0 + crop.shape[0])
        if sx1 > sx0 and sy1 > sy0:
            crop[sy0 - y0:sy1 - y0, sx0 - x0:sx1 - x0] = self.img[sy0:sy1, sx0:sx1]
        size = (max(1, round(crop.shape[1] / scale)), max(1, round(crop.shape[0] / scale)))
        out = cv2.resize(crop, size, interpolation=cv2.INTER_AREA) if scale > 1 else cv2.resize(crop, size, interpolation=cv2.INTER_LINEAR)
        return out, (crop.shape[1] / size[0], crop.shape[0] / size[1])


def tissue_bounds(slide_reader, margin=0.03, edge=1500):
    """Where the tissue is on a slide, as (x, y, w, h) in slide pixels: the bounding box of the pieces of tissue that are not specks
    (a label, dust, the border of the slide make the simple threshold of `plugins_common.tissue_box` return the whole slide)."""
    w, h = slide_reader.size
    scale = max(w, h) / edge
    rgb, (sx, sy) = slide_reader.render((0, 0, w, h), max(scale, 1.0))
    m = tissue_mask(rgb, slide_reader.tissue).astype(np.uint8)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(m, connectivity=8)
    if n <= 1:
        return 0, 0, w, h
    areas = stats[1:, cv2.CC_STAT_AREA]
    keep = [i + 1 for i, a in enumerate(areas) if a >= max(25, 0.02 * areas.max())]
    x0 = min(stats[i, cv2.CC_STAT_LEFT] for i in keep)
    y0 = min(stats[i, cv2.CC_STAT_TOP] for i in keep)
    x1 = max(stats[i, cv2.CC_STAT_LEFT] + stats[i, cv2.CC_STAT_WIDTH] for i in keep)
    y1 = max(stats[i, cv2.CC_STAT_TOP] + stats[i, cv2.CC_STAT_HEIGHT] for i in keep)
    mx, my = (x1 - x0) * margin, (y1 - y0) * margin
    bx0, by0 = max(0.0, (x0 - mx) * sx), max(0.0, (y0 - my) * sy)
    bx1, by1 = min(float(w), (x1 + mx) * sx), min(float(h), (y1 + my) * sy)
    return bx0, by0, bx1 - bx0, by1 - by0


# ---------------------------------------------------------------------------------------------------------------------------------
# geometry
# ---------------------------------------------------------------------------------------------------------------------------------

def _grid(box, scale_xy):
    """3x3: slide pixels -> pixels of an image rendered from `box` at `scale_xy`."""
    x, y, _, _ = box
    return np.array([[1 / scale_xy[0], 0, -x / scale_xy[0]], [0, 1 / scale_xy[1], -y / scale_xy[1]], [0, 0, 1]], dtype=np.float64)


def _apply(m, pts):
    p = np.asarray(pts, dtype=np.float64).reshape(-1, 2)
    q = p @ m[:2, :2].T + m[:2, 2]
    return q


@dataclass
class Level:
    """The two slides on the grid of the target region at one scale: `target` and `source` (warped into it by the matrix) as RGB,
    their structure images and the mask of where both have tissue; `grid` maps target slide pixels to this grid."""
    target: np.ndarray
    source: np.ndarray
    ft: np.ndarray
    fs: np.ndarray
    mask: np.ndarray
    grid: np.ndarray
    scale: tuple


def make_level(src, tgt, m, box, scale, sigma=1.2):
    """Renders `box` of the target at `scale` and the part of the source that `m` puts there, warped onto the same grid."""
    t_rgb, t_scale = tgt.render(box, scale)
    h, w = t_rgb.shape[:2]
    inv = np.linalg.inv(m)
    corners = _apply(inv, [(box[0], box[1]), (box[0] + box[2], box[1]), (box[0], box[1] + box[3]), (box[0] + box[2], box[1] + box[3])])
    x0, y0 = np.floor(corners.min(axis=0)).astype(int)
    x1, y1 = np.ceil(corners.max(axis=0)).astype(int)
    x0, y0, x1, y1 = max(0, x0), max(0, y0), min(src.size[0], x1), min(src.size[1], y1)
    if x1 - x0 < 8 or y1 - y0 < 8:
        return None
    k = np.sqrt(abs(np.linalg.det(m[:2, :2])))  # target pixels per source pixel: render the source at the same pixel density
    s_rgb, s_scale = src.render((x0, y0, x1 - x0, y1 - y0), scale / max(k, 1e-6))
    h_mat = _grid(box, t_scale) @ m @ np.linalg.inv(_grid((x0, y0, 0, 0), s_scale))
    warped = cv2.warpAffine(s_rgb, h_mat[:2], (w, h), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=tuple(float(v) for v in src.tissue[0]))
    valid = cv2.warpAffine(np.full(s_rgb.shape[:2], 255, np.uint8), h_mat[:2], (w, h), flags=cv2.INTER_NEAREST) > 0
    ft, mt = structure(t_rgb, sigma, tgt.tissue)
    fs, ms = structure(warped, sigma, src.tissue)
    return Level(t_rgb, warped, ft, fs, mt & ms & valid, _grid(box, t_scale), t_scale)


def _correct(m, w_grid, level):
    """The matrix after the correction `w_grid` (2x3 or 3x3, target grid pixels -> warped source grid pixels, as ECC and the tile fit
    give it): target content at x is found in the warped source at W x, so the slides' mapping becomes W^-1 M."""
    w3 = np.vstack([w_grid[:2], [0, 0, 1]]) if w_grid.shape[0] == 2 else w_grid
    w0 = np.linalg.inv(level.grid) @ w3 @ level.grid  # the same in target slide pixels
    return np.linalg.inv(w0) @ m, w0


# ---------------------------------------------------------------------------------------------------------------------------------
# stage 1: pyramid of ECC steps
# ---------------------------------------------------------------------------------------------------------------------------------

def ecc_step(level):
    """The affine W (2x3, target grid -> warped source grid) that makes the structure images agree best, and their correlation after
    it; None when ECC does not converge (too little in common)."""
    w = np.eye(2, 3, dtype=np.float32)
    crit = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 200, 1e-6)
    try:
        cc, w = cv2.findTransformECC(level.ft, level.fs, w, cv2.MOTION_AFFINE, crit, level.mask.astype(np.uint8) * 255, 5)
    except cv2.error:
        return None, -1.0
    return w.astype(np.float64), float(cc)


def pyramid(src, tgt, m, box, opt, rep, log=print):
    longest = max(box[2], box[3])
    edges, e = [], opt.coarse_edge
    while e < opt.work_edge:
        edges.append(e)
        e *= 2
    edges.append(opt.work_edge)
    for edge in edges:
        scale = max(longest / edge, 1.0)
        lv = make_level(src, tgt, m, box, scale)
        if lv is None:
            rep.add(f"{edge}px: no overlap")
            continue
        before = ncc(lv.ft, lv.fs, lv.mask)
        w, cc = ecc_step(lv)
        if w is None:
            rep.add(f"{edge}px: ECC found nothing (correlation {before:.3f})")
            continue
        nm, w0 = _correct(m, w, lv)
        shift = np.hypot(*(w0[:2, 2] + (w0[:2, :2] - np.eye(2)) @ [box[0] + box[2] / 2, box[1] + box[3] / 2]))
        deform = np.abs(w0[:2, :2] - np.eye(2)).max()
        after = ncc(lv.ft, cv2.warpAffine(lv.fs, w, lv.ft.shape[::-1], flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP, borderValue=0), lv.mask)
        limit = opt.max_deform * (0.2 if edge >= 2048 else 1.0)
        if after < max(before - 0.01, opt.min_cc) or shift > opt.max_shift * longest or deform > limit:
            rep.add(f"{edge}px: step refused (correlation {before:.3f} -> {after:.3f}, moves {shift:.0f} px, deformation {deform:.3f})")
            continue
        rep.add(f"{edge}px: correlation {before:.3f} -> {after:.3f}, moved {shift:.1f} px")
        m = nm
    return m


# ---------------------------------------------------------------------------------------------------------------------------------
# stage 2: tiles
# ---------------------------------------------------------------------------------------------------------------------------------

def tile_shifts(level, tile, min_fill=0.35):
    """Measures the shift of tiles between the two structure images by phase correlation. Returns the tile centres (target grid
    pixels), where the same content is in the warped source (centre + shift), and the correlation peak of each."""
    h, w = level.ft.shape
    step = tile // 2
    win = cv2.createHanningWindow((tile, tile), cv2.CV_32F)
    pts, to, resp = [], [], []
    for y in range(0, h - tile + 1, step):
        for x in range(0, w - tile + 1, step):
            if level.mask[y:y + tile, x:x + tile].mean() < min_fill:
                continue
            a, b = level.ft[y:y + tile, x:x + tile], level.fs[y:y + tile, x:x + tile]
            if a.std() < 1e-3 or b.std() < 1e-3:
                continue
            (dx, dy), r = cv2.phaseCorrelate(a, b, win)
            pts.append((x + tile / 2, y + tile / 2))
            to.append((x + tile / 2 + dx, y + tile / 2 + dy))
            resp.append(r)
    return np.array(pts, dtype=np.float64).reshape(-1, 2), np.array(to, dtype=np.float64).reshape(-1, 2), np.array(resp)


def tile_fit(pts, to, resp, tile, keep=0.7):
    """A robust affine map from the tile centres to where they are found (RANSAC over the better part of the tiles) and its inliers."""
    if len(pts) < 12:
        return None, 0, np.zeros(len(pts), bool)
    best = resp >= np.quantile(resp, 1 - keep)
    p, q = pts[best], to[best]
    w, inl = cv2.estimateAffine2D(p, q, method=cv2.RANSAC, ransacReprojThreshold=max(1.0, tile / 48), maxIters=4000, confidence=0.999, refineIters=20)
    if w is None or inl.sum() < 8:
        return None, 0, np.zeros(len(pts), bool)
    mask = np.zeros(len(pts), bool)
    mask[np.where(best)[0][inl.ravel() > 0]] = True
    return w, int(inl.sum()), mask


def tiles(src, tgt, m, box, opt, rep, log=print):
    longest = max(box[2], box[3])
    scale = max(longest / opt.work_edge, 1.0)
    last = None
    for r in range(opt.rounds):
        lv = make_level(src, tgt, m, box, scale)
        if lv is None:
            break
        pts, to, resp = tile_shifts(lv, opt.tile)
        w, n, inl = tile_fit(pts, to, resp, opt.tile)
        # the typical remaining shift of the tiles that agree on a common motion: what is left to correct
        resid = np.linalg.norm(to - pts, axis=1)[inl] if n else np.array([])
        now = float(np.median(resid)) if len(resid) else None
        if w is None:
            rep.add(f"tiles {r + 1}: too few usable tiles ({len(pts)}), kept")
            break
        if last is not None and now is not None and now >= last * 0.98:
            rep.add(f"tiles {r + 1}: shifts no longer shrink ({now:.2f} px), done")
            break
        nm, w0 = _correct(m, w, lv)
        deform = np.abs(w0[:2, :2] - np.eye(2)).max()
        if deform > 0.03:
            rep.add(f"tiles {r + 1}: correction of {deform:.3f} in scale or shear refused")
            break
        rep.add(f"tiles {r + 1}: {n} of {len(pts)} tiles agree, median shift {now:.2f} px (grid {scale:.1f} slide px each)")
        m, last = nm, now
        rep.inliers = n
    return m


# ---------------------------------------------------------------------------------------------------------------------------------
# stage 3: patches at (nearly) full resolution
# ---------------------------------------------------------------------------------------------------------------------------------

def choose_patches(level, box, side_l0, n):
    """Centres (target slide pixels) of up to n*n patches of `side_l0` slide pixels: one per cell of a grid over the box, where the
    structure of the tissue is richest, and only where a patch is mostly tissue of both slides."""
    h, w = level.ft.shape
    win = max(8, int(round(side_l0 / level.scale[0])))
    if win >= min(h, w):
        return []
    rich = cv2.boxFilter(level.ft * level.mask, -1, (win, win), normalize=True, borderType=cv2.BORDER_CONSTANT)
    fill = cv2.boxFilter(level.mask.astype(np.float32), -1, (win, win), normalize=True, borderType=cv2.BORDER_CONSTANT)
    rich[fill < 0.6] = 0
    rich[: win // 2, :] = 0
    rich[-win // 2:, :] = 0
    rich[:, : win // 2] = 0
    rich[:, -win // 2:] = 0
    out = []
    ys, xs = np.linspace(0, h, n + 1).astype(int), np.linspace(0, w, n + 1).astype(int)
    for i in range(n):
        for j in range(n):
            cell = rich[ys[i]:ys[i + 1], xs[j]:xs[j + 1]]
            if cell.size == 0 or cell.max() <= 0.02:
                continue
            cy, cx = np.unravel_index(int(cell.argmax()), cell.shape)
            gx, gy = (xs[j] + cx + 0.5, ys[i] + cy + 0.5)
            out.append(tuple(_apply(np.linalg.inv(level.grid), [(gx, gy)])[0]))
    return out


def patch_shifts(src, tgt, m, centres, scale, patch):
    """Phase correlation of a patch around each centre, rendered at `scale` slide pixels per pixel. Returns the centres that gave a
    reliable answer (target slide pixels), where the same content is in the warped source (slide pixels: centre + shift) and the peak."""
    side = patch * scale
    win = cv2.createHanningWindow((patch, patch), cv2.CV_32F)
    pts, to, resp = [], [], []
    for cx, cy in centres:
        box = (cx - side / 2, cy - side / 2, side, side)
        if box[0] < 0 or box[1] < 0 or box[0] + side > tgt.size[0] or box[1] + side > tgt.size[1]:
            continue
        lv = make_level(src, tgt, m, box, scale)
        if lv is None or lv.ft.shape != (patch, patch) or lv.mask.mean() < 0.5:
            continue
        a, b = lv.ft, lv.fs
        if a.std() < 1e-3 or b.std() < 1e-3:
            continue
        (dx, dy), r = cv2.phaseCorrelate(a, b, win)
        if abs(dx) > patch / 4 or abs(dy) > patch / 4:  # more than a quarter of the patch: the peak is not to be believed
            continue
        pts.append((cx, cy))
        to.append((cx + dx * lv.scale[0], cy + dy * lv.scale[1]))
        resp.append(r)
    return np.array(pts, dtype=np.float64).reshape(-1, 2), np.array(to, dtype=np.float64).reshape(-1, 2), np.array(resp)


def patch_fit(pts, to, resp, scale, keep=0.8):
    """RANSAC affine map (target slide pixels -> where the content is) over the patches; the threshold is about a pixel of the level."""
    if len(pts) < 10:
        return None, np.zeros(len(pts), bool)
    best = resp >= np.quantile(resp, 1 - keep)
    p, q = pts[best], to[best]
    w, inl = cv2.estimateAffine2D(p, q, method=cv2.RANSAC, ransacReprojThreshold=max(1.5 * scale, 2.0), maxIters=4000, confidence=0.999, refineIters=20)
    if w is None or inl.sum() < 8:
        return None, np.zeros(len(pts), bool)
    mask = np.zeros(len(pts), bool)
    mask[np.where(best)[0][inl.ravel() > 0]] = True
    return w, mask


def patch_error(pts, to, w, inl):
    """How far off a matrix is where the patches agree on a common motion: the median shift (slide pixels) of those patches against the
    matrix. It is what the common motion would still correct, so ~0 for an exact matrix; the noise of the measurement is about
    a fifth of a pixel of the level."""
    if w is None or not inl.any():
        return float("nan")
    return float(np.median(np.linalg.norm(to - pts, axis=1)[inl]))


def patches(src, tgt, m, box, opt, rep, log=print):
    longest = max(box[2], box[3])
    scale0 = max(longest / opt.work_edge, 1.0)
    base = make_level(src, tgt, m, box, scale0)
    if base is None:
        return m
    scales, s = [], 16.0
    while s > opt.fine_scale * 1.01:
        scales.append(s)
        s /= 2
    scales.append(max(opt.fine_scale, 1.0))
    scales = [s for s in scales if s < scale0 * 0.9] or scales[-1:]
    centres = choose_patches(base, box, opt.patch * scales[-1] * 1.0, opt.patch_grid)
    if len(centres) < 10:
        rep.add(f"patches: only {len(centres)} places with enough tissue, skipped")
        return m
    for s in scales:
        pts, to, resp = patch_shifts(src, tgt, m, centres, s, opt.patch)
        w, inl = patch_fit(pts, to, resp, s)
        if w is None:
            rep.add(f"patches at {s:g} px: {len(pts)} usable of {len(centres)}, too few to fit")
            continue
        shift = float(np.median(np.linalg.norm(to - pts, axis=1)[inl]))
        grid = np.diag([1.0, 1.0, 1.0])  # the fit is in slide pixels already
        nm, w0 = _correct(m, w, Level(None, None, None, None, None, grid, (s, s)))
        deform = np.abs(w0[:2, :2] - np.eye(2)).max()
        if deform > 0.02:
            rep.add(f"patches at {s:g} px: correction of {deform:.3f} in scale or shear refused")
            continue
        rep.add(f"patches at {s:g} px: {int(inl.sum())} of {len(centres)} patches agree, median shift {shift:.1f} slide px, corrected")
        m = nm
    return m


def patch_measure(src, tgt, m, box, opt):
    """The remaining error of a matrix at the finest patch level: the median shift (slide pixels) of the patches that agree on a common
    motion against the matrix, and how many do."""
    longest = max(box[2], box[3])
    base = make_level(src, tgt, m, box, max(longest / opt.work_edge, 1.0))
    s = max(opt.fine_scale, 1.0)
    if base is None:
        return float("nan"), 0
    centres = choose_patches(base, box, opt.patch * s, opt.patch_grid)
    pts, to, resp = patch_shifts(src, tgt, m, centres, s, opt.patch)
    w, inl = patch_fit(pts, to, resp, s)
    return patch_error(pts, to, w, inl), int(inl.sum())


def measure(src, tgt, m, box, opt):
    """The remaining disagreement of a matrix: median shift (target slide pixels) of the tiles that agree, and how many do."""
    longest = max(box[2], box[3])
    scale = max(longest / opt.work_edge, 1.0)
    lv = make_level(src, tgt, m, box, scale)
    if lv is None:
        return float("nan"), 0
    pts, to, resp = tile_shifts(lv, opt.tile)
    w, n, inl = tile_fit(pts, to, resp, opt.tile)
    if w is None:
        return float("nan"), 0
    # the residual of the tiles about the best common motion, in slide pixels
    fit = pts @ w[:, :2].T + w[:, 2]
    r = np.linalg.norm(to - fit, axis=1)[inl]
    return float(np.median(r) * np.mean(lv.scale)), n


def refine(src, tgt, m0, box, opt=None, log=print):
    """Improves `m0` (source -> target slide pixels) by the pyramid, the tiles and the patches. `box` is the tissue of the target
    (x, y, w, h). Returns the new matrix and a `Report` (`error`: what the patches still disagree by, in slide pixels); the matrix is
    `m0` unchanged when the refinement found nothing better."""
    opt = opt or Options()
    rep = Report()
    m0 = np.asarray(m0, dtype=np.float64)
    m = pyramid(src, tgt, m0, box, opt, rep, log)
    m = tiles(src, tgt, m, box, opt, rep, log)
    m_tiles = m
    m = patches(src, tgt, m, box, opt, rep, log)
    # the decision: the refined matrix must agree with the images better than the one it started from, judged at the finest level
    e0, n0 = patch_measure(src, tgt, m0, box, opt)
    e1, n1 = patch_measure(src, tgt, m, box, opt)
    e_t, n_t = patch_measure(src, tgt, m_tiles, box, opt) if m is not m_tiles else (e1, n1)
    rep.add(f"disagreement at {opt.fine_scale:g} slide px per pixel: start {e0:.1f} px ({n0} patches), after the tiles {e_t:.1f}, final {e1:.1f} ({n1})")
    best, best_e = m, e1
    if not np.isfinite(e1) or (np.isfinite(e_t) and e_t < e1):  # the patches made it worse (or could not be measured): stop at the tiles
        best, best_e = m_tiles, e_t
        if best is not m:
            rep.add("the patch stage did not help: kept the result of the tiles")
    if np.isfinite(e0) and (not np.isfinite(best_e) or best_e > e0):
        rep.add("the refined matrix agrees worse than the start: kept the start")
        best, best_e = m0, e0
    lv0 = make_level(src, tgt, m0, box, max(max(box[2], box[3]) / opt.work_edge, 1.0))
    lv1 = make_level(src, tgt, best, box, max(max(box[2], box[3]) / opt.work_edge, 1.0))
    if lv0 and lv1:
        rep.add(f"agreement of the structure images at {opt.work_edge}px: {ncc(lv0.ft, lv0.fs, lv0.mask):.3f} before, {ncc(lv1.ft, lv1.fs, lv1.mask):.3f} after")
    rep.refined = not np.allclose(best, m0)
    rep.error, rep.inliers = best_e, (n1 if best is m else n_t)
    if not np.isfinite(rep.error):  # no patches to measure on (very faint or very little tissue): the coarser tile level has to do
        rep.error, rep.inliers = measure(src, tgt, best, box, opt)
        rep.add(f"the patches could not be measured; error taken from the tiles at {opt.work_edge}px: {rep.error:.1f} px")
    return best, rep
