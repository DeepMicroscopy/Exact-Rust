"""Crop to a new image (v2 and the legacy exact-sync GET). Rust only."""
import io
import os
import pathlib
import uuid

import httpx
import pytest
from common import BASE, PW

pytestmark = pytest.mark.skipif(httpx.get(BASE + "/api/version").status_code != 200, reason="server has no /api/version (Django)")

IMAGES = pathlib.Path(os.environ.get("IMAGE_PATH", pathlib.Path(__file__).resolve().parents[2] / "reference/instance/images"))


def client(user="rt_teamadmin"):
    c = httpx.Client(base_url=BASE, timeout=120)
    r = c.post("/api/v2/auth/login", json={"username": user, "password": PW})
    c.headers["X-CSRF-Token"] = r.json()["csrf_token"]
    return c


def textured(w=900, h=700):
    from PIL import Image, ImageDraw
    im = Image.new("RGB", (w, h), (40, 60, 90))
    d = ImageDraw.Draw(im)
    for i in range(60):
        d.ellipse([(i * 53) % w, (i * 31) % h, (i * 53) % w + 40, (i * 31) % h + 40], fill=((i * 37) % 255, (i * 91) % 255, (i * 53) % 255))
    b = io.BytesIO()
    im.save(b, "PNG")
    return b.getvalue()


@pytest.fixture
def sets():
    c = client()
    a = c.post("/api/v2/image-sets", json={"name": f"cr-a-{uuid.uuid4().hex[:6]}", "team": 1}).json()
    b = c.post("/api/v2/image-sets", json={"name": f"cr-b-{uuid.uuid4().hex[:6]}", "team": 1}).json()
    img = c.post(f"/api/v2/image-sets/{a['id']}/images", files={"f": (f"src-{uuid.uuid4().hex[:6]}.png", textured())}).json()["items"][0]["id"]
    yield c, a, b, img
    for s in (a, b):
        c.delete(f"/api/v2/image-sets/{s['id']}")


def test_crop_creates_a_readable_pyramid_image_that_remembers_its_origin(sets):
    c, a, b, img = sets
    r = c.post(f"/api/v2/images/{img}/crop", json={"x": 100, "y": 50, "w": 300, "h": 200, "image_set": b["id"]})
    assert r.status_code == 201, r.text
    new = r.json()
    assert (new["width"], new["height"], new["image_set"], new["crop_source"], new["crop_x"], new["crop_y"], new["crop_frame"]) == (300, 200, b["id"], img, 100, 50, 0)
    assert new["name"].endswith("x100_y50_z0_w300_h200.tiff") and (IMAGES / b["path"] / new["name"]).exists()
    assert c.get(f"/api/v2/images/{new['id']}/metadata").status_code == 200


def test_crop_twice_answers_409_with_the_existing_image(sets):
    c, a, b, img = sets
    body = {"x": 10, "y": 10, "w": 100, "h": 100, "image_set": b["id"]}
    first = c.post(f"/api/v2/images/{img}/crop", json=body).json()
    again = c.post(f"/api/v2/images/{img}/crop", json=body)
    assert again.status_code == 409 and again.json()["existing"] == first["id"]


def test_crop_validation_and_permissions(sets):
    c, a, b, img = sets
    assert c.post(f"/api/v2/images/{img}/crop", json={"x": 800, "y": 600, "w": 300, "h": 300, "image_set": b["id"]}).status_code == 400  # outside
    assert c.post(f"/api/v2/images/{img}/crop", json={"x": 0, "y": 0, "w": 0, "h": 10, "image_set": b["id"]}).status_code == 400
    assert c.post(f"/api/v2/images/{img}/crop", json={"x": 0, "y": 0, "w": 10, "h": 10}).status_code == 400  # no target
    assert c.post(f"/api/v2/images/{img}/crop", json={"x": 0, "y": 0, "w": 10, "h": 10, "image_set": 99999}).status_code == 400
    assert client("rt_outsider").post(f"/api/v2/images/{img}/crop", json={"x": 0, "y": 0, "w": 10, "h": 10, "image_set": b["id"]}).status_code == 404
    c.patch(f"/api/v2/image-sets/{b['id']}", json={"image_lock": True})
    assert c.post(f"/api/v2/images/{img}/crop", json={"x": 0, "y": 0, "w": 10, "h": 10, "image_set": b["id"]}).status_code == 403
    assert all(s["id"] != b["id"] for s in c.get("/api/v2/image-sets/writable").json()["items"])


def test_writable_sets_lists_unlocked_sets_of_my_teams(sets):
    c, a, b, img = sets
    items = c.get("/api/v2/image-sets/writable").json()["items"]
    assert {a["id"], b["id"]} <= {s["id"] for s in items} and {"id", "name", "team", "team_name"} <= set(items[0])
    assert client("rt_outsider").get("/api/v2/image-sets/writable").json()["items"] == [] or all(s["team"] != 1 for s in client("rt_outsider").get("/api/v2/image-sets/writable").json()["items"])


def test_legacy_get_crop_as_exact_sync_calls_it(sets):
    c, a, b, img = sets
    r = c.get(f"/images/api/image/crop/{img}/20/30/0/120/90/{b['id']}/")
    assert r.status_code == 201 and r.json()["width"] == 120 and r.json()["height"] == 90 and r.json()["crop_source"] == img
    assert c.get(f"/images/api/image/crop/{img}/2000/30/0/120/90/{b['id']}/").status_code == 403
