"""GET /images/image/centered_snapshot/{id}/{cx}/{cy}/{w}/{h}/: full-resolution region centred on a point, white outside (Rust only)."""
import io

import httpx
import pytest
from common import BASE, PW
from PIL import Image

pytestmark = pytest.mark.skipif(httpx.get(BASE + "/api/version").status_code != 200, reason="server has no /api/version (Django)")

IMAGE = 2


def client():
    return httpx.Client(base_url=BASE, auth=("aubreville", PW), timeout=60)


def snap(c, cx, cy, w, h, **q):
    return c.get(f"/images/image/centered_snapshot/{IMAGE}/{cx}/{cy}/{w}/{h}/", params=q)


def test_inside_equals_the_patch():
    c = client()
    r = snap(c, 600, 500, 200, 100)
    assert r.status_code == 200 and r.headers["content-type"] == "image/png"
    got = Image.open(io.BytesIO(r.content))
    assert got.size == (200, 100)
    ref = c.get(f"/api/v2/images/{IMAGE}/get-patch", params={"x": 500, "y": 450, "width": 200, "height": 100})
    assert ref.status_code == 200
    assert list(got.convert("RGB").getdata()) == list(Image.open(io.BytesIO(ref.content)).convert("RGB").getdata())


def test_outside_is_white_and_size_is_exact():
    c = client()
    info = c.get(f"/api/v2/images/{IMAGE}").json()
    w, h = info["width"], info["height"]
    # centred on the top-left corner: three quarters white, the lower right quarter is the slide
    im = Image.open(io.BytesIO(snap(c, 0, 0, 100, 60).content)).convert("RGB")
    assert im.size == (100, 60)
    assert im.getpixel((0, 0)) == (255, 255, 255) and im.getpixel((49, 29)) == (255, 255, 255)
    ref = Image.open(io.BytesIO(c.get(f"/api/v2/images/{IMAGE}/get-patch", params={"x": 0, "y": 0, "width": 50, "height": 30}).content)).convert("RGB")
    assert im.crop((50, 30, 100, 60)).tobytes() == ref.tobytes()
    # completely outside, and past the bottom right corner
    far = Image.open(io.BytesIO(snap(c, w + 5000, h + 5000, 64, 64).content)).convert("RGB")
    assert far.size == (64, 64) and far.getextrema() == ((255, 255), (255, 255), (255, 255))
    assert Image.open(io.BytesIO(snap(c, w, h, 31, 21).content)).size == (31, 21)


def test_jpeg_and_errors():
    c = client()
    r = snap(c, 300, 300, 64, 64, format="jpeg")
    assert r.status_code == 200 and r.headers["content-type"] == "image/jpeg"
    assert snap(c, 300, 300, 64, 64, format="gif").status_code == 400
    assert snap(c, 300, 300, 0, 64).status_code == 400
    assert snap(c, 300, 300, 9000, 64).status_code == 400
    assert c.get("/images/image/centered_snapshot/99999999/1/1/10/10/").status_code == 404
    assert httpx.get(BASE + f"/images/image/centered_snapshot/{IMAGE}/1/1/10/10/").status_code in (401, 403)


def test_large_snapshot_is_quick():
    import time
    c = client()
    t = time.time()
    r = snap(c, 4000, 4000, 2048, 2048)
    assert r.status_code == 200 and Image.open(io.BytesIO(r.content)).size == (2048, 2048)
    assert time.time() - t < 5
