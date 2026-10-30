"""Read-only accounts: they look, they cannot change anything, however they log in (Rust only)."""
import uuid

import httpx
import pytest
from common import BASE, PW

pytestmark = pytest.mark.skipif(httpx.get(BASE + "/api/version").status_code != 200, reason="server has no /api/version (Django)")


def client(user="aubreville", password=PW):
    c = httpx.Client(base_url=BASE, timeout=60)
    r = c.post("/api/v2/auth/login", json={"username": user, "password": password})
    assert r.status_code == 200, r.text
    c.headers["X-CSRF-Token"] = r.json()["csrf_token"]
    return c


@pytest.fixture()
def reviewer():
    admin = client()
    name = f"reviewer-{uuid.uuid4().hex[:6]}"
    r = admin.post("/api/v2/admin/users", json={"username": name, "first_name": "Rita", "last_name": "Review", "email": "rita@example.org", "teams": [1], "read_only": True})
    assert r.status_code == 201, r.text
    u = r.json()
    yield admin, u
    admin.delete(f"/api/v2/users/{u['id']}")


def test_creating_a_person_sets_names_email_teams_and_the_flag(reviewer):
    admin, u = reviewer
    assert u["read_only"] is True and u["teams"] == 1 and u["permissions"] == [] and len(u["password"]) >= 20
    profile = admin.get(f"/api/v2/admin/users/{u['id']}/profile").json()
    assert (profile["first_name"], profile["last_name"], profile["email"]) == ("Rita", "Review", "rita@example.org")
    row = admin.get(f"/api/v2/users/{u['id']}?fields=id,is_staff,is_superuser,team_set").json()
    assert not row["is_staff"] and not row["is_superuser"] and row["team_set"] == [1]
    roles = admin.get("/api/v2/admin/roles").json()
    assert u["id"] in roles["read_only_ids"] and u["id"] not in roles["site_admin_ids"]
    me = client(u["username"], u["password"]).get("/api/v2/auth/me").json()
    assert me["read_only"] is True
    assert client("rt_member").get("/api/v2/auth/me").json()["read_only"] is False


def test_a_read_only_account_can_read_but_not_write_in_the_ui_api(reviewer):
    _, u = reviewer
    c = client(u["username"], u["password"])
    assert c.get("/api/v2/image-sets?limit=5").status_code == 200
    assert c.get("/api/v2/images?fields=id&limit=5").status_code == 200
    assert c.get("/api/v2/annotations?image=34&deleted=false&limit=5").status_code == 200
    for method, url, body in [
        ("POST", "/api/v2/image-sets", {"name": "no", "team": 1}),
        ("POST", "/api/v2/annotations", {"image": 1, "annotation_type": 1, "vector": {"x1": 1, "y1": 1, "x2": 9, "y2": 9}}),
        ("PATCH", "/api/v2/image-sets/1", {"name": "no"}),
        ("DELETE", "/api/v2/annotations/1", None),
        ("POST", "/api/v2/images/1/crop", {"x": 0, "y": 0, "w": 10, "h": 10, "frame": 0, "image_set": 1}),
        ("POST", "/api/v2/images/1/register", {"target_image": 2}),
    ]:
        r = c.request(method, url, json=body)
        assert r.status_code == 403 and "read only" in r.text, (method, url, r.status_code, r.text)


def test_the_old_interfaces_refuse_it_too_but_listing_works(reviewer):
    _, u = reviewer
    basic = httpx.Client(base_url=BASE, auth=(u["username"], u["password"]), timeout=60)  # what exact-sync and workers use
    assert basic.get("/api/v1/images/images/?limit=3").status_code == 200
    assert basic.post("/api/v1/images/image_sets/", json={"name": "no", "team": 1}).status_code == 403
    assert basic.delete("/api/v1/annotations/annotations/1/").status_code == 403
    r = basic.post("/annotations/api/annotation/create/", json={"image_id": 1, "annotation_type_id": 1, "vector": {"x1": 1, "y1": 1, "x2": 9, "y2": 9}})
    assert r.status_code == 403
    assert basic.get("/images/api/image/crop/1/0/0/1/10/10/1/").status_code == 403  # a GET that creates an image
    assert basic.post("/images/api/list_imagesets/", json={}).status_code == 200  # exact-sync lists with a POST: that is not a write


def test_it_can_sign_out_and_the_administrator_can_lift_the_flag_at_once(reviewer):
    admin, u = reviewer
    c = client(u["username"], u["password"])
    assert c.post("/api/v2/image-sets", json={"name": "x", "team": 1}).status_code == 403
    assert admin.patch(f"/api/v2/users/{u['id']}", json={"read_only": False}).status_code == 200
    made = c.post("/api/v2/image-sets", json={"name": f"ro-{uuid.uuid4().hex[:6]}", "team": 1})
    assert made.status_code == 201, made.text  # the same session, no new login
    admin.delete(f"/api/v2/image-sets/{made.json()['id']}")
    assert admin.patch(f"/api/v2/users/{u['id']}", json={"read_only": True}).status_code == 200
    assert c.post("/api/v2/image-sets", json={"name": "x", "team": 1}).status_code == 403
    assert c.post("/api/v2/auth/logout").status_code == 204  # signing out is not a change of data


def test_who_may_create_and_set(reviewer):
    admin, u = reviewer
    brummel = client("brummel")  # staff and site admin, not a superuser
    name = f"viewer-{uuid.uuid4().hex[:6]}"
    r = brummel.post("/api/v2/admin/users", json={"username": name, "read_only": True, "teams": [1]})
    assert r.status_code == 201, r.text
    assert brummel.patch(f"/api/v2/users/{r.json()['id']}", json={"read_only": False}).status_code == 200
    assert brummel.post("/api/v2/admin/users", json={"username": name + "x", "preset": "registration_worker"}).status_code == 403  # permissions: superusers
    assert brummel.post("/api/v2/admin/users", json={"username": name + "y", "permissions": ["processing.add_plugin"]}).status_code == 403
    me = brummel.get("/api/v2/auth/me").json()["id"]
    assert brummel.patch(f"/api/v2/users/{me}", json={"read_only": True}).status_code == 400  # not one's own
    for who in ("rt_teamadmin", "rt_member"):
        c = client(who)
        assert c.post("/api/v2/admin/users", json={"username": "nope"}).status_code == 403
        assert c.patch(f"/api/v2/users/{u['id']}", json={"read_only": False}).status_code == 403
    admin.delete(f"/api/v2/users/{r.json()['id']}")


def test_impersonating_a_read_only_user_is_read_only_and_one_can_stop(reviewer):
    admin, u = reviewer
    assert admin.post(f"/api/v2/admin/users/{u['id']}/impersonate").status_code == 200
    me = admin.get("/api/v2/auth/me").json()  # a new session: its own CSRF token
    assert me["username"] == u["username"] and me["read_only"] is True
    admin.headers["X-CSRF-Token"] = me["csrf_token"]
    r = admin.post("/api/v2/image-sets", json={"name": "x", "team": 1})
    assert r.status_code == 403 and "read only" in r.text, r.text
    assert admin.post("/api/v2/auth/stop-impersonating").status_code == 200
    back = admin.get("/api/v2/auth/me").json()
    assert back["username"] == "aubreville"
    admin.headers["X-CSRF-Token"] = back["csrf_token"]


def test_a_read_only_token_or_account_creating_a_user_is_refused(reviewer):
    _, u = reviewer
    c = client(u["username"], u["password"])
    assert c.post("/api/v2/admin/users", json={"username": f"x-{uuid.uuid4().hex[:6]}"}).status_code == 403
