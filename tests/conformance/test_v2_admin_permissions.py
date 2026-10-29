"""Model permissions and service accounts: the workflow for creating a worker (Rust only)."""
import uuid

import httpx
import pytest
from common import BASE, PW

pytestmark = pytest.mark.skipif(httpx.get(BASE + "/api/version").status_code != 200, reason="server has no /api/version (Django)")

REGISTRATION_WORKER = ["images.change_imageregistration", "processing.add_plugin", "processing.change_pluginjob"]


def client(user="aubreville", password=PW):
    c = httpx.Client(base_url=BASE, timeout=60)
    r = c.post("/api/v2/auth/login", json={"username": user, "password": password})
    assert r.status_code == 200, r.text
    c.headers["X-CSRF-Token"] = r.json()["csrf_token"]
    return c


@pytest.fixture()
def worker():
    admin = client()
    name = f"worker-{uuid.uuid4().hex[:6]}"
    r = admin.post("/api/v2/admin/users", json={"username": name, "preset": "registration_worker", "teams": [1]})
    assert r.status_code == 201, r.text
    w = r.json()
    yield admin, w
    admin.delete(f"/api/v2/users/{w['id']}")


def test_the_catalog_offers_what_matters_and_the_presets(worker):
    cat = client().get("/api/v2/admin/permissions").json()
    keys = {p["key"] for p in cat["permissions"]}
    assert {"processing.add_plugin", "processing.change_pluginjob", "images.change_imageregistration"} <= keys
    assert not any(k.split(".")[1].startswith("view_") for k in keys)
    assert {a for a in (k.split(".")[0] for k in keys)} <= {"administration", "annotations", "images", "processing"}
    preset = next(p for p in cat["presets"] if p["id"] == "registration_worker")
    assert sorted(preset["permissions"]) == REGISTRATION_WORKER and preset["label"] and preset["description"]
    assert {p["id"] for p in cat["presets"]} >= {"registration_worker", "analysis_worker"}


def test_creating_a_worker_gives_a_password_once_the_preset_and_the_teams(worker):
    admin, w = worker
    assert w["password"] and len(w["password"]) >= 20 and w["teams"] == 1 and sorted(w["permissions"]) == REGISTRATION_WORKER
    state = admin.get(f"/api/v2/admin/users/{w['id']}/permissions").json()
    assert state["username"] == w["username"] and state["direct"] == REGISTRATION_WORKER and state["groups"] == []
    assert "password" not in admin.get(f"/api/v2/users/{w['id']}").json()
    # the new account logs in, is not staff, and can do what the preset says: announce a plugin; and nothing else
    c = client(w["username"], w["password"])
    me = c.get("/api/v2/auth/me").json()
    assert not me.get("is_staff") and not me.get("is_superuser")
    r = c.post("/api/v2/plugins/register", json={"name": f"p-{uuid.uuid4().hex[:6]}", "author": "t", "package": "t_pkg", "plugin_type": 2})
    assert r.status_code == 201, r.text
    admin.delete(f"/api/v2/plugins/{r.json()['id']}")
    assert c.post("/api/v2/products", json={"name": f"x-{uuid.uuid4().hex[:6]}"}).status_code == 403  # nothing beyond the preset


def test_replacing_the_permissions_takes_effect_at_once(worker):
    admin, w = worker
    c = client(w["username"], w["password"])
    body = {"name": f"p-{uuid.uuid4().hex[:6]}", "author": "t", "package": "t_pkg", "plugin_type": 2}
    r = admin.put(f"/api/v2/admin/users/{w['id']}/permissions", json={"permissions": ["processing.change_pluginjob"]})
    assert r.status_code == 200 and r.json()["direct"] == ["processing.change_pluginjob"]
    assert c.post("/api/v2/plugins/register", json=body).status_code == 403
    r = admin.put(f"/api/v2/admin/users/{w['id']}/permissions", json={"permissions": ["processing.add_plugin", "processing.add_plugin"]})
    assert r.json()["direct"] == ["processing.add_plugin"]
    made = c.post("/api/v2/plugins/register", json=body)
    assert made.status_code == 201
    admin.delete(f"/api/v2/plugins/{made.json()['id']}")
    assert admin.put(f"/api/v2/admin/users/{w['id']}/permissions", json={"permissions": []}).json()["direct"] == []


