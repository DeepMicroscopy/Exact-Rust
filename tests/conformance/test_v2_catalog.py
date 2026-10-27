"""Tags and products of image sets, annotation types and products (v2 + the legacy endpoints exact-sync uses). Rust only."""
import uuid

import httpx
import pytest
from common import BASE, PW

pytestmark = pytest.mark.skipif(httpx.get(BASE + "/api/version").status_code != 200, reason="server has no /api/version (Django)")


def client(user="rt_member"):
    c = httpx.Client(base_url=BASE, timeout=60)
    r = c.post("/api/v2/auth/login", json={"username": user, "password": PW})
    c.headers["X-CSRF-Token"] = r.json()["csrf_token"]
    return c


@pytest.fixture
def a_set():
    c = client("rt_teamadmin")
    s = c.post("/api/v2/image-sets", json={"name": f"cat-{uuid.uuid4().hex[:8]}", "team": 1}).json()
    yield c, s["id"]
    c.delete(f"/api/v2/image-sets/{s['id']}")


def test_v2_tags_add_idempotent_remove_and_cleanup(a_set):
    c, sid = a_set
    name = f"Tag {uuid.uuid4().hex[:6]}?"
    r1 = c.post(f"/api/v2/image-sets/{sid}/tags", json={"name": name})
    clean = name.lower().replace("?", "").replace(" ", "_")
    assert r1.status_code == 201 and r1.json()["name"] == clean
    assert c.post(f"/api/v2/image-sets/{sid}/tags", json={"name": name}).status_code == 200
    assert clean in [t["name"] for t in c.get(f"/api/v2/image-sets/{sid}", params={"expand": "set_tags"}).json()["set_tags"]]
    assert c.delete(f"/api/v2/image-sets/{sid}/tags/{clean}").status_code == 204
    assert c.delete(f"/api/v2/image-sets/{sid}/tags/{clean}").status_code == 404
    assert c.get("/api/v2/set-tags", params={"name": clean}).json()["items"] == []  # the unused tag is gone


def test_legacy_tag_endpoints_answer_like_django(a_set):
    c, sid = a_set
    name = f"leg{uuid.uuid4().hex[:6]}"
    r = c.post("/images/api/imageset/tag/add/", json={"image_set_id": sid, "tag_name": name.upper()})
    assert r.status_code == 201 and r.json()["detail"] == "tagged the imageset." and r.json()["tag"]["name"] == name
    again = c.post("/images/api/imageset/tag/add/", json={"image_set_id": sid, "tag_name": name})
    assert again.status_code == 200 and again.json() == {"detail": "imageset has the tag already."}
    gone = c.request("DELETE", "/images/api/imageset/tag/delete/", json={"image_set_id": sid, "tag_name": name})
    assert gone.status_code == 201 and gone.json()["detail"] == "removed the tag."
    assert c.request("DELETE", "/images/api/imageset/tag/delete/", json={"image_set_id": sid, "tag_name": name}).status_code == 404


def test_tag_permissions(a_set):
    _, sid = a_set
    assert client("rt_outsider").post(f"/api/v2/image-sets/{sid}/tags", json={"name": "x"}).status_code == 404
    assert client("rt_outsider").post("/images/api/imageset/tag/add/", json={"image_set_id": sid, "tag_name": "x"}).status_code == 404


def test_set_products_v2_and_legacy(a_set):
    c, sid = a_set
    assert c.put(f"/api/v2/image-sets/{sid}/products/1").status_code == 204
    assert c.put(f"/api/v2/image-sets/{sid}/products/1").status_code == 204
    assert c.put(f"/api/v2/image-sets/{sid}/products/99999").status_code == 404
    assert c.delete(f"/api/v2/image-sets/{sid}/products/1").status_code == 204
    assert c.delete(f"/api/v2/image-sets/{sid}/products/1").status_code == 404
    r = c.post("/images/api/imageset/product/add/", json={"image_set_id": sid, "product_id": 1})
    assert r.status_code == 201 and r.json()["product"]["id"] == 1
    assert c.post("/images/api/imageset/product/add/", json={"image_set_id": sid, "product_id": 1}).json() == {"detail": "imageset has the product already."}
    d = c.request("DELETE", "/images/api/imageset/product/delete/", json={"image_set_id": sid, "product_id": 1})
    assert d.status_code == 201 and d.json()["detail"] == "removed the product."


