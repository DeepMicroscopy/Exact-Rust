"""One image store (IMAGE_PATH) for both servers: what one writes, the other must find, serve and delete."""
import hashlib
import os
import stat

import httpx
import pytest

from coex import BOTH, IMAGE_PATH, django, execute, png, rust, sql, unique

USER = "rt_teamadmin"
VOLATILE_IMAGE = {"id", "image_set_id", "time", "creator_id", "name", "filename"}


def make_set(server):
    """An image set the way each server's own API makes one (Django: the v1 REST create; Rust has no v1 create, its own is v2)."""
    name = unique("coex-set")
    if server is django:
        r = server.basic("aubreville").post("/api/v1/images/image_sets/", json={"name": name, "team": 1, "images": [], "product_set": [], "set_tags": []})
    else:
        r = server.session("aubreville").post("/api/v2/image-sets", json={"name": name, "team": 1})
    assert r.status_code in (200, 201), f"{server.name}: {r.status_code} {r.text[:200]}"
    sid = r.json()["id"]
    row = sql(f"select path from images_imageset where id = {sid}")[0]
    return sid, row["path"]


def upload(server, set_id, name, data):
    """The browser's upload (a session, CSRF): the same URL on both servers."""
    c = server.session(USER)
    r = c.post(f"/images/image/upload/{set_id}/", files={"file": (name, data, "image/png")})
    assert r.status_code == 200, f"{server.name}: {r.status_code} {r.text[:300]}"
    return r.json()


def image_row(name, set_id):
    rows = sql(f'select * from images_image where name = \'{name}\' and image_set_id = {set_id}')
    assert len(rows) == 1, rows
    return rows[0]


def folder(path):
    return os.path.join(IMAGE_PATH, path)


@pytest.fixture(scope="module")
def sets():
    out = {s.name: make_set(s) for s in BOTH}
    yield out


def test_an_image_set_made_by_either_server_has_its_folder_in_the_shared_store(sets):
    for name, (sid, path) in sets.items():
        assert path and os.path.isdir(folder(path)), f"{name}: no folder {path!r}"
    modes = {n: stat.S_IMODE(os.stat(folder(p)).st_mode) for n, (_, p) in sets.items()}
    assert modes["django"] == modes["rust"], f"the folders get different permissions: { {k: oct(v) for k, v in modes.items()} }"


@pytest.mark.parametrize("uploader", [django, rust], ids=lambda s: f"uploaded-by-{s.name}")
def test_an_upload_into_a_set_of_the_other_server_works_and_both_serve_it(uploader, sets):
    reader = rust if uploader is django else django
    sid, path = sets[reader.name]
    name = unique("up") + ".png"
    data = png(400, 300, seed=7)
    r = upload(uploader, sid, name, data)
    row = image_row(name, sid)
    on_disk = os.path.join(folder(path), row["filename"])
    assert os.path.isfile(on_disk), f"the file is not where the row says: {on_disk}"
    # both servers read the same file, whoever wrote it
    info = {}
    for s in BOTH:
        c = s.basic(USER)
        meta = c.get(f"/api/v1/images/images/{row['id']}/slide_information/")
        assert meta.status_code == 200, f"{s.name} cannot read the image {uploader.name} uploaded: {meta.status_code} {meta.text[:200]}"
        info[s.name] = meta.json()
        th = c.get(f"/api/v1/images/images/{row['id']}/thumbnail/")
        assert th.status_code == 200 and th.content[:4] == b"\x89PNG", f"{s.name}: thumbnail {th.status_code}"
        dz = c.get(f"/api/v1/images/images/{row['id']}/1/0/tile/")
        assert dz.status_code == 200 and b"<Image" in dz.content, f"{s.name}: DZI {dz.status_code}"
    assert info["django"] == info["rust"], "the two servers describe the same file differently"
    # the first thing a user does: open it (a tile)
    for s in BOTH:
        t = s.basic(USER).get(f"/api/v1/images/images/{row['id']}/1/0/tile_files/0/0_0.jpeg/")
        assert t.status_code == 200, f"{s.name}: tile {t.status_code}"


