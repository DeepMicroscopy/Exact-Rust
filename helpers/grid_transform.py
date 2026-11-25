"""A registration kept as the mapped positions of a grid of source points (what VALIS gives: its warps are functions of points, not
fields in EXACT's convention). Pickled into `images_imageregistration.file`; `registration_helper.py` unpickles it to convert points
(numpy and scipy only), like `DhrTransform`.

The grid covers the overview of the source slide's tissue; `dst` holds, for every grid point, where the registration puts it, in
target slide pixels. Points between grid points are bilinear, points outside the grid follow the affine map that fits the grid best
(the registration says nothing about the glass around the tissue, a straight continuation is the least surprising answer there).
"""
import numpy as np


class GridTransform:
    def __init__(self, xs, ys, dst):
        self.xs = np.asarray(xs, dtype=np.float64)  # (W,) source slide x of the grid columns, increasing
        self.ys = np.asarray(ys, dtype=np.float64)  # (H,) source slide y of the grid rows, increasing
        self.dst = np.ascontiguousarray(dst, dtype=np.float64)  # (H, W, 2) target slide pixels
        gx, gy = np.meshgrid(self.xs, self.ys)
        a = np.stack([gx.ravel(), gy.ravel(), np.ones(gx.size)], axis=1)
        self.coef, *_ = np.linalg.lstsq(a, self.dst.reshape(-1, 2), rcond=None)  # (3, 2)

    def matrix(self):
        """The homography (3x3) of the best affine fit and the mean distance of the grid from it (target pixels)."""
        m = np.eye(3)
        m[:2, :] = self.coef.T
        gx, gy = np.meshgrid(self.xs, self.ys)
        fit = np.stack([gx.ravel(), gy.ravel(), np.ones(gx.size)], axis=1) @ self.coef
        return m, float(np.linalg.norm(fit - self.dst.reshape(-1, 2), axis=1).mean())

    def convert(self, points):
        from scipy import ndimage  # imported here: before other libraries' OpenMP runtimes in one process it can crash

        p = np.asarray(points, dtype=np.float64).reshape(-1, 2)
        affine = np.hstack([p, np.ones((len(p), 1))]) @ self.coef
        # grid coordinates (fractional index); outside the grid they are clamped for the lookup and the affine answer is used
        fx = np.interp(p[:, 0], self.xs, np.arange(len(self.xs)), left=-1, right=-1)
        fy = np.interp(p[:, 1], self.ys, np.arange(len(self.ys)), left=-1, right=-1)
        inside = (fx >= 0) & (fy >= 0)
        out = affine.copy()
        if inside.any():
            for c in (0, 1):
                out[inside, c] = ndimage.map_coordinates(self.dst[:, :, c], [fy[inside], fx[inside]], order=1, mode="nearest")
        return out

    def transform_boxes(self, boxes):
        """The call registration_helper.py makes: [[x, y, w, h], ...] -> the same with moved corners."""
        b = np.asarray(boxes, dtype=np.float64).reshape(-1, 4)
        out = b.copy()
        out[:, :2] = self.convert(b[:, :2])
        return out
