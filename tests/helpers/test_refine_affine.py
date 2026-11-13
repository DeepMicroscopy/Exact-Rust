"""helpers/refine_affine.py on synthetic slides with a known transform: the refinement must pull a matrix that is off by tens of
pixels (and a degree) to well under a pixel, also when the two "stains" differ and part of one section is missing."""
import pathlib
import sys

import cv2
import numpy as np
import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "helpers"))
import refine_affine as ra  # noqa: E402


OPT = ra.Options(work_edge=2048, tile=160, fine_scale=1.0, patch=256, patch_grid=6)


def tissue(w, h, seed):
    """An RGB 'section': a tissue shaped blob full of nuclei like dots and fibres on white glass."""
    rng = np.random.default_rng(seed)
    img = np.zeros((h, w), np.float32)
    for _ in range(9000):  # nuclei
        x, y, r = rng.integers(0, w), rng.integers(0, h), rng.integers(3, 9)
        cv2.circle(img, (int(x), int(y)), int(r), float(rng.uniform(0.4, 1.0)), -1)
    for _ in range(500):  # fibres
        p = rng.integers(0, [w, h], size=2)
        q = p + rng.integers(-250, 250, size=2)
        cv2.line(img, tuple(int(v) for v in p), tuple(int(v) for v in q), float(rng.uniform(0.2, 0.6)), int(rng.integers(1, 4)))
    img = cv2.GaussianBlur(img, (0, 0), 1.5)
    body = np.zeros((h, w), np.float32)
    cv2.ellipse(body, (w // 2, h // 2), (int(w * 0.42), int(h * 0.40)), 8, 0, 360, 1.0, -1)
    body = cv2.GaussianBlur(body, (0, 0), 25)
    d = np.clip(img * 0.8 + 0.25, 0, 1) * body  # optical density
    t = np.exp(-d[..., None] * np.array([1.1, 1.8, 0.9], np.float32))  # pink and purple
    return (np.clip(t, 0, 1) * 255).astype(np.uint8)


def restain(rgb, seed):
    """The 'other stain': channels mixed, contrast changed, noise."""
    rng = np.random.default_rng(seed)
    f = rgb.astype(np.float32) / 255
    od = -np.log(np.clip(f, 1 / 255, 1))
    mix = np.array([[0.2, 0.9, 0.3], [0.8, 0.3, 0.1], [0.1, 0.4, 1.0]], np.float32)
    od2 = np.clip(od @ mix.T * 0.8 + rng.normal(0, 0.02, od.shape), 0, None)
    return (np.clip(np.exp(-od2), 0, 1) * 255).astype(np.uint8)


def error(m_est, m_true, w, h):
    gx, gy = np.meshgrid(np.linspace(w * 0.2, w * 0.8, 9), np.linspace(h * 0.2, h * 0.8, 9))
    p = np.stack([gx.ravel(), gy.ravel()], axis=1)
    return np.linalg.norm(ra._apply(np.asarray(m_est), p) - ra._apply(np.asarray(m_true), p), axis=1)


@pytest.fixture(scope="module")
def pair():
    w, h = 5000, 3600
    src = tissue(w, h, 1)
    # the target: the source moved by M_TRUE, another stain, a piece torn out
    m_true = np.array([[0.985, 0.045, 310.0], [-0.045, 0.985, -120.0], [0, 0, 1]])
    tgt = cv2.warpAffine(src, m_true[:2], (w, h), flags=cv2.INTER_AREA, borderValue=(255, 255, 255))
    tgt = restain(tgt, 2)
    tgt[1400:2000, 2600:3300] = 255
    return ra.ArrayReader(src), ra.ArrayReader(tgt), m_true, (w, h)


def start(m_true, shift, degrees, scale=1.0):
    a = np.deg2rad(degrees)
    r = np.array([[np.cos(a) * scale, -np.sin(a) * scale, 0], [np.sin(a) * scale, np.cos(a) * scale, 0], [0, 0, 1]])
    c = np.array([2500, 1800, 1.0])
    m = np.eye(3)
    m[:2, 2] = shift
    # perturbation about the centre of the tissue, in target space
    t = np.eye(3)
    t[:2, 2] = c[:2]
    t_inv = np.eye(3)
    t_inv[:2, 2] = -c[:2]
    return m @ t @ r @ t_inv @ m_true


@pytest.mark.parametrize("shift,deg,scale", [((40, -30), 1.2, 1.0), ((-90, 60), -2.0, 1.01), ((15, 10), 0.3, 1.0)])
def test_the_refinement_finds_the_true_transform(pair, shift, deg, scale):
    src, tgt, m_true, (w, h) = pair
    m0 = start(m_true, shift, deg, scale)
    before = error(m0, m_true, w, h)
    box = (0, 0, w, h)
    m, rep = ra.refine(src, tgt, m0, box, OPT)
    after = error(m, m_true, w, h)
    print("\n".join(rep.steps), f"\nbefore {before.mean():.1f} px, after {after.mean():.2f} px (max {after.max():.2f})")
    assert before.mean() > 15
    assert after.mean() < 1.5 and after.max() < 3.0
    assert rep.refined and rep.error < 3


def test_a_perfect_matrix_stays_put(pair):
    src, tgt, m_true, (w, h) = pair
    m, rep = ra.refine(src, tgt, m_true, (0, 0, w, h), OPT)
    assert error(m, m_true, w, h).max() < 2.0


def test_unrelated_slides_do_not_make_things_worse(pair):
    src, _, m_true, (w, h) = pair
    other = ra.ArrayReader(tissue(w, h, 77))
    m0 = start(m_true, (20, 20), 0.5)
    m, rep = ra.refine(src, other, m0, (0, 0, w, h), OPT)
    # with nothing in common there is nothing to find: whatever it does must not move the tissue far from where it was
    assert error(m, m0, w, h).max() < 150


class FakeSlide:
    """An OpenSlide look-alike over an array: dimensions, level_downsamples and read_region (RGBA, white outside the slide)."""

    def __init__(self, img):
        self.levels = [img]
        while min(self.levels[-1].shape[:2]) > 600:
            self.levels.append(cv2.resize(self.levels[-1], None, fx=0.5, fy=0.5, interpolation=cv2.INTER_AREA))
        self.dimensions = (img.shape[1], img.shape[0])
        self.level_downsamples = tuple(float(2 ** i) for i in range(len(self.levels)))

    def read_region(self, loc, level, size):
        from PIL import Image

        img, down = self.levels[level], 2 ** level
        x0, y0 = int(loc[0] / down), int(loc[1] / down)
        out = np.full((size[1], size[0], 3), 255, np.uint8)
        x1, y1 = max(0, x0), max(0, y0)
        x2, y2 = min(img.shape[1], x0 + size[0]), min(img.shape[0], y0 + size[1])
        if x2 > x1 and y2 > y1:
            out[y1 - y0:y2 - y0, x1 - x0:x2 - x0] = img[y1:y2, x1:x2]
        return Image.fromarray(out).convert("RGBA")


def test_the_plugin_registers_two_stains_to_within_a_few_pixels(pair, monkeypatch):
    """The whole plugin on slides: SIFT for the rough alignment, then the refinement; the matrix must be close to the true one."""
    import importlib.util

    src_img, tgt_img, m_true, (w, h) = pair[0].img, pair[1].img, pair[2], pair[3]
    spec = importlib.util.spec_from_file_location("multistage_plugin", pathlib.Path(ra.__file__).parent / "plugins" / "multistage_registration.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    slides = {"src": FakeSlide(src_img), "tgt": FakeSlide(tgt_img)}
    monkeypatch.setattr(mod, "open_slide", lambda path, exact_dir: slides[path])
    plugin = mod.PLUGINS[0]
    assert plugin.unavailable() is None and plugin.plugin_type == 2
    logs = []
    ctx = type("Ctx", (), {"exact_dir": None, "log": staticmethod(logs.append)})()
    res = plugin.register("src", "tgt", {**plugin.defaults(), "initial": "sift", "thumbnail_size": 1500, "refine_size": 2048, "tile_size": 160, "rounds": 2}, ctx)
    m = np.array([[res.matrix[f"t_{i}{j}"] for j in range(3)] for i in range(3)])
    print("\n".join(logs))
    assert error(m, m_true, w, h).max() < 4.0, error(m, m_true, w, h)
    assert res.error < 4 and res.file is None and res.runtime >= 0
    # without the refinement the rough alignment is what comes back, and it is worse
    rough = plugin.register("src", "tgt", {**plugin.defaults(), "initial": "sift", "thumbnail_size": 1500, "refine": False}, ctx)
    m0 = np.array([[rough.matrix[f"t_{i}{j}"] for j in range(3)] for i in range(3)])
    assert error(m0, m_true, w, h).mean() > error(m, m_true, w, h).mean()


def test_an_existing_deeperhistreg_registration_replaces_the_rough_alignment(pair, monkeypatch):
    import importlib.util

    import coarse_align

    src_img, tgt_img, m_true, (w, h) = pair[0].img, pair[1].img, pair[2], pair[3]
    spec = importlib.util.spec_from_file_location("multistage_plugin", pathlib.Path(ra.__file__).parent / "plugins" / "multistage_registration.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    slides = {"src": FakeSlide(src_img), "tgt": FakeSlide(tgt_img)}
    monkeypatch.setattr(mod, "open_slide", lambda path, exact_dir: slides[path])
    monkeypatch.setattr(coarse_align, "sift_affine", lambda *a, **k: (_ for _ in ()).throw(AssertionError("the rough alignment must be skipped")))
    plugin = mod.PLUGINS[0]
    off = m_true.copy()
    off[0, 2] += 12.0  # what a feature based registration is typically off by
    off[1, 2] -= 9.0
    existing = {"plugin": "DeeperHistReg", "matrix": {f"t_{i}{j}": float(off[i][j]) for i in range(3) for j in range(3)}, "error": 3.0}
    logs = []
    ctx = type("Ctx", (), {"exact_dir": None, "log": staticmethod(logs.append), "existing": existing})()
    res = plugin.register("src", "tgt", {**plugin.defaults(), "refine_size": 2048, "tile_size": 160, "rounds": 2}, ctx)
    m = np.array([[res.matrix[f"t_{i}{j}"] for j in range(3)] for i in range(3)])
    assert any("no rough alignment needed" in line for line in logs)
    assert error(m, m_true, w, h).max() < 4.0 < error(off, m_true, w, h).max()
    # a matrix that cannot be right is not used
    bad = {**existing, "matrix": {**existing["matrix"], "t_00": 0.0, "t_11": 0.0, "t_01": 0.0, "t_10": 0.0}}
    assert mod.reusable(bad, (0, 0, w, h), (0, 0, w, h)) is None
    assert mod.reusable(None, (0, 0, w, h), (0, 0, w, h)) is None
    far = {**existing, "matrix": {**existing["matrix"], "t_02": 50.0 * w}}
    assert mod.reusable(far, (0, 0, w, h), (0, 0, w, h)) is None


def test_the_rotation_search_finds_a_half_turn(pair):
    """A source that is turned by 180 degrees has no SIFT matches that agree; the rotation search finds the turn."""
    import coarse_align

    src_img, _, _, (w, h) = pair[0].img, pair[1].img, pair[2], pair[3]
    turned = cv2.rotate(src_img, cv2.ROTATE_180)
    a, b = coarse_align._structure_u8(cv2.resize(turned, (w // 4, h // 4))), coarse_align._structure_u8(cv2.resize(src_img, (w // 4, h // 4)))
    eye = np.diag([4.0, 4.0, 1.0])
    m = coarse_align.rotation_search(a, b, eye, eye, 30)  # turned source -> source
    # the turn about the centre of the slide: x -> (w, h) - x
    assert np.allclose(ra._apply(m, [(1000, 800), (3000, 2000)]), [(w - 1000, h - 800), (w - 3000, h - 2000)], atol=12)
