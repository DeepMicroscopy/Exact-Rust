"""The result of a DeeperHistReg registration, as the Rust server keeps it: a displacement field on a small overview of the
two slides plus what is needed to get from slide pixels to the field and back. Pickled into `images_imageregistration.file`;
`registration_helper.py` unpickles it to convert points (numpy and scipy only, no torch).

DeeperHistReg's field maps TARGET to SOURCE positions (`source = target + field(target)`, field in pixels of the preprocessed
overview, channel 0 = x, channel 1 = y), the registrations of EXACT map source to target, so points are converted by
inverting the field with a fixed-point iteration.
"""
import numpy as np


class DhrTransform:
    origin_source = origin_target = (0, 0)  # pickles written before the overviews were cropped to the tissue

    def __init__(self, field, pad_source, pad_target, ratio, scale_source, scale_target, origin_source=(0, 0), origin_target=(0, 0)):
        self.field = np.ascontiguousarray(field, dtype=np.float32)  # (2, H, W)
        self.pad_source = pad_source  # ((top, bottom), (left, right)) in overview pixels, as DeeperHistReg pads the pair
        self.pad_target = pad_target
        self.ratio = float(ratio)  # padded overview pixels per field pixel
        self.scale_source = tuple(scale_source)  # slide (level 0) pixels per overview pixel, (x, y)
        self.scale_target = tuple(scale_target)
        self.origin_source = tuple(origin_source)  # slide pixel at the overview's top left corner: the overviews show the tissue only
        self.origin_target = tuple(origin_target)

    def _displacement(self, x, y):
        from scipy import ndimage  # imported here: before qt_wsi_reg's libraries in one process it crashes (two OpenMP runtimes)

        pos = [y, x]
        return (ndimage.map_coordinates(self.field[0], pos, order=1, mode="nearest"),
                ndimage.map_coordinates(self.field[1], pos, order=1, mode="nearest"))

    def convert(self, points):
        """Source slide pixels (n, 2) -> target slide pixels (n, 2)."""
        p = np.asarray(points, dtype=np.float64).reshape(-1, 2)
        sx = (p[:, 0] - self.origin_source[0]) / self.scale_source[0] + self.pad_source[1][0]
        sy = (p[:, 1] - self.origin_source[1]) / self.scale_source[1] + self.pad_source[0][0]
        sx, sy = sx / self.ratio, sy / self.ratio  # now in field pixels
        tx, ty = sx.copy(), sy.copy()
        for _ in range(40):  # target = source - field(target); converges for the smooth fields registration produces
            ux, uy = self._displacement(tx, ty)
            nx, ny = sx - ux, sy - uy
            moved = max(np.abs(nx - tx).max(initial=0), np.abs(ny - ty).max(initial=0))
            tx, ty = nx, ny
            if moved < 1e-3:
                break
        tx = (tx * self.ratio - self.pad_target[1][0]) * self.scale_target[0] + self.origin_target[0]
        ty = (ty * self.ratio - self.pad_target[0][0]) * self.scale_target[1] + self.origin_target[1]
        return np.stack([tx, ty], axis=1)

    def transform_boxes(self, boxes):
        """The call registration_helper.py makes on an `qt_wsi_reg` quad tree: [[x, y, w, h], ...] -> the same with moved corners."""
        b = np.asarray(boxes, dtype=np.float64).reshape(-1, 4)
        out = b.copy()
        out[:, :2] = self.convert(b[:, :2])
        return out

    def affine(self, size, grid=24):
        """The homography (3x3, row major) that fits the registration best, and the mean distance of the fit from it in target
        pixels. `size` is the source slide's (width, height) in pixels; the fit is made on a grid over it."""
        xs, ys = np.meshgrid(np.linspace(0, size[0], grid), np.linspace(0, size[1], grid))
        src = np.stack([xs.ravel(), ys.ravel()], axis=1)
        dst = self.convert(src)
        fx = ((dst[:, 0] - self.origin_target[0]) / self.scale_target[0] + self.pad_target[1][0]) / self.ratio  # where in the field the target lies: points that
        fy = ((dst[:, 1] - self.origin_target[1]) / self.scale_target[1] + self.pad_target[0][0]) / self.ratio  # fall outside it say nothing about the alignment
        inside = (fx >= 0) & (fx <= self.field.shape[2]) & (fy >= 0) & (fy <= self.field.shape[1])
        if inside.sum() >= 6:
            src, dst = src[inside], dst[inside]
        a = np.hstack([src, np.ones((len(src), 1))])
        coef, *_ = np.linalg.lstsq(a, dst, rcond=None)  # (3, 2): dst = a @ coef
        fit = a @ coef
        err = float(np.linalg.norm(fit - dst, axis=1).mean())
        m = np.eye(3)
        m[:2, :] = coef.T
        return m, err
