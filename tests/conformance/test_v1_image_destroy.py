"""DELETE /api/v1/images/images/{id}/ (`destroy_image` of exact-sync): the image goes with its file, the answer is 204 with no body (Rust)."""
import os
import struct
import uuid
import zlib

import httpx
import pytest
from common import BASE, PW

pytestmark = pytest.mark.skipif(httpx.get(BASE + "/api/version").status_code != 200, reason="server has no /api/version (Django)")


def png(w=64, h=48):
    raw = b"".join(b"\x00" + bytes([i % 256, 100, 200]) * w for i in range(h))

    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))

    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


def session(user="aubreville"):
    c = httpx.Client(base_url=BASE, timeout=60)
    r = c.post("/api/v2/auth/login", json={"username": user, "password": PW})
    c.headers["X-CSRF-Token"] = r.json()["csrf_token"]
    return c


@pytest.fixture
def image_set():
    admin = session()
    s = admin.post("/api/v2/image-sets", json={"name": f"destroy-{uuid.uuid4().hex[:6]}", "team": 1}).json()
    yield admin, s["id"]
    admin.patch(f"/api/v2/image-sets/{s['id']}", json={"image_lock": False})
    admin.delete(f"/api/v2/image-sets/{s['id']}")


def upload(admin, set_id):
    r = admin.post(f"/api/v2/image-sets/{set_id}/images", files={"file": (f"{uuid.uuid4().hex[:6]}.png", png(), "image/png")})
    assert r.status_code in (200, 201), r.text
    return r.json()["items"][0]["id"]


def test_the_image_is_deleted_over_v1_with_basic_login_and_with_a_session(image_set):
    admin, set_id = image_set
    a, b = upload(admin, set_id), upload(admin, set_id)
    basic = httpx.Client(base_url=BASE, auth=("aubreville", PW), timeout=60)
    r = basic.delete(f"/api/v1/images/images/{a}/")
    assert r.status_code == 204 and r.content == b"", r.text
    assert basic.get(f"/api/v1/images/images/{a}/").status_code == 404 and admin.get(f"/api/v2/images/{a}").status_code == 404
    again = basic.delete(f"/api/v1/images/images/{a}/")
    assert again.status_code == 404 and again.json() == {"detail": "Not found."}
    assert admin.delete(f"/api/v1/images/images/{b}/").status_code == 204  # a session, with its CSRF token
    assert admin.get(f"/api/v2/images?image_set={set_id}").json()["items"] == []


def test_permissions_and_the_lock_of_the_image_set(image_set):
    admin, set_id = image_set
    a = upload(admin, set_id)
    # no model permission to delete images (a member of the team) / not logged in
    assert session("rt_member").delete(f"/api/v1/images/images/{a}/").status_code == 403
    assert httpx.delete(BASE + f"/api/v1/images/images/{a}/").status_code in (401, 403)
    assert httpx.Client(base_url=BASE, auth=("aubreville", "wrong"), timeout=60).delete(f"/api/v1/images/images/{a}/").status_code in (401, 403)
    assert admin.patch(f"/api/v2/image-sets/{set_id}", json={"image_lock": True}).status_code == 200
    assert admin.delete(f"/api/v1/images/images/{a}/").status_code == 403  # a locked image set keeps its images
    assert admin.get(f"/api/v2/images/{a}").status_code == 200
    assert admin.delete("/api/v1/images/images/99999999/").status_code == 404
    assert admin.delete("/api/v1/images/images/abc/").status_code == 404


def test_tokens_may_delete_images_only_with_the_images_scope(image_set):
    admin, set_id = image_set
    made = []

    def token(**body):
        r = admin.post("/api/v2/me/tokens", json={"name": f"destroy-{uuid.uuid4().hex[:6]}", **body})
        assert r.status_code == 201, r.text
        made.append(r.json()["id"])
        return httpx.Client(base_url=BASE, timeout=60, headers={"Authorization": f"Bearer {r.json()['token']}"})

    try:
        a, b, c = upload(admin, set_id), upload(admin, set_id), upload(admin, set_id)
        assert token(read_only=True).delete(f"/api/v1/images/images/{a}/").status_code == 403
        assert token(scopes=["annotate", "jobs"]).delete(f"/api/v1/images/images/{a}/").status_code == 403
        assert admin.get(f"/api/v2/images/{a}").status_code == 200
        assert token(scopes=["images"]).delete(f"/api/v1/images/images/{a}/").status_code == 204
        assert token().delete(f"/api/v1/images/images/{b}/").status_code == 204
        assert admin.delete(f"/api/v2/images/{c}").status_code == 204
    finally:
        for i in made:
            admin.delete(f"/api/v2/me/tokens/{i}")
