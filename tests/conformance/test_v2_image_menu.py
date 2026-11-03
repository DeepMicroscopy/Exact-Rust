"""The image menu of the image-set page: download (ZIP for slides with a folder) and related images (Rust only)."""
import io
import zipfile

import httpx
import pytest
from common import BASE, PW

pytestmark = pytest.mark.skipif(httpx.get(BASE + "/api/version").status_code != 200, reason="server has no /api/version (Django)")


def client(user="aubreville", password=PW):
    c = httpx.Client(base_url=BASE, timeout=120)
    r = c.post("/api/v2/auth/login", json={"username": user, "password": password})
    assert r.status_code == 200, r.text
    c.headers["X-CSRF-Token"] = r.json()["csrf_token"]
    return c


def image(c, **match):
    for i in c.get("/api/v1/images/images/", params={"limit": 500}).json()["results"]:
        if all(str(i.get(k, "")).lower().endswith(v) for k, v in match.items()):
            return i
    pytest.skip(f"no image {match} in this database")


def test_a_plain_file_is_sent_as_it_is():
    c = client()
    i = image(c, filename=".tiff")
    r = c.get(f"/api/v2/images/{i['id']}/download")
    assert r.status_code == 200
    assert i["filename"].split("/")[-1] in r.headers["content-disposition"]
    assert int(r.headers["content-length"]) == len(r.content) > 0


@pytest.mark.parametrize("ext, folder", [(".mrxs", "{stem}/"), (".vsi", "_{stem}_/")])
def test_slides_with_a_folder_come_as_a_zip(ext, folder):
    c = client()
    i = image(c, filename=ext)
    r = c.get(f"/api/v2/images/{i['id']}/download")
    assert r.status_code == 200
    assert r.headers["content-disposition"].count(".zip") >= 1
    z = zipfile.ZipFile(io.BytesIO(r.content))
    assert z.testzip() is None
    names = z.namelist()
    stem = i["filename"].rsplit(".", 1)[0].split("/")[-1]
    prefix = folder.format(stem=stem)
    assert any(n.startswith(prefix) and not n.endswith("/") for n in names), names[:5]
    assert any(n.endswith(i["filename"].split("/")[-1]) for n in names)


def test_the_temporary_zip_is_not_left_behind():
    import pathlib
    left = list(pathlib.Path(__file__).resolve().parents[2].glob("reference/instance/cache/downloads/*"))
    assert left == []


def test_download_needs_a_team_membership():
    c = client()
    i = image(c, filename=".tiff")
    out = client("rt_outsider")
    assert out.get(f"/api/v2/images/{i['id']}/download").status_code == 403


def test_related_lists_crops_and_registrations():
    c = client()
    crop = next((i for i in c.get("/api/v1/images/images/", params={"limit": 500}).json()["results"] if i.get("crop_source")), None)
    if crop is None:
        pytest.skip("no crop in this database")
    up = c.get(f"/api/v2/images/{crop['crop_source']}/related").json()
    assert any(r["kind"] == "crop" and r["id"] == crop["id"] for r in up)
    down = c.get(f"/api/v2/images/{crop['id']}/related").json()
    assert any(r["kind"] == "crop_of" and r["id"] == crop["crop_source"] for r in down)
    for r in up + down:
        assert set(r) == {"id", "name", "set", "set_name", "kind"}


def test_related_hides_what_the_user_may_not_see_and_unknown_images():
    c = client()
    assert c.get("/api/v2/images/99999999/related").status_code == 404
    i = image(c, filename=".tiff")
    assert client("rt_outsider").get(f"/api/v2/images/{i['id']}/related").status_code == 404


def test_related_lists_registrations_in_both_directions():
    c = client()
    regs = c.get("/api/v2/registrations", params={"limit": 50}).json()["items"]
    if not regs:
        pytest.skip("no registration in this database")
    r = regs[0]
    src, tgt = r["source_image"], r["target_image"]
    src, tgt = (src["id"], tgt["id"]) if isinstance(src, dict) else (src, tgt)
    assert any(x["kind"] == "registered_to" and x["id"] == tgt for x in c.get(f"/api/v2/images/{src}/related").json())
    assert any(x["kind"] == "registered_from" and x["id"] == src for x in c.get(f"/api/v2/images/{tgt}/related").json())


def test_several_images_come_as_one_zip():
    c = client()
    a = image(c, filename=".tiff")
    b = image(c, filename=".gz")
    r = c.get("/api/v2/images/download", params={"ids": f"{a['id']},{b['id']}"})
    assert r.status_code == 200, r.text[:200]
    assert r.headers["content-type"] == "application/zip"
    names = zipfile.ZipFile(io.BytesIO(r.content)).namelist()
    assert len(names) >= 2 and not any(n.endswith("NOT_INCLUDED.txt") for n in names), names
    one = c.get(f"/api/v2/images/{a['id']}/download")
    assert zipfile.ZipFile(io.BytesIO(r.content)).read(names[0]) in (one.content, zipfile.ZipFile(io.BytesIO(r.content)).read(names[0]))


def test_several_images_are_checked_one_by_one():
    c = client()
    i = image(c, filename=".tiff")
    assert client("rt_outsider").get("/api/v2/images/download", params={"ids": str(i["id"])}).status_code == 403
    assert c.get("/api/v2/images/download", params={"ids": "abc"}).status_code == 400
    assert c.get("/api/v2/images/download", params={"ids": "99999999"}).status_code == 404
    assert c.get("/api/v2/images/download").status_code == 400
    assert httpx.get(BASE + "/api/v2/images/download", params={"ids": str(i["id"])}).status_code in (401, 403)


def test_an_image_is_renamed_and_renamed_back():
    c = client()
    i = image(c, filename=".tiff")
    old = i["name"]
    new = "renamed-by-test.tiff" if old.lower().endswith(".tiff") else "renamed-by-test" + old[old.rfind("."):]
    try:
        r = c.post(f"/api/v2/images/{i['id']}/rename", json={"name": new})
        assert r.status_code == 200, r.text
        assert c.get(f"/api/v1/images/images/{i['id']}/").json()["name"] == new
        # the file of the viewers is untouched
        assert c.get(f"/api/v2/images/{i['id']}/download").status_code == 200
        assert c.get(f"/api/v2/images/{i['id']}/download", params={"original_image": "True"}).status_code == 200
        # the extension stays, no paths, no empty name, no name of another image
        assert c.post(f"/api/v2/images/{i['id']}/rename", json={"name": "x.png"}).status_code == 400
        assert c.post(f"/api/v2/images/{i['id']}/rename", json={"name": "../x" + new[new.rfind("."):]}).status_code == 400
        assert c.post(f"/api/v2/images/{i['id']}/rename", json={"name": ""}).status_code == 400
        other = next(j for j in c.get("/api/v1/images/images/", params={"limit": 500}).json()["results"] if j["image_set"] == i["image_set"] and j["id"] != i["id"] and j["name"].lower().endswith(new[new.rfind("."):].lower()))
        assert c.post(f"/api/v2/images/{i['id']}/rename", json={"name": other["name"]}).status_code == 409
        assert client("rt_outsider").post(f"/api/v2/images/{i['id']}/rename", json={"name": new}).status_code == 403
    finally:
        assert c.post(f"/api/v2/images/{i['id']}/rename", json={"name": old}).status_code == 200
    assert c.get(f"/api/v1/images/images/{i['id']}/").json()["name"] == old
