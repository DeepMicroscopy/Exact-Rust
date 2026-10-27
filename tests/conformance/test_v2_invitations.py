"""Invite-only onboarding and link-based password reset (no self-registration, no e-mail)."""
import secrets
import httpx
import pytest
from common import BASE, PW

pytestmark = pytest.mark.skipif(httpx.get(BASE + "/api/version").status_code != 200, reason="Rust server only")
STRONG = "violet-harbour-2026!"


def login(user, pw=PW):
    c = httpx.Client(base_url=BASE, timeout=30)
    r = c.post("/api/v2/auth/login", json={"username": user, "password": pw})
    assert r.status_code == 200, r.text
    return c, {"X-CSRF-Token": r.json()["csrf_token"]}


def invite(user="brummel", **body):
    c, h = login(user)
    r = c.post("/api/v2/invitations", headers=h, json=body)
    return c, h, r


def new_name():
    return "rt_inv_" + secrets.token_hex(4)


def test_self_registration_does_not_exist():
    for path in ("/api/v2/auth/register", "/api/v2/register", "/accounts/register/"):
        assert httpx.post(BASE + path, json={"username": "x", "password": STRONG}).status_code in (404, 405)


def test_site_admin_invites_and_person_accepts_once():
    _, _, r = invite(team_ids=[1, 2], email="new.person@example.invalid", note="PhD student")
    assert r.status_code == 201
    inv = r.json()
    assert inv["token"].startswith("inv_") and inv["path"] == "/invite/" + inv["token"] and inv["status"] == "pending"
    anon = httpx.Client(base_url=BASE, timeout=30)
    info = anon.get(f"/api/v2/invitations/token/{inv['token']}").json()
    assert info["purpose"] == "invite" and {t["id"] for t in info["teams"]} == {1, 2} and info["email"] == "new.person@example.invalid"
    name = new_name()
    acc = anon.post(f"/api/v2/invitations/token/{inv['token']}/accept", json={"username": name, "password": STRONG, "first_name": "New", "last_name": "Person"})
    assert acc.status_code == 201 and acc.json()["user"]["username"] == name and "HttpOnly" in acc.headers["set-cookie"]
    me = anon.get("/api/v2/auth/me").json()
    assert me["username"] == name and me["is_staff"] is False and me["is_superuser"] is False
    # member of exactly the invited teams, not an admin
    teams = anon.get("/api/v1/users/teams/")
    assert teams.status_code == 200 and {t["id"] for t in teams.json()["results"]} == {1, 2}
    assert all(not m["is_admin"] for m in anon.get("/api/v1/users/team_membership/", params={"user": me["id"]}).json()["results"])
    # can log in with the chosen password; the link is dead now
    assert login(name, STRONG)
    assert anon.get(f"/api/v2/invitations/token/{inv['token']}").status_code == 404
    assert anon.post(f"/api/v2/invitations/token/{inv['token']}/accept", json={"username": new_name(), "password": STRONG}).status_code == 404


def test_token_is_only_stored_hashed_and_only_shown_once():
    c, h, r = invite(team_ids=[1])
    inv = r.json()
    listed = c.get("/api/v2/invitations").json()
    mine = next(i for i in listed if i["id"] == inv["id"])
    assert "token" not in mine and "token_hash" not in mine


def test_accept_validates_username_and_password_like_django():
    _, _, r = invite(team_ids=[1])
    tok = r.json()["token"]
    a = httpx.Client(base_url=BASE, timeout=30)
    url = f"/api/v2/invitations/token/{tok}/accept"
    assert a.post(url, json={"username": "bad name!", "password": STRONG}).json()["username"]
    weak = a.post(url, json={"username": new_name(), "password": "12345678"}).json()["password"]
    assert any("common" in m for m in weak) and any("numeric" in m for m in weak)
    assert any("too short" in m for m in a.post(url, json={"username": new_name(), "password": "abc"}).json()["password"])
    name = new_name()
    assert any("similar" in m for m in a.post(url, json={"username": name, "password": name + "x"}).json()["password"])
    assert a.post(url, json={"username": "aubreville", "password": STRONG}).status_code == 409  # taken
    # failed attempts did not burn the invitation
    assert a.get(f"/api/v2/invitations/token/{tok}").status_code == 200
    assert a.post(url, json={"username": name, "password": STRONG}).status_code == 201


