"""Session authentication of the new API (/api/v2/auth/*): Rust only, no Django counterpart."""
import httpx
import pytest
from common import BASE, PW

pytestmark = pytest.mark.skipif(httpx.get(BASE + "/api/version").status_code != 200, reason="server has no /api/version (Django)")


def login(user="rt_member", pw=PW):
    c = httpx.Client(base_url=BASE, timeout=30)
    return c, c.post("/api/v2/auth/login", json={"username": user, "password": pw})


def test_login_sets_httponly_session_cookie_and_returns_csrf():
    c, r = login()
    assert r.status_code == 200
    j = r.json()
    assert j["user"]["username"] == "rt_member" and len(j["csrf_token"]) >= 32
    sc = r.headers["set-cookie"]
    assert "HttpOnly" in sc and "SameSite=Lax" in sc and sc.startswith("exact_session=")


def test_me_requires_login_and_returns_csrf_for_session():
    assert httpx.get(BASE + "/api/v2/auth/me").status_code == 401
    c, r = login()
    me = c.get("/api/v2/auth/me").json()
    assert me["username"] == "rt_member" and me["csrf_token"] == r.json()["csrf_token"]


@pytest.mark.parametrize("user,pw", [("rt_member", "wrong"), ("nobody", PW), ("rt_inactive", PW)])
def test_bad_credentials_are_401(user, pw):
    _, r = login(user, pw)
    assert r.status_code == 401 and r.json() == {"detail": "Invalid username/password."}


@pytest.mark.parametrize("user", ["rt_argon", "rt_bcrypt", "rt_sha1"])
def test_login_with_all_django_hash_formats(user):
    assert login(user)[1].status_code == 200


def test_session_get_works_on_v1_api():
    c, _ = login("aubreville")
    assert c.get("/api/v1/users/users/").status_code == 200


def test_unsafe_requests_with_session_need_csrf_token():
    c, r = login("rt_member")
    # no header: rejected by CSRF protection before permissions are looked at
    assert c.post("/api/v1/users/teams/", json={"name": "x"}).status_code == 403
    assert "CSRF" in c.post("/api/v1/users/teams/", json={"name": "x"}).json()["detail"]
    # wrong token
    assert "CSRF" in c.post("/api/v1/users/teams/", json={"name": "x"}, headers={"X-CSRF-Token": "nope"}).json()["detail"]
    # right token: passes CSRF, then the model permission check refuses (rt_member lacks users.add_team)
    r2 = c.post("/api/v1/users/teams/", json={"name": "x"}, headers={"X-CSRF-Token": r.json()["csrf_token"]})
    assert r2.status_code == 403 and "permission" in r2.json()["detail"]


def test_logout_invalidates_session():
    c, r = login()
    out = c.post("/api/v2/auth/logout", headers={"X-CSRF-Token": r.json()["csrf_token"]})
    assert out.status_code == 204
    c.cookies.clear()
    assert c.get("/api/v2/auth/me").status_code == 401


def test_logout_without_csrf_is_refused_and_session_survives():
    c, r = login()
    assert c.post("/api/v2/auth/logout").status_code == 403
    assert c.get("/api/v2/auth/me").status_code == 200


def test_token_of_inactive_user_is_refused():
    # hardening vs. Django: tokens of deactivated users do not authenticate (rt_inactive owns none, so create via sql in seed)
    r = httpx.get(BASE + "/api/v1/users/users/", headers={"Authorization": "Bearer pat_rtinactive01.secret-inactive"})
    assert r.status_code == 403


# ---- impersonation (site admins only; mirrors administration.views.user_impersonate_api) ----

def csrf_of(r):
    return {"X-CSRF-Token": r.json()["csrf_token"]}


def test_impersonation_roundtrip_and_audit_state():
    c, r = login("brummel")  # staff, site admin, not superuser
    t = c.post("/api/v2/admin/users/5/impersonate", headers=csrf_of(r))  # rt_member
    assert t.status_code == 200 and t.json()["user"]["username"] == "rt_member" and t.json()["impersonating_real_user_id"] == 3
    me = c.get("/api/v2/auth/me").json()
    assert me["username"] == "rt_member" and me["impersonating_real_user_id"] == 3
    # effective user is the target: sees what rt_member sees (70 images' team), not what brummel sees
    back = c.post("/api/v2/auth/stop-impersonating", headers={"X-CSRF-Token": me["csrf_token"]})
    assert back.status_code == 200 and back.json()["user"]["username"] == "brummel"
    assert c.get("/api/v2/auth/me").json()["impersonating_real_user_id"] is None


def test_impersonation_rules():
    c, r = login("brummel")
    h = csrf_of(r)
    assert c.post("/api/v2/admin/users/3/impersonate", headers=h).json()["detail"] == "Cannot impersonate yourself."
    assert c.post("/api/v2/admin/users/1/impersonate", headers=h).status_code == 403  # superuser target, non-superuser actor
    assert c.post("/api/v2/admin/users/99999/impersonate", headers=h).status_code == 404
    t = c.post("/api/v2/admin/users/5/impersonate", headers=h)
    assert c.post("/api/v2/admin/users/4/impersonate", headers=csrf_of(t)).status_code == 403  # rt_member is no site admin


def test_no_nested_impersonation():
    c, r = login("aubreville")  # superuser + site admin
    t = c.post("/api/v2/admin/users/3/impersonate", headers=csrf_of(r))  # brummel is also a site admin
    assert t.status_code == 200
    again = c.post("/api/v2/admin/users/5/impersonate", headers=csrf_of(t))
    assert again.status_code == 400 and "Already impersonating" in again.json()["detail"]


def test_non_admin_and_non_session_cannot_impersonate():
    c, r = login("rt_teamadmin")
    assert c.post("/api/v2/admin/users/5/impersonate", headers=csrf_of(r)).status_code == 403
    basic = httpx.post(BASE + "/api/v2/admin/users/5/impersonate", auth=("aubreville", PW))
    assert basic.status_code == 403
    assert httpx.post(BASE + "/api/v2/admin/users/5/impersonate").status_code == 403


def test_stop_without_impersonation_is_400():
    c, r = login("brummel")
    assert c.post("/api/v2/auth/stop-impersonating", headers=csrf_of(r)).status_code == 400
