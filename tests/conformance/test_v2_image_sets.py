"""Image set and image writes (v2 + the exact-sync create endpoint), Rust only."""
import io
import os
import pathlib
import uuid

import httpx
import pytest
from common import BASE, PW

pytestmark = pytest.mark.skipif(httpx.get(BASE + "/api/version").status_code != 200, reason="server has no /api/version (Django)")

IMAGES = pathlib.Path(os.environ.get("IMAGE_PATH", pathlib.Path(__file__).resolve().parents[2] / "reference/instance/images"))
TEAM = 1


def client(user="rt_member"):
    c = httpx.Client(base_url=BASE, timeout=60)
    r = c.post("/api/v2/auth/login", json={"username": user, "password": PW})
    c.headers["X-CSRF-Token"] = r.json()["csrf_token"]
    return c


def png():
    from PIL import Image
    b = io.BytesIO()
    Image.new("RGB", (40, 30), (5, 5, 5)).save(b, "PNG")
    return b.getvalue()


def new_set(c, **kw):
    r = c.post("/api/v2/image-sets", json={"name": f"t-{uuid.uuid4().hex[:8]}", "team": TEAM, **kw})
    assert r.status_code == 201, r.text
    return r.json()


def test_create_makes_folder_and_is_readable():
    c = client()
    s = new_set(c, description="d", location="l", priority=3)
    assert s["description"] == "d" and s["location"] == "l" and s["team"] == TEAM
    assert s["path"].endswith(f"_{TEAM}_{s['id']}") and (IMAGES / s["path"]).is_dir()
    assert c.get(f"/api/v2/image-sets/{s['id']}").json()["id"] == s["id"]
    c.delete(f"/api/v2/image-sets/{s['id']}")


def test_create_validation_and_permissions():
    c = client()
    s = new_set(c)
    dup = c.post("/api/v2/image-sets", json={"name": s["name"], "team": TEAM})
    assert dup.status_code == 400 and "name" in dup.json()["errors"]
    assert c.post("/api/v2/image-sets", json={"team": TEAM}).status_code == 400
    assert c.post("/api/v2/image-sets", json={"name": "x", "team": 99999}).status_code == 400
    assert client("rt_outsider").post("/api/v2/image-sets", json={"name": "x", "team": TEAM}).status_code == 403
    c.delete(f"/api/v2/image-sets/{s['id']}")


def test_patch_updates_fields_and_checks_edit_permission():
    c = client()
    s = new_set(c)
    r = c.patch(f"/api/v2/image-sets/{s['id']}", json={"name": s["name"] + "-b", "description": None, "public": True, "image_lock": True})
    assert r.status_code == 200 and r.json()["name"].endswith("-b") and r.json()["description"] is None
    assert client("rt_outsider").patch(f"/api/v2/image-sets/{s['id']}", json={"name": "z"}).status_code in (403, 404)
    c.delete(f"/api/v2/image-sets/{s['id']}")


def test_delete_removes_images_annotations_and_folder():
    c = client("rt_teamadmin")
    s = new_set(c)
    up = c.post(f"/api/v2/image-sets/{s['id']}/images", files={"f": ("a.png", png())}).json()["items"][0]
    ann = c.post("/api/v2/annotations", json={"image": up["id"], "annotation_type": 1, "vector": {"x1": 1, "y1": 1, "x2": 9, "y2": 9}})
    assert ann.status_code == 201
    assert (IMAGES / s["path"] / "a.png").exists()
    assert c.delete(f"/api/v2/image-sets/{s['id']}").status_code == 204
    assert c.get(f"/api/v2/image-sets/{s['id']}").status_code == 404
    assert c.get(f"/api/v2/images/{up['id']}").status_code == 404
    assert c.get(f"/api/v2/annotations/{ann.json()['id']}").status_code == 404
    assert not (IMAGES / s["path"]).exists()


def test_delete_image_removes_file_and_respects_lock():
    c = client("rt_teamadmin")
    s = new_set(c)
    up = c.post(f"/api/v2/image-sets/{s['id']}/images", files={"f": ("b.png", png())}).json()["items"][0]
    c.patch(f"/api/v2/image-sets/{s['id']}", json={"image_lock": True})
    assert c.delete(f"/api/v2/images/{up['id']}").status_code == 403
    c.patch(f"/api/v2/image-sets/{s['id']}", json={"image_lock": False})
    assert c.delete(f"/api/v2/images/{up['id']}").status_code == 204
    assert not (IMAGES / s["path"] / "b.png").exists() and c.get(f"/api/v2/images/{up['id']}").status_code == 404
    c.delete(f"/api/v2/image-sets/{s['id']}")


def test_member_cannot_delete_foreign_set_but_creator_can():
    m = client("rt_member")
    s = new_set(m)  # creator
    admin = client("rt_teamadmin")
    assert admin.delete(f"/api/v2/image-sets/{s['id']}").status_code == 204
    other = new_set(admin)
    assert m.delete(f"/api/v2/image-sets/{other['id']}").status_code == 403
    admin.delete(f"/api/v2/image-sets/{other['id']}")


def test_exact_sync_create_with_nested_ids():
    c = client()
    name = f"sync-{uuid.uuid4().hex[:8]}"
    r = c.post("/images/api/imageset/create/", json={"name": name, "team": {"id": TEAM}, "products": [{"id": 1}], "description": "x"})
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["name"] == name and j["team"]["id"] == TEAM and [p["id"] for p in j["products"]] == [1]
    client("rt_teamadmin").delete(f"/api/v2/image-sets/{j['id']}")


def test_settings_endpoint_has_flags_counts_and_my_permissions():
    c = client("rt_teamadmin")
    s = new_set(c)
    st = c.get(f"/api/v2/image-sets/{s['id']}/settings").json()
    assert st["name"] == s["name"] and st["image_lock"] is False and st["public"] is False and st["image_count"] == 0
    assert st["permissions"]["edit_set"] and st["permissions"]["delete_set"] and st["team_name"]
    c.patch(f"/api/v2/image-sets/{s['id']}", json={"image_lock": True})
    assert c.get(f"/api/v2/image-sets/{s['id']}/settings").json()["image_lock"] is True
    assert client("rt_outsider").get(f"/api/v2/image-sets/{s['id']}/settings").status_code == 404
    c.delete(f"/api/v2/image-sets/{s['id']}")
