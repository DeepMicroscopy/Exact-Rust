"""Personal access tokens: make, list, use, revoke; the secret is shown once; a token cannot make tokens; admins list and revoke."""
import httpx
import pytest
from common import BASE, PW

pytestmark = pytest.mark.skipif(httpx.get(BASE + "/api/version").status_code != 200, reason="server has no /api/version (Django)")


def client(user):
    c = httpx.Client(base_url=BASE, timeout=60)
    r = c.post("/api/v2/auth/login", json={"username": user, "password": PW})
    c.headers["X-CSRF-Token"] = r.json()["csrf_token"]
    return c


def bearer(token):
    return httpx.Client(base_url=BASE, timeout=60, headers={"Authorization": f"Bearer {token}"})


def test_a_new_token_works_everywhere_the_api_takes_tokens_and_can_be_revoked():
    c = client("rt_member")
    made = c.post("/api/v2/me/tokens", json={"name": "conformance"})
    assert made.status_code == 201, made.text
    t = made.json()
    assert t["token"].startswith("pat_" + t["prefix"] + ".") and t["active"] and not t["read_only"] and t["teams"] == []
    # the secret is only in the answer to the POST
    listed = [x for x in c.get("/api/v2/me/tokens").json() if x["id"] == t["id"]]
    assert listed and "token" not in listed[0] and listed[0]["name"] == "conformance"
    # it authenticates v2 and v1, and says whose it is
    assert bearer(t["token"]).get("/api/v2/auth/me").json()["username"] == "rt_member"
    assert bearer(t["token"]).get("/api/v1/users/").status_code == 200
    # a token cannot make or revoke tokens
    assert bearer(t["token"]).post("/api/v2/me/tokens", json={"name": "child"}).status_code == 403
    assert bearer(t["token"]).get("/api/v2/me/tokens").status_code == 403
    # revoke: stops working at once, stays in the list as revoked, a second delete removes the row
    assert c.delete(f"/api/v2/me/tokens/{t['id']}").status_code == 204
    assert bearer(t["token"]).get("/api/v2/auth/me").status_code in (401, 403)
    gone = [x for x in c.get("/api/v2/me/tokens").json() if x["id"] == t["id"]][0]
    assert gone["revoked_at"] and not gone["active"]
    assert c.delete(f"/api/v2/me/tokens/{t['id']}").status_code == 204
    assert all(x["id"] != t["id"] for x in c.get("/api/v2/me/tokens").json())
    assert c.delete(f"/api/v2/me/tokens/{t['id']}").status_code == 404


def test_read_only_and_team_scope_are_enforced_and_checked():
    c = client("rt_member")
    teams = [x["id"] for x in c.get("/api/v2/teams?limit=50").json()["items"]]
    assert teams, "rt_member belongs to a team"
    other = max(teams) + 1000
    assert c.post("/api/v2/me/tokens", json={"name": "x", "teams": [other]}).status_code == 400
    t = c.post("/api/v2/me/tokens", json={"name": "ro", "read_only": True, "teams": teams[:1], "expires_in_days": 3}).json()
    try:
        assert t["read_only"] and t["teams"] == teams[:1] and t["expires_at"]
        b = bearer(t["token"])
        assert b.get("/api/v2/auth/me").status_code == 200
        assert b.put("/api/v2/me/preferences", json={"zoom_slider": True}).status_code == 403  # read-only token
        assert {x["id"] for x in b.get("/api/v2/teams?limit=50").json()["items"]} <= set(teams[:1])
    finally:
        c.delete(f"/api/v2/me/tokens/{t['id']}")
        c.delete(f"/api/v2/me/tokens/{t['id']}")


def test_names_and_expiry_are_validated():
    c = client("rt_member")
    for body in ({"name": ""}, {"name": "   "}, {"name": "x" * 101}, {"name": "x", "expires_in_days": 0}, {"name": "x", "expires_in_days": 99999}):
        assert c.post("/api/v2/me/tokens", json=body).status_code == 400, body


def test_tokens_are_private_and_administrators_can_list_and_revoke_them():
    member, admin = client("rt_member"), client("aubreville")
    t = member.post("/api/v2/me/tokens", json={"name": "private"}).json()
    try:
        # nobody else sees or revokes it through the self-service routes
        assert all(x["id"] != t["id"] for x in client("rt_teamadmin").get("/api/v2/me/tokens").json())
        assert client("rt_teamadmin").delete(f"/api/v2/me/tokens/{t['id']}").status_code == 404
        # the admin list names the owner and never carries the secret
        row = [x for x in admin.get("/api/v2/admin/tokens").json() if x["id"] == t["id"]][0]
        assert row["username"] == "rt_member" and "token" not in row
        assert all(x["user"] == row["user"] for x in admin.get(f"/api/v2/admin/tokens?user={row['user']}").json())
        # not for everybody
        assert member.get("/api/v2/admin/tokens").status_code == 403
        assert member.delete(f"/api/v2/admin/tokens/{t['id']}").status_code == 403
        assert admin.delete(f"/api/v2/admin/tokens/{t['id']}").status_code == 204
        assert bearer(t["token"]).get("/api/v2/auth/me").status_code in (401, 403)
    finally:
        member.delete(f"/api/v2/me/tokens/{t['id']}")
        member.delete(f"/api/v2/me/tokens/{t['id']}")


def test_an_impersonating_administrator_cannot_make_tokens():
    c = httpx.Client(base_url=BASE, timeout=60)
    r = c.post("/api/v2/auth/login", json={"username": "brummel", "password": PW})  # site admin, not superuser
    h = {"X-CSRF-Token": r.json()["csrf_token"]}
    uid = [u for u in c.get("/api/v2/users?limit=200").json()["items"] if u["username"] == "rt_member"][0]["id"]
    t = c.post(f"/api/v2/admin/users/{uid}/impersonate", headers=h)
    assert t.status_code == 200, t.text
    h = {"X-CSRF-Token": c.get("/api/v2/auth/me").json()["csrf_token"]}
    try:
        assert c.post("/api/v2/me/tokens", json={"name": "stolen"}, headers=h).status_code == 403
        assert c.get("/api/v2/me/tokens").status_code == 403
    finally:
        c.post("/api/v2/auth/stop-impersonating", headers=h)