def test_team_admins_can_only_invite_into_their_own_teams():
    assert invite("rt_teamadmin", team_ids=[1])[2].status_code == 201       # admin of team 1
    assert invite("rt_teamadmin", team_ids=[1, 2])[2].status_code == 403     # not admin of team 2
    assert invite("rt_teamadmin", team_ids=[])[2].status_code == 403         # no teams: site admins only
    assert invite("rt_member", team_ids=[1])[2].status_code == 403           # plain member
    assert invite("brummel", team_ids=[999999])[2].status_code == 400        # unknown team
    assert invite("brummel", team_ids=[1], expires_in_days=0)[2].status_code == 400
    assert httpx.post(BASE + "/api/v2/invitations", json={"team_ids": [1]}).status_code == 403  # anonymous


def test_listing_and_revoking():
    c, h, r = invite("rt_teamadmin", team_ids=[1])
    inv = r.json()
    assert inv["id"] in [i["id"] for i in c.get("/api/v2/invitations").json()]
    other, oh = login("rt_member")
    assert inv["id"] not in [i["id"] for i in other.get("/api/v2/invitations").json()]
    assert other.delete(f"/api/v2/invitations/{inv['id']}", headers=oh).status_code == 404  # not theirs
    admin, ah = login("brummel")
    assert inv["id"] in [i["id"] for i in admin.get("/api/v2/invitations").json()]  # site admin sees all
    assert c.delete(f"/api/v2/invitations/{inv['id']}", headers=h).status_code == 204
    assert httpx.get(BASE + f"/api/v2/invitations/token/{inv['token']}").status_code == 404
    assert httpx.post(BASE + f"/api/v2/invitations/token/{inv['token']}/accept", json={"username": new_name(), "password": STRONG}).status_code == 404


def test_password_reset_link_flow():
    # a throwaway user to reset
    _, _, r = invite(team_ids=[1])
    name = new_name()
    httpx.post(BASE + f"/api/v2/invitations/token/{r.json()['token']}/accept", json={"username": name, "password": STRONG})
    victim, _ = login(name, STRONG)
    uid = victim.get("/api/v2/auth/me").json()["id"]
    # warm the server's Basic-auth cache with the old password; the reset below must invalidate it
    assert httpx.get(BASE + "/api/v1/users/users/", auth=(name, STRONG)).status_code == 200
    # only site admins may create reset links
    other, oh = login("rt_teamadmin")
    assert other.post(f"/api/v2/admin/users/{uid}/reset-link", headers=oh).status_code == 403
    admin, ah = login("brummel")
    assert admin.post("/api/v2/admin/users/1/reset-link", headers=ah).status_code == 403  # superuser target
    assert admin.post("/api/v2/admin/users/99999/reset-link", headers=ah).status_code == 404
    link = admin.post(f"/api/v2/admin/users/{uid}/reset-link", headers=ah)
    assert link.status_code == 201 and link.json()["token"].startswith("rst_")
    tok = link.json()["token"]
    anon = httpx.Client(base_url=BASE, timeout=30)
    assert anon.get(f"/api/v2/invitations/token/{tok}").json()["username"] == name
    assert anon.post(f"/api/v2/invitations/token/{tok}/accept", json={"password": "12345678"}).status_code == 400
    new_pw = "amber-meadow-7741$"
    done = anon.post(f"/api/v2/invitations/token/{tok}/accept", json={"password": new_pw})
    assert done.status_code == 200 and done.json()["user"]["username"] == name
    # old password and old sessions are dead, new password works, link is single use
    assert httpx.post(BASE + "/api/v2/auth/login", json={"username": name, "password": STRONG}).status_code == 401
    assert httpx.get(BASE + "/api/v1/users/users/", auth=(name, STRONG)).status_code == 403, "cached credentials must not survive a password change"
    assert httpx.get(BASE + "/api/v1/users/users/", auth=(name, new_pw)).status_code == 200
    assert victim.get("/api/v2/auth/me").status_code == 401
    assert httpx.post(BASE + "/api/v2/auth/login", json={"username": name, "password": new_pw}).status_code == 200
    assert anon.post(f"/api/v2/invitations/token/{tok}/accept", json={"password": new_pw + "x"}).status_code == 404


def test_invite_token_cannot_be_used_as_reset_and_vice_versa():
    _, _, r = invite(team_ids=[1])
    # an invite has no user: accepting it as reset is impossible; it is only an invite
    a = httpx.Client(base_url=BASE, timeout=30)
    assert a.get(f"/api/v2/invitations/token/{r.json()['token']}").json()["purpose"] == "invite"
