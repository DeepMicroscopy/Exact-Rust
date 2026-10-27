"""Moving an image to another image set (port of exact/images/move.py), v2 and legacy. Rust only."""
import io
import os
import pathlib
import uuid

import httpx
import pytest
from common import BASE, PW

pytestmark = pytest.mark.skipif(httpx.get(BASE + "/api/version").status_code != 200, reason="server has no /api/version (Django)")

IMAGES = pathlib.Path(os.environ.get("IMAGE_PATH", pathlib.Path(__file__).resolve().parents[2] / "reference/instance/images"))
BB = {"x1": 1, "y1": 1, "x2": 9, "y2": 9}


def client(user="rt_teamadmin"):
    c = httpx.Client(base_url=BASE, timeout=60)
    r = c.post("/api/v2/auth/login", json={"username": user, "password": PW})
    c.headers["X-CSRF-Token"] = r.json()["csrf_token"]
    return c


def png(color=(9, 9, 9)):
    from PIL import Image
    b = io.BytesIO()
    Image.new("RGB", (20, 16), color).save(b, "PNG")
    return b.getvalue()


@pytest.fixture
def sets():
    c = client()
    made = [c.post("/api/v2/image-sets", json={"name": f"mv-{uuid.uuid4().hex[:8]}", "team": 1}).json() for _ in range(2)]
    yield c, made
    for s in made:
        c.delete(f"/api/v2/image-sets/{s['id']}")


def upload(c, s, name=None, color=(9, 9, 9)):
    name = name or f"m-{uuid.uuid4().hex[:6]}.png"
    r = c.post(f"/api/v2/image-sets/{s['id']}/images", files={"f": (name, png(color))})
    assert r.status_code == 201, r.text
    return r.json()["items"][0]["id"], name


def test_move_moves_files_row_and_annotations_and_checks_annotation_types(sets):
    c, (a, b) = sets
    c.put(f"/api/v2/image-sets/{a['id']}/products/1")
    img, name = upload(c, a)
    ann = c.post("/api/v2/annotations", json={"image": img, "annotation_type": 1, "vector": BB}).json()
    # the target does not offer the annotation type that is used
    r = c.post(f"/api/v2/images/{img}/move", json={"image_set": b["id"]})
    assert r.status_code == 409 and "Annotation" in r.json()["detail"]
    c.put(f"/api/v2/image-sets/{b['id']}/products/1")
    r = c.post(f"/api/v2/images/{img}/move", json={"image_set": b["id"]})
    assert r.status_code == 200 and r.json() == {"id": img, "image_set": b["id"]}
    assert not (IMAGES / a["path"] / name).exists() and (IMAGES / b["path"] / name).exists()
    assert c.get(f"/api/v2/images/{img}").json()["image_set"] == b["id"]
    assert c.get(f"/api/v2/annotations/{ann['id']}").json()["image"] == img  # annotations stay with the image
    assert c.get(f"/api/v2/images/{img}/metadata").status_code == 200  # the viewer finds the file in its new place


def test_refusals(sets):
    c, (a, b) = sets
    img, name = upload(c, a)
    assert c.post(f"/api/v2/images/{img}/move", json={"image_set": a["id"]}).status_code == 400  # same set
    assert c.post(f"/api/v2/images/{img}/move", json={}).status_code == 400
    # name clash in the target
    upload(c, b, name)
    r = c.post(f"/api/v2/images/{img}/move", json={"image_set": b["id"]})
    assert r.status_code == 409 and "already contains an image with this name" in r.json()["detail"]
    # locked target
    c.patch(f"/api/v2/image-sets/{b['id']}", json={"image_lock": True})
    assert c.post(f"/api/v2/images/{img}/move", json={"image_set": b["id"]}).status_code == 403
    # an outsider does not see the sets at all
    assert client("rt_outsider").post(f"/api/v2/images/{img}/move", json={"image_set": b["id"]}).status_code == 404
    assert c.post(f"/api/v2/images/{img}/move", json={"image_set": 99999}).status_code == 404
    assert (IMAGES / a["path"] / name).exists()  # nothing changed


def test_member_needs_delete_images_in_the_source(sets):
    c, (a, b) = sets
    img, _ = upload(c, a)
    m = client("rt_member")  # member, but neither creator nor admin of the source set
    assert m.post(f"/api/v2/images/{img}/move", json={"image_set": b["id"]}).status_code == 403


def test_legacy_move_and_targets(sets):
    c, (a, b) = sets
    img, name = upload(c, a)
    targets = c.get("/images/api/image/move-targets/").json()
    assert {"id": b["id"], "name": b["name"]} == {k: v for k, v in next(t for t in targets if t["id"] == b["id"]).items() if k != "team"}
    r = c.post(f"/images/api/image/move/{img}/{b['id']}/")
    assert r.status_code == 200 and r.json() == {"id": img, "image_set": b["id"]}
    assert (IMAGES / b["path"] / name).exists()
    c.patch(f"/api/v2/image-sets/{b['id']}", json={"image_lock": True})
    assert all(t["id"] != b["id"] for t in c.get("/images/api/image/move-targets/").json())


def test_symlinked_copy_in_another_set_follows_the_move(sets):
    c, (a, b) = sets
    img, name = upload(c, a)
    other = c.post("/api/v2/image-sets", json={"name": f"mv-{uuid.uuid4().hex[:8]}", "team": 1}).json()
    try:
        # a copy as Django makes it: a database row plus a symbolic link to the original file
        c2 = c.post(f"/api/v2/image-sets/{other['id']}/images", files={"f": (name, png((9, 9, 9)))}).json()["items"][0]["id"]
        link = IMAGES / other["path"] / name
        link.unlink()
        link.symlink_to((IMAGES / a["path"] / name).resolve())
        assert c.post(f"/api/v2/images/{img}/move", json={"image_set": b["id"]}).status_code == 200
        assert link.is_symlink() and link.resolve() == (IMAGES / b["path"] / name).resolve()
        assert c.get(f"/api/v2/images/{c2}/metadata").status_code == 200
    finally:
        c.delete(f"/api/v2/image-sets/{other['id']}")
