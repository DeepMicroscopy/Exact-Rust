"""GridTransform (what the VALIS plugin keeps): points between grid points follow the grid, points outside the grid its affine fit,
and the file can be pickled and used by registration_helper.py's call (`transform_boxes`).
Run: python -m pytest tests/helpers"""
import pathlib
import pickle
import sys

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "helpers"))
from grid_transform import GridTransform  # noqa: E402


def affine(p):
    """rotation by 0.1 rad, scale 1.1 and a shift"""
    c, s = 1.1 * np.cos(0.1), 1.1 * np.sin(0.1)
    return np.stack([c * p[..., 0] - s * p[..., 1] + 40, s * p[..., 0] + c * p[..., 1] - 25], axis=-1)


def make(bend=0.0):
    xs, ys = np.linspace(100, 900, 17), np.linspace(50, 650, 13)
    gx, gy = np.meshgrid(xs, ys)
    g = np.stack([gx, gy], axis=-1)
    dst = affine(g)
    dst[..., 1] += bend * np.sin(gx / 900 * np.pi)  # a deformation that no matrix follows
    return GridTransform(xs, ys, dst)


def test_an_affine_grid_is_reproduced_everywhere_and_fits_exactly():
    t = make()
    pts = np.array([[100.0, 50.0], [333.3, 222.2], [900.0, 650.0], [-500.0, 2000.0], [4000.0, -10.0]])
    assert np.allclose(t.convert(pts), affine(pts), atol=1e-6)  # inside: bilinear on an affine map is exact; outside: its fit
    m, err = t.matrix()
    assert err < 1e-9 and np.allclose(m[:2] @ np.array([300, 200, 1.0]), affine(np.array([300.0, 200.0])))


def test_a_deformation_is_followed_inside_and_leaves_an_error_in_the_matrix():
    t = make(bend=30.0)
    p = np.array([[500.0, 350.0]])
    assert abs((t.convert(p) - affine(p))[0, 1] - 30.0) < 1.0  # the bend at x = 500 is about 30 * sin(pi * 500 / 900)
    _, err = t.matrix()
    assert err > 3.0  # the matrix cannot follow it: that is what the error of the plugin's matrix says


def test_pickle_and_the_call_of_the_registration_helper():
    t = pickle.loads(pickle.dumps(make(bend=10.0)))
    out = t.transform_boxes([[300.0, 200.0, 0, 0], [800.0, 600.0, 5, 7]])
    assert out.shape == (2, 4) and np.allclose(out[1, 2:], [5, 7])
    assert np.allclose(out[:, :2], t.convert(np.array([[300.0, 200.0], [800.0, 600.0]])))
