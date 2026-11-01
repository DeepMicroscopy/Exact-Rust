"""DhrTransform: a synthetic DeeperHistReg result (a rotation about the overview centre, field in DeeperHistReg's target -> source
convention) must convert slide points like the rotation does, and its homography fit must recover it.
Run: python -m pytest tests/helpers"""
import pathlib
import pickle
import sys

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "helpers"))
from dhr_transform import DhrTransform  # noqa: E402


def rotation_field(h, w, angle, shift):
    """source = R(target) + shift, as a displacement field of target positions (x, y channels)."""
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float64)
    c, s = np.cos(angle), np.sin(angle)
    cx, cy = w / 2, h / 2
    sx = c * (xs - cx) - s * (ys - cy) + cx + shift[0]
    sy = s * (xs - cx) + c * (ys - cy) + cy + shift[1]
    return np.stack([sx - xs, sy - ys])


def make(angle=0.2, shift=(5.0, -3.0)):
    h, w = 400, 500
    field = rotation_field(h, w, angle, shift)
    # slides 10x the field's pixels, field = overview / 1.25, source padded 20 px above and below, target 30 px left and right
    t = DhrTransform(field, ((20, 20), (0, 0)), ((0, 0), (30, 30)), 1.25, (10.0, 10.0), (12.0, 12.0))
    return t, angle, shift, (h, w)


def truth(t, angle, shift, shape, pts):
    """the target slide position that the construction above implies for source slide points"""
    h, w = shape
    out = []
    for x, y in pts:
        px, py = (x / 10.0 + 0) * 1, (y / 10.0 + 20)  # padded source overview pixels
        sx, sy = px / 1.25, py / 1.25  # field pixels, a source position
        c, s = np.cos(angle), np.sin(angle)
        # invert source = R(target - centre) + centre + shift
        dx, dy = sx - w / 2 - shift[0], sy - h / 2 - shift[1]
        tx, ty = c * dx + s * dy + w / 2, -s * dx + c * dy + h / 2
        out.append([(tx * 1.25 - 30) * 12.0, (ty * 1.25 - 0) * 12.0])
    return np.array(out)


def test_points_follow_the_field_and_the_scales():
    t, angle, shift, shape = make()
    pts = [(1500.0, 1200.0), (2500.0, 1700.0), (800.0, 900.0)]
    assert np.abs(t.convert(pts) - truth(t, angle, shift, shape, pts)).max() < 0.05


def test_it_survives_pickling_and_converts_boxes_like_the_quad_tree():
    t, *_ = make()
    t2 = pickle.loads(pickle.dumps(t))
    boxes = [[1500, 1200, 64, 64], [900, 1000, 0, 0]]
    got = t2.transform_boxes(boxes)
    assert got.shape == (2, 4) and (got[:, 2:] == np.array(boxes)[:, 2:]).all()
    assert np.allclose(got[:, :2], t.convert([[1500, 1200], [900, 1000]]))


def test_homography_fit_recovers_a_rigid_motion():
    t, angle, shift, shape = make()
    m, err = t.affine((0, 0, 3000, 2000))
    pts = np.array([[1500.0, 1200.0], [2500.0, 1700.0]])
    got = (m @ np.c_[pts, np.ones(2)].T).T[:, :2]
    assert err < 0.5 and np.abs(got - truth(t, angle, shift, shape, pts)).max() < 0.5
    assert np.allclose(m[2], [0, 0, 1])


def test_overviews_of_a_region_shift_the_slide_coordinates():
    """Cropped overviews: the same field, but the slides' pixels are counted from the corner of the region shown."""
    t, angle, shift, shape = make()
    cropped = DhrTransform(t.field, t.pad_source, t.pad_target, t.ratio, t.scale_source, t.scale_target, (700.0, 300.0), (-400.0, 50.0))
    pts = np.array([[1500.0, 1200.0], [2500.0, 1700.0]])
    plain = t.convert(pts - [700.0, 300.0])  # the same points in the coordinates of the uncropped transform
    assert np.allclose(cropped.convert(pts), plain + [-400.0, 50.0])
    m, err = cropped.affine((0, 0, 3000, 2000))
    assert err < 0.5 and np.allclose((m @ np.c_[pts, np.ones(2)].T).T[:, :2], cropped.convert(pts), atol=0.5)


def test_a_rotation_of_more_than_ninety_degrees_converts_too():
    """The first inversion (a fixed point iteration) diverged above ~60 degrees: slides scanned turned by 90 or 180 degrees failed."""
    for angle in (1.75, 3.2, -2.4):
        t, a, shift, shape = make(angle=angle)
        h, w = shape
        c, s = np.cos(a), np.sin(a)
        src, want = [], []
        for fx, fy in [(200, 150), (300, 250), (150, 300), (350, 120)]:  # targets inside the field (500 x 400 pixels)
            sx = c * (fx - w / 2) - s * (fy - h / 2) + w / 2 + shift[0]  # the source position of that target, in field pixels
            sy = s * (fx - w / 2) + c * (fy - h / 2) + h / 2 + shift[1]
            src.append([sx * 1.25 * 10.0, (sy * 1.25 - 20) * 10.0])  # source slide pixels (padded overview / ratio, padding 20 px above)
            want.append([(fx * 1.25 - 30) * 12.0, fy * 1.25 * 12.0])  # target slide pixels
        assert np.abs(t.convert(src) - np.array(want)).max() < 0.1, angle
        m, err = t.affine((0, 0, 3000, 2000))
        assert err < 1.0
