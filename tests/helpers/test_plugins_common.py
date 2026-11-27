"""read_scaled: a big region is read in pieces (a slide with no pyramid would otherwise be read whole at full resolution).
Run: python -m pytest tests/helpers"""
import pathlib
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "helpers"))
import plugins_common  # noqa: E402


class Fake:
    """A slide with level 0 only: smooth colour ramps plus some structure; remembers how big each read was."""

    def __init__(self, w, h):
        self.dimensions = (w, h)
        self.level_downsamples = [1.0]
        self.reads = []
        yy, xx = np.mgrid[0:h, 0:w]
        self.pixels = np.stack([(xx * 255 // w), (yy * 255 // h), ((xx // 64 + yy // 64) % 2) * 200], axis=-1).astype(np.uint8)

    def read_region(self, location, level, size):
        x, y = location
        self.reads.append(size)
        w, h = size
        rgb = self.pixels[y : y + h, x : x + w]
        rgba = np.concatenate([rgb, np.full(rgb.shape[:2] + (1,), 255, np.uint8)], axis=-1)
        return Image.fromarray(rgba, "RGBA")


def test_a_big_region_is_read_in_pieces_and_looks_like_the_whole(monkeypatch):
    monkeypatch.setattr(plugins_common, "BIG_REGION", 1_000_000)
    monkeypatch.setattr(plugins_common, "PIECE", 1024)
    slide = Fake(6000, 4000)
    img, (sx, sy) = plugins_common.render(slide, (0, 0, 6000, 4000), 600)
    assert img.size == (600, 400)
    assert (sx, sy) == (10.0, 10.0)
    assert len(slide.reads) > 1
    assert max(w * h for w, h in slide.reads) <= 1024 * 1024  # never the whole region at once
    whole = Image.fromarray(slide.pixels).resize((600, 400), Image.LANCZOS)
    diff = np.abs(np.asarray(img).astype(int) - np.asarray(whole).astype(int))
    assert diff.mean() < 3.0


def test_a_small_region_is_read_at_once():
    slide = Fake(800, 600)
    img, _ = plugins_common.render(slide, (0, 0, 800, 600), 400)
    assert img.size == (400, 300)
    assert len(slide.reads) == 1


def test_the_reader_of_refine_affine_uses_pieces_too(monkeypatch):
    import refine_affine as ra

    monkeypatch.setattr(plugins_common, "BIG_REGION", 1_000_000)
    monkeypatch.setattr(plugins_common, "PIECE", 1024)
    slide = Fake(5000, 3000)
    rgb, (sx, sy) = ra.SlideReader(slide).render((0, 0, 5000, 3000), 10.0)
    assert rgb.shape == (300, 500, 3)
    assert max(w * h for w, h in slide.reads) <= 1024 * 1024
