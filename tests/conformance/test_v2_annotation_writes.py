"""/api/v2 annotation writes: create, idempotency, validation, conditional PATCH, soft/hard delete, verify, permissions."""
import uuid

import httpx
import pytest
from common import BASE, PW

pytestmark = pytest.mark.skipif(httpx.get(BASE + "/api/version").status_code != 200, reason="server has no /api/version (Django)")

BB = {"x1": 10, "y1": 20, "x2": 60, "y2": 90}
IMAGE, BBOX_TYPE, POLY_TYPE = 2, 1, 4


def client(user="rt_member"):
    c = httpx.Client(base_url=BASE, timeout=30)
    r = c.post("/api/v2/auth/login", json={"username": user, "password": PW})
    assert r.status_code == 200
    c.headers["X-CSRF-Token"] = r.json()["csrf_token"]
    return c


def make(c, **kw):
    body = {"image": IMAGE, "annotation_type": BBOX_TYPE, "vector": BB, **kw}
    r = c.post("/api/v2/annotations", json=body)
    assert r.status_code in (200, 201), r.text
    return r.json()


def test_create_returns_v2_shape_and_is_not_verified():
    c = client()
    a = make(c, description="hello", meta_data={"k": 1})
    assert a["vector"] == BB and a["description"] == "hello" and a["meta_data"] == {"k": 1}
    assert a["deleted"] is False and a["last_edit_time"].endswith("Z") or "+00:00" in a["last_edit_time"]
    assert a["verified_by_user"] is False  # writing does not verify
    assert c.get(f"/api/v2/annotations/{a['id']}").json()["id"] == a["id"]


def test_create_with_existing_unique_identifier_is_idempotent():
    c = client()
    u = str(uuid.uuid4())
    r1 = c.post("/api/v2/annotations", json={"image": IMAGE, "annotation_type": BBOX_TYPE, "vector": BB, "unique_identifier": u})
    r2 = c.post("/api/v2/annotations", json={"image": IMAGE, "annotation_type": BBOX_TYPE, "vector": {**BB, "x2": 99}, "unique_identifier": u})
    assert (r1.status_code, r2.status_code) == (201, 200)
    assert r1.json()["id"] == r2.json()["id"] and r2.json()["vector"] == BB


@pytest.mark.parametrize("body,field", [
    ({"annotation_type": BBOX_TYPE, "vector": BB}, "image"),
    ({"image": IMAGE, "vector": BB}, "annotation_type"),
    ({"image": IMAGE, "annotation_type": BBOX_TYPE}, "vector"),
    ({"image": 99999, "annotation_type": BBOX_TYPE, "vector": BB}, "image"),
    ({"image": IMAGE, "annotation_type": 99999, "vector": BB}, "annotation_type"),
    ({"image": IMAGE, "annotation_type": BBOX_TYPE, "vector": {"x1": 1, "y1": 1, "x2": 1, "y2": 5}}, "vector"),
    ({"image": IMAGE, "annotation_type": POLY_TYPE, "vector": {"x1": 1, "y1": 2, "x2": 3, "y2": 4}}, "vector"),
    ({"image": IMAGE, "annotation_type": BBOX_TYPE, "vector": BB, "unique_identifier": "nope"}, "unique_identifier"),
])
def test_validation_errors_name_the_field(body, field):
    r = client().post("/api/v2/annotations", json=body)
    assert r.status_code == 400 and field in r.json()["errors"]


def test_vector_is_cast_to_integers_and_null_means_not_in_image():
    c = client()
    assert make(c, vector={"x1": 10.7, "y1": 20.2, "x2": 60.9, "y2": 90.1})["vector"] == {"x1": 10, "y1": 20, "x2": 60, "y2": 90}
    assert make(c, vector=None)["vector"] is None


def test_patch_updates_and_sets_last_editor():
    c = client()
    a = make(c)
    r = c.patch(f"/api/v2/annotations/{a['id']}", json={"vector": {**BB, "x2": 80}, "description": "moved"})
    assert r.status_code == 200
    j = r.json()
    assert j["vector"]["x2"] == 80 and j["description"] == "moved" and j["last_edit_time"] >= a["last_edit_time"]


def test_patch_type_change_only_within_same_vector_family():
    c = client()
    a = make(c)
    assert c.patch(f"/api/v2/annotations/{a['id']}", json={"annotation_type": 5}).status_code == 200  # bbox -> fixed size bbox
    assert c.patch(f"/api/v2/annotations/{a['id']}", json={"annotation_type": POLY_TYPE}).status_code == 400


