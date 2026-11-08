"""POST /api/v1/images/image_sets/ (Rust only): the v1 representation, DRF-shaped errors, permissions."""
import uuid

import httpx
import pytest
from common import BASE, PW

pytestmark = pytest.mark.skipif(httpx.get(BASE + "/api/version").status_code != 200, reason="server has no /api/version (Django)")


def client(user="aubreville"):
    return httpx.Client(base_url=BASE, auth=(user, PW), timeout=60)


def test_create_image_set_over_v1():
    c = client()
    name = "v1 set " + uuid.uuid4().hex[:8]
    r = c.post("/api/v1/images/image_sets/", json={"name": name, "team": 1, "description": "made by the test", "product_set": []})
    assert r.status_code == 201, r.text
    try:
        d = r.json()
        assert d["name"] == name and d["team"] == 1 and d["creator"] == 1 and d["images"] == [] and d["product_set"] == []
        assert d["path"].endswith(f"_1_{d['id']}")
        # it is there, and a second one with the same name is refused the DRF way
        assert c.get(f"/api/v1/images/image_sets/{d['id']}/").json()["name"] == name
        dup = c.post("/api/v1/images/image_sets/", json={"name": name, "team": 1})
        assert dup.status_code == 400 and dup.json() == {"name": ["An image set with this name exists in the team."]}
    finally:
        c.delete(f"/api/v2/image-sets/{r.json()['id']}")


def test_errors_and_permissions():
    c = client()
    assert c.post("/api/v1/images/image_sets/", json={"team": 1}).json() == {"name": ["This field is required."]}
    assert c.post("/api/v1/images/image_sets/", json={"name": "x"}).json() == {"team": ["This field is required."]}
    assert c.post("/api/v1/images/image_sets/", json={"name": "x", "team": 999999}).status_code == 400
    assert client("rt_member").post("/api/v1/images/image_sets/", json={"name": "nope", "team": 1}).status_code == 403
    assert httpx.post(BASE + "/api/v1/images/image_sets/", json={"name": "x", "team": 1}).status_code in (401, 403)