def test_refusals(worker):
    admin, w = worker
    bad = lambda **kw: admin.put(f"/api/v2/admin/users/{w['id']}/permissions", json=kw).status_code  # noqa: E731
    assert bad(permissions=["nonsense.add_thing"]) == 400
    assert bad(permissions=["processing.view_plugin"]) == 400  # view_* is not offered
    assert bad(permissions="processing.add_plugin") == 400
    me = admin.get("/api/v2/auth/me").json()["id"]
    assert admin.put(f"/api/v2/admin/users/{me}/permissions", json={"permissions": []}).status_code == 400  # not one's own
    assert admin.post("/api/v2/admin/users", json={"username": w["username"]}).status_code == 400  # taken
    assert admin.post("/api/v2/admin/users", json={"username": ""}).status_code == 400
    assert admin.post("/api/v2/admin/users", json={"username": "bad name!"}).status_code == 400
    assert admin.post("/api/v2/admin/users", json={"username": f"u-{uuid.uuid4().hex[:6]}", "preset": "nope"}).status_code == 400
    assert admin.post("/api/v2/admin/users", json={"username": f"u-{uuid.uuid4().hex[:6]}", "permissions": ["x.y"]}).status_code == 400
    # only superusers: a team admin, a member, nobody
    for who in ("rt_teamadmin", "rt_member"):
        c = client(who)
        assert c.get("/api/v2/admin/permissions").status_code == 403
        assert c.get(f"/api/v2/admin/users/{w['id']}/permissions").status_code == 403
        assert c.put(f"/api/v2/admin/users/{w['id']}/permissions", json={"permissions": []}).status_code == 403
        assert c.post("/api/v2/admin/users", json={"username": "nope"}).status_code == 403
    assert httpx.get(BASE + "/api/v2/admin/permissions").status_code in (401, 403)


def test_a_worker_account_without_a_preset_has_no_permissions_and_no_teams():
    admin = client()
    name = f"plain-{uuid.uuid4().hex[:6]}"
    r = admin.post("/api/v2/admin/users", json={"username": name})
    assert r.status_code == 201 and r.json()["permissions"] == [] and r.json()["teams"] == 0
    try:
        assert admin.get(f"/api/v2/admin/users/{r.json()['id']}/permissions").json()["direct"] == []
    finally:
        admin.delete(f"/api/v2/users/{r.json()['id']}")


def test_the_administrator_flag_can_be_read_and_set_by_superusers_only(worker):
    admin, w = worker
    assert w["id"] not in admin.get("/api/v2/admin/roles").json()["site_admin_ids"]
    r = admin.patch(f"/api/v2/users/{w['id']}", json={"is_site_admin": True})
    assert r.status_code == 200, r.text
    assert w["id"] in admin.get("/api/v2/admin/roles").json()["site_admin_ids"]
    # that user now administers users (the Users tab's rights): a site admin may read the roles
    assert client(w["username"], w["password"]).get("/api/v2/admin/roles").status_code == 200
    assert admin.patch(f"/api/v2/users/{w['id']}", json={"is_site_admin": False}).status_code == 200
    assert w["id"] not in admin.get("/api/v2/admin/roles").json()["site_admin_ids"]
    assert client(w["username"], w["password"]).get("/api/v2/admin/roles").status_code == 403
    me = admin.get("/api/v2/auth/me").json()["id"]
    assert admin.patch(f"/api/v2/users/{me}", json={"is_site_admin": False}).status_code == 400  # not one's own
    # brummel is staff and site admin, not a superuser: administers users but does not hand out the role
    assert client("brummel").patch(f"/api/v2/users/{w['id']}", json={"is_site_admin": True}).status_code == 403
    assert client("rt_member").get("/api/v2/admin/roles").status_code == 403
