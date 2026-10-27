"""Image upload: legacy `/images/image/upload/{set}/` and v2 `/api/v2/image-sets/{id}/images` (Rust only)."""
import io
import os
import pathlib
import uuid
import zipfile

import httpx
import pytest
from common import BASE, PW

pytestmark = pytest.mark.skipif(httpx.get(BASE + "/api/version").status_code != 200, reason="server has no /api/version (Django)")

SET_ID, SET_DIR = 2, "exact_1_2"
ROOT = pathlib.Path(os.environ.get("IMAGE_PATH", pathlib.Path(__file__).resolve().parents[2] / "reference/instance/images")) / SET_DIR


def png(width=64, height=48, color=(200, 30, 30)):
    from PIL import Image
    b = io.BytesIO()
    Image.new("RGB", (width, height), color).save(b, "PNG")
    return b.getvalue()


@pytest.fixture
def cleanup():
    names = []
    yield names
    for n in names:
        (ROOT / n).unlink(missing_ok=True)


def client(user="rt_member"):
    c = httpx.Client(base_url=BASE, timeout=60)
    r = c.post("/api/v2/auth/login", json={"username": user, "password": PW})
    c.headers["X-CSRF-Token"] = r.json()["csrf_token"]
    return c


def test_v2_upload_registers_image_with_size_and_is_readable(cleanup):
    name = f"up-{uuid.uuid4().hex[:8]}.png"
    cleanup.append(name)
    c = client()
    r = c.post(f"/api/v2/image-sets/{SET_ID}/images", files={"file": (name, png(64, 48))})
    assert r.status_code == 201, r.text
    item = r.json()["items"][0]
    assert item["type"] == "image" and "error" not in item
    img = c.get(f"/api/v2/images/{item['id']}").json()
    assert (img["width"], img["height"], img["frames"], img["name"]) == (64, 48, 1, name)
    assert c.get(f"/api/v2/images/{item['id']}/metadata").status_code == 200
    assert c.get(f"/api/v1/images/images/{item['id']}/").json()["id"] == item["id"]


def test_duplicate_upload_reports_existing_id(cleanup):
    name = f"dup-{uuid.uuid4().hex[:8]}.png"
    cleanup.append(name)
    c = client()
    data = png(30, 30, (1, 2, 3))
    first = c.post(f"/images/image/upload/{SET_ID}/", files={"f": (name, data)}).json()["files"][0]
    again = c.post(f"/images/image/upload/{SET_ID}/", files={"f": (name, data)}).json()["files"][0]
    assert first["type"] == "image" and again["error"] == "This image already exists in the imageset!" and again["id"] == first["id"]


def test_document_becomes_auxiliary_file_and_junk_is_rejected(cleanup):
    c = client()
    n1, n2 = f"notes-{uuid.uuid4().hex[:8]}.txt", f"junk-{uuid.uuid4().hex[:8]}.png"
    cleanup.extend([n1, n2])
    r = c.post(f"/images/image/upload/{SET_ID}/", files=[("a", (n1, b"hello")), ("b", (n2, b"not an image"))]).json()["files"]
    assert r[0]["type"] == "auxfile" and r[1]["error"] == "This file type is unsupported!"
    assert not (ROOT / n2).exists()


def test_zip_is_unpacked_into_images(cleanup):
    tag = uuid.uuid4().hex[:8]
    names = [f"z1-{tag}.png", f"z2-{tag}.png"]
    cleanup.extend(names)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr(names[0], png(20, 20, (9, 9, 9)))
        z.writestr(names[1], png(21, 21, (8, 8, 8)))
    c = client()
    r = c.post(f"/api/v2/image-sets/{SET_ID}/images", files={"f": (f"bundle-{tag}.zip", buf.getvalue())})
    assert r.status_code == 201 and r.json()["items"][0].get("error") is None
    got = c.get("/api/v2/images", params={"image_set": SET_ID, "name__contains": tag}).json()["items"]
    assert sorted(i["name"] for i in got) == names


def test_permissions():
    assert httpx.post(BASE + f"/images/image/upload/{SET_ID}/", files={"f": ("x.png", png())}).status_code in (401, 403)
    assert client("rt_outsider").post(f"/api/v2/image-sets/{SET_ID}/images", files={"f": ("x.png", png())}).status_code == 403
    assert client().post("/api/v2/image-sets/99999/images", files={"f": ("x.png", png())}).status_code == 404
