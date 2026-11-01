"""The result of a DeeperHistReg registration, as the Rust server keeps it: a displacement field on a small overview of the
two slides plus what is needed to get from slide pixels to the field and back. Pickled into `images_imageregistration.file`;
`registration_helper.py` unpickles it to convert points (numpy and scipy only, no torch).

DeeperHistReg's field maps TARGET to SOURCE positions (`source = target + field(target)`, field in pixels of the preprocessed
overview, channel 0 = x, channel 1 = y), the registrations of EXACT map source to target, so points are converted by
inverting the field (Newton's method with the field's gradient).
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

    def _gradients(self):
        """d(field)/dx and d(field)/dy of both channels, sampled by Newton's method in `convert` (computed once)."""
        g = getattr(self, "_grad", None)
        if g is None:
            g = self._grad = [np.gradient(self.field[c], axis=a) for c in (0, 1) for a in (1, 0)]  # ux_x, ux_y, uy_x, uy_y
        return g

    def __getstate__(self):
        state = dict(self.__dict__)
        state.pop("_grad", None)
        return state

    def convert(self, points, with_residual=False):
        """Source slide pixels (n, 2) -> target slide pixels (n, 2). With `with_residual` also how far (field pixels) the answer is from
        solving the equation: large where the point has no counterpart inside the registered area."""
        from scipy import ndimage  # imported here: before qt_wsi_reg's libraries in one process it crashes (two OpenMP runtimes)

        p = np.asarray(points, dtype=np.float64).reshape(-1, 2)
        sx = (p[:, 0] - self.origin_source[0]) / self.scale_source[0] + self.pad_source[1][0]
        sy = (p[:, 1] - self.origin_source[1]) / self.scale_source[1] + self.pad_source[0][0]
        sx, sy = sx / self.ratio, sy / self.ratio  # now in field pixels
        gxx, gxy, gyx, gyy = self._gradients()
        at = lambda a, x, y: ndimage.map_coordinates(a, [y, x], order=1, mode="nearest")
        tx, ty = sx.copy(), sy.copy()
        # solve target + field(target) = source for the target. Newton's method, not the fixed point target = source - field(target):
        # that one only converges where the field changes slowly, and diverges for a rotation of more than about 60 degrees
        for _ in range(50):
            rx = tx + at(self.field[0], tx, ty) - sx
            ry = ty + at(self.field[1], tx, ty) - sy
            a, b = 1 + at(gxx, tx, ty), at(gxy, tx, ty)
            c, d = at(gyx, tx, ty), 1 + at(gyy, tx, ty)
            det = a * d - b * c
            det = np.where(np.abs(det) < 1e-6, 1e-6, det)
            dx, dy = (d * rx - b * ry) / det, (-c * rx + a * ry) / det
            tx, ty = tx - dx, ty - dy
            if max(np.abs(dx).max(initial=0), np.abs(dy).max(initial=0)) < 1e-3:
                break
        residual = np.hypot(tx + at(self.field[0], tx, ty) - sx, ty + at(self.field[1], tx, ty) - sy)
        tx = (tx * self.ratio - self.pad_target[1][0]) * self.scale_target[0] + self.origin_target[0]
        ty = (ty * self.ratio - self.pad_target[0][0]) * self.scale_target[1] + self.origin_target[1]
        out = np.stack([tx, ty], axis=1)
        return (out, residual) if with_residual else out

    def transform_boxes(self, boxes):
        """The call registration_helper.py makes on an `qt_wsi_reg` quad tree: [[x, y, w, h], ...] -> the same with moved corners."""
        b = np.asarray(boxes, dtype=np.float64).reshape(-1, 4)
        out = b.copy()
        out[:, :2] = self.convert(b[:, :2])
        return out

    def affine(self, box, grid=24):
        """The homography (3x3, row major) that fits the registration best, and the mean distance of the fit from it in target
        pixels. `box` is the region (x, y, w, h) of the source slide the fit is made on: the tissue, because the field says
        nothing about the glass around it (there it is whatever the registration extrapolated)."""
        x, y, w, h = box
        xs, ys = np.meshgrid(np.linspace(x, x + w, grid), np.linspace(y, y + h, grid))
        src = np.stack([xs.ravel(), ys.ravel()], axis=1)
        dst, residual = self.convert(src, with_residual=True)
        fx = ((dst[:, 0] - self.origin_target[0]) / self.scale_target[0] + self.pad_target[1][0]) / self.ratio  # where in the field the target lies: points that
        fy = ((dst[:, 1] - self.origin_target[1]) / self.scale_target[1] + self.pad_target[0][0]) / self.ratio  # fall outside it say nothing about the alignment
        inside = (fx >= 0) & (fx <= self.field.shape[2]) & (fy >= 0) & (fy <= self.field.shape[1]) & (residual < 0.5)
        if inside.sum() >= 6:
            src, dst = src[inside], dst[inside]
        a = np.hstack([src, np.ones((len(src), 1))])
        coef, *_ = np.linalg.lstsq(a, dst, rcond=None)  # (3, 2): dst = a @ coef
        fit = a @ coef
        err = float(np.linalg.norm(fit - dst, axis=1).mean())
        m = np.eye(3)
        m[:2, :] = coef.T
        return m, err
