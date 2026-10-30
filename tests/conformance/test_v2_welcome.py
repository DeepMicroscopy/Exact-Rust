"""The first-login greeting: shown until it was dismissed once, remembered per user (Rust only)."""
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
def newcomer():
    admin = client()
    name = f"newcomer-{uuid.uuid4().hex[:6]}"
    r = admin.post("/api/v2/admin/users", json={"username": name, "teams": [1]})
    assert r.status_code == 201, r.text
    yield admin, r.json()
    admin.delete(f"/api/v2/users/{r.json()['id']}")


def test_a_new_user_is_greeted_once(newcomer):
    _, u = newcomer
    c = client(u["username"], u["password"])
    first = c.get("/api/v2/welcome").json()
    assert first["show"] is True and "notice" in first
    assert c.post("/api/v2/welcome/seen").status_code == 204
    assert c.get("/api/v2/welcome").json()["show"] is False
    # remembered by the server for the user, not by the browser: a new login elsewhere does not show it again
    again = client(u["username"], u["password"])
    assert again.get("/api/v2/welcome").json()["show"] is False
    assert c.post("/api/v2/welcome/seen").status_code == 204  # dismissing twice is harmless


def test_somebody_who_was_marked_as_greeted_is_not_greeted():
    assert client("rt_member").get("/api/v2/welcome").json()["show"] is False  # the scratch users are marked by reference/mark-welcomed.sh


def test_a_read_only_account_can_dismiss_it():
    admin = client()
    name = f"ro-greeted-{uuid.uuid4().hex[:6]}"
    u = admin.post("/api/v2/admin/users", json={"username": name, "teams": [1], "read_only": True}).json()
    try:
        c = client(u["username"], u["password"])
        assert c.get("/api/v2/welcome").json()["show"] is True
        assert c.post("/api/v2/welcome/seen").status_code == 204  # not a change of data: refused for no read-only account
        assert c.get("/api/v2/welcome").json()["show"] is False
    finally:
        admin.delete(f"/api/v2/users/{u['id']}")


def test_an_administrator_impersonating_a_newcomer_neither_sees_nor_dismisses_it(newcomer):
    admin, u = newcomer
    assert admin.post(f"/api/v2/admin/users/{u['id']}/impersonate").status_code == 200
    me = admin.get("/api/v2/auth/me").json()
    admin.headers["X-CSRF-Token"] = me["csrf_token"]
    assert me["username"] == u["username"]
    assert admin.get("/api/v2/welcome").json()["show"] is False
    assert admin.post("/api/v2/welcome/seen").status_code == 204
    assert admin.post("/api/v2/auth/stop-impersonating").status_code == 200
    # the newcomer still has the greeting waiting
    assert client(u["username"], u["password"]).get("/api/v2/welcome").json()["show"] is True


def test_anonymous_requests_are_refused():
    assert httpx.get(BASE + "/api/v2/welcome").status_code in (401, 403)
    assert httpx.post(BASE + "/api/v2/welcome/seen").status_code in (401, 403)