def test_the_same_upload_leaves_the_same_row_and_file_whichever_server_took_it(sets):
    name = unique("same") + ".png"
    data = png(350, 250, seed=11)
    made = {}
    for s in BOTH:
        sid, path = sets[s.name]
        upload(s, sid, name, data)
        row = image_row(name, sid)
        made[s.name] = (row, path)
    a, b = (made["django"][0], made["rust"][0])
    diff = {k: (a[k], b[k]) for k in a if k not in VOLATILE_IMAGE and a[k] != b[k]}
    assert not diff, f"the rows differ: {diff}"
    assert a["filename"] == b["filename"] == name, (a["filename"], b["filename"])
    fa, fb = (os.path.join(folder(made[n][1]), made[n][0]["filename"]) for n in ("django", "rust"))
    assert os.path.getsize(fa) > 0 and os.path.getsize(fb) > 0
    # the new file's permissions (a file that one server writes must stay writable and deletable for the other)
    assert stat.S_IMODE(os.stat(fa).st_mode) == stat.S_IMODE(os.stat(fb).st_mode), "files get different permissions"
    # what is left next to the file (pyramid, thumbnails) is the same kind of thing
    la, lb = (sorted(os.listdir(folder(made[n][1]))) for n in ("django", "rust"))
    suffixes = lambda names: sorted({os.path.splitext(n)[1] for n in names})  # noqa: E731
    assert suffixes(la) == suffixes(lb), (la, lb)


@pytest.mark.parametrize("deleter", [django, rust], ids=lambda s: f"deleted-by-{s.name}")
def test_an_image_the_other_server_uploaded_is_deleted_completely(deleter, sets):
    uploader = rust if deleter is django else django
    sid, path = sets[uploader.name]
    name = unique("del") + ".png"
    upload(uploader, sid, name, png(300, 200, seed=3))
    row = image_row(name, sid)
    on_disk = os.path.join(folder(path), row["filename"])
    assert os.path.isfile(on_disk)
    # the annotation of the image goes with it
    a = uploader.basic(USER).post("/annotations/api/annotation/create/", json={"image_id": row["id"], "annotation_type_id": 1, "vector": {"x1": 5, "y1": 5, "x2": 30, "y2": 30}})
    assert a.status_code in (200, 201), a.text[:300]
    # each server's own delete (Django: the old GET url of its UI; Rust has no v1 delete, its own is v2)
    if deleter is django:
        r = deleter.session(USER).get(f"/images/api/image/delete/{row['id']}/")
    else:
        r = deleter.session(USER).delete(f"/api/v2/images/{row['id']}")
    assert r.status_code in (200, 204), f"{deleter.name}: {r.status_code} {r.text[:200]}"
    assert sql(f"select count(*) n from images_image where id = {row['id']}")[0]["n"] == 0
    assert sql(f"select count(*) n from annotations_annotation where image_id = {row['id']}")[0]["n"] == 0
    assert not os.path.exists(on_disk), f"{deleter.name} left the file of the image {uploader.name} uploaded"
    left = [n for n in os.listdir(folder(path)) if n.startswith(os.path.splitext(row["filename"])[0])]
    assert not left, f"leftovers of the deleted image: {left}"


def test_the_same_file_uploaded_twice_is_refused_across_servers(sets):
    sid, _ = sets["django"]
    name = unique("dup") + ".png"
    data = png(300, 200, seed=5)
    upload(django, sid, name, data)
    r = rust.session(USER).post(f"/images/image/upload/{sid}/", files={"file": (name, data, "image/png")})
    body = r.json()
    assert sql(f"select count(*) n from images_image where name = '{name}' and image_set_id = {sid}")[0]["n"] == 1, body
