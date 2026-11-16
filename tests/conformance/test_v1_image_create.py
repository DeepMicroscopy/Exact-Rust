"""POST /api/v1/images/images/ (Rust only): image upload over v1, what exact-sync's `ImagesApi.create_image` calls.

Django's `ImageViewSet.create`: multipart with the files and `image_set` (exact-sync sends the file first), answers the new
images as a page of the v1 list. Duplicates are skipped and only missing from the answer.
"""
import io
import os
import pathlib
import uuid
import zipfile

import httpx
import pytest
from common import BASE, PW

pytestmark = pytest.mark.skipif(httpx.get(BASE + "/api/version").status_code != 200, reason="server has no /api/version (Django)")

IMAGES = pathlib.Path(os.environ.get("IMAGE_PATH", pathlib.Path(__file__).resolve().parents[2] / "reference/instance/images"))
URL = "/api/v1/images/images/"


def client(user="aubreville"):
    return httpx.Client(base_url=BASE, auth=(user, PW), timeout=60)


def png(color=(9, 9, 9), size=(20, 16)):
    from PIL import Image
    b = io.BytesIO()
    Image.new("RGB", size, color).save(b, "PNG")
    return b.getvalue()


def multipart(parts):
    """A multipart body with the parts in the given order: `(name, value)` or `(name, (filename, bytes))`."""
    boundary = "UploadBoundary-xyz"  # what exact-sync uses
    out = b""
    for name, value in parts:
        out += f"--{boundary}\r\n".encode()
        if isinstance(value, tuple):
            out += f'Content-Disposition: form-data; name="{name}"; filename="{value[0]}"\r\nContent-Type: image/png\r\n\r\n'.encode()
            out += value[1] + b"\r\n"
        else:
            out += f'Content-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
    out += f"--{boundary}--\r\n".encode()
    return out, {"Content-Type": f"multipart/form-data; boundary={boundary}"}


def upload(c, parts):
    body, headers = multipart(parts)
    return c.post(URL, content=body, headers=headers)


def staged_leftovers():
    return [p for p in IMAGES.rglob(".upload-*")] if IMAGES.exists() else []


@pytest.fixture
def image_set():
    c = client()
    r = c.post("/api/v1/images/image_sets/", json={"name": f"v1-img-{uuid.uuid4().hex[:8]}", "team": 1})
    assert r.status_code == 201, r.text
    yield c, r.json()
    c.delete(f"/api/v2/image-sets/{r.json()['id']}")


def test_upload_in_exact_sync_order_answers_the_v1_list_page(image_set):
    c, s = image_set
    name = f"v1-{uuid.uuid4().hex[:6]}.png"
    # exact-sync: the file field first, then image_type and image_set
    r = upload(c, [("file_path", (name, png())), ("image_type", "0"), ("image_set", str(s["id"]))])
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["count"] == 1 and d["next"] is None and d["previous"] is None
    img = d["results"][0]
    assert img == c.get(f"{URL}{img['id']}/").json()  # the v1 representation
    assert img["name"] == name and img["image_set"] == s["id"] and (img["width"], img["height"]) == (20, 16)
    assert (IMAGES / s["path"] / name).exists()
    assert not staged_leftovers()


def test_set_first_several_files_and_duplicates(image_set):
    c, s = image_set
    a, b = f"a-{uuid.uuid4().hex[:6]}.png", f"b-{uuid.uuid4().hex[:6]}.png"
    r = upload(c, [("image_set", str(s["id"])), ("f1", (a, png((1, 2, 3)))), ("f2", (b, png((4, 5, 6))))])
    assert r.status_code == 200, r.text
    assert sorted(i["name"] for i in r.json()["results"]) == sorted([a, b])
    # the same file again: skipped, as in Django (no error, just not in the answer)
    again = upload(c, [("file_path", (a, png((1, 2, 3)))), ("image_set", str(s["id"]))])
    assert again.status_code == 200 and again.json() == {"count": 0, "next": None, "previous": None, "results": []}
    assert c.get(URL, params={"image_set": s["id"]}).json()["count"] == 2


def test_zip_answers_all_images_of_the_archive(image_set):
    c, s = image_set
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("z1.png", png((7, 7, 7)))
        z.writestr("z2.png", png((8, 8, 8)))
    r = upload(c, [("file_path", ("both.zip", buf.getvalue())), ("image_set", str(s["id"]))])
    assert r.status_code == 200, r.text
    assert sorted(i["name"] for i in r.json()["results"]) == ["z1.png", "z2.png"]


def test_paging_parameters_apply_to_the_answer(image_set):
    c, s = image_set
    body, headers = multipart([("f1", ("p1.png", png((1, 1, 1)))), ("f2", ("p2.png", png((2, 2, 2)))), ("image_set", str(s["id"]))])
    d = c.post(URL + "?limit=1", content=body, headers=headers).json()
    assert d["count"] == 2 and len(d["results"]) == 1 and "offset=1" in d["next"]


def test_refusals_leave_nothing_behind(image_set):
    c, s = image_set
    f = ("file_path", ("r.png", png()))
    r = upload(c, [f])  # no image_set: Django's int(... 0) -> get_object_or_404
    assert r.status_code == 404 and r.json() == {"detail": "No ImageSet matches the given query."}
    assert upload(c, [f, ("image_set", "999999")]).status_code == 404
    r = upload(c, [f, ("image_set", "abc")])
    assert r.status_code == 400 and r.json() == {"image_set": ["A valid integer is required."]}
    assert upload(client("rt_outsider"), [f, ("image_set", str(s["id"]))]).status_code == 403
    body, headers = multipart([f, ("image_set", str(s["id"]))])
    assert httpx.post(BASE + URL, content=body, headers=headers).status_code in (401, 403)
    c.patch(f"/api/v2/image-sets/{s['id']}", json={"image_lock": True})
    assert upload(c, [f, ("image_set", str(s["id"]))]).status_code == 403
    c.patch(f"/api/v2/image-sets/{s['id']}", json={"image_lock": False})
    assert c.get(URL, params={"image_set": s["id"]}).json()["count"] == 0
    assert not staged_leftovers()


def test_the_list_and_its_methods_are_unchanged():
    c = client()
    assert c.get(URL, params={"limit": 1}).json()["results"] is not None
    # methods the list does not have answer as on every other v1 list
    for m in ("PUT", "PATCH", "DELETE"):
        assert c.request(m, URL).status_code == c.request(m, "/api/v1/images/image_sets/").status_code == 405
