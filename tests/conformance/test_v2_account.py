"""What an account does to itself (Rust only): /api/v2/me/account, /email, /password, /statistics."""
import httpx
import pytest
from common import BASE, PW

pytestmark = pytest.mark.skipif(httpx.get(BASE + "/api/version").status_code != 200, reason="server has no /api/version (Django)")

NEW = "Quite-Another-Pass-phrase-4711"


def client(user, pw=PW):
    c = httpx.Client(base_url=BASE, timeout=30)
    r = c.post("/api/v2/auth/login", json={"username": user, "password": pw})
    assert r.status_code == 200, r.text
    c.headers["X-CSRF-Token"] = r.json()["csrf_token"]
    return c


def test_the_email_address_is_read_validated_and_stored():
    c = client("rt_outsider")
    try:
        before = c.get("/api/v2/me/account").json()
        assert before["username"] == "rt_outsider"
        for bad in ["nobody", "a@b", "two words@x.org"]:
            r = c.put("/api/v2/me/email", json={"email": bad})
            assert r.status_code == 400 and "email" in r.json(), bad
        assert c.put("/api/v2/me/email", json={"email": " me@example.org "}).json() == {"email": "me@example.org"}
        assert c.get("/api/v2/me/account").json()["email"] == "me@example.org"
        c.put("/api/v2/me/email", json={"email": before["email"]})
    finally:
        c.close()


def test_changing_the_password_checks_the_old_one_and_signs_other_devices_out():
    here, there = client("brummel"), client("brummel")
    new = None
    try:
        r = here.post("/api/v2/me/password", json={"current_password": "wrong", "new_password": NEW})
        assert r.status_code == 400 and "current_password" in r.json()
        r = here.post("/api/v2/me/password", json={"current_password": PW, "new_password": "12345678"})
        assert r.status_code == 400 and "new_password" in r.json()
        assert here.post("/api/v2/me/password", json={"current_password": PW, "new_password": NEW}).status_code == 204
        new = NEW
        assert here.get("/api/v2/auth/me").status_code == 200  # this browser stays signed in
        assert there.get("/api/v2/auth/me").status_code in (401, 403)  # the other one does not
        assert httpx.post(BASE + "/api/v2/auth/login", json={"username": "brummel", "password": PW}).status_code == 401
        client("brummel", NEW).close()
    finally:
        if new:
            assert here.post("/api/v2/me/password", json={"current_password": NEW, "new_password": PW}).status_code == 204
        here.close()
        there.close()


def test_the_statistics_cover_30_days_and_the_teams_of_the_account():
    c = client("rt_member")
    try:
        s = c.get("/api/v2/me/statistics").json()
        assert len(s["per_day"]) == 30
        assert {"annotations", "images", "verifications", "teams"} <= set(s)
        assert all({"id", "name", "annotations", "images"} <= set(t) for t in s["teams"])
    finally:
        c.close()


def test_the_account_endpoints_need_a_login():
    for method, path, body in [
        ("GET", "/api/v2/me/account", None),
        ("PUT", "/api/v2/me/email", {"email": "x@y.de"}),
        ("POST", "/api/v2/me/password", {"current_password": "a", "new_password": "b"}),
        ("GET", "/api/v2/me/statistics", None),
    ]:
        assert httpx.request(method, BASE + path, json=body).status_code in (401, 403), path