def test_conditional_patch_conflicts_with_current_state():
    c = client()
    a = make(c)
    ok = c.patch(f"/api/v2/annotations/{a['id']}", json={"description": "one", "expected_last_edit_time": a["last_edit_time"]})
    assert ok.status_code == 200
    stale = c.patch(f"/api/v2/annotations/{a['id']}", json={"description": "two", "expected_last_edit_time": a["last_edit_time"]})
    assert stale.status_code == 409 and stale.json()["current"]["description"] == "one"


def test_soft_delete_and_undo_then_hard_delete():
    c = client()
    a = make(c)
    assert c.delete(f"/api/v2/annotations/{a['id']}").status_code == 204
    assert c.get(f"/api/v2/annotations/{a['id']}").json()["deleted"] is True
    assert c.patch(f"/api/v2/annotations/{a['id']}", json={"deleted": False}).json()["deleted"] is False
    assert c.delete(f"/api/v2/annotations/{a['id']}", params={"hard": "true"}).status_code == 204
    assert c.get(f"/api/v2/annotations/{a['id']}").status_code == 404


def test_verify_and_unverify():
    c = client("rt_teamadmin")
    a = make(client("rt_member"))
    assert c.post(f"/api/v2/annotations/{a['id']}/verify", json={"verified": True}).json()["verified_by_user"] is True
    assert c.post(f"/api/v2/annotations/{a['id']}/verify", json={"verified": False}).json()["verified_by_user"] is False


def test_outsider_cannot_see_write_or_delete():
    a = make(client())
    o = client("rt_outsider")
    assert o.patch(f"/api/v2/annotations/{a['id']}", json={"description": "x"}).status_code == 404
    assert o.delete(f"/api/v2/annotations/{a['id']}").status_code == 404
    assert o.post("/api/v2/annotations", json={"image": IMAGE, "annotation_type": BBOX_TYPE, "vector": BB}).status_code == 400


def test_requires_authentication_and_csrf():
    assert httpx.post(BASE + "/api/v2/annotations", json={}).status_code in (401, 403)
    c = client()
    del c.headers["X-CSRF-Token"]
    assert c.post("/api/v2/annotations", json={"image": IMAGE, "annotation_type": BBOX_TYPE, "vector": BB}).status_code == 403


def test_global_annotation_exists_once_and_is_switched_on_again():
    admin = client("aubreville")
    t = admin.post("/api/v2/annotation-types", json={"name": f"glob-{uuid.uuid4().hex[:6]}", "vector_type": 7, "product": 1}).json()
    c = client("rt_member")
    try:
        first = c.post("/api/v2/annotations", json={"image": IMAGE, "annotation_type": t["id"], "vector": None, "unique_identifier": str(uuid.uuid4())})
        assert first.status_code == 201 and first.json()["vector"] is None
        again = c.post("/api/v2/annotations", json={"image": IMAGE, "annotation_type": t["id"], "vector": None, "unique_identifier": str(uuid.uuid4())})
        assert again.status_code == 200 and again.json()["id"] == first.json()["id"]
        assert c.delete(f"/api/v2/annotations/{first.json()['id']}").status_code == 204  # switched off
        back = c.post("/api/v2/annotations", json={"image": IMAGE, "annotation_type": t["id"], "vector": None, "unique_identifier": str(uuid.uuid4())})
        assert back.status_code == 200 and back.json()["id"] == first.json()["id"] and back.json()["deleted"] is False
    finally:
        for a in admin.get("/api/v2/annotations", params={"annotation_type": t["id"]}).json()["items"]:
            admin.delete(f"/api/v2/annotations/{a['id']}", params={"hard": "true"})
        admin.delete(f"/api/v2/annotation-types/{t['id']}")


def test_the_frame_of_an_annotation_in_a_stack_is_stored_with_the_vector():
    c = client()
    a = make(c, vector={**BB, "frame": 4})
    assert a["vector"] == {**BB, "frame": 4}
    moved = c.patch(f"/api/v2/annotations/{a['id']}", json={"vector": {"x1": 2, "y1": 2, "x2": 9, "y2": 9, "frame": 4}})
    assert moved.status_code == 200 and moved.json()["vector"]["frame"] == 4
    # the frame is not a coordinate: another extra key is still refused, and so is a frame that is no number
    assert c.post("/api/v2/annotations", json={"image": IMAGE, "annotation_type": BBOX_TYPE, "vector": {**BB, "frame": 4, "z": 1}}).status_code == 400
    assert c.post("/api/v2/annotations", json={"image": IMAGE, "annotation_type": BBOX_TYPE, "vector": {**BB, "frame": "x"}}).status_code == 400
    c.delete(f"/api/v2/annotations/{a['id']}")
