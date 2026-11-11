"""Limited personal access tokens: a token with scopes (jobs, annotate, images) may look and do only that (Rust only)."""
import os
import subprocess
import uuid

import httpx
import pytest
from common import BASE, PW, drop_registration_plugin, registration_plugin

pytestmark = pytest.mark.skipif(httpx.get(BASE + "/api/version").status_code != 200, reason="server has no /api/version (Django)")

IMAGE, SET_ID, BBOX_TYPE = 2, 2, 1  # rt_member's team
JSRC, JTGT = 15, 16  # a registration pair (aubreville)
BB = {"x1": 10, "y1": 20, "x2": 60, "y2": 90}
LIMITED = "This token is limited and may not do this."


def client(user):
    c = httpx.Client(base_url=BASE, timeout=60)
    r = c.post("/api/v2/auth/login", json={"username": user, "password": PW})
    c.headers["X-CSRF-Token"] = r.json()["csrf_token"]
    return c


@pytest.fixture
def tokens():
    made = []

    def make(user, **body):
        c = client(user)
        r = c.post("/api/v2/me/tokens", json={"name": f"scope-{uuid.uuid4().hex[:6]}", **body})
        assert r.status_code == 201, r.text
        t = r.json()
        made.append((c, t["id"]))
        return t, httpx.Client(base_url=BASE, timeout=60, headers={"Authorization": f"Bearer {t['token']}"})

    yield make
    for c, i in made:
        c.delete(f"/api/v2/me/tokens/{i}")
        c.delete(f"/api/v2/me/tokens/{i}")


@pytest.fixture
def reg_plugin():
    registration_plugin(client("aubreville"))
    yield
    subprocess.run([f"{os.environ.get('PGBIN', '/Applications/Postgres.app/Contents/Versions/latest/bin')}/psql", "-h", "127.0.0.1", "-d", os.environ.get("RUST_DB", "exact_rust_test"), "-Atc",
                    "delete from processing_pluginjob where image_id = 15 and plugin_id in (select id from processing_plugin where plugin_type = 2)"], capture_output=True)
    drop_registration_plugin()


def test_scopes_are_reported_and_checked(tokens):
    t, _ = tokens("rt_member")
    assert t["scopes"] is None  # not limited
    t, _ = tokens("rt_member", scopes=["jobs", "images", "jobs"])
    assert t["scopes"] == ["images", "jobs"]
    c = client("rt_member")
    assert [x["scopes"] for x in c.get("/api/v2/me/tokens").json() if x["id"] == t["id"]] == [["images", "jobs"]]
    for bad in ([], ["admin"], ["jobs", "everything"], "jobs"):
        assert c.post("/api/v2/me/tokens", json={"name": "x", "scopes": bad}).status_code in (400, 422), bad
    assert c.post("/api/v2/me/tokens", json={"name": "x", "scopes": ["jobs"], "read_only": True}).status_code == 400


def test_a_jobs_token_queues_jobs_and_nothing_else(tokens, reg_plugin):
    _, j = tokens("aubreville", scopes=["jobs"])
    assert j.get("/api/v2/auth/me").status_code == 200 and j.get("/api/v2/images/%d" % JSRC).status_code in (200, 404)
    q = j.post(f"/api/v2/images/{JSRC}/register", json={"target_image": JTGT})
    assert q.status_code == 202, q.text
    st = j.get(f"/api/v2/registration-jobs/{q.json()['id']}")
    assert st.status_code == 200 and st.json()["status"] == "queued"
    assert j.delete(f"/api/v2/jobs/registration/{q.json()['id']}").status_code == 204  # cancel
    for method, path, body in [
        ("POST", "/api/v2/annotations", {"image": IMAGE, "annotation_type": BBOX_TYPE, "vector": BB}),
        ("PATCH", f"/api/v2/images/{IMAGE}", {"name": "x"}),
        ("POST", f"/api/v2/image-sets/{SET_ID}/images", None),
        ("POST", "/api/v2/jobs/claim", {"worker": "w", "kinds": ["registration"]}),  # worker routes are not for a limited token
        ("PUT", "/api/v2/me/preferences", {"zoom_slider": True}),
        ("POST", "/api/v2/me/tokens", {"name": "child"}),
        ("POST", "/api/v2/admin/users", {"username": "evil"}),
    ]:
        r = j.request(method, path, json=body)
        assert r.status_code == 403 and r.json()["detail"] == LIMITED, (method, path, r.status_code, r.text)


def test_an_annotate_token_annotates_and_nothing_else(tokens, reg_plugin):
    _, a = tokens("rt_member", scopes=["annotate"])
    made = a.post("/api/v2/annotations", json={"image": IMAGE, "annotation_type": BBOX_TYPE, "vector": BB, "unique_identifier": str(uuid.uuid4())})
    assert made.status_code in (200, 201), made.text
    aid = made.json()["id"]
    assert a.patch(f"/api/v2/annotations/{aid}", json={"vector": {**BB, "x2": 80}}, headers={"If-Match": made.headers.get("etag", "*")}).status_code in (200, 412, 428)
    assert a.delete(f"/api/v2/annotations/{aid}").status_code in (200, 204)
    assert a.post(f"/api/v2/images/{IMAGE}/register", json={"target_image": 3}).status_code == 403
    assert a.post(f"/api/v2/image-sets/{SET_ID}/images", files={"file": ("x.txt", b"x")}).status_code == 403
    assert a.patch(f"/api/v2/annotation-types/{BBOX_TYPE}", json={"name": "x"}).status_code == 403


def test_an_images_token_manages_images_and_nothing_else(tokens):
    _, i = tokens("rt_member", scopes=["images"])
    up = i.post(f"/api/v2/image-sets/{SET_ID}/images", files={"file": (f"scope-{uuid.uuid4().hex[:6]}.txt", b"hello")})
    assert up.status_code in (200, 201), up.text
    assert i.post("/api/v2/annotations", json={"image": IMAGE, "annotation_type": BBOX_TYPE, "vector": BB}).status_code == 403
    assert i.post(f"/api/v2/images/{IMAGE}/register", json={"target_image": 3}).status_code == 403
    item = up.json()["items"][0]
    d = i.delete(f"/api/v2/auxiliary-files/{item['id']}")
    # documents are image-set content: the scope lets the request through (what refuses it, if anything, is the image set's own rule)
    assert d.status_code == 204 or d.json()["detail"] != LIMITED, d.text
    client("aubreville").delete(f"/api/v2/auxiliary-files/{item['id']}")


def test_the_scopes_go_with_the_token_and_other_tokens_are_not_limited(tokens):
    t, j = tokens("rt_member", scopes=["jobs"])
    free, f = tokens("rt_member")
    assert j.post("/api/v2/annotations", json={"image": IMAGE, "annotation_type": BBOX_TYPE, "vector": BB}).status_code == 403
    r = f.post("/api/v2/annotations", json={"image": IMAGE, "annotation_type": BBOX_TYPE, "vector": BB, "unique_identifier": str(uuid.uuid4())})
    assert r.status_code in (200, 201), r.text
    f.delete(f"/api/v2/annotations/{r.json()['id']}")
    c = client("rt_member")
    assert c.delete(f"/api/v2/me/tokens/{t['id']}").status_code == 204
    assert c.delete(f"/api/v2/me/tokens/{t['id']}").status_code == 204  # gone, scope row with it
    assert j.get("/api/v2/auth/me").status_code in (401, 403)
