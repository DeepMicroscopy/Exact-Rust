"""Auxiliary files (documents in an image set): list, download, delete (Rust only)."""
import uuid

import httpx
import pytest
from common import BASE, PW

pytestmark = pytest.mark.skipif(httpx.get(BASE + "/api/version").status_code != 200, reason="server has no /api/version (Django)")

SET_ID = 2


def client(user="rt_member"):
    c = httpx.Client(base_url=BASE, timeout=60)
    r = c.post("/api/v2/auth/login", json={"username": user, "password": PW})
    c.headers["X-CSRF-Token"] = r.json()["csrf_token"]
    return c


def test_a_document_is_listed_downloaded_and_deleted():
    c = client()
    name = f"report-{uuid.uuid4().hex[:8]}.txt"
    body = b"hello pathologist\n"
    item = c.post(f"/api/v2/image-sets/{SET_ID}/images", files={"file": (name, body)}).json()["items"][0]
    assert item["type"] == "auxfile", item
    listed = c.get(f"/api/v2/image-sets/{SET_ID}/auxiliary-files").json()
    row = next(f for f in listed["files"] if f["id"] == item["id"])
    assert row["name"] == name and row["filesize"] == len(body) and row["creator"] == "rt_member"
    d = c.get(f"/api/v2/auxiliary-files/{item['id']}/download")
    assert d.status_code == 200 and d.content == body
    assert name in d.headers["content-disposition"]
    if listed["can_delete"]:
        assert c.delete(f"/api/v2/auxiliary-files/{item['id']}").status_code == 204
        assert c.get(f"/api/v2/auxiliary-files/{item['id']}/download").status_code == 404


def test_an_outsider_cannot_see_the_files():
    c = client("rt_member")
    name = f"secret-{uuid.uuid4().hex[:8]}.txt"
    item = c.post(f"/api/v2/image-sets/{SET_ID}/images", files={"file": (name, b"x")}).json()["items"][0]
    o = client("rt_outsider")
    assert o.get(f"/api/v2/auxiliary-files/{item['id']}/download").status_code == 404
    assert o.get(f"/api/v2/image-sets/{SET_ID}/auxiliary-files").status_code == 404
    assert o.delete(f"/api/v2/auxiliary-files/{item['id']}").status_code == 404
    c.delete(f"/api/v2/auxiliary-files/{item['id']}")


def test_team_statistics_for_members_only():
    c = client()
    teams = c.get("/api/v2/teams").json()
    tid = teams["items"][0]["id"] if "items" in teams else teams["results"][0]["id"]
    d = c.get(f"/api/v2/teams/{tid}/statistics")
    assert d.status_code == 200, d.text
    j = d.json()
    assert j["total_images"] >= 1 and j["storage_gb"] >= 0
    assert sum(a["count"] for a in j["annotation_types"]) == j["total_annotations"]
    assert sum(t["count"] for t in j["image_types"]) == j["total_images"]
    assert sum(e["count"] for e in j["extensions"]) == j["total_images"]
    o = client("rt_outsider")
    assert o.get(f"/api/v2/teams/{tid}/statistics").status_code == 404
