"""Thumbnails under load: a burst of requests for many different images, and many for the same one (Rust only)."""
import os
import pathlib
from concurrent.futures import ThreadPoolExecutor

import httpx
import pytest
from common import BASE, PW

pytestmark = pytest.mark.skipif(httpx.get(BASE + "/api/version").status_code != 200, reason="server has no /api/version (Django)")

CACHE = pathlib.Path(os.environ.get("EXACT_CACHE_DIR", pathlib.Path(__file__).resolve().parents[2] / "reference/instance/cache")) / "thumbnails"


def client():
    c = httpx.Client(base_url=BASE, timeout=300)
    c.post("/api/v2/auth/login", json={"username": "aubreville", "password": PW}).raise_for_status()
    return c


def image_ids(c, n):
    return [i["id"] for i in c.get(f"/api/v2/images?fields=id&limit={n}").json()["items"]]


def drop_cached(image_id):
    for f in CACHE.glob(f"{image_id}-v*.png"):
        f.unlink()


def test_a_burst_of_different_images_is_answered_completely_and_the_same_again():
    c = client()
    ids = image_ids(c, 60)
    assert len(ids) >= 20
    for i in ids:
        drop_cached(i)

    def get(i):
        return i, httpx.get(f"{BASE}/api/v2/images/{i}/thumbnail", cookies=c.cookies, timeout=300)

    with ThreadPoolExecutor(max_workers=40) as pool:
        first = dict((i, (r.status_code, r.content)) for i, r in pool.map(get, ids))
    assert all(code in (200, 400) for code, _ in first.values()), {i: code for i, (code, _) in first.items() if code not in (200, 400)}
    assert sum(code == 200 for code, _ in first.values()) >= len(ids) // 2
    for i, (code, body) in first.items():
        if code == 200:
            assert body[:8] == b"\x89PNG\r\n\x1a\n"
    # the second look is the cached one: the same bytes
    with ThreadPoolExecutor(max_workers=40) as pool:
        second = dict((i, (r.status_code, r.content)) for i, r in pool.map(get, ids))
    assert second == first


def test_many_requests_for_one_thumbnail_render_it_once():
    c = client()
    i = next(i for i in image_ids(c, 60) if c.get(f"/api/v2/images/{i}/thumbnail").status_code == 200)
    drop_cached(i)

    def get(_):
        return httpx.get(f"{BASE}/api/v2/images/{i}/thumbnail", cookies=c.cookies, timeout=300)

    with ThreadPoolExecutor(max_workers=24) as pool:
        rs = list(pool.map(get, range(24)))
    assert all(r.status_code == 200 for r in rs)
    assert len({r.content for r in rs}) == 1
    files = list(CACHE.glob(f"{i}-v*.png"))
    assert len(files) == 1 and not list(CACHE.glob(f"{i}-v*.tmp*")), files
    assert files[0].read_bytes() == rs[0].content
    assert "max-age" in rs[0].headers["cache-control"]