def test_annotation_type_crud_and_protection():
    c = client("aubreville")
    name = f"t-{uuid.uuid4().hex[:6]}"
    r = c.post("/api/v2/annotation-types", json={"name": name, "vector_type": 5, "color_code": "#123456", "product": 1})
    assert r.status_code == 201, r.text
    t = r.json()
    assert (t["name"], t["vector_type"], t["color_code"], t["product"]) == (name, 5, "#123456", 1)
    assert c.patch(f"/api/v2/annotation-types/{t['id']}", json={"color_code": "#abcdef", "active": False}).json()["color_code"] == "#abcdef"
    assert c.patch(f"/api/v2/annotation-types/{t['id']}", json={"vector_type": 1}).json()["vector_type"] == 1  # unused: allowed
    assert c.post("/api/v2/annotation-types", json={"name": "x", "vector_type": 99}).status_code == 400
    # used types cannot be deleted
    img = c.get("/api/v2/images", params={"limit": 1}).json()["items"][0]["id"]
    a = c.post("/api/v2/annotations", json={"image": img, "annotation_type": t["id"], "vector": {"x1": 1, "y1": 1, "x2": 9, "y2": 9}})
    assert a.status_code == 201
    assert c.delete(f"/api/v2/annotation-types/{t['id']}").status_code == 409
    assert c.patch(f"/api/v2/annotation-types/{t['id']}", json={"vector_type": 2}).status_code == 400
    c.delete(f"/api/v2/annotations/{a.json()['id']}", params={"hard": "true"})
    assert c.delete(f"/api/v2/annotation-types/{t['id']}").status_code == 204
    assert c.get(f"/api/v2/annotation-types/{t['id']}").status_code == 404


def test_annotation_type_needs_model_permission():
    assert client("rt_outsider").post("/api/v2/annotation-types", json={"name": "x"}).status_code == 403


def test_legacy_annotation_type_create_and_delete():
    c = client("aubreville")
    name = f"leg-{uuid.uuid4().hex[:6]}"
    r = c.post("/administration/api/annotation_type/create/", json={"name": name, "vector_type": 1, "product_id": 1})
    assert r.status_code == 201 and r.json()["annotationType"]["name"] == name
    tid = r.json()["annotationType"]["id"]
    assert client("rt_member").post("/administration/api/annotation_type/delete/", json={"annotation_type_id": tid}).status_code == 403
    assert c.post("/administration/api/annotation_type/delete/", json={"annotation_type_id": tid}).json() == {"detail": "OK"}


def test_product_crud_with_copy_of_annotation_types():
    c = client("aubreville")
    name = f"p-{uuid.uuid4().hex[:6]}"
    r = c.post("/api/v2/products", json={"name": name, "team": 1, "copy_product": 1})
    assert r.status_code == 201, r.text
    pid = r.json()["id"]
    types = c.get("/api/v2/annotation-types", params={"product": pid}).json()["items"]
    assert len(types) >= 1
    assert c.post("/api/v2/products", json={"name": name, "team": 1}).status_code == 400
    assert c.patch(f"/api/v2/products/{pid}", json={"description": "d"}).json()["description"] == "d"
    assert c.delete(f"/api/v2/products/{pid}").status_code == 204
    assert c.get(f"/api/v2/products/{pid}").status_code == 404
    left = c.get("/api/v2/annotation-types", params={"id__in": ",".join(str(t["id"]) for t in types)}).json()["items"]
    assert all(t["product"] is None for t in left)  # SET_NULL: the copied types stay, unassigned
    for t in left:
        c.delete(f"/api/v2/annotation-types/{t['id']}")
